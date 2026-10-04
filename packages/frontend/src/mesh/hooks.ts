/**
 * The app's typed reads of the replica: one hook per document type, on the
 * generic `@vspark/mesh-react` hooks. The peer is provided before the first
 * render (`<MeshProvider>` in main.tsx), so every hook here reads a collection
 * that exists; scene nodes and compose layers have their own modules (./nodes,
 * ./compose), runtime state too (./runtime).
 *
 * Granularity is the point of a per-document hook: `useMeshDoc(col, id)`
 * re-renders when THAT document changes, while a hook over a whole collection
 * re-renders on any change in it.
 */
import {
  useCollection,
  useMeshAll,
  useMeshChildren,
  useMeshDoc,
  useMeshSelector,
} from '@vspark/mesh-react';
import {
  useEditorStore,
  type AnimationClipMeta,
  type Behavior,
  type ClipPlayback,
  type ScheduledAnimation,
} from '../store/editorStore';
import { playbackDocId } from '@vspark/shared/clipPlayback';
import {
  mapLogic,
  mapTrackClip,
  type TrackClipRecord,
  type CameraEffectRecord,
  type ComposeLayerRecord,
  type LogicRecord,
  type RawLogic,
} from '../api/client';

// --- per-document reads ------------------------------------------------------

/** One scene node (see ./nodes). */
export { useSceneNode } from './nodes';

/** One compose layer, watched individually: re-renders only when it changes. */
export function useComposeLayer(id: string | null | undefined) {
  const doc = useMeshDoc(
    useCollection<ComposeLayerRecord>('compose_layer'),
    id ?? ''
  );
  const live = useEditorStore((s) => (id ? s.liveLayers[id] : undefined));
  if (!id || !doc) return undefined;
  return live ? { ...doc, ...live } : doc;
}

/** The camera effects on a node, live from the replica. */
export function useCameraEffects(
  nodeId: string | null | undefined
): CameraEffectRecord[] {
  const col = useCollection<CameraEffectRecord>('camera_effect');
  return useMeshChildren(col, nodeId ?? '');
}

/** The behaviors on a node, live from the replica. */
export function useNodeBehaviors(
  nodeId: string | null | undefined
): Behavior[] {
  const col = useCollection<Behavior>('behavior');
  return useMeshChildren(col, nodeId ?? '');
}

/** Every behavior this tab holds, live (filter by node where it matters: the
 *  tab's subscription spans the server). */
export function useAllBehaviors(): Behavior[] {
  return useMeshAll(useCollection<Behavior>('behavior'));
}

/** A mocap receiver behavior's live status (backend mesh/status.ts, kind
 *  'tracking'). It goes when the behavior does, so it cannot outlive it. */
export interface TrackingStatus {
  connected?: boolean;
  tracking?: boolean;
}

/** Every receiver's status this tab holds, by behavior id. */
export function useTrackingStatuses(): Record<string, TrackingStatus> {
  const all = useMeshAll(
    useCollection<{ id: string; kind: string; key: string } & TrackingStatus>(
      'server_status'
    )
  );
  const out: Record<string, TrackingStatus> = {};
  for (const d of all) if (d.kind === 'tracking') out[d.key] = d;
  return out;
}

/** Clip transport state, by clip id (the documents are keyed `pb:<clipId>`). */
export function useClipPlaybacks(): Record<string, ClipPlayback> {
  return useMeshSelector(
    useCollection<ClipPlayback>('clip_playback'),
    '**',
    (c) => Object.fromEntries(c.all().map((p) => [p.clipId, p]))
  );
}

/** One clip's transport state. */
export function useClipPlayback(clipId: string): ClipPlayback | undefined {
  return useMeshDoc(
    useCollection<ClipPlayback>('clip_playback'),
    playbackDocId(clipId)
  );
}

/** Imported animation clips, by id. */
export function useAnimationClips(): Record<string, AnimationClipMeta> {
  return useMeshSelector(
    useCollection<AnimationClipMeta>('animation_clip'),
    '**',
    (c) => Object.fromEntries(c.all().map((a) => [a.id, a]))
  );
}

/** An avatar's clip timeline. */
export function useNodeSchedule(nodeId: string): ScheduledAnimation[] {
  return useMeshChildren(
    useCollection<ScheduledAnimation>('scheduled_animation'),
    nodeId
  );
}

/** Document form → runtime form, once per document version: the replica hands
 *  out the same object until the document changes, so this is cached by it. */
const logicCache = new WeakMap<object, LogicRecord>();
export function logicRecordOf(
  raw: RawLogic | undefined
): LogicRecord | undefined {
  if (!raw) return undefined;
  let rec = logicCache.get(raw);
  if (!rec) logicCache.set(raw, (rec = mapLogic(raw)));
  return rec;
}

/** Every signal graph this tab holds, in runtime form, by id. */
export function useLogicRecords(): Record<string, LogicRecord> {
  return useMeshSelector(useCollection<RawLogic>('logic'), '**', (c) =>
    Object.fromEntries(c.all().map((g) => [g.id, logicRecordOf(g)!]))
  );
}

/** One signal graph, in runtime form. */
export function useLogicRecord(id: string): LogicRecord | undefined {
  return useMeshSelector(useCollection<RawLogic>('logic'), id, (c) =>
    logicRecordOf(c.get(id))
  );
}

/** Clip document (children keyed by id) → the ordered record the timeline and
 *  evaluator work with, once per document version. */
const clipCache = new WeakMap<object, TrackClipRecord>();
export function trackClipRecordOf(
  raw: Record<string, unknown> | undefined
): TrackClipRecord | undefined {
  if (!raw) return undefined;
  let rec = clipCache.get(raw);
  if (!rec) clipCache.set(raw, (rec = mapTrackClip(raw)));
  return rec;
}

/** Every track clip this tab holds, as records. */
export function useTrackClips(): TrackClipRecord[] {
  return useMeshSelector(
    useCollection<Record<string, unknown>>('track_clip'),
    '**',
    (c) => c.all().map((d) => trackClipRecordOf(d)!)
  );
}

/** One track clip, as a record. */
export function useTrackClip(id: string | null | undefined) {
  return useMeshSelector(
    useCollection<Record<string, unknown>>('track_clip'),
    id ?? '',
    (c) => trackClipRecordOf(id ? c.get(id) : undefined)
  );
}
