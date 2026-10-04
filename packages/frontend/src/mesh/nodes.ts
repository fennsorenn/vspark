/**
 * Scene nodes and scenes, read from the replica.
 *
 * One rtype (`scene_node`); a scene is the root node of its tree
 * (`kind: 'scene'`). The tab subscribes server-wide, so these hooks keep to the
 * open project. Two views are laid over the documents:
 *
 *   - `liveNodes`: a node's transform while a local gesture or a received
 *     preview's tween runs (previewSmoother);
 *   - `projectedNodes`: a peer's placed object, projected under its container
 *     node (sync/sharedProjection.ts, Phase 6 — goes with W7).
 */
import { useMemo } from 'react';
import { useCollection, useMeshSelector } from '@vspark/mesh-react';
import { collectionOf } from './docs';
import {
  useEditorStore,
  type SceneItem,
  type StageObject,
} from '../store/editorStore';

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

function projectNodes(
  docs: StageObject[],
  projectId: string | null,
  live: Record<string, Record<string, number>>,
  projected: StageObject[]
): StageObject[] {
  const out: StageObject[] = [];
  if (projectId)
    for (const d of docs)
      if (d.projectId === projectId && d.kind !== 'scene')
        out.push(withLive(d, live[d.id]));
  for (const p of projected) out.push(withLive(p, live[p.id]));
  return out;
}

const sceneItemOf = (d: StageObject): SceneItem => ({
  id: d.id,
  name: d.name,
  runtimeSettings: (d.properties ?? {}) as SceneItem['runtimeSettings'],
});

/** The open project's nodes (every scene's, not the scene roots), plus the
 *  nodes projected from placed objects. */
export function useSceneNodes(): StageObject[] {
  const docs = useMeshSelector(useCollection<StageObject>(RTYPE), '**', (c) =>
    c.all()
  );
  const projectId = useEditorStore((s) => s.projectId);
  const live = useEditorStore((s) => s.liveNodes);
  const projected = useEditorStore((s) => s.projectedNodes);
  return useMemo(
    () => projectNodes(docs, projectId, live, projected),
    [docs, projectId, live, projected]
  );
}

/** The open project's scenes. */
export function useScenes(): SceneItem[] {
  const docs = useMeshSelector(useCollection<StageObject>(RTYPE), '**', (c) =>
    c.all()
  );
  const projectId = useEditorStore((s) => s.projectId);
  return useMemo(
    () =>
      projectId
        ? docs
            .filter((d) => d.kind === 'scene' && d.projectId === projectId)
            .map(sceneItemOf)
        : [],
    [docs, projectId]
  );
}

/** One node, live and projected views included. */
export function useSceneNode(id: string | null | undefined) {
  const nodes = useSceneNodes();
  return useMemo(
    () => (id ? nodes.find((n) => n.id === id) : undefined),
    [nodes, id]
  );
}

/** Imperative reads (event handlers, frame loops). */
export function sceneNodesNow(): StageObject[] {
  const s = useEditorStore.getState();
  return projectNodes(
    collectionOf<StageObject>(RTYPE).all(),
    s.projectId,
    s.liveNodes,
    s.projectedNodes
  );
}

export function scenesNow(): SceneItem[] {
  const projectId = useEditorStore.getState().projectId;
  if (!projectId) return [];
  return collectionOf<StageObject>(RTYPE)
    .all()
    .filter((d) => d.kind === 'scene' && d.projectId === projectId)
    .map(sceneItemOf);
}

export function sceneNodeNow(id: string): StageObject | undefined {
  return sceneNodesNow().find((n) => n.id === id);
}
