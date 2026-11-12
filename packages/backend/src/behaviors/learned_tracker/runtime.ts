import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { getInstallDir } from '../../routes/update.js';

/**
 * The Learned Tracking runtime: motiontracker's `mtservice` (camera → MediaPipe
 * Holistic → learned body model → VRM bones as VMC over UDP), run as a child
 * process. It is not bundled with vspark: it is started with `uv` from a local
 * motiontracker checkout, so `uv` installs its Python environment on first use.
 *
 * Control runs over the child's stdin/stdout as JSON lines (motiontracker
 * `service/src/mtservice/cli.py`): commands `avatar` / `camera` / `stop` in,
 * events `ready` / `status` / `error` / `stopped` out. Closing stdin stops it,
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
}

export interface RuntimeOptions {
  /** motiontracker checkout (contains `service/`). */
  runtimeDir: string;
  camera: number;
  /** UDP port the runtime sends VMC to (on 127.0.0.1). */
  port: number;
  /** Absolute path of the driven avatar's .vrm, or null for the runtime's default rest pose. */
  vrmPath: string | null;
}

/** Restart delays after an unexpected exit; the last one repeats. */
const BACKOFF_MS = [2000, 5000, 10000, 30000];
/** A run this long resets the backoff. */
const STABLE_MS = 60000;

/** A motiontracker checkout: has the runtime package. */
export function isRuntimeDir(dir: string): boolean {
  return existsSync(join(dir, 'service', 'pyproject.toml'));
}

/**
 * Where the motiontracker checkout is: env `VSPARK_MOTIONTRACKER_PATH`, else
 * config.json `learnedTracker.runtimePath` (relative paths from the install
 * dir), else the nearest `motiontracker` folder beside the install dir or one
 * of its parents (in dev the install dir is packages/backend, so a checkout
 * next to the vspark repo is found too).
 */
export function learnedRuntimeDir(): string {
  const env = process.env.VSPARK_MOTIONTRACKER_PATH;
  if (env) return resolve(env);
  const installDir = getInstallDir();
  try {
    const cfgPath =
      process.env.VSPARK_CONFIG_PATH ?? join(installDir, 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as {
      learnedTracker?: { runtimePath?: string };
    };
    const p = cfg.learnedTracker?.runtimePath;
    if (p) return resolve(installDir, p);
  } catch {
    /* no config: search below */
  }
  for (let d = resolve(installDir); dirname(d) !== d; d = dirname(d)) {
    const candidate = join(dirname(d), 'motiontracker');
    if (isRuntimeDir(candidate)) return candidate;
  }
  return resolve(installDir, '..', 'motiontracker');
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

  constructor(
    private readonly label: string,
    private readonly onStatus: (s: RuntimeStatus) => void,
    private readonly command: CommandBuilder = uvCommand,
    private readonly checkDir: (dir: string) => boolean = isRuntimeDir
  ) {}

  get current(): RuntimeStatus {
    return this.status;
  }

  /** Start, or apply changed options to the running process. Camera and
   *  avatar changes go over stdin; a new port or checkout restarts it. */
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
  }

  stop(): void {
    this.stopping = true;
    this.opts = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.terminate();
    this.setStatus({ state: 'stopped' });
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
        message: `motiontracker runtime not found at ${opts.runtimeDir} (set learnedTracker.runtimePath in config.json)`,
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
