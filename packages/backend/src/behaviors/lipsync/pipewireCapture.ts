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

import {
  execFile,
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
} from 'child_process';
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

/**
 * What the capture is doing, for the editor:
 *   - `starting`  — parec was just started;
 *   - `capturing` — sound is arriving (a non-silent frame within `idleMs`);
 *   - `idle`      — parec runs but there is no sound: silence (a null
 *                   sink's monitor keeps delivering zeros) or no samples at
 *                   all (a suspended sink);
 *   - `error`     — parec failed or exited; it is retried with backoff.
 *                   `message` is parec's last complaint (e.g. an unknown
 *                   source) or the spawn error (parec missing).
 */
export type CaptureState = 'starting' | 'capturing' | 'idle' | 'error';
export interface CaptureStatus {
  state: CaptureState;
  message?: string;
}

/** Can this server capture a PipeWire/Pulse source? Linux with `parec` on
 *  PATH. Checked once at boot; the editor offers the PipeWire input only
 *  when it is true. */
export function canCapturePipeWire(
  platform: NodeJS.Platform = process.platform,
  spawnSync: (
    cmd: string,
    args: string[]
  ) => { status: number | null; error?: Error } = nodeSpawnSync
): boolean {
  if (platform !== 'linux') return false;
  try {
    const r = spawnSync('parec', ['--version']);
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Does the source exist? `pactl list short sources`, second column. Needed
 * because PipeWire's Pulse server does not refuse an unknown `--device`: it
 * records the DEFAULT source instead, so a typo would lip-sync from the wrong
 * input without any error. Null when pactl cannot answer (check skipped).
 */
export function pactlSourceExists(source: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile(
      'pactl',
      ['list', 'short', 'sources'],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const names = stdout
          .split('\n')
          .map((l) => l.split('\t')[1]?.trim())
          .filter(Boolean);
        resolve(names.includes(source));
      }
    );
  });
}

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
  /** No sound (silence or no samples) for this long reads `idle`. */
  idleMs?: number;
  /** Injected in tests; `child_process.spawn` otherwise. */
  spawn?: SpawnFn;
  log?: (msg: string) => void;
  /** Called when the capture state changes (not on every frame). */
  onStatus?: (status: CaptureStatus) => void;
  /** Checked before each parec start (see `pactlSourceExists`); an unknown
   *  source is an error, retried with backoff. Omitted: no check. */
  sourceExists?: (source: string) => Promise<boolean | null>;
}

/** A restarted parec that has stayed up this long is no longer "failing". */
const ERROR_CLEAR_MS = 1000;

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
/** Below this, every weight counts as closed (skip re-sending silence). */
const QUIET = 1e-3;

export class PipeWireLipsyncCapture {
  private readonly source: string;
  private readonly sampleRate: number;
  private readonly hop: number;
  private readonly staleMs: number;
  private readonly idleMs: number;
  private readonly spawnFn: SpawnFn;
  private readonly log: (msg: string) => void;
  private readonly onVisemes: (w: VisemeWeights) => void;
  private readonly onStatus: (s: CaptureStatus) => void;
  private readonly sourceExists?: (s: string) => Promise<boolean | null>;
  private readonly classifier: VisemeClassifier;
  private status: CaptureStatus | null = null;
  /** parec's last stderr line, reported when it exits. */
  private lastStderr = '';
  private childSince = 0;

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
  private lastSoundAt = 0;
  private closed = true;

  constructor(opts: PipeWireCaptureOptions) {
    this.source = opts.source;
    this.sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.hop = Math.max(1, Math.round(this.sampleRate / (opts.fps ?? 30)));
    this.staleMs = opts.staleMs ?? 150;
    this.idleMs = opts.idleMs ?? 2000;
    this.spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
    this.log = opts.log ?? ((m) => console.log(`[Lipsync] ${m}`));
    this.onVisemes = opts.onVisemes;
    this.onStatus = opts.onStatus ?? (() => {});
    this.sourceExists = opts.sourceExists;
    this.classifier = new VisemeClassifier(this.sampleRate, opts.templates);
  }

  get running(): boolean {
    return !this.stopped;
  }

  /** The current state (null before start). */
  get current(): CaptureStatus | null {
    return this.status;
  }

  private setStatus(state: CaptureState, message?: string): void {
    if (this.status?.state === state && this.status.message === message)
      return;
    this.status = message === undefined ? { state } : { state, message };
    this.onStatus(this.status);
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
    if (!this.sourceExists) return this.startParec();
    void this.sourceExists(this.source).then(
      (exists) => {
        if (this.stopped || this.child) return;
        if (exists === false) {
          this.log(`unknown source ${this.source}; retrying`);
          this.setStatus('error', `Unknown source: ${this.source}`);
          this.scheduleRestart();
          return;
        }
        this.startParec();
      },
      () => {
        if (!this.stopped && !this.child) this.startParec();
      }
    );
  }

  private startParec(): void {
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
      this.setStatus('error', (e as Error).message);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.childSince = Date.now();
    this.lastStderr = '';
    this.carry = Buffer.alloc(0);
    // A retry keeps showing the error until it proves itself (checkStale).
    if (this.status?.state !== 'error') this.setStatus('starting');
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.child === child) this.onData(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (!msg) return;
      this.lastStderr = msg.split('\n').at(-1)!.trim();
      this.log(`parec (${this.source}): ${msg}`);
    });
    // 'error' fires instead of 'exit' when the binary is missing (ENOENT).
    child.on('error', (err: Error) => {
      if (this.child !== child) return;
      this.log(`parec failed for ${this.source}: ${err.message}`);
      this.child = null;
      this.setStatus('error', err.message);
      this.scheduleRestart();
    });
    child.on('exit', (code: number | null) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopped) return;
      this.log(`parec for ${this.source} exited (${code}); restarting`);
      this.setStatus('error', this.lastStderr || `parec exited (${code})`);
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
    if (!quiet) {
      this.lastSoundAt = Date.now();
      this.setStatus('capturing');
    }
    // Silence after silence carries nothing new; send the first closed frame
    // and then stay quiet until there is sound again.
    if (quiet && this.closed) return;
    this.closed = quiet;
    this.onVisemes(quiet ? emptyVisemeWeights() : w);
  }

  private checkStale(): void {
    const now = Date.now();
    if (now - this.lastDataAt > this.staleMs) this.closeMouth();
    if (!this.child || now - this.lastSoundAt <= this.idleMs) return;
    // parec is up but there is no sound. After a failure, only once it has
    // stayed up.
    if (this.status?.state !== 'error' || now - this.childSince > ERROR_CLEAR_MS)
      this.setStatus('idle');
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
