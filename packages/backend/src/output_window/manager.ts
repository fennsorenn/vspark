// OBS window-capture output: keeps one off-screen Electron window per compose
// scene with `config.obsWindowCapture === true`, for as long as the server runs.
// OBS Browser Sources share one Chromium GPU process whose offscreen frame
// hand-off starves under an uncapped fullscreen game; a normal window captured
// with OBS Window Capture does not (see dev-notes/plans/obs-output-window.md).
//
// All windows live in a single Electron child process (packages/output-window),
// driven over the Node IPC channel with the full desired window set per message.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { obsOutputWindowTitle } from '@vspark/shared';

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

export class OutputWindowManager {
  private desired: OutputWindowSpec[] = [];
  private lastSent = '';
  private proc: OutputProcess | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartDelay: number;
  private stopped = false;
  private warnedUnavailable = false;

  constructor(
    private readonly opts: {
      viewerOrigin: string;
      launcher: OutputLauncher | null;
      log?: (msg: string) => void;
      restartDelayMs?: number;
    }
  ) {
    this.restartDelay = opts.restartDelayMs ?? 1000;
  }

  private log(msg: string): void {
    (this.opts.log ?? console.log)(`[OutputWindows] ${msg}`);
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
    if (!this.opts.launcher) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.log(
          'OBS window capture is enabled for a compose scene, but the output-window runtime (Electron) is not available in this install.'
        );
      }
      return false;
    }
    let proc: OutputProcess;
    try {
      proc = this.opts.launcher();
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

/**
 * Launcher for the Electron output-window process, or null when the runtime is
 * not installed (e.g. the packaged release, which does not ship Electron yet).
 */
export function createElectronLauncher(
  log: (msg: string) => void = console.log
): OutputLauncher | null {
  let electronPath: string;
  let mainScript: string;
  try {
    const require = createRequire(import.meta.url);
    ({ electronPath, mainScript } = require('@vspark/output-window') as {
      electronPath: string;
      mainScript: string;
    });
  } catch {
    return null;
  }
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
