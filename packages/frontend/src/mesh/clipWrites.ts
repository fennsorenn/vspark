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
 * Deleting an element is a null at its path: `set` can write a key but not
 * remove one, and readers skip nulls (idMap.ts).
 */
import { meshBatch } from './peer';
import { collectionOf, createDoc, setField } from './docs';
import { actionLabel, settled, watch } from './writeFeedback';
import { playbackDocId } from '@vspark/shared/clipPlayback';
import type {
  TrackClipRecord,
  TrackClipLaneRecord,
  TrackClipKeyframeRecord,
  TrackClipEventRecord,
} from '../api/client';

const RTYPE = 'track_clip';
const col = () => collectionOf(RTYPE);
const subject = () => actionLabel(RTYPE);

// --- clip fields --------------------------------------------------------------

/** Patch a clip's own fields (name, duration, loop, mode, autoplay). */
export function commitClipPatch(
  clipId: string,
  patch: Partial<
    Pick<TrackClipRecord, 'name' | 'duration' | 'loop' | 'mode' | 'autoplay'>
  >
): void {
  if (!col().get(clipId)) return;
  watch(col().update(clipId, patch).ack, subject());
}

// --- lanes --------------------------------------------------------------------

/** Add a lane. */
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
  // Keyframes go over as a map — the document shape, not the record's.
  const h = setField(RTYPE, clipId, `lanes.${lane.id}`, {
    ...lane,
    keyframes: {},
  });
  if (h) settled(await h.ack, subject());
  return lane;
}

/** Remove a lane. */
export async function commitLaneDelete(
  clipId: string,
  laneId: string
): Promise<void> {
  const h = setField(RTYPE, clipId, `lanes.${laneId}`, null);
  if (h) settled(await h.ack, subject());
}

/** Patch a lane's own fields, leaving its keyframes alone. */
export function commitLanePatch(
  clipId: string,
  laneId: string,
  patch: Partial<Omit<TrackClipLaneRecord, 'id' | 'clipId' | 'keyframes'>>
): void {
  for (const [k, v] of Object.entries(patch))
    setField(RTYPE, clipId, `lanes.${laneId}.${k}`, v);
}

// --- keyframes ----------------------------------------------------------------

/** In-flight keyframe drag: an overlay at this keyframe's path, so watching
 *  tabs see it move without it ever becoming model state. */
export function previewKeyframe(
  clipId: string,
  laneId: string,
  kf: TrackClipKeyframeRecord
): void {
  if (!col().get(clipId)) return;
  col().set(clipId, `lanes.${laneId}.keyframes.${kf.id}`, kf, {
    channel: 'preview',
  });
}

/** Settled keyframe edit — one committed write, one undo step. */
export function commitKeyframe(
  clipId: string,
  laneId: string,
  kf: TrackClipKeyframeRecord
): void {
  setField(RTYPE, clipId, `lanes.${laneId}.keyframes.${kf.id}`, kf);
}

export function commitKeyframeDelete(
  clipId: string,
  laneId: string,
  keyframeId: string
): void {
  setField(RTYPE, clipId, `lanes.${laneId}.keyframes.${keyframeId}`, null);
}

// --- event markers ------------------------------------------------------------

/** Add or update one marker. */
export function commitEvent(clipId: string, ev: TrackClipEventRecord): void {
  setField(RTYPE, clipId, `events.${ev.id}`, ev);
}

export function commitEventDelete(clipId: string, eventId: string): void {
  setField(RTYPE, clipId, `events.${eventId}`, null);
}

// --- the clip itself ----------------------------------------------------------

/** Create a clip on a node or a compose layer. */
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
  // Document shape: children keyed by id, empty at birth.
  await createDoc(RTYPE, { ...clip, lanes: {}, events: {} });
  return clip;
}

/** Delete a clip and its transport document.
 *
 *  Both, always: removing the clip while leaving the playback document alive
 *  would leave every replica holding transport state for a clip that no
 *  longer exists. One batch, so undo restores the pair together. */
export async function commitClipDelete(clipId: string): Promise<void> {
  const c = col();
  if (!c.get(clipId)) return;
  const playback = collectionOf('clip_playback');
  const acks = meshBatch(() => {
    const out = [c.remove(clipId).ack];
    if (playback.get(playbackDocId(clipId)))
      out.push(playback.remove(playbackDocId(clipId)).ack);
    return out;
  });
  for (const o of await Promise.all(acks)) settled(o, subject());
}
