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
