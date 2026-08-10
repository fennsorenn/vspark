/**
 * Provider A — server-managed browser capture agent.
 *
 * Spawns an already-installed Chromium-family browser pointed at the existing
 * `/media-input/:projectId` page in agent mode. The page captures exactly as it does for
 * a human user and uplinks over the normal WebSocket, so **there is no second tracking
 * implementation to maintain** — that is this provider's whole appeal.
 *
 * Deliberately NOT headless. Headless is the ideal Windows EcoQoS target: no window, no
 * focus, ever. Instead the window is real but parked far offscreen, with Chromium's own
 * backgrounding heuristics disabled. That is a materially different scheduling class from
 * OBS's `obs-browser-page.exe`, which is backgrounded by construction and loses ~80%
 * throughput when OBS loses focus (obsproject/obs-studio#12982).
 *
 * Note `--disable-features=UseEcoQoSForBackgroundProcess` is deliberately absent: recent
 * Chromium removed/ignores it, so it would be cargo cult. Not being backgrounded in the
 * first place is the actual lever, plus a raised priority on the process we spawn.
 *
 * No new runtime dependency: the page dials home over the existing WebSocket, so a plain
 * `spawn` is enough — no puppeteer, no Playwright, no bundled Chromium.
 */

import { spawn, type ChildProcess } from 'child_process';
import { accessSync, constants, mkdirSync } from 'fs';
import os from 'os';
import { join } from 'path';
import type {
  CaptureDevice,
  CaptureKind,
  CaptureProvider,
  CaptureProviderStatus,
  CaptureRequest,
} from '../types.js';

/** Candidate browser binaries, best first. Edge is on every Windows box, so this
 *  effectively needs no setup there. */
const WINDOWS_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files\\Chromium\\Application\\chrome.exe',
];

const POSIX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/brave-browser',
  '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

function findBrowser(): string | null {
  const fromEnv = process.env.VSPARK_CAPTURE_BROWSER;
  const candidates = fromEnv
    ? [fromEnv]
    : process.platform === 'win32'
      ? WINDOWS_CANDIDATES
      : POSIX_CANDIDATES;
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* next */
    }
  }
  return null;
}

interface Assignment {
  behaviorId: string;
  projectId: string;
  kind: CaptureKind;
  deviceId?: string;
}

interface Agent {
  projectId: string;
  child: ChildProcess;
  /** The URL this agent was launched with — also its assignment-set signature, since the
   *  assignments are encoded in the query string. */
  url: string;
  restarts: number;
  stopping: boolean;
}

/** Devices reported by an agent page after it calls enumerateDevices(). */
let reportedDevices: CaptureDevice[] = [];

/** Called by the capture route when an agent page posts its device list. */
export function setReportedDevices(devices: CaptureDevice[]): void {
  reportedDevices = devices;
}

export class BrowserAgentProvider implements CaptureProvider {
  readonly id = 'browser_agent' as const;
  readonly kinds: CaptureKind[] = ['tracking', 'lipsync'];

  private readonly assignments = new Map<string, Assignment>();
  private readonly agents = new Map<string, Agent>();
  private lastError: string | null = null;

  constructor(
    private readonly opts: {
      /** HTTP port the server listens on — the agent navigates to localhost:<port>. */
      port: number;
      /** Directory for the persistent browser profile (so permissions stick forever). */
      profileRoot: string;
    }
  ) {}

  async probe(): Promise<{ available: boolean; detail: string | null }> {
    const bin = findBrowser();
    if (!bin)
      return {
        available: false,
        detail:
          'no Chromium-family browser found (set VSPARK_CAPTURE_BROWSER to override)',
      };
    return { available: true, detail: bin };
  }

  async start(req: CaptureRequest): Promise<void> {
    this.assignments.set(req.behaviorId, {
      behaviorId: req.behaviorId,
      projectId: req.projectId,
      kind: req.kind,
      deviceId: req.deviceId,
    });
    await this.reconcileProject(req.projectId);
  }

  async stop(behaviorId: string): Promise<void> {
    const a = this.assignments.get(behaviorId);
    if (!a) return;
    this.assignments.delete(behaviorId);
    await this.reconcileProject(a.projectId);
  }

  /**
   * One agent window per project, serving every server-sourced behaviour in it — which is
   * what a user would actually run, and avoids paying for a second ~300 MB browser.
   * The assignment set is baked into the URL, so a change means relaunching that agent.
   */
  private async reconcileProject(projectId: string): Promise<void> {
    const mine = [...this.assignments.values()].filter(
      (a) => a.projectId === projectId
    );
    const existing = this.agents.get(projectId);

    if (mine.length === 0) {
      if (existing) await this.killAgent(projectId);
      return;
    }

    const url = this.agentUrl(projectId, mine);
    if (existing && existing.url === url && !existing.child.killed) return;
    if (existing) await this.killAgent(projectId);
    this.launch(projectId, url);
  }

  private agentUrl(projectId: string, assignments: Assignment[]): string {
    const params = new URLSearchParams({ agent: '1' });
    for (const a of assignments) {
      params.set(a.kind, a.behaviorId);
      if (a.deviceId) params.set(`${a.kind}Device`, a.deviceId);
    }
    return `http://localhost:${this.opts.port}/media-input/${projectId}?${params}`;
  }

  private launch(projectId: string, url: string): void {
    const bin = findBrowser();
    if (!bin) throw new Error('no Chromium-family browser found');

    const profileDir = join(this.opts.profileRoot, `agent-${projectId}`);
    mkdirSync(profileDir, { recursive: true });

    const args = [
      `--user-data-dir=${profileDir}`,
      // Auto-grant camera/mic. Combined with the persistent profile above, this is what
      // removes the per-session permission dance that motivated the whole feature.
      '--use-fake-ui-for-media-stream',
      // Real window, parked offscreen — see the file header for why not --headless.
      '--window-position=-32000,-32000',
      '--window-size=480,360',
      // Keep Chromium from demoting its own renderer once the window isn't visible.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      `--app=${url}`,
    ];

    const child = spawn(bin, args, {
      // Not detached: the agent must die with the server, never outlive it holding the
      // camera open.
      detached: false,
      stdio: 'ignore',
    });

    child.on('exit', (code) => {
      const agent = this.agents.get(projectId);
      if (!agent || agent.child !== child) return;
      if (agent.stopping) return;
      // Unexpected exit — the page crashed or the user closed it. Relaunch, with a cap so
      // a permanently broken browser doesn't spin.
      if (agent.restarts < 5) {
        console.warn(
          `[capture/browser_agent] agent for ${projectId} exited (${code}); restarting`
        );
        agent.restarts++;
        this.relaunch(agent, projectId);
      } else {
        this.lastError = `agent for ${projectId} exited repeatedly (last code ${code})`;
        console.error(`[capture/browser_agent] ${this.lastError}`);
        this.agents.delete(projectId);
      }
    });

    this.agents.set(projectId, {
      projectId,
      child,
      url,
      restarts: 0,
      stopping: false,
    });
    this.raisePriority(child);
    console.log(`[capture/browser_agent] launched ${bin} for project ${projectId}`);
  }

  /** Relaunch in place, preserving the restart counter so the cap still applies. */
  private relaunch(agent: Agent, projectId: string): void {
    this.agents.delete(projectId);
    try {
      this.launch(projectId, agent.url);
      const fresh = this.agents.get(projectId);
      if (fresh) fresh.restarts = agent.restarts;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Best-effort priority bump. This only reaches the process we spawned — Chromium
   * self-demotes its renderer children internally, which is precisely the asymmetry that
   * makes the node_inference provider worth comparing against.
   */
  private raisePriority(child: ChildProcess): void {
    if (!child.pid) return;
    try {
      os.setPriority(child.pid, -5);
    } catch (e) {
      console.warn(
        `[capture/browser_agent] could not raise priority (needs elevation on some systems): ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }

  private async killAgent(projectId: string): Promise<void> {
    const agent = this.agents.get(projectId);
    if (!agent) return;
    agent.stopping = true;
    this.agents.delete(projectId);
    try {
      agent.child.kill();
    } catch {
      /* already gone */
    }
  }

  async listDevices(): Promise<CaptureDevice[]> {
    // Device enumeration comes from a running agent page rather than from platform APIs:
    // the page's enumerateDevices() already returns labelled devices (the profile has a
    // standing permission grant), so there is no per-OS device code to write or maintain.
    return reportedDevices;
  }

  status(): CaptureProviderStatus {
    return {
      id: this.id,
      available: true,
      detail: this.lastError,
      running: [...this.assignments.keys()],
    };
  }

  async close(): Promise<void> {
    for (const projectId of [...this.agents.keys()]) await this.killAgent(projectId);
    this.assignments.clear();
  }
}
