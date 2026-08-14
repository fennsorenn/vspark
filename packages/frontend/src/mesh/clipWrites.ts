/**
 * Track-clip writes on the mesh, per element.
 *
 * A clip is one document with its lanes, keyframes and event markers keyed by
 * id (@vspark/shared/idMap), so an edit addresses the element it changes:
 * `lanes.<laneId>.keyframes.<kfId>`. That is the whole point of the keying —
 * two people editing different keyframes of the same lane no longer overwrite
 * each other, and one dragged keyframe is one undo step rather than a rewrite
 * of the lane.
 *
 * Two channels, as everywhere else:
 *
 *   - `previewKeyframe` — the in-flight drag, on the lossy `preview` channel.
 *     Other tabs watch the keyframe move; no persistence, no undo entry, and
 *     the overlay clears when the commit lands. One overlay per keyframe,
 *     carrying the whole keyframe object: a drag moves `t` and `value`
 *     together, and a handle drag moves both fractions.
 *   - `commit*` — the settled edit. One call, one undo step.
 *
 * The REST fallbacks (peer not armed / authority offline) are per-endpoint and
 * list-shaped, because that is the API outside services have: the helper
 * rebuilds the list from the store and PUTs it. Those writes are authored by
 * the server, so they are not undoable — the honest consequence, same as
 * everywhere else.
 */
import { getMeshHandles, meshBatch } from './peer';
import { playbackDocId } from '@vspark/shared/clipPlayback';
import { useEditorStore } from '../store/editorStore';
import {
  api,
  type TrackClipRecord,
  type TrackClipLaneRecord,
  type TrackClipKeyframeRecord,
  type TrackClipEventRecord,
} from '../api/client';

const col = () => getMeshHandles()?.collections.track_clip;

/** Whether the tab peer can author this clip right now. */
function authored(clipId: string): boolean {
  const c = col();
  return !!c?.canWrite() && !!c.get(clipId);
}

const clipOf = (clipId: string): TrackClipRecord | undefined =>
  useEditorStore.getState().trackClips.find((c) => c.id === clipId);

const laneOf = (
  clipId: string,
  laneId: string
): TrackClipLaneRecord | undefined =>
  clipOf(clipId)?.lanes.find((l) => l.id === laneId);

// --- clip fields --------------------------------------------------------------

/** Patch a clip's own fields (name, duration, loop, mode, autoplay). */
export function commitClipPatch(
  clipId: string,
  patch: Partial<
    Pick<TrackClipRecord, 'name' | 'duration' | 'loop' | 'mode' | 'autoplay'>
  >
): void {
  if (authored(clipId)) {
    col()!.update(clipId, patch);
    return;
  }
  const cur = clipOf(clipId);
  if (cur) useEditorStore.getState().updateTrackClipLocal({ ...cur, ...patch });
  void api.updateTrackClip(clipId, patch).catch(() => {});
}

// --- lanes --------------------------------------------------------------------

/** Add a lane. The id is minted here so the create is authored by this tab and
 *  lands on its undo stack. */
export async function commitLaneCreate(
  clipId: string,
  spec: {
    targetKind: TrackClipLaneRecord['targetKind'];
    targetId: string;
    paramPath: string;
    defaultValue: number;
  }
): Promise<TrackClipLaneRecord> {
  const lane: TrackClipLaneRecord = {
    id: crypto.randomUUID(),
    clipId,
    ...spec,
    keyframes: [],
  };
  if (authored(clipId)) {
    // Keyframes go over as a map — this is the document shape, not the store's.
    await col()!.set(clipId, `lanes.${lane.id}`, { ...lane, keyframes: {} })
      .ack;
    // The feeder mirrors the replica into the store; nothing to apply here.
    return lane;
  }
  const created = await api.createTrackClipLane(clipId, spec);
  useEditorStore.getState().addTrackClipLane(clipId, created);
  return created;
}

/** Remove a lane. On the mesh that is a null at its path — `set` can write a
 *  key but not remove one, and readers skip nulls (idMap.ts). */
export async function commitLaneDelete(
  clipId: string,
  laneId: string
): Promise<void> {
  if (authored(clipId)) {
    await col()!.set(clipId, `lanes.${laneId}`, null).ack;
    return;
  }
  await api.deleteTrackClipLane(laneId).catch(() => {});
  useEditorStore.getState().removeTrackClipLane(laneId, clipId);
}

/** Patch a lane's own fields, leaving its keyframes alone. */
export function commitLanePatch(
  clipId: string,
  laneId: string,
  patch: Partial<Omit<TrackClipLaneRecord, 'id' | 'clipId' | 'keyframes'>>
): void {
  if (authored(clipId)) {
    for (const [k, v] of Object.entries(patch))
      col()!.set(clipId, `lanes.${laneId}.${k}`, v);
    return;
  }
  const lane = laneOf(clipId, laneId);
  if (lane)
    useEditorStore.getState().updateTrackClipLaneLocal({ ...lane, ...patch });
  void api.updateTrackClipLane(laneId, patch).catch(() => {});
}

// --- keyframes ----------------------------------------------------------------

/** The lane's keyframes with `kf` inserted or replaced, in `t` order — the list
 *  shape the store and the REST endpoint both want. */
function withKeyframe(
  lane: TrackClipLaneRecord,
  kf: TrackClipKeyframeRecord
): TrackClipKeyframeRecord[] {
  const rest = lane.keyframes.filter((k) => k.id !== kf.id);
  return [...rest, kf].sort((a, b) => a.t - b.t);
}

/** In-flight keyframe drag: an overlay at this keyframe's path, so watching
 *  tabs see it move without it ever becoming model state. */
export function previewKeyframe(
  clipId: string,
  laneId: string,
  kf: TrackClipKeyframeRecord
): void {
  if (authored(clipId)) {
    col()!.set(clipId, `lanes.${laneId}.keyframes.${kf.id}`, kf, {
      channel: 'preview',
    });
    return;
  }
  // No peer to fan out to — still track the drag locally.
  const lane = laneOf(clipId, laneId);
  if (lane)
    useEditorStore
      .getState()
      .replaceTrackClipLaneKeyframes(laneId, withKeyframe(lane, kf));
}

/** Settled keyframe edit — one committed write, one undo step. */
export function commitKeyframe(
  clipId: string,
  laneId: string,
  kf: TrackClipKeyframeRecord
): void {
  if (authored(clipId)) {
    col()!.set(clipId, `lanes.${laneId}.keyframes.${kf.id}`, kf);
    return;
  }
  const lane = laneOf(clipId, laneId);
  if (!lane) return;
  const next = withKeyframe(lane, kf);
  useEditorStore.getState().replaceTrackClipLaneKeyframes(laneId, next);
  void api.replaceTrackClipKeyframes(laneId, next).catch(() => {});
}

export function commitKeyframeDelete(
  clipId: string,
  laneId: string,
  keyframeId: string
): void {
  if (authored(clipId)) {
    col()!.set(clipId, `lanes.${laneId}.keyframes.${keyframeId}`, null);
    return;
  }
  const lane = laneOf(clipId, laneId);
  if (!lane) return;
  const next = lane.keyframes.filter((k) => k.id !== keyframeId);
  useEditorStore.getState().replaceTrackClipLaneKeyframes(laneId, next);
  void api.replaceTrackClipKeyframes(laneId, next).catch(() => {});
}

// --- event markers ------------------------------------------------------------

function withEvent(
  clip: TrackClipRecord,
  ev: TrackClipEventRecord
): TrackClipEventRecord[] {
  const rest = clip.events.filter((e) => e.id !== ev.id);
  return [...rest, ev].sort((a, b) => a.t - b.t);
}

/** Add or update one marker. */
export function commitEvent(clipId: string, ev: TrackClipEventRecord): void {
  if (authored(clipId)) {
    col()!.set(clipId, `events.${ev.id}`, ev);
    return;
  }
  const clip = clipOf(clipId);
  if (!clip) return;
  const next = withEvent(clip, ev);
  useEditorStore.getState().replaceTrackClipEvents(clipId, next);
  void api.replaceTrackClipEvents(clipId, next).catch(() => {});
}

export function commitEventDelete(clipId: string, eventId: string): void {
  if (authored(clipId)) {
    col()!.set(clipId, `events.${eventId}`, null);
    return;
  }
  const clip = clipOf(clipId);
  if (!clip) return;
  const next = clip.events.filter((e) => e.id !== eventId);
  useEditorStore.getState().replaceTrackClipEvents(clipId, next);
  void api.replaceTrackClipEvents(clipId, next).catch(() => {});
}

// --- the clip itself ----------------------------------------------------------

/** Create a clip on a node or a compose layer. The id is minted here so the
 *  create is authored by this tab and can be undone. */
export async function commitClipCreate(
  owner:
    | { kind: 'scene_node'; id: string }
    | { kind: 'compose_layer'; id: string },
  spec: { name: string; duration?: number; loop?: boolean; mode?: string }
): Promise<TrackClipRecord> {
  const clip: TrackClipRecord = {
    id: crypto.randomUUID(),
    ownerNodeId: owner.kind === 'scene_node' ? owner.id : null,
    ownerLayerId: owner.kind === 'compose_layer' ? owner.id : null,
    name: spec.name,
    duration: spec.duration ?? 2,
    loop: spec.loop ?? false,
    mode: (spec.mode ?? 'override') as TrackClipRecord['mode'],
    autoplay: false,
    lanes: [],
    events: [],
  };
  const c = col();
  if (c?.canWrite()) {
    const outcome = await c.set(clip.id, '', {
      ...clip,
      // Document shape: children keyed by id, empty at birth.
      lanes: {},
      events: {},
    }).ack;
    if (outcome.status === 'rejected')
      throw new Error(outcome.reason ?? 'clip create refused');
    return clip;
  }
  const body = { name: clip.name, duration: clip.duration };
  const created =
    owner.kind === 'scene_node'
      ? await api.createTrackClipForNode(owner.id, body)
      : await api.createTrackClipForLayer(owner.id, body);
  useEditorStore.getState().addTrackClip(created);
  return created;
}

/** Delete a clip and its transport document.
 *
 *  Both, always: removing the clip row while leaving the playback document
 *  alive would leave every replica holding transport state for a clip that no
 *  longer exists — the same orphan the DELETE route removes by hand. One batch,
 *  so undo restores the pair together. */
export async function commitClipDelete(clipId: string): Promise<void> {
  const c = col();
  const playback = getMeshHandles()?.collections.clip_playback;
  if (c?.canWrite() && c.get(clipId)) {
    const acks = meshBatch(() => {
      const out = [c.remove(clipId).ack];
      const doc = playback?.get(playbackDocId(clipId));
      if (doc) out.push(playback!.remove(playbackDocId(clipId)).ack);
      return out;
    });
    await Promise.all(acks);
    return;
  }
  useEditorStore.getState().removeTrackClip(clipId);
  await api.deleteTrackClip(clipId).catch(() => {});
}
