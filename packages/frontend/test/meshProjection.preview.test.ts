/**
 * A gesture on a shared object, seen by the receiver.
 *
 * The owner drags a node they have shared; the receiver sees it move. That used
 * to be a bespoke WS kind (`node_transform_preview`) produced by two gesture
 * handlers beside their mesh write, forwarded by the owner's server, and
 * applied in three places (the /ws handler, the direct WebRTC edge, and the
 * relay). The gesture is ALREADY on the mesh preview channel for local tabs,
 * and the placed subscription selects no channel — so those overlays reach the
 * receiver too, and the projection can read them.
 *
 * What these pin is the routing: overlays inside an active projection tween the
 * projected node, and overlays outside one are left alone (a preview must not
 * animate a node this tab merely happens to hold).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Op = { op: string; id: string; doc?: unknown; path?: string; v?: unknown };
type Observer = (c: Op) => void;

const observers = new Map<string, Observer>();
const smoothed: { nodeId: string; transform: Record<string, number> }[] = [];
/** Owner subtree membership, as the containment index would answer it. */
let subtree: Record<string, string[]> = {};

vi.mock('../src/mesh/peer', () => ({
  initMeshPeer: () =>
    Promise.resolve({
      peer: {
        isDescendant: (childId: string, rootId: string) =>
          (subtree[rootId] ?? []).includes(childId),
      },
      collections: new Proxy(
        {},
        {
          get: (_t, rtype: string) => ({
            observe: (_p: string, cb: Observer) => observers.set(rtype, cb),
            subtree: (rootId: string) =>
              (subtree[rootId] ?? []).map((id) => ({ id, name: id })),
          }),
        }
      ),
    }),
  getMeshHandles: () => ({
    peer: {
      isDescendant: (childId: string, rootId: string) =>
        (subtree[rootId] ?? []).includes(childId),
    },
    collections: new Proxy(
      {},
      {
        get: () => ({
          subtree: (rootId: string) =>
            (subtree[rootId] ?? []).map((id) => ({ id, name: id })),
        }),
      }
    ),
  }),
}));

vi.mock('../src/previewSmoother', () => ({
  smoothNodeTransform: (nodeId: string, transform: Record<string, number>) =>
    smoothed.push({ nodeId, transform }),
}));

// The projection store itself is not what is under test here — the ROUTING
// decision is (which overlays reach a projected node). Mocking it also keeps
// applySnapshot's teardown/rebuild out of the store, which the module's own
// store subscription would otherwise re-enter.
vi.mock('../src/sync/sharedProjection', () => ({
  REMOTE_OBJECT_KIND: 'remote_object',
  applySnapshot: vi.fn(),
  applyUpdate: vi.fn(),
  removeProjection: vi.fn(),
  isProjected: () => true,
  owningProjectionRoot: (_owner: string, id: string) =>
    (subtree.obj ?? []).includes(id) ? 'obj' : undefined,
}));

const withTransform = (id: string, t: Record<string, number>) => ({
  id,
  name: id,
  components: { transform: t },
});

async function startProjection() {
  const { useEditorStore } = await import('../src/store/editorStore');
  const { useConnectionsStore } = await import('../src/store/connectionsStore');
  // A placed container + a live subscription = an active projection.
  useEditorStore.setState({
    nodes: [
      {
        id: 'container',
        kind: 'remote_object',
        name: 'Placed',
        components: {
          remoteRef: { ownerPeerId: 'OWNER', remoteObjectId: 'obj' },
        },
      } as never,
    ],
  });
  useConnectionsStore.setState({ subscribed: { OWNER: ['obj'] } } as never);
  const { startMeshProjection } = await import('../src/sync/meshProjection');
  startMeshProjection();
  // Let initMeshPeer's promise resolve so the observer is registered.
  await Promise.resolve();
  await Promise.resolve();
}

describe('shared-object projection — in-flight gestures', () => {
  beforeEach(() => {
    observers.clear();
    smoothed.length = 0;
    subtree = { obj: ['obj', 'inner'] };
    vi.resetModules();
  });

  it('tweens a projected node from a preview overlay', async () => {
    await startProjection();
    observers.get('scene_node')!({
      op: 'ephemeral',
      id: 'inner',
      path: 'components.transform.x',
      doc: withTransform('inner', { x: 5, y: 0, z: 0 }),
    });

    // Projected nodes keep the OWNER's ids, so the overlay names the node it
    // moves — no id translation anywhere on this path.
    expect(smoothed).toEqual([{ nodeId: 'inner', transform: { x: 5 } }]);
  });

  it('sends all three rotation axes together', async () => {
    await startProjection();
    observers.get('scene_node')!({
      op: 'ephemeral',
      id: 'inner',
      path: 'components.transform.ry',
      doc: withTransform('inner', { rx: 0, ry: 1.5, rz: 0 }),
    });

    // Rotation tweens as ONE quaternion: fed an axis at a time, the last op
    // recomputes the target from the store's lagging values and cancels the
    // ones before it.
    expect(smoothed[0].transform).toEqual({ rx: 0, ry: 1.5, rz: 0 });
  });

  it('ignores overlays for nodes outside the projection', async () => {
    await startProjection();
    observers.get('scene_node')!({
      op: 'ephemeral',
      id: 'mine',
      path: 'components.transform.x',
      doc: withTransform('mine', { x: 9 }),
    });

    // This tab holds plenty of nodes that are not part of the placed object;
    // its own gestures are already handled by the store feeder.
    expect(smoothed).toEqual([]);
  });

  it('ignores an overlay carrying no transform', async () => {
    await startProjection();
    observers.get('scene_node')!({
      op: 'ephemeral',
      id: 'inner',
      path: 'name',
      doc: { id: 'inner', name: 'renamed' },
    });
    expect(smoothed).toEqual([]);
  });
});
