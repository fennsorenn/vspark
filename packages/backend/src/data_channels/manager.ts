/**
 * Data-channel bus.
 *
 * A NEW sibling of the runtime-override bus (see runtime_overrides/manager.ts).
 * It reuses the same WS + snapshot-on-connect shape, but instead of coercing a
 * scalar onto a registered paramPath of a specific (targetKind, targetId), it
 * carries an ARBITRARY structured payload keyed by a free-form channel name.
 *
 * This is the generic, data-shape-agnostic half of Phase 3: the chat overlay is
 * the first producer, but `set_data → data channel → feed layer` works for any
 * payload (alert tickers, event logs, scoreboards, poll results, …). The bus
 * never inspects the payload.
 *
 * Scoping: channels are scene-scoped (decision 6). A producer that can't resolve
 * a scene publishes to the GLOBAL bucket `'*'`; the frontend feed layer reads
 * its own scene first and falls back to `'*'`, so single-scene projects work
 * with zero configuration while multi-scene projects can disambiguate by wiring
 * an explicit scene id on `set_data`.
 *
 * Volume: whole-payload republish per `set` (decision 8 — no diffing/debounce).
 * Fine for chat rates; documented in dev-notes/modules/data-channels.md.
 *
 * See dev-notes/modules/data-channels.md.
 */
import type { WSSync } from '../ws/index.js';

/** The global / scene-agnostic bucket key. */
export const GLOBAL_SCENE = '*';

interface SnapshotEntry {
  sceneId: string;
  channel: string;
  payload: unknown;
}

export class DataChannelManager {
  private _ws: WSSync | null = null;

  /** sceneId → channelName → latest payload */
  private readonly _bySceneId = new Map<string, Map<string, unknown>>();

  init(ws: WSSync): void {
    this._ws = ws;
  }

  /** Publish (or replace) the payload on a named channel within a scene. The
   *  whole payload is rebroadcast — consumers replace their held value. */
  set(sceneId: string, channel: string, payload: unknown): void {
    const scene = sceneId || GLOBAL_SCENE;
    if (!channel) return;
    let chans = this._bySceneId.get(scene);
    if (!chans) {
      chans = new Map();
      this._bySceneId.set(scene, chans);
    }
    chans.set(channel, payload);
    this._ws?.broadcast('data_channel_set', {
      sceneId: scene,
      channel,
      payload,
    });
  }

  /** Clear a single channel within a scene. No-op if nothing is set. */
  clear(sceneId: string, channel: string): void {
    const scene = sceneId || GLOBAL_SCENE;
    const chans = this._bySceneId.get(scene);
    if (!chans || !chans.delete(channel)) return;
    if (chans.size === 0) this._bySceneId.delete(scene);
    this._ws?.broadcast('data_channel_clear', { sceneId: scene, channel });
  }

  /** Drop every channel owned by a scene (producer teardown). */
  clearAllForScene(sceneId: string): void {
    const scene = sceneId || GLOBAL_SCENE;
    const chans = this._bySceneId.get(scene);
    if (!chans) return;
    for (const channel of Array.from(chans.keys())) {
      this._ws?.broadcast('data_channel_clear', { sceneId: scene, channel });
    }
    this._bySceneId.delete(scene);
  }

  /** Send the full snapshot to a freshly-connected WS client (single message,
   *  mirrors the runtime-override snapshot pattern). */
  sendSnapshotTo(
    send: (kind: string, payload: Record<string, unknown>) => void
  ): void {
    const entries: SnapshotEntry[] = [];
    for (const [sceneId, chans] of this._bySceneId) {
      for (const [channel, payload] of chans) {
        entries.push({ sceneId, channel, payload });
      }
    }
    send('data_channel_snapshot', { entries });
  }
}

// Singleton — wired in src/index.ts like the other managers.
export const dataChannelManager = new DataChannelManager();
