/**
 * Another tab's gesture glides instead of snapping (previewSmoother). Its
 * previews reach this peer as overlays on the lossy channel; the observer
 * started by `startPreviewSmoothing` tweens what this tab shows (`liveNodes`)
 * toward them. A second peer stands in for the other tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoopbackPair, createMeshPeer } from '@vspark/mesh';
import { MODELS } from '@vspark/shared/models';
import { testPeer } from './helpers/mesh';
import { useEditorStore } from '../src/store/editorStore';

const node = {
  id: 'n1',
  rootSceneNodeId: 's1',
  projectId: 'p1',
  parentId: null,
  name: 'N',
  kind: 'group',
  components: {
    transform: { type: 'transform', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
  },
};

async function twoTabs() {
  const here = testPeer();
  const lb = createLoopbackPair(here.id, 'other');
  here.addTransport(lb.a);
  const other = createMeshPeer({
    identity: { peerId: 'other' },
    models: MODELS,
    transports: [lb.b],
  });
  const theirs = other.collection<Record<string, unknown>>('scene_node');
  here.grants.grant({
    grantee: 'other',
    entityRtype: 'scene_node',
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true, update: true },
  });
  here.collection('scene_node').put(node, { v: { t: 1, c: 0, n: 'seed' } });
  await lb.flush();
  await other.subscribe({
    entityRtype: 'scene_node',
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
  });
  await lb.flush();
  const { startPreviewSmoothing } = await import('../src/previewSmoother');
  const stop = startPreviewSmoothing(here);
  return { theirs, flush: lb.flush, stop, close: () => other.close() };
}

describe('preview smoothing', () => {
  beforeEach(() => {
    // Tween state is module-level: a fresh module per test.
    vi.resetModules();
    vi.stubGlobal('requestAnimationFrame', () => 1); // tweens stay in flight
    useEditorStore.setState({ liveNodes: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('tweens a node another tab is dragging', async () => {
    const t = await twoTabs();
    t.theirs.set('n1', 'components.transform.x', 8, { channel: 'preview' });
    await t.flush();
    const { hasNodeTween } = await import('../src/previewSmoother');
    expect(hasNodeTween('n1')).toBe(true);
    t.stop();
    t.close();
  });

  it('a rotation preview tweens all three axes together', async () => {
    const t = await twoTabs();
    t.theirs.set('n1', 'components.transform.ry', 1.2, { channel: 'preview' });
    await t.flush();
    const { hasNodeTween } = await import('../src/previewSmoother');
    expect(hasNodeTween('n1')).toBe(true);
    t.stop();
    t.close();
  });

  it("this tab's own previews are not tweened", async () => {
    const t = await twoTabs();
    testPeer()
      .collection('scene_node')
      .set('n1', 'components.transform.z', 3, { channel: 'preview' });
    const { hasNodeTween } = await import('../src/previewSmoother');
    expect(hasNodeTween('n1')).toBe(false);
    t.stop();
    t.close();
  });

  it('tweens a node that has no transform committed yet', async () => {
    const t = await twoTabs();
    const { components: _c, ...bare } = node;
    testPeer()
      .collection('scene_node')
      .put({ ...bare, id: 'n2' }, { v: { t: 2, c: 0, n: 'seed' } });
    await t.flush();
    t.theirs.set('n2', 'components.transform.x', 3, { channel: 'preview' });
    await t.flush();
    const { hasNodeTween } = await import('../src/previewSmoother');
    expect(hasNodeTween('n2')).toBe(true);
    t.stop();
    t.close();
  });

  it("this tab's committed transform clears what it showed for the gesture", async () => {
    const t = await twoTabs();
    // The smoother's own store instance (modules are reset per test).
    const { useEditorStore: store } = await import('../src/store/editorStore');
    store.getState().setLiveNode('n1', { x: 5 });
    testPeer().collection('scene_node').set('n1', 'components.transform.x', 5);
    await t.flush();
    expect(store.getState().liveNodes.n1).toBeUndefined();
    t.stop();
    t.close();
  });
});
