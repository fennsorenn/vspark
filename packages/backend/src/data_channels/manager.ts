/**
 * Data-channel bus.
 *
 * A generic sibling of the runtime-override bus (runtime_overrides/manager.ts).
 * Where the override bus carries scalar param writes keyed by
 * (targetKind, targetId, paramPath), this bus carries **arbitrary structured
 * field values** keyed by `(scope, field)`. It is the publish surface used by the
 * generic `set_data` signal node, whose user-defined labeled input ports each
 * become a named FIELD; the frontend renders the field-set through a
 * data-shape-independent template (`feed` compose layer / 3D billboard).
 *
 * Addressing has two parts:
 *  - **scope** — the id of the consumer a field-set is targeted at (a compose
 *    layer or scene node id), or `''` for GLOBAL (visible to every consumer). A
 *    consumer reads `global ∪ its-own-id`. set_data's optional `scope` input
 *    selects the target; unwired → global.
 *  - **field** — the label of one published value (the former "channel name"),
 *    referenced by bare name in templates.
 *
 * `set` MERGES the given fields into a scope (it never replaces the whole scope),
 * so two producers publishing different fields into the same scope don't clobber
 * each other. `seed` is the same but only fills fields not already present (used
 * by set_data on bind to pre-create its declared fields as `null`, so a template
 * referencing a bare field name resolves before the first publish rather than
 * throwing). Whole-value republish per field — no diffing (fine for chat rates).
 *
 * Scopes/fields are retained until cleared, and re-sent as a snapshot on every
 * new WS connect so a freshly-loaded editor/viewer matches current state.
 *
 * See dev-notes/modules/data-channels.md.
 */
import type { WSSync } from '../ws/index.js';

/** Snapshot row: one scope and all its retained fields. */
interface SnapshotEntry {
  scope: string;
  fields: Record<string, unknown>;
}

export class DataChannelManager {
  private _ws: WSSync | null = null;

  /** scope → (field → last-published value). scope '' is GLOBAL. */
  private readonly _scopes = new Map<string, Map<string, unknown>>();

  init(ws: WSSync): void {
    this._ws = ws;
  }

  private _scopeKey(scope: unknown): string {
    return typeof scope === 'string' ? scope.trim() : '';
  }

  private _bucket(scope: string): Map<string, unknown> {
    let m = this._scopes.get(scope);
    if (!m) {
      m = new Map();
      this._scopes.set(scope, m);
    }
    return m;
  }

  /** Merge `fields` into a scope, overwriting same-named fields. Broadcasts the
   *  changed subset. */
  set(scope: string, fields: Record<string, unknown>): void {
    const key = this._scopeKey(scope);
    const names = Object.keys(fields ?? {});
    if (names.length === 0) return;
    const bucket = this._bucket(key);
    for (const name of names) bucket.set(name, fields[name]);
    this._ws?.broadcast('data_channel_set', { scope: key, fields });
  }

  /** Like `set`, but only fills fields not already present. Broadcasts only the
   *  newly-added fields (no-op broadcast if none). Used to pre-seed declared
   *  fields so bare-name template references resolve before first publish. */
  seed(scope: string, fields: Record<string, unknown>): void {
    const key = this._scopeKey(scope);
    const bucket = this._bucket(key);
    const added: Record<string, unknown> = {};
    for (const name of Object.keys(fields ?? {})) {
      if (!bucket.has(name)) {
        bucket.set(name, fields[name]);
        added[name] = fields[name];
      }
    }
    if (Object.keys(added).length > 0) {
      this._ws?.broadcast('data_channel_set', { scope: key, fields: added });
    }
  }

  /** Clear one field in a scope, or the whole scope when `field` is omitted. */
  clear(scope: string, field?: string): void {
    const key = this._scopeKey(scope);
    const bucket = this._scopes.get(key);
    if (!bucket) return;
    if (field === undefined) {
      this._scopes.delete(key);
      this._ws?.broadcast('data_channel_clear', { scope: key });
      return;
    }
    if (!bucket.delete(field)) return;
    if (bucket.size === 0) this._scopes.delete(key);
    this._ws?.broadcast('data_channel_clear', { scope: key, field });
  }

  /** Drop every scope. Mainly for tests / full reset. */
  clearAll(): void {
    if (this._scopes.size === 0) return;
    const keys = [...this._scopes.keys()];
    this._scopes.clear();
    for (const key of keys) {
      this._ws?.broadcast('data_channel_clear', { scope: key });
    }
  }

  /** Send the current snapshot to a freshly-connected WS client (one message
   *  with all retained scopes/fields). Mirrors the override-bus snapshot. */
  sendSnapshotTo(
    send: (kind: string, payload: Record<string, unknown>) => void
  ): void {
    const entries: SnapshotEntry[] = [];
    for (const [scope, bucket] of this._scopes) {
      entries.push({ scope, fields: Object.fromEntries(bucket) });
    }
    send('data_channel_snapshot', { entries });
  }
}

// Singleton wired in src/index.ts.
export const dataChannelManager = new DataChannelManager();
