/**
 * SpawnManager — ephemeral clip-clone spawning.
 *
 * `spawn_clip` calls `spawn(clipId)`. We:
 *   1. Resolve the clip's owner entity (scene node or compose layer).
 *   2. Deep-clone the owner with a tmp id (always unhidden), broadcasting the
 *      tmp record on the existing node/layer-added WS channel so the frontend
 *      renders it indistinguishably from a persisted entity.
 *   3. Duplicate the clip with a new id and remap each lane's target_id to the
 *      tmp entity id, broadcasting on `track_clip_added` so the frontend
 *      evaluator picks it up.
 *   4. Trigger the duplicated clip via `playback.triggerEphemeral`, which
 *      reuses the existing `track_clip_started` broadcast path but never
 *      touches SQLite.
 *   5. When the clip finishes (manual stop or auto-stop timer for non-looping
 *      clips), tear down: broadcast `track_clip_removed` + the matching
 *      node/layer-removed message.
 *
 * Nothing is ever written to SQLite. State lives only in memory; if the
 * backend restarts mid-spawn the tmp entity simply disappears.
 *
 * See dev-notes/modules/spawn.md.
 */
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import type { WSSync } from '../ws/index.js';
import type { TrackClipPlaybackManager } from '../track_clips/playback.js';
import { runtimeOverrideManager } from '../runtime_overrides/manager.js';

export type SpawnedKind = 'scene_node' | 'compose_layer';

export interface SpawnRef {
  tmpNodeId: string;
  tmpClipId: string;
  kind: SpawnedKind;
}

interface ActiveSpawn {
  tmpId: string;
  tmpClipId: string;
  kind: SpawnedKind;
}

export class SpawnManager {
  private _ws: WSSync | null = null;
  private _playback: TrackClipPlaybackManager | null = null;
  private _unsubFinished: (() => void) | null = null;
  /** Active spawns keyed by tmpClipId — that's what the playback manager
   *  reports when a clip finishes. */
  private readonly _byClipId = new Map<string, ActiveSpawn>();

  /** Whether a clip id is a live ephemeral spawn (for collab relay: its play
   *  frames must be mirrored raw, since the receiver only has the cloned copy). */
  isEphemeralClip(clipId: string): boolean {
    return this._byClipId.has(clipId);
  }

  init(ws: WSSync, playback: TrackClipPlaybackManager): void {
    this._ws = ws;
    this._playback = playback;
    this._unsubFinished?.();
    this._unsubFinished = playback.onClipFinished((clipId) => {
      const active = this._byClipId.get(clipId);
      if (!active) return;
      this._cleanup(active);
    });
  }

  /** Spawn a tmp clone of the given clip's owner and play a tmp clip on it.
   *  Returns the SpawnRef payload (or null on lookup failure). */
  spawn(clipId: string): SpawnRef | null {
    if (!this._ws || !this._playback) return null;
    const db = getDb();
    const clipRow = db
      .prepare(
        'SELECT id, owner_node_id, owner_layer_id, name, duration, loop, mode FROM track_clips WHERE id = ?'
      )
      .get(clipId) as
      | {
          id: string;
          owner_node_id: string | null;
          owner_layer_id: string | null;
          name: string;
          duration: number;
          loop: number;
          mode: string;
        }
      | undefined;
    if (!clipRow) {
      console.warn(`[spawn] clip ${clipId} not found`);
      return null;
    }

    // Determine kind + source entity id from the clip's owner column.
    const sourceId = clipRow.owner_node_id ?? clipRow.owner_layer_id;
    const kind: SpawnedKind | null = clipRow.owner_node_id
      ? 'scene_node'
      : clipRow.owner_layer_id
        ? 'compose_layer'
        : null;
    if (!sourceId || !kind) {
      console.warn(
        `[spawn] clip ${clipId} has no owner; cannot determine what to clone`
      );
      return null;
    }

    // Clone the source entity in memory with a tmp id; always unhidden.
    const tmpId = `__spawn:${randomUUID()}`;
    const tmpClipId = `__spawn:${randomUUID()}`;
    const cloneResult =
      kind === 'scene_node'
        ? this._cloneSceneNode(sourceId, tmpId)
        : this._cloneComposeLayer(sourceId, tmpId);
    if (!cloneResult) return null;
    const { record: cloned, sceneId } = cloneResult;

    // Pre-register the tmp target's scene with the override bus so
    // `set_*_param` writes against the tmp id don't have to look it up in
    // SQLite (where it doesn't exist).
    runtimeOverrideManager.registerTarget(tmpId, sceneId);

    // Load the source clip's lanes + keyframes, remapping each lane's
    // target_id and clip_id to the tmp ids. Lane ids get fresh uuids too so
    // they don't collide with the source clip's lane ids.
    const laneRows = db
      .prepare(
        'SELECT id, target_kind, target_id, param_path, default_value FROM track_clip_lanes WHERE clip_id = ?'
      )
      .all(clipRow.id) as Array<{
      id: string;
      target_kind: string;
      target_id: string;
      param_path: string;
      default_value: number;
    }>;
    const lanes = laneRows.map((lane) => {
      // Only remap lanes that targeted the source entity directly. Lanes
      // pointing at *other* entities are left as-is (rare but possible).
      const remap = lane.target_id === sourceId;
      const newTargetId = remap ? tmpId : lane.target_id;
      const newTargetKind = remap ? kind : lane.target_kind;
      const kfRows = db
        .prepare(
          'SELECT id, t, value, easing, in_handle_t_fraction, in_handle_v_fraction, out_handle_t_fraction, out_handle_v_fraction FROM track_clip_keyframes WHERE lane_id = ? ORDER BY t'
        )
        .all(lane.id) as Array<{
        id: string;
        t: number;
        value: number;
        easing: string;
        in_handle_t_fraction: number | null;
        in_handle_v_fraction: number | null;
        out_handle_t_fraction: number | null;
        out_handle_v_fraction: number | null;
      }>;
      return {
        id: `__spawn:${randomUUID()}`,
        clipId: tmpClipId,
        targetKind: newTargetKind,
        targetId: newTargetId,
        paramPath: lane.param_path,
        defaultValue: lane.default_value,
        keyframes: kfRows.map((k) => ({
          id: `__spawn:${randomUUID()}`,
          t: k.t,
          value: k.value,
          easing: k.easing,
          inHandleTFraction: k.in_handle_t_fraction,
          inHandleVFraction: k.in_handle_v_fraction,
          outHandleTFraction: k.out_handle_t_fraction,
          outHandleVFraction: k.out_handle_v_fraction,
        })),
      };
    });

    // Clone event markers, retargeting owner-pointed markers to the tmp id.
    const eventRows = db
      .prepare(
        'SELECT id, t, action, target_kind, target_id, payload FROM track_clip_events WHERE clip_id = ? ORDER BY t'
      )
      .all(clipRow.id) as Array<{
      id: string;
      t: number;
      action: string;
      target_kind: string;
      target_id: string;
      payload: string | null;
    }>;
    const events = eventRows.map((e) => {
      const remap = e.target_id === sourceId;
      let payload: Record<string, unknown> | null = null;
      if (e.payload) {
        try {
          payload = JSON.parse(e.payload) as Record<string, unknown>;
        } catch {
          payload = null;
        }
      }
      return {
        id: `__spawn:${randomUUID()}`,
        t: e.t,
        action: e.action,
        targetKind: remap ? kind : e.target_kind,
        targetId: remap ? tmpId : e.target_id,
        payload,
      };
    });

    const tmpClip = {
      id: tmpClipId,
      ownerNodeId: kind === 'scene_node' ? tmpId : null,
      ownerLayerId: kind === 'compose_layer' ? tmpId : null,
      name: `${clipRow.name} (spawn)`,
      duration: clipRow.duration,
      loop: clipRow.loop === 1,
      mode: clipRow.mode,
      autoplay: false,
      startedAt: null,
      lanes,
      events,
    };

    // Order matters: entity first (so the renderer can mount it), then clip
    // (so the evaluator finds the target ids), then the playback trigger.
    this._ws.broadcast(
      kind === 'scene_node' ? 'node_added' : 'compose_layer_added',
      cloned as Record<string, unknown>
    );
    this._ws.broadcast(
      'track_clip_added',
      tmpClip as unknown as Record<string, unknown>
    );
    // Register the ephemeral clip BEFORE triggering it: triggerEphemeral
    // synchronously broadcasts `track_clip_started`, and the collab relay only
    // forwards that play-frame for clips `isEphemeralClip()` reports as live.
    // Registering after the trigger left the start frame un-relayed, so a
    // spawned clip mounted on collab peers but never animated there.
    const active: ActiveSpawn = { tmpId, tmpClipId, kind };
    this._byClipId.set(tmpClipId, active);

    this._playback.triggerEphemeral(
      tmpClipId,
      clipRow.duration,
      clipRow.loop === 1
    );

    return { tmpNodeId: tmpId, tmpClipId, kind };
  }

  private _cloneSceneNode(
    sourceId: string,
    tmpId: string
  ): { record: Record<string, unknown>; sceneId: string } | null {
    const row = getDb()
      .prepare('SELECT * FROM scene_nodes WHERE id = ?')
      .get(sourceId) as
      | {
          id: string;
          root_scene_node_id: string;
          parent_id: string | null;
          bone_attachment: string | null;
          name: string;
          kind: string;
          file_path: string | null;
          components: string;
          properties: string;
        }
      | undefined;
    if (!row) {
      console.warn(`[spawn] scene_node ${sourceId} not found`);
      return null;
    }
    const record = {
      id: tmpId,
      rootSceneNodeId: row.root_scene_node_id,
      name: `${row.name} (spawn)`,
      kind: row.kind,
      // Always render at the scene root so the spawn is visible regardless of
      // the source's parent; transforms on the source still apply via the
      // cloned components.
      parentId: null,
      boneAttachment: null,
      filePath: row.file_path,
      components: _parseJson(row.components),
      properties: _parseJson(row.properties),
      // Spawned entities are always unhidden even if the source was hidden
      // (templates are typically hidden so they don't render alongside spawns).
      hidden: false,
    };
    return { record, sceneId: row.root_scene_node_id };
  }

  private _cloneComposeLayer(
    sourceId: string,
    tmpId: string
  ): { record: Record<string, unknown>; sceneId: string } | null {
    const row = getDb()
      .prepare('SELECT * FROM compose_layers WHERE id = ?')
      .get(sourceId) as
      | {
          id: string;
          scene_id: string;
          root_compose_scene_id: string | null;
          camera_node_id: string | null;
          parent_id: string | null;
          name: string;
          kind: string;
          asset_id: string | null;
          config: string;
          x: number;
          y: number;
          width: number;
          height: number;
          rotation: number;
          anchor_h: string;
          anchor_v: string;
          scene_order: number;
          camera_order: number;
          visible: number;
        }
      | undefined;
    if (!row) {
      console.warn(`[spawn] compose_layer ${sourceId} not found`);
      return null;
    }
    const record = {
      id: tmpId,
      projectId: '',
      rootComposeSceneId: row.root_compose_scene_id,
      cameraNodeId: row.camera_node_id,
      parentId: row.parent_id,
      name: `${row.name} (spawn)`,
      kind: row.kind,
      assetId: row.asset_id,
      config: _parseJson(row.config),
      x: row.x,
      y: row.y,
      width: row.width,
      height: row.height,
      rotation: row.rotation,
      anchorH: row.anchor_h,
      anchorV: row.anchor_v,
      sceneOrder: row.scene_order,
      cameraOrder: row.camera_order,
      // Always visible on spawn (matches the scene-node "always unhidden" rule).
      visible: true,
    };
    return { record, sceneId: row.scene_id };
  }

  /** Tear down a finished spawn: drop the tmp clip + tmp entity from the
   *  frontend store, and clear any runtime overrides keyed on the tmp id. */
  private _cleanup(active: ActiveSpawn): void {
    if (!this._ws) return;
    this._byClipId.delete(active.tmpClipId);
    // Clear runtime overrides on the tmp entity first so the override-bus
    // snapshot doesn't replay them after entity removal on the next reconnect.
    runtimeOverrideManager.clearAllForTarget(active.kind, active.tmpId);
    this._ws.broadcast('track_clip_removed', { id: active.tmpClipId });
    this._ws.broadcast(
      active.kind === 'scene_node' ? 'node_removed' : 'compose_layer_removed',
      { id: active.tmpId }
    );
  }
}

function _parseJson(s: unknown): Record<string, unknown> {
  if (typeof s !== 'string') return (s as Record<string, unknown>) ?? {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const spawnManager = new SpawnManager();
