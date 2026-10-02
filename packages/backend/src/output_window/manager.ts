// OBS window-capture output: keeps one off-screen Electron window per compose
// scene with `config.obsWindowCapture === true`, for as long as the server runs.
// OBS Browser Sources share one Chromium GPU process whose offscreen frame
// hand-off starves under an uncapped fullscreen game; a normal window captured
// with OBS Window Capture does not (see dev-notes/plans/obs-output-window.md).
//
// All windows live in a single Electron child process (packages/output-window),
// driven over the Node IPC channel with the full desired window set per message.
import { spawn } from 'node:child_process';
import { obsOutputWindowTitle } from '@vspark/shared';
import type { RuntimePaths } from './runtime.js';

export interface ComposeSceneDoc {
  id: string;
  projectId: string;
  kind: string;
  name: string;
  width: number;
  height: number;
  config?: Record<string, unknown>;
}

export interface OutputWindowSpec {
  id: string;
  url: string;
  width: number;
  height: number;
  title: string;
}

/** Minimal surface of a spawned child process the manager relies on. */
export interface OutputProcess {
  send(msg: { windows: OutputWindowSpec[] }): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export type OutputLauncher = () => OutputProcess;

export function desiredWindows(
  docs: readonly ComposeSceneDoc[],
  viewerOrigin: string
): OutputWindowSpec[] {
  return docs
    .filter((d) => d.kind === 'compose_scene' && d.config?.obsWindowCapture === true)
    .map((d) => ({
      id: d.id,
      url: `${viewerOrigin}/viewer/${d.projectId}/compose/${d.id}?output=window`,
      width: Math.max(1, Math.round(d.width || 1920)),
      height: Math.max(1, Math.round(d.height || 1080)),
      title: obsOutputWindowTitle(d.name),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const MAX_RESTART_MS = 30_000;
const RETRY_AFTER_ERROR_MS = 30_000;

/** Runtime state, broadcast to editors as `output_window_status`. */
export type OutputRuntimeStatus =
  | { state: 'idle' }
  | { state: 'downloading'; progress: number }
  | { state: 'ready' }
  | { state: 'error'; message: string }
  | { state: 'unavailable' };

export class OutputWindowManager {
  private desired: OutputWindowSpec[] = [];
  private lastSent = '';
  private proc: OutputProcess | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartDelay: number;
  private stopped = false;
  private launcher: OutputLauncher | null;
  private preparing = false;
  private failedAt = 0;
  private _status: OutputRuntimeStatus;

  constructor(
    private readonly opts: {
      viewerOrigin: string;
      /** Ready-to-use launcher (running from source, tests). */
      launcher?: OutputLauncher | null;
      /**
       * Makes a launcher available on first need — e.g. downloads the Electron
       * runtime in the packaged release. Retried on the next scene change after
       * a failure.
       */
      prepareLauncher?: (onProgress: (fraction: number) => void) => Promise<OutputLauncher>;
      onStatus?: (status: OutputRuntimeStatus) => void;
      log?: (msg: string) => void;
      restartDelayMs?: number;
    }
  ) {
    this.restartDelay = opts.restartDelayMs ?? 1000;
    this.launcher = opts.launcher ?? null;
    this._status = this.launcher ? { state: 'ready' } : { state: 'idle' };
  }

  private log(msg: string): void {
    (this.opts.log ?? console.log)(`[OutputWindows] ${msg}`);
  }

  get status(): OutputRuntimeStatus {
    return this._status;
  }

  private setStatus(s: OutputRuntimeStatus): void {
    if (JSON.stringify(s) === JSON.stringify(this._status)) return;
    this._status = s;
    this.opts.onStatus?.(s);
  }

  /** Obtain a launcher, preparing the runtime if needed. False while not (yet) possible. */
  private ensureLauncher(): boolean {
    if (this.launcher) return true;
    if (!this.opts.prepareLauncher) {
      if (this._status.state !== 'unavailable') {
        this.log(
          'OBS window capture is enabled for a compose scene, but the output-window runtime (Electron) is not available in this install.'
        );
        this.setStatus({ state: 'unavailable' });
      }
      return false;
    }
    if (this.preparing) return false;
    // After a failure, retry on a later scene change — but not more than every 30 s.
    if (this._status.state === 'error' && Date.now() - this.failedAt < RETRY_AFTER_ERROR_MS) {
      return false;
    }
    this.preparing = true;
    // Status turns 'downloading' only once bytes arrive — a cached runtime
    // goes straight to 'ready' without flashing a download in the editor.
    this.log('preparing the output-window runtime');
    this.opts
      .prepareLauncher((fraction) =>
        this.setStatus({ state: 'downloading', progress: Math.round(fraction * 100) })
      )
      .then((launcher) => {
        this.preparing = false;
        this.launcher = launcher;
        this.setStatus({ state: 'ready' });
        this.log('output-window runtime ready');
        this.apply();
      })
      .catch((e: Error) => {
        this.preparing = false;
        this.failedAt = Date.now();
        this.setStatus({ state: 'error', message: e.message });
        this.log(`output-window runtime unavailable: ${e.message}`);
      });
    return false;
  }

  /** Replace the known compose scenes; opens/updates/closes windows to match. */
  setScenes(docs: readonly ComposeSceneDoc[]): void {
    this.desired = desiredWindows(docs, this.opts.viewerOrigin);
    this.apply();
  }

  get windows(): readonly OutputWindowSpec[] {
    return this.desired;
  }

  private apply(): void {
    if (this.stopped) return;
    if (this.desired.length === 0) {
      this.killProcess();
      return;
    }
    if (!this.proc && !this.ensureProcess()) return;
    const key = JSON.stringify(this.desired);
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.proc?.send({ windows: this.desired });
  }

  private ensureProcess(): boolean {
    if (this.restartTimer) return false; // a restart is already scheduled
    if (!this.ensureLauncher() || !this.launcher) return false;
    let proc: OutputProcess;
    try {
      proc = this.launcher();
    } catch (e) {
      this.log(`failed to start output windows: ${(e as Error).message}`);
      this.scheduleRestart();
      return false;
    }
    this.proc = proc;
    this.lastSent = '';
    proc.onExit((code) => {
      if (this.proc !== proc) return; // superseded or deliberately killed
      this.proc = null;
      if (this.stopped || this.desired.length === 0) return;
      this.log(`output-window process exited (code ${code}); restarting`);
      this.scheduleRestart();
    });
    return true;
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopped) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, MAX_RESTART_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.apply();
    }, delay);
  }

  private killProcess(): void {
    const proc = this.proc;
    this.proc = null;
    this.lastSent = '';
    proc?.kill();
  }

  /** Close every window and stop restarting. Safe to call from an exit handler. */
  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.killProcess();
  }
}

/** Launcher that spawns the Electron output-window process from resolved paths. */
export function createElectronLauncher(
  { electronPath, mainScript }: RuntimePaths,
  log: (msg: string) => void = console.log
): OutputLauncher {
  return () => {
    // IPC, not stdin: Electron's main process reads EOF from stdin on Windows.
    const child = spawn(electronPath, [mainScript], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    child.stdout?.on('data', (d: Buffer) => log(String(d).trimEnd()));
    child.stderr?.on('data', () => {}); // Chromium noise; drain so the pipe never blocks
    child.on('error', (e) => log(`[OutputWindows] output-window process error: ${e.message}`));
    return {
      send: (msg) => {
        if (child.connected) child.send(msg);
      },
      onExit: (cb) => {
        child.on('exit', (code) => cb(code));
      },
      kill: () => {
        if (child.connected) child.disconnect();
        child.kill();
      },
    };
  };
}
