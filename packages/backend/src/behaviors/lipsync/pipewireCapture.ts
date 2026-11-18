/**
 * Server-side lipsync input: capture a PipeWire/PulseAudio source with `parec`
 * and classify it into viseme weights with the shared classifier.
 *
 * This is the lipsync behavior's `pipewire` input mode. The browser mode needs
 * a tab open with the media-input window and a mic picked by hand; this mode
 * starts with the backend, so an external program (e.g. an AI character's TTS
 * playing into a null-sink) drives the mouth with no manual steps. Pointing it
 * at a sink's `.monitor` — the same source OBS captures — keeps mouth and
 * stream audio on one clock.
 *
 * Pacing is by the audio itself: `parec` delivers samples in real time, and a
 * frame is classified every `sampleRate / fps` samples over the latest
 * `FFT_SIZE` window. A suspended sink delivers no samples at all, so a watchdog
 * closes the mouth when data stops rather than freezing it mid-vowel.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import {
  DEFAULT_SAMPLE_RATE,
  FFT_SIZE,
  VisemeClassifier,
  emptyVisemeWeights,
  type VisemeWeights,
  type VowelTemplates,
} from '@vspark/shared/visemes';

export type SpawnFn = (
  command: string,
  args: string[]
) => Pick<ChildProcess, 'stdout' | 'stderr' | 'on' | 'kill'>;

export interface PipeWireCaptureOptions {
  /** PipeWire/Pulse source name, e.g. `my_sink.monitor`. */
  source: string;
  onVisemes: (weights: VisemeWeights) => void;
  templates?: VowelTemplates;
  sampleRate?: number;
  /** Classification frames per second (the browser uplink sends 30). */
  fps?: number;
  /** No samples for this long closes the mouth. */
  staleMs?: number;
  /** Injected in tests; `child_process.spawn` otherwise. */
  spawn?: SpawnFn;
  log?: (msg: string) => void;
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
/** Below this, every weight counts as closed (skip re-sending silence). */
const QUIET = 1e-3;

export class PipeWireLipsyncCapture {
  private readonly source: string;
  private readonly sampleRate: number;
  private readonly hop: number;
  private readonly staleMs: number;
  private readonly spawnFn: SpawnFn;
  private readonly log: (msg: string) => void;
  private readonly onVisemes: (w: VisemeWeights) => void;
  private readonly classifier: VisemeClassifier;

  private child: ReturnType<SpawnFn> | null = null;
  private stopped = true;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private backoffMs = MIN_BACKOFF_MS;

  /** Ring of the latest FFT_SIZE samples; `ringPos` is the next write slot. */
  private readonly ring = new Float32Array(FFT_SIZE);
  private readonly frame = new Float32Array(FFT_SIZE);
  private ringPos = 0;
  private sinceFrame = 0;
  /** A float split across two stdout chunks. */
  private carry: Buffer = Buffer.alloc(0);
  private lastDataAt = 0;
  private closed = true;

  constructor(opts: PipeWireCaptureOptions) {
    this.source = opts.source;
    this.sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.hop = Math.max(1, Math.round(this.sampleRate / (opts.fps ?? 30)));
    this.staleMs = opts.staleMs ?? 150;
    this.spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
    this.log = opts.log ?? ((m) => console.log(`[Lipsync] ${m}`));
    this.onVisemes = opts.onVisemes;
    this.classifier = new VisemeClassifier(this.sampleRate, opts.templates);
  }

  get running(): boolean {
    return !this.stopped;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.watchdog = setInterval(() => this.checkStale(), this.staleMs);
    this.spawnChild();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.restartTimer = this.watchdog = null;
    const child = this.child;
    this.child = null;
    child?.kill();
    this.closeMouth();
  }

  private spawnChild(): void {
    const args = [
      `--device=${this.source}`,
      '--format=float32le',
      `--rate=${this.sampleRate}`,
      '--channels=1',
      '--latency-msec=20',
      '--raw',
    ];
    let child: ReturnType<SpawnFn>;
    try {
      child = this.spawnFn('parec', args);
    } catch (e) {
      this.log(`could not start parec: ${(e as Error).message}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.carry = Buffer.alloc(0);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.child === child) this.onData(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) this.log(`parec (${this.source}): ${msg}`);
    });
    // 'error' fires instead of 'exit' when the binary is missing (ENOENT).
    child.on('error', (err: Error) => {
      if (this.child !== child) return;
      this.log(`parec failed for ${this.source}: ${err.message}`);
      this.child = null;
      this.scheduleRestart();
    });
    child.on('exit', (code: number | null) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopped) return;
      this.log(`parec for ${this.source} exited (${code}); restarting`);
      this.scheduleRestart();
    });
    this.log(`capturing ${this.source}`);
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    this.closeMouth();
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) this.spawnChild();
    }, delay);
  }

  /** Feed raw float32le bytes. Public for tests. */
  onData(chunk: Buffer): void {
    const buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const n = Math.floor(buf.length / 4);
    this.carry = Buffer.from(buf.subarray(n * 4));
    if (n === 0) return;
    this.lastDataAt = Date.now();
    this.backoffMs = MIN_BACKOFF_MS;
    for (let i = 0; i < n; i++) {
      this.ring[this.ringPos] = buf.readFloatLE(i * 4);
      this.ringPos = (this.ringPos + 1) % FFT_SIZE;
      if (++this.sinceFrame >= this.hop) {
        this.sinceFrame = 0;
        this.analyse();
      }
    }
  }

  private analyse(): void {
    // Unroll the ring oldest → newest.
    const tail = FFT_SIZE - this.ringPos;
    this.frame.set(this.ring.subarray(this.ringPos), 0);
    this.frame.set(this.ring.subarray(0, this.ringPos), tail);
    const w = this.classifier.processSamples(this.frame);
    const quiet = isQuiet(w);
    // Silence after silence carries nothing new; send the first closed frame
    // and then stay quiet until there is sound again.
    if (quiet && this.closed) return;
    this.closed = quiet;
    this.onVisemes(quiet ? emptyVisemeWeights() : w);
  }

  private checkStale(): void {
    if (Date.now() - this.lastDataAt > this.staleMs) this.closeMouth();
  }

  private closeMouth(): void {
    this.classifier.reset();
    this.ring.fill(0);
    if (this.closed) return;
    this.closed = true;
    this.onVisemes(emptyVisemeWeights());
  }
}

function isQuiet(w: VisemeWeights): boolean {
  for (const v of Object.values(w)) if (v > QUIET) return false;
  return true;
}
