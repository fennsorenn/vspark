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
 * Scopes/fields are retained until cleared. That retention is now the mesh's:
 * each field is a document in the `data_field` collection on the retained
 * `runtime` channel (see mesh/runtime.ts), so a freshly-loaded editor/viewer
 * gets the current values in its subscription snapshot. This class used to hold
 * them in `_scopes`, broadcast each change on `/ws`, forward it to object-share
 * subscribers, AND answer a `data_channel_snapshot` per connect; the replica
 * does all four.
 *
 * See dev-notes/modules/data-channels.md.
 */
import {
  dataFieldCollection,
  dataFieldKey,
  RUNTIME_CHANNEL,
  type DataFieldDoc,
} from '../mesh/runtime.js';
import { getMeshCollection } from '../mesh/index.js';

export class DataChannelManager {
  /** scope id → what it names, cached. Only used to pick the containment
   *  parent, so a miss costs routing reach, not correctness. */
  private readonly _scopeKinds = new Map<
    string,
    'scene_node' | 'compose_layer' | null
  >();

  private _scopeKey(scope: unknown): string {
    return typeof scope === 'string' ? scope.trim() : '';
  }

  /** What a scope id names, so the document can carry its own containment
   *  parent. Read from the replica rather than SQLite: this runs on the publish
   *  path, which is chat-rate, and the collections are already in memory. */
  private _scopeKind(scope: string): 'scene_node' | 'compose_layer' | null {
    if (scope === '') return null;
    const cached = this._scopeKinds.get(scope);
    if (cached !== undefined) return cached;
    const kind = getMeshCollection('scene_node')?.get(scope)
      ? 'scene_node'
      : getMeshCollection('compose_layer')?.get(scope)
        ? 'compose_layer'
        : null;
    this._scopeKinds.set(scope, kind);
    return kind;
  }

  /** Write one field document. */
  private _put(scope: string, field: string, value: unknown): void {
    const id = dataFieldKey(scope, field);
    dataFieldCollection()?.set(
      id,
      '',
      {
        id,
        scope,
        scopeKind: this._scopeKind(scope),
        field,
        value,
      } as DataFieldDoc,
      { channel: RUNTIME_CHANNEL }
    );
  }

  /** Every live field of a scope. */
  private _fieldsOf(scope: string): DataFieldDoc[] {
    return (dataFieldCollection()?.all() ?? []).filter((d) => d.scope === scope);
  }

  /** Merge `fields` into a scope, overwriting same-named fields.
   *
   *  One document per field, so the merge is structural rather than something
   *  this method has to preserve: two producers publishing different fields of
   *  one scope write different documents and cannot clobber each other, even
   *  under LWW. */
  set(scope: string, fields: Record<string, unknown>): void {
    const key = this._scopeKey(scope);
    const names = Object.keys(fields ?? {});
    if (names.length === 0) return;
    for (const name of names) this._put(key, name, fields[name]);
  }

  /** Like `set`, but only fills fields not already present. Broadcasts only the
   *  newly-added fields (no-op broadcast if none). Used to pre-seed declared
   *  fields so bare-name template references resolve before first publish. */
  seed(scope: string, fields: Record<string, unknown>): void {
    const key = this._scopeKey(scope);
    const col = dataFieldCollection();
    if (!col) return;
    for (const name of Object.keys(fields ?? {}))
      if (!col.get(dataFieldKey(key, name))) this._put(key, name, fields[name]);
  }

  /** Clear one field in a scope, or the whole scope when `field` is omitted.
   *
   *  A clear is a document remove, so the whole-scope form enumerates: the
   *  replica has no prefix-delete, and a receiver sees one remove per field
   *  rather than a single message with an optional `field`. */
  clear(scope: string, field?: string): void {
    const key = this._scopeKey(scope);
    const col = dataFieldCollection();
    if (!col) return;
    const ids =
      field === undefined
        ? this._fieldsOf(key).map((d) => d.id)
        : [dataFieldKey(key, field)];
    for (const id of ids)
      if (col.get(id)) col.remove(id, { channel: RUNTIME_CHANNEL });
  }

  /** Drop every scope. Mainly for tests / full reset. */
  clearAll(): void {
    const col = dataFieldCollection();
    if (!col) return;
    for (const d of col.all()) col.remove(d.id, { channel: RUNTIME_CHANNEL });
    this._scopeKinds.clear();
  }
}

// Singleton wired in src/index.ts.
export const dataChannelManager = new DataChannelManager();
