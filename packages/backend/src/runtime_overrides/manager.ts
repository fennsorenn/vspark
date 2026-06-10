/**
 * Runtime override bus.
 *
 * A parallel surface to the track-clip override slots — same shape, separate
 * slice — so the established playback path stays untouched. Lets signal-graph
 * nodes mutate scene-node and compose-layer params at runtime, transient by
 * default with an opt-in persistent mode.
 *
 * See dev-notes/modules/runtime-overrides.md.
 */
import type { WSSync } from '../ws/index.js';
import { getDb } from '../db/index.js';
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

interface OverrideEntry {
  sceneId: string;
  value: RuntimeOverrideValue;
}

/** Snapshot row shape sent on client connect. */
interface SnapshotEntry {
  targetKind: ParamTargetKind;
  targetId: string;
  paramPath: string;
  value: RuntimeOverrideValue;
}

export class RuntimeOverrideManager {
  private _ws: WSSync | null = null;
  private _persist: RuntimePersistFn | null = null;
  /** Optional tap for multiplayer fan-out of overrides on shared scene nodes. */
  private _forward:
    | ((
        op: 'set' | 'clear',
        payload: Record<string, unknown>
      ) => void)
    | null = null;

  /** sceneId → `${targetKind}:${targetId}:${paramPath}` → entry */
  private readonly _bySceneId = new Map<string, Map<string, OverrideEntry>>();
  /** targetId → sceneId (lookup cache) */
  private readonly _sceneByTarget = new Map<string, string>();

  init(ws: WSSync, persist?: RuntimePersistFn | null): void {
    this._ws = ws;
    this._persist = persist ?? null;
  }

  /** Install the multiplayer override forwarder (injected at startup). */
  setOverrideForwarder(
    fn: (op: 'set' | 'clear', payload: Record<string, unknown>) => void
  ): void {
    this._forward = fn;
  }

  /** Pre-register a (target → scene) mapping so the bus doesn't have to look
   *  it up in SQLite. Used by SpawnManager for tmp entities that have no
   *  database row. Safe to call repeatedly with the same mapping. */
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

    const sceneId = this._resolveSceneId(targetKind, targetId);
    if (!sceneId) {
      console.warn(
        `[runtime-overrides] ${targetKind} ${targetId} not found in any scene`
      );
      return;
    }

    const key = _key(targetKind, targetId, paramPath);
    let sceneMap = this._bySceneId.get(sceneId);
    if (!sceneMap) {
      sceneMap = new Map();
      this._bySceneId.set(sceneId, sceneMap);
    }
    sceneMap.set(key, { sceneId, value: coerced });

    this._ws?.broadcast('runtime_override_set', {
      sceneId,
      targetKind,
      targetId,
      paramPath,
      value: coerced,
    });
    this._forward?.('set', { targetKind, targetId, paramPath, value: coerced });

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
   *  omitted. No-op if nothing is set. */
  clear(
    targetKind: ParamTargetKind,
    targetId: string,
    paramPath?: string
  ): void {
    const sceneId = this._sceneByTarget.get(targetId);
    if (!sceneId) return;
    const sceneMap = this._bySceneId.get(sceneId);
    if (!sceneMap) return;

    if (paramPath) {
      const key = _key(targetKind, targetId, paramPath);
      if (!sceneMap.delete(key)) return;
    } else {
      const prefix = `${targetKind}:${targetId}:`;
      let removed = 0;
      for (const k of Array.from(sceneMap.keys())) {
        if (k.startsWith(prefix)) {
          sceneMap.delete(k);
          removed += 1;
        }
      }
      if (removed === 0) return;
    }

    this._ws?.broadcast('runtime_override_clear', {
      sceneId,
      targetKind,
      targetId,
      ...(paramPath ? { paramPath } : {}),
    });
    this._forward?.('clear', {
      targetKind,
      targetId,
      ...(paramPath ? { paramPath } : {}),
    });
  }

  /** Drop every override owned by a target. Called on entity delete so the
   *  bus doesn't leak stale entries. */
  clearAllForTarget(targetKind: ParamTargetKind, targetId: string): void {
    this.clear(targetKind, targetId);
    this._sceneByTarget.delete(targetId);
  }

  /** Send the current snapshot to a freshly-connected WS client. Mirrors the
   *  track-clip snapshot pattern (single message with all entries). */
  sendSnapshotTo(
    send: (kind: string, payload: Record<string, unknown>) => void
  ): void {
    const entries: SnapshotEntry[] = [];
    for (const sceneMap of this._bySceneId.values()) {
      for (const [key, entry] of sceneMap) {
        const parsed = _parseKey(key);
        if (!parsed) continue;
        entries.push({ ...parsed, value: entry.value });
      }
    }
    send('runtime_override_snapshot', { entries });
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

function _key(
  targetKind: ParamTargetKind,
  targetId: string,
  paramPath: string
): string {
  return `${targetKind}:${targetId}:${paramPath}`;
}

function _parseKey(
  key: string
): { targetKind: ParamTargetKind; targetId: string; paramPath: string } | null {
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

export const runtimeOverrideManager = new RuntimeOverrideManager();
