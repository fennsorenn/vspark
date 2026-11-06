/**
 * HotkeyManager — installs a single system-wide keyboard hook and routes
 * matching key presses into `system_hotkey` nodes across every running logic
 * graph.
 *
 * Responsibilities:
 *  - Lazily start an OS-level global keyboard listener (via the optional
 *    `node-global-key-listener` dependency) the first time a `system_hotkey`
 *    node appears in any running graph, and stop it once none remain.
 *  - On each key-DOWN, walk every running graph and fire the `event` port of
 *    any `system_hotkey` node whose configured key + modifiers match the
 *    keystroke. Mirrors OverliveManager.routeEvent — per-node config filters
 *    are evaluated here, the node body just reacts.
 *
 * The dependency ships per-platform server binaries and needs OS-level access
 * (low-level hooks on Windows, Event Taps on macOS, an X server on Linux). It
 * is loaded with a guarded dynamic import: if the package is unavailable, the
 * platform is unsupported, or the hook can't be installed (e.g. a headless
 * server), the manager logs once and degrades gracefully — the rest of vspark
 * is unaffected and `system_hotkey` nodes simply never fire.
 *
 * Like overlive routing, this assumes a single trusted local user: a global
 * keyboard hook observes every keystroke on the machine while active.
 */
import { mkEvent } from '@vspark/shared/signal';
import { logicManager } from '../logic/manager.js';
import type { HotkeyEventPayload } from '../signal/nodes/system_hotkey.js';

const HOTKEY_KIND = 'system_hotkey';

/** Minimal shape of the bits of `node-global-key-listener` we depend on. */
interface GlobalKeyEvent {
  name?: string;
  state: 'DOWN' | 'UP';
}
type GlobalKeyDownMap = Record<string, boolean | undefined>;
interface GlobalKeyboardListener {
  addListener(
    cb: (e: GlobalKeyEvent, down: GlobalKeyDownMap) => void
  ): Promise<void> | void;
  kill(): void;
}

function modifierHeld(
  down: GlobalKeyDownMap,
  left: string,
  right: string
): boolean {
  return down[left] === true || down[right] === true;
}

export class HotkeyManager {
  private listener: GlobalKeyboardListener | null = null;
  /** Promise guard so concurrent ensureRunning calls share one startup. */
  private starting: Promise<void> | null = null;
  /** Once we've failed to load/start, don't keep retrying every sync(). */
  private failed = false;
  /** Key names currently held — debounces OS auto-repeat to one fire/press. */
  private readonly heldKeys = new Set<string>();

  /**
   * Re-evaluate whether the global hook should be running. Started lazily the
   * first time a `system_hotkey` node exists; stopped once none remain.
   * Wired to LogicManager reconciles so runtime graph edits are picked up.
   */
  sync(): void {
    const wanted = this.hasHotkeyNode();
    if (wanted && !this.listener && !this.starting && !this.failed) {
      void this.start();
    } else if (!wanted && this.listener) {
      this.stop();
    }
  }

  /** Tear the hook down (server shutdown). */
  close(): void {
    this.stop();
  }

  private hasHotkeyNode(): boolean {
    for (const { node } of logicManager.iterateNodes()) {
      if (node.kind === HOTKEY_KIND) return true;
    }
    return false;
  }

  private async start(): Promise<void> {
    if (this.listener || this.starting) return;
    this.starting = (async () => {
      try {
        // Optional dependency — kept out of the bundle (see bundle.mjs) and
        // loaded lazily so an absent package / unsupported platform degrades
        // gracefully instead of crashing the server.
        const mod = (await import('node-global-key-listener')) as {
          GlobalKeyboardListener: new () => GlobalKeyboardListener;
        };
        const listener = new mod.GlobalKeyboardListener();
        await listener.addListener((e, down) => this.onKey(e, down));
        this.listener = listener;
        console.log('[Hotkeys] Global keyboard hook installed.');
      } catch (err) {
        this.failed = true;
        console.warn(
          '[Hotkeys] System-wide hotkeys unavailable — global keyboard hook could not be installed. ' +
            'system_hotkey nodes will not fire. Reason:',
          err instanceof Error ? err.message : err
        );
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  private stop(): void {
    this.heldKeys.clear();
    if (!this.listener) return;
    try {
      this.listener.kill();
    } catch {
      /* best-effort */
    }
    this.listener = null;
    console.log('[Hotkeys] Global keyboard hook removed.');
  }

  private onKey(e: GlobalKeyEvent, down: GlobalKeyDownMap): void {
    const name = (e.name ?? '').toUpperCase();
    if (!name) return;

    if (e.state === 'UP') {
      this.heldKeys.delete(name);
      return;
    }
    if (e.state !== 'DOWN') return;
    // OS hooks repeat DOWN while a key is held — fire only on the press edge.
    if (this.heldKeys.has(name)) return;
    this.heldKeys.add(name);

    const payload: HotkeyEventPayload = {
      key: name,
      ctrl: modifierHeld(down, 'LEFT CTRL', 'RIGHT CTRL'),
      shift: modifierHeld(down, 'LEFT SHIFT', 'RIGHT SHIFT'),
      alt: modifierHeld(down, 'LEFT ALT', 'RIGHT ALT'),
      meta: modifierHeld(down, 'LEFT META', 'RIGHT META'),
    };
    this.dispatch(payload);
  }

  /** Fire the keystroke into every matching system_hotkey node. */
  private dispatch(payload: HotkeyEventPayload): void {
    for (const { graphId, node } of logicManager.iterateNodes()) {
      if (node.kind !== HOTKEY_KIND) continue;
      const cfg = (node.defaultConfig ?? {}) as Record<string, unknown>;
      if (!nodeMatches(cfg, payload)) continue;
      logicManager.fire(graphId, node.id, 'event', mkEvent(payload));
    }
  }
}

/**
 * Does a hotkey node's config match the keystroke? Exact match on the key name
 * and on each of the four modifiers (so Ctrl+S doesn't fire on Ctrl+Shift+S).
 * An empty `key` config never matches. Exported for unit testing.
 */
export function nodeMatches(
  cfg: Record<string, unknown>,
  payload: HotkeyEventPayload
): boolean {
  const wantKey =
    typeof cfg['key'] === 'string' ? cfg['key'].trim().toUpperCase() : '';
  if (!wantKey || wantKey !== payload.key) return false;
  return (
    Boolean(cfg['ctrl']) === payload.ctrl &&
    Boolean(cfg['shift']) === payload.shift &&
    Boolean(cfg['alt']) === payload.alt &&
    Boolean(cfg['meta']) === payload.meta
  );
}

export const hotkeyManager = new HotkeyManager();
