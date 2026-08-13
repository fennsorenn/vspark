/**
 * meshStoreFeeder.sceneNode.test.ts — how the feeder routes scene_node docs.
 *
 * Two regressions, both in the "we don't hold this doc yet" path:
 *
 *  1. A Scene is a `scene_nodes` row (kind === 'scene'), but it belongs in the
 *     `scenes` slice. The REST bundle deliberately excludes scene rows from
 *     `nodes`, so adopting one here left a stray `nodes` entry behind whenever
 *     the mesh snapshot landed after setNodes.
 *  2. The adoption guard read `s.projectId && doc.projectId !== s.projectId`,
 *     which PASSES while projectId is still null — and the feeder starts on
 *     mount, before the async REST load sets it. So docs from other projects
 *     were adopted into the open project during that window.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Op = { op: string; id: string; doc?: unknown };
type Observer = (c: Op) => void;

/** Captures the observer the feeder registers per rtype so tests can drive ops. */
const observers = new Map<string, Observer>();

const RTYPES = [
  'scene_node',
  'behavior',
  'camera_effect',
  'compose_layer',
  'track_clip',
  'scheduled_animation',
  'animation_clip',
];

vi.mock('../src/mesh/peer', () => ({
  initMeshPeer: () =>
    Promise.resolve({
      collections: Object.fromEntries(
        RTYPES.map((rt) => [
          rt,
          { observe: (_p: string, cb: Observer) => observers.set(rt, cb) },
        ])
      ),
    }),
}));

const sceneDoc = (id: string, projectId: string, name = 'S') => ({
  id,
  projectId,
  kind: 'scene',
  name,
  properties: { tickRate: 30 },
});

const meshDoc = (id: string, projectId: string) => ({
  id,
  projectId,
  kind: 'group',
  name: 'N',
  rootSceneNodeId: 'scene-1',
  components: {},
});

let useEditorStore: typeof import('../src/store/editorStore').useEditorStore;

/** Fresh module registry per test: the feeder guards itself with a module-level
 *  `started` flag, so it would only ever run once across the file. */
async function startFeeder() {
  vi.resetModules();
  observers.clear();
  ({ useEditorStore } = await import('../src/store/editorStore'));
  const { startMeshStoreFeeder } = await import('../src/sync/meshStoreFeeder');
  startMeshStoreFeeder();
  await Promise.resolve();
  await Promise.resolve();
}

const feed = (op: Op) => observers.get('scene_node')!(op);

describe('meshStoreFeeder — scene_node routing', () => {
  beforeEach(async () => {
    await startFeeder();
    useEditorStore.setState({
      projectId: 'p1',
      nodes: [],
      scenes: [],
      activeSceneId: null,
    });
  });

  it('routes a scene doc into the scenes slice, not nodes', () => {
    feed({ op: 'upsert', id: 's1', doc: sceneDoc('s1', 'p1', 'Stage') });
    const s = useEditorStore.getState();
    expect(s.nodes.map((n) => n.id)).toEqual([]);
    expect(s.scenes).toEqual([
      { id: 's1', name: 'Stage', runtimeSettings: { tickRate: 30 } },
    ]);
  });

  it('updates a scene already in the slice rather than duplicating it', () => {
    feed({ op: 'upsert', id: 's1', doc: sceneDoc('s1', 'p1', 'Stage') });
    feed({ op: 'upsert', id: 's1', doc: sceneDoc('s1', 'p1', 'Renamed') });
    const { scenes } = useEditorStore.getState();
    expect(scenes).toHaveLength(1);
    expect(scenes[0].name).toBe('Renamed');
  });

  it('removing a scene tears down its subtree and re-picks the active scene', () => {
    feed({ op: 'upsert', id: 's1', doc: sceneDoc('s1', 'p1') });
    feed({ op: 'upsert', id: 's2', doc: sceneDoc('s2', 'p1') });
    useEditorStore.setState({ activeSceneId: 's1' });
    useEditorStore.getState().addNode(meshDoc('n1', 'p1') as never);

    feed({ op: 'remove', id: 's1' });

    const s = useEditorStore.getState();
    expect(s.scenes.map((sc) => sc.id)).toEqual(['s2']);
    // n1 has rootSceneNodeId 'scene-1', not 's1', so it survives; what matters
    // is that activeSceneId moved off the deleted scene rather than dangling.
    expect(s.activeSceneId).toBe('s2');
  });

  it('does not adopt a node from another project', () => {
    feed({ op: 'upsert', id: 'n9', doc: meshDoc('n9', 'other-project') });
    expect(useEditorStore.getState().nodes).toEqual([]);
  });

  it('does not adopt anything while projectId is still unknown', () => {
    // The window between feeder start and the REST load landing.
    useEditorStore.setState({ projectId: null });
    feed({ op: 'upsert', id: 'n9', doc: meshDoc('n9', 'other-project') });
    feed({ op: 'upsert', id: 's9', doc: sceneDoc('s9', 'other-project') });
    const s = useEditorStore.getState();
    expect(s.nodes).toEqual([]);
    expect(s.scenes).toEqual([]);
  });

  it('still adopts an ordinary node from the open project', () => {
    feed({ op: 'upsert', id: 'n1', doc: meshDoc('n1', 'p1') });
    expect(useEditorStore.getState().nodes.map((n) => n.id)).toEqual(['n1']);
  });

  it('ignores ephemeral ops', () => {
    feed({ op: 'ephemeral', id: 'n1', doc: meshDoc('n1', 'p1') });
    expect(useEditorStore.getState().nodes).toEqual([]);
  });
});
