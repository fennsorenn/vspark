import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { getInstallDir } from '../../routes/update.js';
import { downloadedRuntimeDir, isDownloaded } from './download.js';
import { PREVIEW_OFF, type PreviewWanted } from './preview.js';

/**
 * The Learned Tracking runtime: motiontracker's `mtservice` (camera → MediaPipe
 * Holistic → learned body model → VRM bones as VMC over UDP), run as a child
 * process. It is not bundled with vspark: it is started with `uv` from the pinned
 * release the behavior downloads (download.ts) or a local motiontracker checkout,
 * so `uv` installs its Python environment on first use.
 *
 * Control runs over the child's stdin/stdout as JSON lines (motiontracker
 * `service/src/mtservice/cli.py`): commands `avatar` / `camera` / `retarget` /
 * `preview` / `fps` / `history_shift` / `stop` in, events `ready` / `status` /
 * `retarget` / `settings` / `preview` / `error` / `stopped` out. Closing stdin stops it,
 * so it never outlives vspark. Pose data itself arrives over UDP at the
 * behavior's VMC receiver, not here.
 */

export type RuntimeState = 'starting' | 'running' | 'error' | 'stopped';

export interface RuntimeStatus {
  state: RuntimeState;
  /** Human-readable detail: an error, or what a slow start is doing. */
  message?: string;
  /** Frames per second the runtime processes (target 10). */
  fps?: number;
  /** Camera capture → bones sent, ms. */
  latencyMs?: number | null;
  /** MediaPipe detection time per frame, ms. */
  detectMs?: number;
  /** Learned model + conversion time per frame, ms. */
  modelMs?: number;
  /** Share of frames with a detected body (0..1). */
  present?: number;
  /** Model run name, from the runtime's `ready` event. */
  model?: string;
  /** Retargeting to the avatar's proportions, from the runtime's `retarget`
   *  event: requested, applied, and why it is requested but not applied. */
  retarget?: { enabled: boolean; active: boolean; reason: string | null };
  /** Frame rate and history shift in effect, from the runtime's `settings`
   *  event (historyShift null: the runtime has no merger model). */
  settings?: { fps: number; historyShift: HistoryShift | null };
}

/** History shift (motiontracker `mtcore.merged.HISTORY_SHIFTS`): experiment
 *  for 20 FPS, half a 10 FPS step older on every step but the newest
 *  ('every') or every second step ('alternate'). */
export type HistoryShift = 'none' | 'every' | 'alternate';

export interface RuntimeOptions {
  /** motiontracker checkout (contains `service/`). */
  runtimeDir: string;
  camera: number;
  /** UDP port the runtime sends VMC to (on 127.0.0.1). */
  port: number;
  /** Absolute path of the driven avatar's .vrm, or null for the runtime's default rest pose. */
  vrmPath: string | null;
  /** Retarget to the avatar's proportions instead of copying rotations (needs a
   *  VRM). Sent over stdin, at start too, so a runtime without the command only
   *  reports it as unknown instead of failing to start. */
  retarget: boolean;
  /** Frames the runtime processes per second (its default: 10). */
  fps: number;
  historyShift: HistoryShift;
}

/** Restart delays after an unexpected exit; the last one repeats. */
// Capped at 5 s (owner, 2026-11-23): while Learned Tracking is on, someone is
// usually waiting for it to come back, e.g. after replugging the camera.
const BACKOFF_MS = [2000, 5000];
/** A run this long resets the backoff. */
const STABLE_MS = 60000;

/** A motiontracker checkout: has the runtime package. */
export function isRuntimeDir(dir: string): boolean {
  return existsSync(join(dir, 'service', 'pyproject.toml'));
}

export type RuntimeSource =
  | 'env'
  | 'config'
  | 'download'
  | 'checkout'
  | 'missing';

/**
 * Where the motiontracker runtime is, and why there: env
 * `VSPARK_MOTIONTRACKER_PATH`, else config.json `learnedTracker.runtimePath`
 * (relative paths from the install dir), else the pinned runtime downloaded by
 * the behavior's "Download runtime" button (download.ts), else the nearest
 * `motiontracker` checkout beside the install dir or one of its parents (in dev
 * the install dir is packages/backend, so a checkout next to the vspark repo is
 * found too). Missing: where the download would go.
 */
export function learnedRuntimeLocation(): {
  dir: string;
  source: RuntimeSource;
} {
  const env = process.env.VSPARK_MOTIONTRACKER_PATH;
  if (env) return { dir: resolve(env), source: 'env' };
  const installDir = getInstallDir();
  try {
    const cfgPath =
      process.env.VSPARK_CONFIG_PATH ?? join(installDir, 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as {
      learnedTracker?: { runtimePath?: string };
    };
    const p = cfg.learnedTracker?.runtimePath;
    if (p) return { dir: resolve(installDir, p), source: 'config' };
  } catch {
    /* no config: search below */
  }
  if (isDownloaded())
    return { dir: downloadedRuntimeDir(), source: 'download' };
  for (let d = resolve(installDir); dirname(d) !== d; d = dirname(d)) {
    const candidate = join(dirname(d), 'motiontracker');
    if (isRuntimeDir(candidate)) return { dir: candidate, source: 'checkout' };
  }
  return { dir: downloadedRuntimeDir(), source: 'missing' };
}

export function learnedRuntimeDir(): string {
  return learnedRuntimeLocation().dir;
}

/** The command that starts the runtime (overridable for tests). */
export type CommandBuilder = (opts: RuntimeOptions) => {
  cmd: string;
  args: string[];
};

export const uvCommand: CommandBuilder = (o) => ({
  cmd: 'uv',
  args: [
    'run',
    '--project',
    join(o.runtimeDir, 'service'),
    'mtservice',
    '--stdio',
    '--camera',
    String(o.camera),
    '--vmc',
    `127.0.0.1:${o.port}`,
    ...(o.vrmPath ? ['--avatar-vrm', o.vrmPath] : []),
  ],
});

export class LearnedRuntime {
  private child: ChildProcess | null = null;
  private opts: RuntimeOptions | null = null;
  private stopping = false;
  /** Set when we ended the process to start it again with new options. */
  private restartRequested = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private startedAt = 0;
  private stderrTail: string[] = [];
  private status: RuntimeStatus = { state: 'stopped' };
  /** Camera preview the runtime should send (preview.ts); not a saved option. */
  private preview: PreviewWanted = { ...PREVIEW_OFF };
  /** Receives the runtime's `preview` events. */
  onPreview: ((ev: Record<string, unknown>) => void) | null = null;

  constructor(
    private readonly label: string,
    private readonly onStatus: (s: RuntimeStatus) => void,
    private readonly command: CommandBuilder = uvCommand,
    private readonly checkDir: (dir: string) => boolean = isRuntimeDir
  ) {}

  get current(): RuntimeStatus {
    return this.status;
  }

  /** Start, or apply changed options to the running process. Camera, avatar
   *  and retarget changes go over stdin; a new port or checkout restarts it. */
  apply(opts: RuntimeOptions): void {
    const prev = this.opts;
    this.opts = opts;
    this.stopping = false;
    if (!this.child) {
      if (!this.restartTimer) this.spawn();
      return;
    }
    if (
      !prev ||
      prev.port !== opts.port ||
      prev.runtimeDir !== opts.runtimeDir
    ) {
      this.restart();
      return;
    }
    if (prev.camera !== opts.camera)
      this.send({ cmd: 'camera', index: opts.camera });
    if (prev.vrmPath !== opts.vrmPath)
      this.send(
        opts.vrmPath
          ? { cmd: 'avatar', vrm_path: opts.vrmPath }
          : { cmd: 'avatar', rest_positions: null }
      );
    if (prev.retarget !== opts.retarget)
      this.send({ cmd: 'retarget', enabled: opts.retarget });
    if (prev.fps !== opts.fps) this.send({ cmd: 'fps', value: opts.fps });
    if (prev.historyShift !== opts.historyShift)
      this.send({ cmd: 'history_shift', mode: opts.historyShift });
  }

  /** Ask the runtime for picture and/or landmarks per frame (both false: none).
   *  Kept across restarts. */
  setPreview(want: PreviewWanted): void {
    if (
      want.image === this.preview.image &&
      want.landmarks === this.preview.landmarks
    )
      return;
    this.preview = { image: want.image, landmarks: want.landmarks };
    this.send({ cmd: 'preview', ...this.preview });
  }

  stop(): void {
    this.stopping = true;
    this.opts = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.terminate();
    this.setStatus({ state: 'stopped' });
  }

  /** Restart by hand (the behavior's Restart button): a fresh process, also
   *  when one is running, and at once when a retry after a crash is pending.
   *  A runtime stuck waiting on a camera that sends nothing doesn't read its
   *  stop command, so it ends by SIGTERM after 3 s. False when not started. */
  restartNow(): boolean {
    if (!this.opts || this.stopping) return false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.attempt = 0;
    this.restart();
    return true;
  }

  private restart(): void {
    if (!this.child) return this.spawn();
    // The exit handler spawns again once the old process is gone.
    this.restartRequested = true;
    this.terminate();
  }

  private terminate(): void {
    const child = this.child;
    if (!child) return;
    this.send({ cmd: 'stop' });
    child.stdin?.end();
    // Closing stdin makes the runtime exit by itself; signals only if it hangs.
    this.killTimer = setTimeout(() => {
      child.kill('SIGTERM');
      this.killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
    }, 3000);
  }

  private send(cmd: Record<string, unknown>): void {
    if (this.child?.stdin?.writable)
      this.child.stdin.write(JSON.stringify(cmd) + '\n');
  }

  private setStatus(s: RuntimeStatus): void {
    this.status = s;
    this.onStatus(s);
  }

  private spawn(): void {
    this.restartTimer = null;
    const opts = this.opts;
    if (!opts || this.stopping) return;
    if (!this.checkDir(opts.runtimeDir)) {
      this.setStatus({
        state: 'error',
        message: `motiontracker runtime not found at ${opts.runtimeDir}: download it in the behavior's properties (or set learnedTracker.runtimePath in config.json)`,
      });
      return;
    }
    const { cmd, args } = this.command(opts);
    this.stderrTail = [];
    this.startedAt = Date.now();
    this.setStatus({
      state: 'starting',
      message:
        this.attempt === 0
          ? 'Starting (the first start installs the runtime and can take a few minutes)'
          : `Restarting (attempt ${this.attempt + 1})`,
    });
    console.log(`[LearnedTracker] ${this.label}: ${cmd} ${args.join(' ')}`);
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.setStatus({ state: 'error', message: (err as Error).message });
      return;
    }
    this.child = child;
    // Read once the runtime is up (stdin is queued until then); off is its default.
    if (opts.retarget) this.send({ cmd: 'retarget', enabled: true });
    // The runtime's defaults are 10 FPS and no shift; anything else goes over
    // stdin too, so an older runtime only reports an unknown command.
    if (opts.fps !== 10) this.send({ cmd: 'fps', value: opts.fps });
    if (opts.historyShift !== 'none')
      this.send({ cmd: 'history_shift', mode: opts.historyShift });
    if (this.preview.image || this.preview.landmarks)
      this.send({ cmd: 'preview', ...this.preview });
    let buf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.onLine(line);
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
        // The runtime's own log lines; MediaPipe's native logging stays quiet.
        if (line.startsWith('[mtservice]'))
          console.log(`[LearnedTracker] ${this.label}: ${line}`);
      }
    });
    child.on('error', (err) => {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      this.setStatus({
        state: 'error',
        message: missing
          ? `'${cmd}' not found: install uv (https://docs.astral.sh/uv/) to use Learned Tracking`
          : err.message,
      });
      // A failed spawn may not emit 'exit'; retry like a crash (onExit runs once per child).
      this.onExit(child, null, null);
    });
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
  }

  private onLine(line: string): void {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // not ours
    }
    switch (ev.event) {
      case 'ready': {
        const model = (ev.model as { run?: string } | undefined)?.run;
        this.setStatus({ state: 'running', model });
        break;
      }
      case 'status':
        this.setStatus({
          ...this.status,
          state: 'running',
          message: undefined,
          fps: ev.fps as number,
          latencyMs: ev.latency_ms as number | null,
          detectMs: ev.detect_ms as number,
          modelMs: ev.model_ms as number,
          present: ev.present as number,
        });
        break;
      case 'preview':
        this.onPreview?.(ev);
        break;
      case 'settings':
        this.setStatus({
          ...this.status,
          settings: {
            fps: Number(ev.fps),
            historyShift: (ev.history_shift as HistoryShift | null) ?? null,
          },
        });
        break;
      case 'retarget':
        this.setStatus({
          ...this.status,
          retarget: {
            enabled: !!ev.enabled,
            active: !!ev.active,
            reason: (ev.reason as string | null) ?? null,
          },
        });
        break;
      case 'error':
        console.warn(`[LearnedTracker] ${this.label}: ${String(ev.message)}`);
        this.setStatus({ ...this.status, message: String(ev.message) });
        break;
    }
  }

  private onExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
    if (this.child !== child) return;
    this.child = null;
    if (this.stopping || !this.opts) return;
    if (this.restartRequested) {
      this.restartRequested = false;
      this.attempt = 0;
      this.spawn();
      return;
    }
    if (Date.now() - this.startedAt > STABLE_MS) this.attempt = 0;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    // MediaPipe's native log lines (W0000 / I0000 …) say nothing about the failure.
    const tail = this.stderrTail
      .filter((l) => !/^[WI]\d{4} /.test(l))
      .slice(-3)
      .join(' | ');
    this.setStatus({
      state: 'error',
      message:
        this.status.state === 'error' && this.status.message
          ? this.status.message
          : `Runtime exited (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ''}; retrying in ${Math.round(delay / 1000)} s`,
    });
    this.restartTimer = setTimeout(() => this.spawn(), delay);
  }
}
