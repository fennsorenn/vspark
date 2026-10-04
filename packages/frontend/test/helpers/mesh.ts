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
 *  them. Grows as store slices move onto the replica. */
const MESH_SLICES: Record<string, string> = {
  behaviors: 'behavior',
  cameraEffects: 'camera_effect',
};

/**
 * Seed editor state the way the app holds it: the keys that are mesh documents
 * (MESH_SLICES) go into the test peer — hydrated, so they are not on the undo
 * stack — and everything else into the zustand store.
 */
/** Each seed is newer than the last, so re-seeding a document replaces it. */
let seedClock = 0;

export function seedEditor(state: Record<string, unknown>): void {
  const rest: Record<string, unknown> = { ...state };
  for (const [key, rtype] of Object.entries(MESH_SLICES)) {
    if (!(key in rest)) continue;
    const docs = rest[key] as { id: string }[];
    delete rest[key];
    const col = testPeer().collection<{ id: string }>(rtype);
    for (const d of docs)
      col.put(d, { v: { t: ++seedClock, c: 0, n: 'seed' } });
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
