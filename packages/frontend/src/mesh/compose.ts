/**
 * Compose layers and compose scenes, read from the replica.
 *
 * One rtype (`compose_layer`); a compose scene is the root layer of its tree
 * (`kind: 'compose_scene'`). The tab subscribes server-wide, so these hooks
 * keep to the open project. While a gesture or a received preview's tween is
 * running, what this tab shows for a layer is laid over its document
 * (`liveLayers` in the editor store, see previewSmoother and
 * composeLayerInteractions).
 */
import { useMemo } from 'react';
import { useCollection, useMeshSelector } from '@vspark/mesh-react';
import { collectionOf } from './docs';
import { useEditorStore } from '../store/editorStore';
import type { ComposeLayerRecord } from '../api/client';

const RTYPE = 'compose_layer';

function inProject(
  docs: ComposeLayerRecord[],
  projectId: string | null,
  live: Record<string, Partial<ComposeLayerRecord>>
): ComposeLayerRecord[] {
  const out: ComposeLayerRecord[] = [];
  for (const d of docs) {
    if (!projectId || d.projectId !== projectId) continue;
    const l = live[d.id];
    out.push(l ? { ...d, ...l } : d);
  }
  return out;
}

/** Every compose document of the open project, scenes included. */
export function useComposeAll(): ComposeLayerRecord[] {
  const docs = useMeshSelector(
    useCollection<ComposeLayerRecord>(RTYPE),
    '**',
    (c) => c.all()
  );
  const projectId = useEditorStore((s) => s.projectId);
  const live = useEditorStore((s) => s.liveLayers);
  return useMemo(
    () => inProject(docs, projectId, live),
    [docs, projectId, live]
  );
}

/** The open project's compose layers (not the scene roots). */
export function useComposeLayers(): ComposeLayerRecord[] {
  const all = useComposeAll();
  return useMemo(() => all.filter((l) => l.kind !== 'compose_scene'), [all]);
}

/** The open project's compose scenes. */
export function useComposeScenes(): ComposeLayerRecord[] {
  const all = useComposeAll();
  return useMemo(() => all.filter((l) => l.kind === 'compose_scene'), [all]);
}

/** Imperative reads (event handlers, hit tests), live fields included. */
export function composeAllNow(): ComposeLayerRecord[] {
  const s = useEditorStore.getState();
  return inProject(
    collectionOf<ComposeLayerRecord>(RTYPE).all(),
    s.projectId,
    s.liveLayers
  );
}

export const composeLayersNow = (): ComposeLayerRecord[] =>
  composeAllNow().filter((l) => l.kind !== 'compose_scene');

export const composeScenesNow = (): ComposeLayerRecord[] =>
  composeAllNow().filter((l) => l.kind === 'compose_scene');

/** One compose document (layer or scene), live fields included. */
export function composeDocNow(id: string): ComposeLayerRecord | undefined {
  const d = collectionOf<ComposeLayerRecord>(RTYPE).get(id);
  if (!d) return undefined;
  const l = useEditorStore.getState().liveLayers[id];
  return l ? { ...d, ...l } : d;
}
