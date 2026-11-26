/**
 * The mesh peer component tests run against: what the app's tab peer is, minus
 * the network. One fresh peer per test (reset in setup.ts), opened with the
 * shared declarations. It is not a participant, so it decides its own writes —
 * a test writes, reads back, and undoes exactly as the app does.
 *
 * Seed documents with `testPeer().collection('scene_node').create(...)`.
 */
import { createMeshPeer, type Collection, type MeshPeer } from '@vspark/mesh';
import { MODELS, TAB_MODELS } from '@vspark/shared/models';
import { useEditorStore } from '../../src/store/editorStore';

let current: MeshPeer | null = null;

export function testPeer(): MeshPeer {
  if (!current) {
    current = createMeshPeer({
      identity: { peerId: 'test-server' },
      models: MODELS,
    });
    for (const rtype of TAB_MODELS) current.collection(rtype);
  }
  return current;
}

/** The peer as `getMeshHandles()` returns it in the app. */
export function testHandles() {
  const peer = testPeer();
  const collections: Record<string, Collection<Record<string, unknown>>> = {};
  for (const rtype of TAB_MODELS) collections[rtype] = peer.collection(rtype);
  return { peer, serverPeerId: 'test-server', collections };
}

export function resetTestPeer(): void {
  current?.close();
  current = null;
}

/** Editor-state keys that are mesh documents now, by the collection holding
 *  them. */
const MESH_SLICES: Record<string, string> = {
  behaviors: 'behavior',
  cameraEffects: 'camera_effect',
  composeLayers: 'compose_layer',
  composeScenes: 'compose_layer',
  nodes: 'scene_node',
  scenes: 'scene_node',
};

/** Project-scoped collections: the hooks show only the open project's. */
const PROJECT_SCOPED = new Set(['compose_layer', 'scene_node']);

/** Each seed is newer than the last, so re-seeding a document replaces it. */
let seedClock = 0;

/**
 * Seed editor state the way the app holds it: the keys that are mesh documents
 * (MESH_SLICES) go into the test peer — hydrated, so they are not on the undo
 * stack — and everything else into the zustand store. A scene (`scenes`) is a
 * `kind: 'scene'` root node; documents without a `projectId` get the open
 * project's (one is opened if none is).
 */
export function seedEditor(state: Record<string, unknown>): void {
  const rest: Record<string, unknown> = { ...state };
  const projectId =
    (state.projectId as string | undefined) ??
    useEditorStore.getState().projectId ??
    'proj-test';
  rest.projectId = projectId;
  for (const [key, rtype] of Object.entries(MESH_SLICES)) {
    if (!(key in rest)) continue;
    let docs = rest[key] as Record<string, unknown>[];
    delete rest[key];
    if (key === 'scenes')
      docs = docs.map((sc) => ({
        id: sc.id,
        name: sc.name,
        kind: 'scene',
        rootSceneNodeId: sc.id,
        parentId: null,
        components: {},
        properties: sc.runtimeSettings ?? {},
        projectId: sc.projectId ?? projectId,
      }));
    else if (PROJECT_SCOPED.has(rtype))
      docs = docs.map((d) => ({ projectId, ...d }));
    const col = testPeer().collection<{ id: string }>(rtype);
    for (const d of docs)
      col.put(d as { id: string }, { v: { t: ++seedClock, c: 0, n: 'seed' } });
  }
  useEditorStore.setState(rest as never);
}

/** One collection's documents, in the test peer. */
export function docsOf<T extends object = Record<string, unknown>>(
  rtype: string
): T[] {
  return testPeer().collection<T>(rtype).all();
}

/** A track clip in record form (lists) → its document form (keyed by id), as
 *  the mesh holds it. */
export function clipDoc(clip: {
  id: string;
  lanes: { id: string; keyframes: { id: string }[] }[];
  events: { id: string }[];
}): Record<string, unknown> {
  const byId = <T extends { id: string }>(xs: readonly T[]) =>
    Object.fromEntries(xs.map((x) => [x.id, x]));
  return {
    ...clip,
    lanes: byId(
      clip.lanes.map((l) => ({ ...l, keyframes: byId(l.keyframes) }))
    ),
    events: byId(clip.events),
  };
}

/** Put a track clip (record form) into the test peer. */
export function seedClip(clip: Parameters<typeof clipDoc>[0]): void {
  testPeer()
    .collection<{ id: string }>('track_clip')
    .put(clipDoc(clip) as { id: string }, {
      v: { t: ++seedClock, c: 0, n: 'seed' },
    });
}
