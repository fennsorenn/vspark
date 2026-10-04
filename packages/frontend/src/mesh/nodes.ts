/**
 * Scene nodes and scenes, read from the replica.
 *
 * One rtype (`scene_node`); a scene is the root node of its tree
 * (`kind: 'scene'`). The tab subscribes server-wide, so these hooks keep to the
 * open project — including the collab scenes mounted into it, whose documents
 * keep their author's projectId (which project of ours a mounted scene lives in
 * is this server's mount record, `collab_scenes`, read over REST for now). Two
 * views are laid over the documents:
 *
 *   - `liveNodes`: a node's transform while a local gesture or a received
 *     preview's tween runs (previewSmoother). It changes every animation
 *     frame of a drag, so it is merged per node — `useSceneNode(id)` and the
 *     Viewport's node renderers — never into the `useSceneNodes()` list: that
 *     list has ~20 readers, and merging there re-rendered all of them (the
 *     whole editor) every frame of another tab's drag;
 *   - `projectedNodes`: a peer's placed object, projected under its container
 *     node (sync/sharedProjection.ts, Phase 6 — goes with W7).
 */
import { useMemo } from 'react';
import { useCollection, useMeshSelector } from '@vspark/mesh-react';
import type { AppliedChange } from '@vspark/mesh';
import { collectionOf } from './docs';
import {
  useEditorStore,
  type SceneItem,
  type StageObject,
} from '../store/editorStore';
import { useConnectionsStore } from '../store/connectionsStore';

const RTYPE = 'scene_node';

function withLive(
  n: StageObject,
  live: Record<string, number> | undefined
): StageObject {
  if (!live) return n;
  const transform = (n.components as Record<string, unknown> | undefined)
    ?.transform as Record<string, unknown> | undefined;
  return {
    ...n,
    components: {
      ...n.components,
      transform: { type: 'transform', ...transform, ...live },
    },
  };
}

type Mounts = Record<string, { role: string; projectId: string }>;

/** Is `scene` a scene of the open project: its own, or mounted into it? */
const ofProject = (
  d: StageObject,
  sceneId: string,
  projectId: string,
  mounts: Mounts
): boolean =>
  d.projectId === projectId ||
  (mounts[sceneId]?.role === 'mounted' &&
    mounts[sceneId].projectId === projectId);

function projectNodes(
  docs: StageObject[],
  projectId: string | null,
  live: Record<string, Record<string, number>>,
  projected: StageObject[],
  mounts: Mounts
): StageObject[] {
  const out: StageObject[] = [];
  if (projectId)
    for (const d of docs)
      if (
        d.kind !== 'scene' &&
        ofProject(d, d.rootSceneNodeId, projectId, mounts)
      )
        out.push(withLive(d, live[d.id]));
  for (const p of projected) out.push(withLive(p, live[p.id]));
  return out;
}

const sceneItemOf = (d: StageObject): SceneItem => ({
  id: d.id,
  name: d.name,
  runtimeSettings: (d.properties ?? {}) as SceneItem['runtimeSettings'],
});

const NO_LIVE: Record<string, Record<string, number>> = {};

/** A transform preview: shown through `liveNodes` per node, so the lists skip
 *  it — at a drag's rate (one op per field every 33ms) recomputing them
 *  re-rendered the whole editor many times a second. */
const transformPreview = (c: AppliedChange<StageObject>) =>
  c.op === 'ephemeral' && !!c.path?.startsWith('components.transform.');
const LIST_OPTS = { skip: transformPreview };

/** The open project's nodes (every scene's, not the scene roots), plus the
 *  nodes projected from placed objects. Without the `liveNodes` overlay (see
 *  the header): read one node's live transform with `useSceneNode(id)`. */
export function useSceneNodes(): StageObject[] {
  const docs = useMeshSelector(
    useCollection<StageObject>(RTYPE),
    '**',
    (c) => c.all(),
    LIST_OPTS
  );
  const projectId = useEditorStore((s) => s.projectId);
  const projected = useEditorStore((s) => s.projectedNodes);
  const mounts = useConnectionsStore((s) => s.collabScenes);
  return useMemo(
    () => projectNodes(docs, projectId, NO_LIVE, projected, mounts),
    [docs, projectId, projected, mounts]
  );
}

/** The open project's scenes. */
export function useScenes(): SceneItem[] {
  const docs = useMeshSelector(
    useCollection<StageObject>(RTYPE),
    '**',
    (c) => c.all(),
    LIST_OPTS
  );
  const projectId = useEditorStore((s) => s.projectId);
  const mounts = useConnectionsStore((s) => s.collabScenes);
  return useMemo(
    () =>
      projectId
        ? docs
            .filter(
              (d) => d.kind === 'scene' && ofProject(d, d.id, projectId, mounts)
            )
            .map(sceneItemOf)
        : [],
    [docs, projectId, mounts]
  );
}

/** One node, live and projected views included. */
export function useSceneNode(id: string | null | undefined) {
  const nodes = useSceneNodes();
  const live = useEditorStore((s) => (id ? s.liveNodes[id] : undefined));
  return useMemo(() => {
    const n = id ? nodes.find((x) => x.id === id) : undefined;
    return n && withLive(n, live);
  }, [nodes, id, live]);
}

/** A node's transform with its live overlay (a running gesture or tween), for
 *  renderers that already hold the node from the list. */
export function useLiveTransform(
  node: StageObject
): Record<string, unknown> | undefined {
  const live = useEditorStore((s) => s.liveNodes[node.id]);
  const t = (node.components as Record<string, unknown> | undefined)
    ?.transform as Record<string, unknown> | undefined;
  return useMemo(() => (live ? { ...t, ...live } : t), [t, live]);
}

/** Imperative reads (event handlers, frame loops). */
export function sceneNodesNow(): StageObject[] {
  const s = useEditorStore.getState();
  return projectNodes(
    collectionOf<StageObject>(RTYPE).all(),
    s.projectId,
    s.liveNodes,
    s.projectedNodes,
    useConnectionsStore.getState().collabScenes
  );
}

export function scenesNow(): SceneItem[] {
  const projectId = useEditorStore.getState().projectId;
  if (!projectId) return [];
  const mounts = useConnectionsStore.getState().collabScenes;
  return collectionOf<StageObject>(RTYPE)
    .all()
    .filter((d) => d.kind === 'scene' && ofProject(d, d.id, projectId, mounts))
    .map(sceneItemOf);
}

export function sceneNodeNow(id: string): StageObject | undefined {
  return sceneNodesNow().find((n) => n.id === id);
}
