/**
 * Runtime override bus.
 *
 * A parallel surface to the track-clip override slots — same shape, separate
 * slice — so the established playback path stays untouched. Lets signal-graph
 * nodes mutate scene-node and compose-layer params at runtime, transient by
 * default with an opt-in persistent mode.
 *
 * The overrides themselves live in the mesh `runtime_override` collection on a
 * retained channel (see mesh/runtime.ts) — this class validates and coerces,
 * then writes there. It used to broadcast on `/ws`, forward to object-share
 * subscribers, tap the collab relay, AND hold every live value in its own map
 * so it could replay a snapshot to each new client. The replica does all four.
 *
 * See dev-notes/modules/runtime-overrides.md.
 */
import { getDb } from '../db/index.js';
import {
  overrideCollection,
  overrideKey,
  RUNTIME_CHANNEL,
} from '../mesh/runtime.js';
import {
  coerceParamValue,
  getParamPathSpec,
  type ParamTargetKind,
} from '@vspark/shared/paramPaths';

export type RuntimeOverrideValue = number | string | boolean;

export interface RuntimeOverrideSetOpts {
  /** Also write the value through to SQLite via the injected persist hook.
   *  When the persist hook is unset or throws, the in-bus override is kept
   *  and the failure is logged — transient correctness wins over eventual
   *  consistency for streaming overlays. */
  persist?: boolean;
}

/** Caller-provided persistence hook. Receives a value already coerced to the
 *  paramPath's declared scalar type. Implementations should map the
 *  (targetKind, targetId, paramPath) tuple onto whichever underlying field
 *  the path refers to and run the appropriate UPDATE. */
export type RuntimePersistFn = (
  targetKind: ParamTargetKind,
  targetId: string,
  paramPath: string,
  value: RuntimeOverrideValue
) => void | Promise<void>;

export class RuntimeOverrideManager {
  private _persist: RuntimePersistFn | null = null;
  /** targetId → sceneId, for targets with no row of their own (spawned tmp
   *  entities). Kept only so `clear` can still find them — see registerTarget. */
  private readonly _sceneByTarget = new Map<string, string>();

  init(persist?: RuntimePersistFn | null): void {
    this._persist = persist ?? null;
  }

  /** Pre-register a (target → scene) mapping for an entity with no database
   *  row. Used by SpawnManager for tmp entities. Safe to call repeatedly.
   *
   *  A spawned entity is not a mesh document either, so its overrides get no
   *  containment parent and reach tabs by rtype subscription rather than by
   *  scene grant. That is the same reach they had over the old `/ws`
   *  broadcast; only collab/share routing (which never carried tmp ids) is
   *  narrower. */
  registerTarget(targetId: string, sceneId: string): void {
    this._sceneByTarget.set(targetId, sceneId);
  }

  /** Set or replace an override. Validates the path against the registry and
   *  coerces the value; rejects silently (with a log) for unknown paths or
   *  uncoercible values. */
  set(
    targetKind: ParamTargetKind,
    targetId: string,
    paramPath: string,
    value: unknown,
    opts: RuntimeOverrideSetOpts = {}
  ): void {
    const spec = getParamPathSpec(targetKind, paramPath);
    if (!spec) {
      console.warn(
        `[runtime-overrides] unknown paramPath ${targetKind}:${paramPath}`
      );
      return;
    }
    const coerced = coerceParamValue(spec, value);
    if (coerced == null) {
      console.warn(
        `[runtime-overrides] uncoercible value for ${targetKind}:${paramPath}:`,
        value
      );
      return;
    }

    // Still resolved, still refused when it doesn't land: an override on an
    // entity that is in no scene is a graph addressing something that isn't
    // there, and dropping it with a log is the behaviour the bus has always
    // had. The scene id no longer keys anything — containment does that now —
    // so this is purely the existence check.
    if (!this._resolveSceneId(targetKind, targetId)) {
      console.warn(
        `[runtime-overrides] ${targetKind} ${targetId} not found in any scene`
      );
      return;
    }

    const id = overrideKey(targetKind, targetId, paramPath);
    overrideCollection()?.set(
      id,
      '',
      { id, targetKind, targetId, paramPath, value: coerced },
      { channel: RUNTIME_CHANNEL }
    );

    if (opts.persist && this._persist) {
      // Persist asynchronously; never block the override or interrupt the
      // broadcast. Failures keep the in-bus value (intentional).
      void Promise.resolve()
        .then(() => this._persist!(targetKind, targetId, paramPath, coerced))
        .catch((err) => {
          console.error(
            `[runtime-overrides] persist failed for ${targetKind}:${targetId}:${paramPath}:`,
            err
          );
        });
    }
  }

  /** Clear a single override, or all overrides for a target when paramPath is
   *  omitted. No-op if nothing is set.
   *
   *  A clear is a document REMOVE, which is why the whole-target form has to
   *  enumerate: the replica holds one document per path, and there is no
   *  prefix-delete. `all()` is a small list (live overrides only), and this
   *  runs on entity deletion, not per frame. */
  clear(
    targetKind: ParamTargetKind,
    targetId: string,
    paramPath?: string
  ): void {
    const col = overrideCollection();
    if (!col) return;
    const ids = paramPath
      ? [overrideKey(targetKind, targetId, paramPath)]
      : col
          .all()
          .filter(
            (d) => d.targetKind === targetKind && d.targetId === targetId
          )
          .map((d) => d.id);
    for (const id of ids)
      if (col.get(id)) col.remove(id, { channel: RUNTIME_CHANNEL });
  }

  /** Drop every override owned by a target. Called on entity delete so the
   *  bus doesn't leak stale entries. */
  clearAllForTarget(targetKind: ParamTargetKind, targetId: string): void {
    this.clear(targetKind, targetId);
    this._sceneByTarget.delete(targetId);
  }

  /** Resolve a target id back to its containing scene id. Cached after the
   *  first lookup. Scene nodes are looked up via the root_scene_node_id column
   *  (same column the broadcast bus uses); compose layers via their scene_id. */
  private _resolveSceneId(
    targetKind: ParamTargetKind,
    targetId: string
  ): string | null {
    const cached = this._sceneByTarget.get(targetId);
    if (cached) return cached;
    const db = getDb();
    let sceneId: string | undefined;
    if (targetKind === 'scene_node') {
      const row = db
        .prepare('SELECT root_scene_node_id FROM scene_nodes WHERE id = ?')
        .get(targetId) as { root_scene_node_id?: string } | undefined;
      sceneId = row?.root_scene_node_id;
    } else {
      const row = db
        .prepare('SELECT scene_id FROM compose_layers WHERE id = ?')
        .get(targetId) as { scene_id?: string } | undefined;
      sceneId = row?.scene_id;
    }
    if (!sceneId) return null;
    this._sceneByTarget.set(targetId, sceneId);
    return sceneId;
  }
}

export const runtimeOverrideManager = new RuntimeOverrideManager();
