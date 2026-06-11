import { useEffect, useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import type { StageObject } from '../store/editorStore';
import type { CameraEffectRecord } from '../api/client';
import {
  mapBehavior,
  mapComposeLayer,
  mapTrackClip,
  mapTrackClipLane,
  mapTrackClipKeyframe,
  mapTrackClipEvent,
  getScenes,
} from '../api/client';
import { setVmcPose, setVmcBlendshapes } from '../vmcPoseStore';
import { smoothNodeTransform, smoothComposeLayer } from '../previewSmoother';
import { setIkTargets } from '../ikTargetStore';
import type {
  IkTargetFrame,
  AnimationBlendMode,
  ApiAnimationMessage,
  MediaCommand,
} from '@vspark/shared/types';
import { dispatchMediaCommand } from '../components/editor/mediaRegistry';
import { SYNC_MESSAGE_KIND, type SyncEnvelope } from '@vspark/shared/sync';
import { applyRemote } from '../sync/registry';
import '../sync/resources';
import { setShareWriteRelay } from '../sync/remoteEdit'; // also registers the edit router
import {
  applySnapshot as applySharedSnapshot,
  applyUpdate as applySharedUpdate,
  removeProjection as removeSharedProjection,
  removePeerProjections as removePeerSharedProjections,
  rollbackWrite,
} from '../sync/sharedProjection';
import { useConnectionsStore } from '../store/connectionsStore';
import { clientMesh } from '../mesh/clientMesh';

const WS_URL =`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
const RECONNECT_MS = 3000;

/** Module-level ref so any component can send messages on the shared editor WS. */
export const editorWsRef = { current: null as WebSocket | null };

// Relay path for Phase 6 remote writes when there's no direct edge: forward the
// `_share_write` to this server, which relays it to the owner over the mesh.
setShareWriteRelay((owner, env) => {
  const ws = editorWsRef.current;
  if (ws?.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ kind: 'mp_share_write', payload: { owner, env } }));
});

/** Send a live in-flight transform update so other connected editors can preview
 *  the motion without waiting for the final PUT. Silently no-ops if the WS isn't open. */
export function sendNodeTransformPreview(
  nodeId: string,
  transform: Record<string, number>
) {
  const ws = editorWsRef.current;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({ kind: 'node_transform_preview', nodeId, transform })
  );
}

/** Forward a clip-driven transform of a *shared* object to subscribers only (no
 *  local co-editor broadcast — they evaluate the same clip themselves). The
 *  backend reuses the `node_transform_preview` stream kind toward subscribers. */
export function sendSharedNodeTransform(
  nodeId: string,
  transform: Record<string, number>
) {
  const ws = editorWsRef.current;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({ kind: 'shared_node_transform', nodeId, transform })
  );
}

/** Send a live in-flight compose-layer patch (position/size/rotation) so other
 *  editors see the change before the user releases the mouse. */
export function sendComposeLayerPreview(
  id: string,
  patch: Record<string, unknown>
) {
  const ws = editorWsRef.current;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ kind: 'compose_layer_preview', id, patch }));
}

export function useWsSync() {
  const setVmcStatus = useEditorStore((s) => s.setVmcStatus);
  const setVmcTracking = useEditorStore((s) => s.setVmcTracking);
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingReloadRef = useRef<boolean>(false);

  useEffect(() => {
    let dead = false;

    const connect = () => {
      if (dead) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      editorWsRef.current = ws;

      ws.onopen = () => {
        // Re-announce this tab to the client-mesh signaling relay.
        clientMesh.sendHello();
        if (pendingReloadRef.current) {
          pendingReloadRef.current = false;
          useEditorStore.getState().setPendingReload(false);
          window.location.reload();
        }
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            kind: string;
            payload: Record<string, unknown>;
          };
          if (msg.kind === SYNC_MESSAGE_KIND) {
            // Unified sync layer: route every envelope through one dispatcher.
            // Unmigrated resource types are ignored, so this coexists with the
            // legacy bespoke kinds below during the phased migration.
            applyRemote(msg.payload as unknown as SyncEnvelope);
            return;
          }
          if (msg.kind === 'vmc_status') {
            setVmcStatus(
              msg.payload.behaviorId as string,
              msg.payload.connected as boolean
            );
          } else if (msg.kind === 'vmc_tracking_state') {
            setVmcTracking(
              msg.payload.behaviorId as string,
              msg.payload.tracking as boolean
            );
          } else if (msg.kind === 'vmc_pose') {
            setVmcPose(
              msg.payload.nodeId as string,
              msg.payload.bones as Record<
                string,
                [number, number, number, number]
              >,
              (msg.payload.animationBlendMode as
                | AnimationBlendMode
                | undefined) ?? 'override'
            );
          } else if (msg.kind === 'vmc_blendshapes') {
            setVmcBlendshapes(
              msg.payload.nodeId as string,
              msg.payload.blendshapes as Record<string, number>
            );
          } else if (msg.kind === 'pose_ik_targets') {
            setIkTargets(
              msg.payload.nodeId as string,
              msg.payload as unknown as IkTargetFrame
            );
          } else if (msg.kind === 'api_animation') {
            const p = msg.payload as unknown as ApiAnimationMessage;
            useEditorStore.getState().setApiAnimation(
              p.nodeId,
              p.queue.length > 0 && p.startedAt != null
                ? {
                    queue: p.queue,
                    loopMode: p.loopMode,
                    startedAt: p.startedAt,
                  }
                : null
            );
          } else if (msg.kind === 'node_updated') {
            const { id, ...updates } = msg.payload as { id: string } & Record<
              string,
              unknown
            >;
            useEditorStore.getState().updateNode(id, updates);
          } else if (msg.kind === 'node_transform_preview') {
            // In-flight transform from another client's drag/wheel; tween the
            // displayed value towards it instead of snapping. The originating
            // client follows up with a node_updated when the gesture settles.
            const p = msg.payload as {
              nodeId: string;
              transform: Record<string, number>;
            };
            smoothNodeTransform(p.nodeId, p.transform);
          } else if (msg.kind === 'node_added') {
            const store = useEditorStore.getState();
            const node = msg.payload as unknown as StageObject;
            // Only add if we have this scene loaded; avoid duplicates
            if (store.nodes.every((n) => n.id !== node.id)) {
              store.addNode(node);
            }
          } else if (msg.kind === 'behavior_added') {
            const behavior = mapBehavior(msg.payload);
            const store = useEditorStore.getState();
            // Dedupe: the originating client may have refetched already.
            if (store.behaviors.every((b) => b.id !== behavior.id)) {
              store.addBehavior(behavior);
            }
          } else if (msg.kind === 'node_removed') {
            useEditorStore.getState().deleteNode(msg.payload.id as string);
          } else if (msg.kind === 'scene_removed') {
            useEditorStore.getState().removeScene(msg.payload.id as string);
          } else if (msg.kind === 'scene_updated') {
            const p = msg.payload as {
              id: string;
              name?: string;
              runtimeSettings?: Record<string, unknown>;
            };
            const patch: Record<string, unknown> = {};
            if (p.name != null) patch.name = p.name;
            if (p.runtimeSettings != null)
              patch.runtimeSettings = p.runtimeSettings;
            useEditorStore.getState().updateSceneItem(p.id, patch);
          } else if (msg.kind === 'camera_effect_added') {
            const p = msg.payload as Record<string, unknown>;
            const effect: CameraEffectRecord = {
              id: p.id as string,
              nodeId: (p.node_id ?? p.nodeId) as string,
              kind: p.kind as string,
              enabled: Boolean(p.enabled),
              config:
                typeof p.config === 'string'
                  ? JSON.parse(p.config)
                  : ((p.config as Record<string, unknown>) ?? {}),
            };
            const store = useEditorStore.getState();
            if (store.cameraEffects.every((e) => e.id !== effect.id))
              store.addCameraEffect(effect);
          } else if (msg.kind === 'camera_effect_updated') {
            const p = msg.payload as {
              id: string;
              enabled?: boolean;
              config?: Record<string, unknown>;
            };
            useEditorStore.getState().updateCameraEffect(p.id, {
              ...(p.enabled != null ? { enabled: p.enabled } : {}),
              ...(p.config != null ? { config: p.config } : {}),
            });
          } else if (msg.kind === 'camera_effect_removed') {
            useEditorStore
              .getState()
              .removeCameraEffect(msg.payload.id as string);
          } else if (msg.kind === 'compose_layer_added') {
            const added = mapComposeLayer(msg.payload);
            if (added.kind === 'compose_scene') {
              useEditorStore.getState().addComposeScene(added);
            } else {
              useEditorStore.getState().addComposeLayer(added);
            }
          } else if (msg.kind === 'compose_layer_updated') {
            // Final committed state from a PUT. Route through the smoother so
            // numeric fields (x/y/w/h/rotation) tween from the last preview
            // into the canonical value instead of snapping.
            const layer = mapComposeLayer(msg.payload);
            smoothComposeLayer(
              layer.id,
              layer as unknown as Record<string, unknown>
            );
          } else if (msg.kind === 'compose_layer_removed') {
            const removedId = msg.payload.id as string;
            const st = useEditorStore.getState();
            if (st.composeScenes.some((cs) => cs.id === removedId)) {
              st.removeComposeScene(removedId);
            } else {
              st.removeComposeLayer(removedId);
            }
          } else if (msg.kind === 'compose_layer_preview') {
            const p = msg.payload as {
              id: string;
              patch: Record<string, unknown>;
            };
            // Tween numeric fields (x/y/width/height/rotation); apply other
            // fields immediately. Mirrors the smoothing applied to 3D node previews.
            smoothComposeLayer(p.id, p.patch);
          } else if (msg.kind === 'compose_layer_reordered') {
            const updates = (msg.payload.updates ?? []) as {
              id: string;
              sceneOrder: number;
              cameraOrder: number;
            }[];
            const store = useEditorStore.getState();
            for (const u of updates) {
              store.updateComposeLayerLocal(u.id, {
                sceneOrder: u.sceneOrder,
                cameraOrder: u.cameraOrder,
              });
            }
          } else if (msg.kind === 'track_clip_added') {
            useEditorStore.getState().addTrackClip(mapTrackClip(msg.payload));
          } else if (msg.kind === 'track_clip_updated') {
            useEditorStore
              .getState()
              .updateTrackClipLocal(mapTrackClip(msg.payload));
          } else if (msg.kind === 'track_clip_removed') {
            useEditorStore.getState().removeTrackClip(msg.payload.id as string);
          } else if (msg.kind === 'track_clip_lane_added') {
            const lane = mapTrackClipLane(msg.payload);
            useEditorStore.getState().addTrackClipLane(lane.clipId, lane);
          } else if (msg.kind === 'track_clip_lane_updated') {
            useEditorStore
              .getState()
              .updateTrackClipLaneLocal(mapTrackClipLane(msg.payload));
          } else if (msg.kind === 'track_clip_lane_removed') {
            useEditorStore
              .getState()
              .removeTrackClipLane(
                msg.payload.id as string,
                (msg.payload.clipId ?? null) as string | null
              );
          } else if (msg.kind === 'track_clip_keyframes_replaced') {
            const laneId = msg.payload.laneId as string;
            const rows =
              (msg.payload.keyframes as Record<string, unknown>[]) ?? [];
            useEditorStore
              .getState()
              .replaceTrackClipLaneKeyframes(
                laneId,
                rows.map(mapTrackClipKeyframe)
              );
          } else if (msg.kind === 'track_clip_events_replaced') {
            const clipId = msg.payload.clipId as string;
            const rows =
              (msg.payload.events as Record<string, unknown>[]) ?? [];
            useEditorStore
              .getState()
              .replaceTrackClipEvents(clipId, rows.map(mapTrackClipEvent));
          } else if (msg.kind === 'track_clip_started') {
            const p = msg.payload as {
              clipId: string;
              startedAt: number;
              loop: boolean;
              serverNow: number;
            };
            const clockOffsetMs = p.serverNow - Date.now();
            // Any pending user-override suppressions are dropped: triggering /
            // resuming / seeking re-asserts the clip as the source of truth.
            useEditorStore.getState().clearOverrideSuppressions();
            useEditorStore.getState().setTrackClipPlayback(p.clipId, {
              kind: 'playing',
              startedAt: p.startedAt,
              loop: p.loop,
              clockOffsetMs,
            });
          } else if (msg.kind === 'track_clip_paused') {
            const p = msg.payload as {
              clipId: string;
              pausedAtT: number;
              serverNow: number;
            };
            const clockOffsetMs = p.serverNow - Date.now();
            const prev = useEditorStore.getState().trackClipPlayback[p.clipId];
            const loop = prev?.loop ?? false;
            // Pausing here is reached via the Pause button OR a Seek operation;
            // either way we want the clip's value back in the inputs.
            useEditorStore.getState().clearOverrideSuppressions();
            useEditorStore.getState().setTrackClipPlayback(p.clipId, {
              kind: 'paused',
              pausedAtT: p.pausedAtT,
              loop,
              clockOffsetMs,
            });
          } else if (msg.kind === 'track_clip_stopped') {
            useEditorStore
              .getState()
              .setTrackClipPlayback(msg.payload.clipId as string, null);
            useEditorStore.getState().clearOverrideSuppressions();
          } else if (msg.kind === 'track_clip_playback_snapshot') {
            const p = msg.payload as {
              entries: {
                clipId: string;
                loop: boolean;
                startedAt?: number;
                pausedAtT?: number;
              }[];
              serverNow: number;
            };
            const clockOffsetMs = p.serverNow - Date.now();
            const next: Record<
              string,
              import('../store/editorStore').TrackClipPlayback
            > = {};
            for (const e of p.entries ?? []) {
              if (e.startedAt != null) {
                next[e.clipId] = {
                  kind: 'playing',
                  startedAt: e.startedAt,
                  loop: e.loop,
                  clockOffsetMs,
                };
              } else if (e.pausedAtT != null) {
                next[e.clipId] = {
                  kind: 'paused',
                  pausedAtT: e.pausedAtT,
                  loop: e.loop,
                  clockOffsetMs,
                };
              }
            }
            useEditorStore.getState().clearOverrideSuppressions();
            useEditorStore.getState().replaceTrackClipPlayback(next);
          } else if (msg.kind === 'runtime_override_set') {
            const p = msg.payload as {
              targetKind: 'scene_node' | 'compose_layer';
              targetId: string;
              paramPath: string;
              value: number | string | boolean;
            };
            useEditorStore
              .getState()
              .setRuntimeOverride(
                p.targetKind,
                p.targetId,
                p.paramPath,
                p.value
              );
          } else if (msg.kind === 'runtime_override_clear') {
            const p = msg.payload as {
              targetKind: 'scene_node' | 'compose_layer';
              targetId: string;
              paramPath?: string;
            };
            useEditorStore
              .getState()
              .clearRuntimeOverride(p.targetKind, p.targetId, p.paramPath);
          } else if (msg.kind === 'runtime_override_snapshot') {
            const p = msg.payload as {
              entries: Array<{
                targetKind: 'scene_node' | 'compose_layer';
                targetId: string;
                paramPath: string;
                value: number | string | boolean;
              }>;
            };
            useEditorStore.getState().replaceRuntimeOverrides(p.entries ?? []);
          } else if (msg.kind === 'media_control') {
            const p = msg.payload as {
              targetId: string;
              command: MediaCommand;
            };
            dispatchMediaCommand(p.targetId, p.command);
          } else if (msg.kind === 'data_channel_set') {
            const p = msg.payload as {
              scope: string;
              fields: Record<string, unknown>;
            };
            useEditorStore
              .getState()
              .mergeDataChannels(p.scope ?? '', p.fields ?? {});
          } else if (msg.kind === 'data_channel_clear') {
            const p = msg.payload as { scope: string; field?: string };
            useEditorStore.getState().clearDataChannels(p.scope ?? '', p.field);
          } else if (msg.kind === 'data_channel_snapshot') {
            const p = msg.payload as {
              entries: Array<{
                scope: string;
                fields: Record<string, unknown>;
              }>;
            };
            useEditorStore.getState().replaceDataChannels(p.entries ?? []);
          } else if (msg.kind === 'mp_status') {
            useConnectionsStore
              .getState()
              .setStatus(
                msg.payload.status as 'idle' | 'connecting' | 'ready' | 'closed'
              );
          } else if (msg.kind === 'mp_peer') {
            const p = msg.payload as {
              peerId: string;
              connected?: boolean;
              paired?: boolean;
              displayName?: string;
            };
            if (typeof p.connected === 'boolean')
              useConnectionsStore
                .getState()
                .setConnected(p.peerId, p.connected, p.displayName);
            // New pairing (or unknown peer) → refetch the authoritative list.
            useConnectionsStore.getState().bumpRevision();
          } else if (msg.kind === 'mp_presence') {
            // Presence reflected via lastSeen refresh on the next list fetch.
            useConnectionsStore.getState().bumpRevision();
          } else if (msg.kind === 'mp_connect_request') {
            const p = msg.payload as { peerId: string; displayName: string };
            useConnectionsStore
              .getState()
              .addIncoming({ peerId: p.peerId, displayName: p.displayName });
          } else if (msg.kind === 'mp_shares') {
            // A connected peer advertised the objects it shares with us.
            const p = msg.payload as {
              peerId: string;
              shares: import('../store/connectionsStore').SharedOffer[];
            };
            useConnectionsStore
              .getState()
              .setOffers(p.peerId, p.shares ?? []);
          } else if (msg.kind === 'mp_collab_offer') {
            // A peer offered a scene for collaborative (persisted, two-way)
            // editing — surface it so we can mount it into a local project.
            const p = msg.payload as {
              peerId: string;
              sceneId: string;
              name: string;
            };
            useConnectionsStore
              .getState()
              .addCollabOffer(p.peerId, { sceneId: p.sceneId, name: p.name });
          } else if (msg.kind === 'mp_collab_mounted') {
            // A collaborative scene was just persisted into one of our projects
            // (straight to SQLite, so no per-node sync events) — reload that
            // project's scenes so the new one appears, then focus it. Live edits
            // after this flow through the normal scene_node sync layer.
            const p = msg.payload as {
              peerId: string;
              sceneId: string;
              projectId: string;
            };
            useConnectionsStore
              .getState()
              .clearCollabOffer(p.peerId, p.sceneId);
            const ed = useEditorStore.getState();
            if (ed.projectId === p.projectId) {
              void getScenes(p.projectId)
                .then((data) => {
                  const s = useEditorStore.getState();
                  s.setScenes(data.scenes);
                  s.setNodes(data.nodes);
                  s.setBehaviors(data.behaviors);
                  s.setCameraEffects(data.cameraEffects);
                  s.setActiveScene(p.sceneId);
                })
                .catch(() => {});
            }
          } else if (msg.kind === 'mp_shared_snapshot') {
            const p = msg.payload as {
              peerId: string;
              snapshot: { objectId: string };
            };
            applySharedSnapshot(
              p.peerId,
              p.snapshot as unknown as Parameters<typeof applySharedSnapshot>[1]
            );
            useConnectionsStore
              .getState()
              .setSubscribed(p.peerId, p.snapshot.objectId, true);
          } else if (msg.kind === 'mp_shared_update') {
            const p = msg.payload as {
              peerId: string;
              objectId: string;
              env: SyncEnvelope;
            };
            applySharedUpdate(p.peerId, p.objectId, p.env);
          } else if (msg.kind === 'mp_shared_unshared') {
            const p = msg.payload as { peerId: string; objectId: string };
            removeSharedProjection(p.peerId, p.objectId);
            useConnectionsStore
              .getState()
              .setSubscribed(p.peerId, p.objectId, false);
          } else if (msg.kind === 'mp_shared_write_nak') {
            // Owner rejected our optimistic write (relay path) → roll back.
            const p = msg.payload as { id?: string; objectId?: string };
            rollbackWrite((p.id ?? p.objectId) as string);
          } else if (msg.kind === 'mp_shared_gone') {
            const p = msg.payload as { peerId: string };
            removePeerSharedProjections(p.peerId);
            useConnectionsStore.getState().clearPeerSharing(p.peerId);
          } else if (msg.kind === 'mp_shared_stream') {
            // Live pose/blendshapes for a placed shared avatar. The frame keeps
            // the owner's node id, which the projection preserves, so it applies
            // directly to the projected node.
            const p = msg.payload as {
              kind: string;
              payload: Record<string, unknown>;
            };
            const f = p.payload ?? {};
            if (p.kind === 'vmc_pose') {
              setVmcPose(
                f.nodeId as string,
                f.bones as Record<string, [number, number, number, number]>,
                (f.animationBlendMode as AnimationBlendMode | undefined) ??
                  'override'
              );
            } else if (p.kind === 'vmc_blendshapes') {
              setVmcBlendshapes(
                f.nodeId as string,
                f.blendshapes as Record<string, number>
              );
            } else if (p.kind === 'pose_ik_targets') {
              setIkTargets(f.nodeId as string, f as unknown as IkTargetFrame);
            } else if (p.kind === 'node_transform_preview') {
              // Smooth in-flight drag of a shared object on the receiver.
              smoothNodeTransform(
                f.nodeId as string,
                f.transform as Record<string, number>
              );
            }
          } else if (msg.kind === 'mp_shared_override') {
            // Graph-driven runtime override on a shared node (owner ids are
            // preserved by the projection, so it applies to the projected node).
            const p = msg.payload as {
              op: 'set' | 'clear';
              targetKind: 'scene_node' | 'compose_layer';
              targetId: string;
              paramPath?: string;
              value?: number | string | boolean;
            };
            if (p.op === 'set' && p.paramPath != null && p.value != null) {
              useEditorStore
                .getState()
                .setRuntimeOverride(
                  p.targetKind,
                  p.targetId,
                  p.paramPath,
                  p.value
                );
            } else if (p.op === 'clear') {
              useEditorStore
                .getState()
                .clearRuntimeOverride(p.targetKind, p.targetId, p.paramPath);
            }
          } else if (msg.kind === 'mp_shared_datachannel') {
            // Data channel scoped to a shared node (scope = owner node id, which
            // the projection preserves, so the projected feed/template resolves it).
            const p = msg.payload as {
              op: 'set' | 'clear';
              scope: string;
              fields?: Record<string, unknown>;
              field?: string;
            };
            if (p.op === 'set') {
              useEditorStore
                .getState()
                .mergeDataChannels(p.scope ?? '', p.fields ?? {});
            } else {
              useEditorStore.getState().clearDataChannels(p.scope ?? '', p.field);
            }
          } else if (msg.kind === 'mesh_roster') {
            const p = msg.payload as { participants?: string[] };
            clientMesh.setRoster(p.participants ?? []);
          } else if (msg.kind === 'mesh_signal') {
            const p = msg.payload as { from?: string; data?: unknown };
            if (p.from)
              void clientMesh.handleSignal(
                p.from,
                p.data as Parameters<typeof clientMesh.handleSignal>[1]
              );
          } else if (msg.kind === 'server_update') {
            if (
              (msg.payload as { reloadOnReconnect?: boolean }).reloadOnReconnect
            ) {
              pendingReloadRef.current = true;
              useEditorStore.getState().setPendingReload(true);
            }
          }
        } catch {
          /* ignore malformed */
        }
      };

      ws.onclose = () => {
        if (!dead) timerRef.current = setTimeout(connect, RECONNECT_MS);
      };
    };

    connect();
    return () => {
      dead = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [setVmcStatus, setVmcTracking]);
}
