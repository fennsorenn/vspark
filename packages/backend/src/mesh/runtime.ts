/**
 * Runtime state as mesh documents — graph-driven param overrides, and the
 * published data fields that feed templates.
 *
 * Both used to travel three transports at once: the local `/ws` broadcast
 * (`runtime_override_set` / `data_channel_set` / `_clear`, plus a `_snapshot`
 * replayed to each new client), the collab `runtime_control` relay, and the
 * object-share `_share_override` / `_share_datachannel` envelopes. Three
 * writers, three delivery guarantees, and a fourth copy of the state in each
 * manager's own map.
 *
 * They are STATE, not events: each manager held every live value (`_bySceneId`,
 * `_scopes`) precisely so it could replay them to a freshly-connected tab. That
 * is what a retained channel is, so the collections replace the maps — a
 * subscriber gets the current values in its subscription snapshot, and the
 * `_snapshot` messages have nothing left to do.
 *
 * ## Why this channel and not `committed` or `control`
 *
 * - `committed` acks through the collection authority, and an acked write is a
 *   logged one: a graph firing overrides at 60 Hz would bury the authoring
 *   tab's undo stack under writes the user never made. Only
 *   `ch.ack === 'authority'` writes are logged, so dropping `ack` drops them
 *   from undo — which is the intent, not an accident of configuration.
 * - `control` (used by clip/runtime events) is `retained: false`. Events are
 *   fine to lose if you weren't listening; an override is not. A late joiner
 *   would render the un-overridden value forever.
 *
 * So: reliable + stamped + retained, no ack. Stamped is not optional — LWW
 * needs versions, and the registry rejects a retained channel without it.
 *
 * ## Keying (overrides)
 *
 * `${targetKind}:${targetId}:${paramPath}` — one document per overridden path,
 * so two graphs overriding different params of one node don't clobber each
 * other, and a clear is a plain `remove`. `targetKind` has no colon and
 * `targetId` is a uuid, so the two `indexOf` splits are unambiguous even though
 * a paramPath contains dots.
 *
 * Containment parent is the TARGET, so the existing scene-subtree grants route
 * overrides cross-type — the same trick track clips use to ride a scene grant.
 * A spawned tmp entity has no `scene_node` document to hang off, so its
 * overrides get no parent; tabs subscribe by rtype and receive them regardless,
 * and only grant-routed collab/share delivery is affected (which never carried
 * tmp ids anyway).
 */
import type { Collection, MeshPeer } from '@vspark/mesh';
import type { ParamTargetKind } from '@vspark/shared/paramPaths';

/** Reliable, stamped, retained, unacked: durable state that must reach late
 *  joiners, without an ack (and so without an undo entry). */
export const RUNTIME_CHANNEL = 'runtime';
export const RUNTIME_OVERRIDE_RTYPE = 'runtime_override';

export interface RuntimeOverrideDoc {
  /** `${targetKind}:${targetId}:${paramPath}` */
  id: string;
  targetKind: ParamTargetKind;
  targetId: string;
  paramPath: string;
  value: number | string | boolean;
  [k: string]: unknown;
}

/** The document id for one overridden param path. */
export const overrideKey = (
  targetKind: ParamTargetKind,
  targetId: string,
  paramPath: string
): string => `${targetKind}:${targetId}:${paramPath}`;

/** Split a key back into its parts, or null if it isn't one of ours. */
export function parseOverrideKey(key: string): {
  targetKind: ParamTargetKind;
  targetId: string;
  paramPath: string;
} | null {
  const i = key.indexOf(':');
  if (i < 0) return null;
  const targetKind = key.slice(0, i) as ParamTargetKind;
  if (targetKind !== 'scene_node' && targetKind !== 'compose_layer')
    return null;
  const rest = key.slice(i + 1);
  const j = rest.indexOf(':');
  if (j < 0) return null;
  return {
    targetKind,
    targetId: rest.slice(0, j),
    paramPath: rest.slice(j + 1),
  };
}

/** Containment: an override hangs off the entity it overrides, so a subtree
 *  grant on a scene covers every override inside it without naming the rtype. */
export const overrideParent = (
  d: Record<string, unknown>
): { rtype: string; id: string } | null =>
  (d.targetKind === 'scene_node' || d.targetKind === 'compose_layer') &&
  typeof d.targetId === 'string'
    ? { rtype: d.targetKind, id: d.targetId }
    : null;

// --- data channels -----------------------------------------------------------

export const DATA_FIELD_RTYPE = 'data_field';

/** One published field of one scope.
 *
 *  ONE DOCUMENT PER FIELD, not per scope. The bus MERGES fields into a scope
 *  precisely so two producers publishing different fields don't clobber each
 *  other; a whole-scope document would reinstate that clobber at the LWW layer,
 *  and the alternative — a dotted path per field — cannot survive a field label
 *  containing a dot, and the labels are arbitrary user text from `set_data`'s
 *  input ports. */
export interface DataFieldDoc {
  /** `${scope}:${field}` — scope is an entity id or '' for global, so it never
   *  contains a colon and the single split is unambiguous. */
  id: string;
  scope: string;
  /** What `scope` names, so both peers derive the same containment parent
   *  without a database lookup. `null` for the global scope, which belongs to
   *  no entity. */
  scopeKind: 'scene_node' | 'compose_layer' | null;
  field: string;
  value: unknown;
  [k: string]: unknown;
}

export const dataFieldKey = (scope: string, field: string): string =>
  `${scope}:${field}`;

/** Split a data-field key. The scope may be empty (global). */
export function parseDataFieldKey(
  key: string
): { scope: string; field: string } | null {
  const i = key.indexOf(':');
  if (i < 0) return null;
  return { scope: key.slice(0, i), field: key.slice(i + 1) };
}

/** Containment: a scoped field hangs off the entity it is scoped to, so a
 *  share/collab subtree grant carries it. Global fields belong to no entity and
 *  reach subscribers by rtype alone. */
export const dataFieldParent = (
  d: Record<string, unknown>
): { rtype: string; id: string } | null =>
  (d.scopeKind === 'scene_node' || d.scopeKind === 'compose_layer') &&
  typeof d.scope === 'string' &&
  d.scope !== ''
    ? { rtype: d.scopeKind, id: d.scope }
    : null;

let _overrides: Collection<RuntimeOverrideDoc> | null = null;
let _dataFields: Collection<DataFieldDoc> | null = null;

/** Register the runtime channel + collections. Idempotent. */
export function initMeshRuntime(peer: MeshPeer): void {
  if (_overrides) return;
  peer.channel(RUNTIME_CHANNEL, {
    transport: 'reliable',
    stamped: true,
    retained: true,
  });
  _overrides = peer.collection<RuntimeOverrideDoc>(RUNTIME_OVERRIDE_RTYPE, {
    channels: [RUNTIME_CHANNEL],
    parent: overrideParent,
    authority: 'self',
  });
  _dataFields = peer.collection<DataFieldDoc>(DATA_FIELD_RTYPE, {
    channels: [RUNTIME_CHANNEL],
    parent: dataFieldParent,
    authority: 'self',
  });
}

/** The override collection, or null before the mesh is up (tests that skip it,
 *  and the window before `initBackendMesh`). Callers no-op rather than throw:
 *  an override is best-effort by design — the bus logs and drops on a bad path
 *  too, and a missing store must not take down a running graph. */
export function overrideCollection(): Collection<RuntimeOverrideDoc> | null {
  return _overrides;
}

/** The data-field collection, or null before the mesh is up. Same best-effort
 *  contract as {@link overrideCollection}. */
export function dataFieldCollection(): Collection<DataFieldDoc> | null {
  return _dataFields;
}

/** Test seam — drops the registered collections so the next init rebuilds
 *  them against a fresh peer. */
export function resetMeshRuntime(): void {
  _overrides = null;
  _dataFields = null;
}
