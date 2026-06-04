/**
 * Data-channel bus.
 *
 * A generic sibling of the runtime-override bus (runtime_overrides/manager.ts).
 * Where the override bus carries scalar param writes keyed by
 * (targetKind, targetId, paramPath), this bus carries **arbitrary structured
 * payloads** keyed by a free-form channel name. It is the publish surface used
 * by the generic `set_data` signal node to push data out to the frontend, which
 * renders it through a data-shape-independent template (`feed` compose layer).
 *
 * Addressing is by channel NAME only. The motivating producer
 * (overlive_chat_feed → set_data) is driven by the OverliveManager, which fires
 * into project-scoped graphs that have no scene context, so there is no sceneId
 * to scope by at the bus. "Scene-scoping" is handled naturally on the frontend:
 * a feed layer only mounts (and therefore only renders channel data) when its
 * compose scene is the one being shown. Channel names are the user's
 * responsibility to keep unambiguous.
 *
 * Whole-payload republish per `set` — no diffing/debounce (fine for chat rates;
 * documented as a known limitation in the plan). Channels are retained until
 * overwritten or explicitly cleared, and re-sent as a snapshot on every new WS
 * connect so a freshly-loaded editor/viewer matches current state.
 *
 * See dev-notes/modules/data-channels.md.
 */
import type { WSSync } from '../ws/index.js';

/** Snapshot row shape sent on client connect. */
interface SnapshotEntry {
  channel: string;
  payload: unknown;
}

export class DataChannelManager {
  private _ws: WSSync | null = null;

  /** channelName → last-published payload (retained). */
  private readonly _channels = new Map<string, unknown>();

  init(ws: WSSync): void {
    this._ws = ws;
  }

  /** Publish a payload to a named channel, replacing any previous value.
   *  Empty / non-string channel names are ignored (with a log). */
  set(channel: string, payload: unknown): void {
    const name = typeof channel === 'string' ? channel.trim() : '';
    if (!name) {
      console.warn('[data-channels] set with empty channel name — ignored');
      return;
    }
    this._channels.set(name, payload);
    this._ws?.broadcast('data_channel_set', { channel: name, payload });
  }

  /** Clear a single channel. No-op if nothing is set. */
  clear(channel: string): void {
    const name = typeof channel === 'string' ? channel.trim() : '';
    if (!name) return;
    if (!this._channels.delete(name)) return;
    this._ws?.broadcast('data_channel_clear', { channel: name });
  }

  /** Drop every channel. Mainly for tests / full reset. */
  clearAll(): void {
    if (this._channels.size === 0) return;
    const names = [...this._channels.keys()];
    this._channels.clear();
    for (const name of names) {
      this._ws?.broadcast('data_channel_clear', { channel: name });
    }
  }

  /** Send the current snapshot to a freshly-connected WS client (single
   *  message with all retained channels). Mirrors the override-bus snapshot. */
  sendSnapshotTo(
    send: (kind: string, payload: Record<string, unknown>) => void
  ): void {
    const entries: SnapshotEntry[] = [];
    for (const [channel, payload] of this._channels) {
      entries.push({ channel, payload });
    }
    send('data_channel_snapshot', { entries });
  }
}

// Singleton wired in src/index.ts.
export const dataChannelManager = new DataChannelManager();
