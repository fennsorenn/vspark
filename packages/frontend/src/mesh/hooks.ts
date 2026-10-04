/**
 * The bridge between this app's peer and `@vspark/mesh-react`.
 *
 * The hooks in that package take a `Collection` as an argument, and this tab's
 * collections only exist once `initMeshPeer()` has resolved — so a component had
 * no way to obtain one, which is why the package sat written, tested and
 * entirely unimported. These hooks close that gap: they yield the collection
 * when there is one, `undefined` before that, and re-render the caller when it
 * arrives.
 *
 * ## What reading through here buys, and what it does not
 *
 * Not "live reads" — `sync/meshStoreFeeder` already keeps the Zustand store
 * live, and most components read it perfectly well. What a collection hook adds
 * is the GRANULARITY: `useMeshDoc(col, id)` re-renders when THAT document
 * changes, where `useSceneNodes()` re-renders every subscriber
 * whenever any node anywhere changes.
 *
 * So this is worth reaching for when a component watches one document (or one
 * subtree) out of many, and not worth it for a component that already wants the
 * whole slice.
 *
 * ## Why the store is still the load path
 *
 * The editor hydrates from the REST scene bundle, which usually lands before the
 * mesh subscription snapshot. A component reading the replica directly would
 * therefore render empty during that window. Until the snapshot is the load
 * path, the store remains the thing to read for "show me everything", and these
 * hooks are for the narrower per-document reads where that window doesn't apply
 * (a doc the user has already selected, so both sources are populated).
 */
import { useEffect, useState } from 'react';
import {
  useCanWrite,
  useCollection,
  useMeshAll,
  useMeshChildren,
  useMeshDoc,
  useMeshSelector,
} from '@vspark/mesh-react';
import type { Collection, MeshPeer } from '@vspark/mesh';
import { getMeshHandles, onMeshReady, type MeshHandles } from './peer';
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

type Dto = Record<string, unknown>;

/** The tab's handles once the peer is up, `null` before. Re-renders on arrival. */
export function useMeshHandles(): MeshHandles | null {
  const [handles, setHandles] = useState<MeshHandles | null>(() =>
    getMeshHandles()
  );
  useEffect(() => onMeshReady(setHandles), []);
  return handles;
}

/** One bound collection, or `undefined` before the peer is up. */
export function useMeshCollection<T extends object = Dto>(
  rtype: string
): Collection<T> | undefined {
  return useMeshHandles()?.collections[rtype] as Collection<T> | undefined;
}

/** The tab's peer, or `undefined` before it is up. */
export function useMeshPeer(): MeshPeer | undefined {
  return useMeshHandles()?.peer;
}

/**
 * Whether an edit to this rtype can currently land on the mesh.
 *
 * `false` means the tab peer isn't up or its authority is unreachable. Writes
 * still work in that state — the helpers fall back to REST — so this is not a
 * disable signal on its own. It is the honest input for telling the user that
 * an edit is taking the slower path, next to {@link ./writeFeedback}, which
 * tells them when one was refused outright.
 *
 * Returns `true` when the peer is not up at all: a control must not render
 * disabled during the async init window, when nothing is wrong yet.
 */
export function useMeshCanWrite(rtype: string): boolean {
  const handles = useMeshHandles();
  const col = handles?.collections[rtype];
  return useCanWriteSafe(handles?.peer, col);
}

/** `useCanWrite` needs both a peer and a collection; hooks must be called
 *  unconditionally, so the null window is handled here rather than by every
 *  caller writing the same guard. */
function useCanWriteSafe(
  peer: MeshPeer | undefined,
  col: Collection<Dto> | undefined
): boolean {
  // A stand-in with the same shape keeps the hook call unconditional while the
  // peer is still starting. `onStatus` returns a no-op unsubscribe, so nothing
  // is registered and nothing leaks.
  const stubPeer = usePeerStub();
  const stubCol = useColStub();
  return useCanWrite(peer ?? stubPeer, col ?? stubCol);
}

let _peerStub: MeshPeer | null = null;
let _colStub: Collection<Dto> | null = null;

function usePeerStub(): MeshPeer {
  if (!_peerStub)
    _peerStub = {
      status: () => ({ peers: [], pending: 0 }),
      onStatus: () => () => {},
    } as unknown as MeshPeer;
  return _peerStub;
}

function useColStub(): Collection<Dto> {
  if (!_colStub)
    // `true`, not `false`: before the peer exists nothing is wrong, and a
    // control that renders itself as degraded during startup is lying.
    _colStub = { canWrite: () => true } as unknown as Collection<Dto>;
  return _colStub;
}

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
