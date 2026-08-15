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

// Answer for ANY rtype rather than listing them. A hardcoded list here is a
// second copy of RTYPES in mesh/peer.ts, and it drifts the moment one is added:
// the feeder then throws on the missing collection, and because it swallows
// that into a console warning, EVERY observer silently stops being registered —
// so the whole suite goes green-but-inert rather than failing loudly.
vi.mock('../src/mesh/peer', () => ({
  initMeshPeer: () =>
    Promise.resolve({
      collections: new Proxy(
        {},
        {
          get: (_t, rtype: string) => ({
            observe: (_p: string, cb: Observer) => observers.set(rtype, cb),
            // Slices with no REST load (`logic`, `runtime_override`) seed
            // themselves from the replica. Without this the seed throws, the
            // feeder swallows it, and every observer AFTER the seed silently
            // stops being registered — the exact green-but-inert failure the
            // note above warns about.
            all: () => [],
          }),
        }
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
/** Same module instance the feeder holds — both are imported into the registry
 *  created by the resetModules() below, so the tween maps are shared. */
let smoother: typeof import('../src/previewSmoother');

/** Fresh module registry per test: the feeder guards itself with a module-level
 *  `started` flag, so it would only ever run once across the file — and
 *  previewSmoother's tween maps would leak between tests. */
async function startFeeder() {
  vi.resetModules();
  observers.clear();
  ({ useEditorStore } = await import('../src/store/editorStore'));
  smoother = await import('../src/previewSmoother');
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

  it('does not adopt a new node from an ephemeral op', () => {
    // A preview is an in-flight gesture on a doc you already hold; it must
    // never bring a node into existence.
    feed({ op: 'ephemeral', id: 'n1', doc: meshDoc('n1', 'p1') });
    expect(useEditorStore.getState().nodes).toEqual([]);
  });
});

describe('meshStoreFeeder — scene_node previews', () => {
  beforeEach(async () => {
    // rAF never fires here, so a started tween stays live and the store keeps
    // the pre-gesture value — which is what lets us assert "tweening, not
    // snapped" without driving frames.
    vi.stubGlobal('requestAnimationFrame', () => 1);
    await startFeeder();
    useEditorStore.setState({
      projectId: 'p1',
      scenes: [],
      nodes: [
        {
          ...meshDoc('n1', 'p1'),
          components: {
            transform: { type: 'transform', x: 0, y: 0, z: 0, ry: 0 },
          },
        } as never,
      ],
    });
  });

  const transformOf = () =>
    (
      useEditorStore.getState().nodes[0].components as Record<string, unknown>
    ).transform as Record<string, number>;

  const withTransform = (t: Record<string, number>) => ({
    ...meshDoc('n1', 'p1'),
    components: { transform: { type: 'transform', ...t } },
  });

  it('hands an ephemeral transform to the smoother instead of dropping it', () => {
    expect(smoother.hasNodeTween('n1')).toBe(false);
    feed({
      op: 'ephemeral',
      id: 'n1',
      path: 'components.transform.x',
      doc: withTransform({ x: 100, y: 0, z: 0, ry: 0 }),
    });
    // A tween is now running — this is the assertion that distinguishes
    // "tweened" from "dropped on the floor", which the store value alone
    // cannot (it reads 0 either way).
    expect(smoother.hasNodeTween('n1')).toBe(true);
    expect(transformOf().x).toBe(0);
  });

  it('tweens a rotate-only ephemeral op', () => {
    feed({
      op: 'ephemeral',
      id: 'n1',
      path: 'components.transform.ry',
      doc: withTransform({ x: 0, y: 0, z: 0, ry: 1.2 }),
    });
    expect(smoother.hasNodeTween('n1')).toBe(true);
  });

  it('a trailing rotation axis does not cancel the ones before it', () => {
    // A rotation gesture fans out as three per-axis ops. Rotation tweens as ONE
    // quaternion, and the smoother rebuilds the whole target from any axis it
    // is not handed — reading those from the store, which lags the running
    // tween. Fed one axis at a time, the trailing rz:0 recomputed the target as
    // (0,0,0) and the node never turned. Caught by the two-tab e2e spec first.
    // Capture the rAF callback BEFORE the first feed: ensureLoop only registers
    // one while `rafHandle` is null, so a stub installed afterwards never sees it.
    const rafs: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafs.push(cb);
      return 1;
    });

    const doc = withTransform({ x: 0, y: 0, z: 0, rx: 0, ry: 1.5708, rz: 0 });
    for (const axis of ['rx', 'ry', 'rz'])
      feed({
        op: 'ephemeral',
        id: 'n1',
        path: `components.transform.${axis}`,
        doc,
      });

    // Drive the tween past SMOOTH_MS so it lands exactly on its target.
    vi.spyOn(performance, 'now').mockReturnValue(1e6);
    rafs.forEach((cb) => cb(1e6));
    expect(transformOf().ry).toBeCloseTo(1.5708, 3);
  });

  it('a committed transform lands immediately when no gesture is in flight', () => {
    feed({ op: 'upsert', id: 'n1', doc: withTransform({ x: 42, y: 0, z: 0 }) });
    expect(transformOf().x).toBe(42);
  });

  it('a committed transform mid-gesture retargets rather than snapping', () => {
    feed({
      op: 'ephemeral',
      id: 'n1',
      path: 'components.transform.x',
      doc: withTransform({ x: 100, y: 0, z: 0, ry: 0 }),
    });
    feed({ op: 'upsert', id: 'n1', doc: withTransform({ x: 100, y: 0, z: 0 }) });
    // Still gliding: the committed value must not jump the node to its final
    // pose, or the drag ends with a visible snap on every watching tab.
    expect(transformOf().x).toBe(0);
  });

  it('a committed NON-transform change still applies mid-gesture', () => {
    feed({
      op: 'ephemeral',
      id: 'n1',
      path: 'components.transform.x',
      doc: withTransform({ x: 100, y: 0, z: 0, ry: 0 }),
    });
    feed({
      op: 'upsert',
      id: 'n1',
      doc: { ...withTransform({ x: 100, y: 0, z: 0 }), name: 'Renamed' },
    });
    expect(useEditorStore.getState().nodes[0].name).toBe('Renamed');
    expect(transformOf().x).toBe(0);
  });
});

/**
 * The same guard, for compose layers.
 *
 * The tab subscribes to `compose_layer` across the whole server (entityId
 * '*'), and this observer adopted everything it saw — so opening one project
 * listed the compose scenes of every other one. An e2e caught it the moment a
 * full run had created a second project; a user with two projects would have
 * hit it on the first switch.
 */
describe('meshStoreFeeder — compose_layer scoping', () => {
  const layerDoc = (id: string, projectId: string, kind = 'image') => ({
    id,
    projectId,
    kind,
    name: id,
    rootComposeSceneId: kind === 'compose_scene' ? null : 'cs-1',
    parentId: null,
    orderKey: 'a0',
  });

  const feedLayer = (op: Op) => observers.get('compose_layer')!(op);

  beforeEach(async () => {
    await startFeeder();
    useEditorStore.setState({
      projectId: 'p1',
      composeScenes: [],
      composeLayers: [],
    });
  });

  it('adopts a layer of the open project', () => {
    feedLayer({ op: 'upsert', id: 'l1', doc: layerDoc('l1', 'p1') });
    expect(useEditorStore.getState().composeLayers.map((l) => l.id)).toEqual([
      'l1',
    ]);
  });

  it('ignores a layer belonging to another project', () => {
    feedLayer({ op: 'upsert', id: 'l2', doc: layerDoc('l2', 'other') });
    expect(useEditorStore.getState().composeLayers).toEqual([]);
  });

  it('ignores a compose SCENE belonging to another project', () => {
    // The visible symptom: another project's scenes listed in this project's
    // Compose tree.
    feedLayer({
      op: 'upsert',
      id: 'cs2',
      doc: layerDoc('cs2', 'other', 'compose_scene'),
    });
    expect(useEditorStore.getState().composeScenes).toEqual([]);
  });

  it('drops everything while projectId is still unknown', () => {
    // The feeder starts on mount; projectId arrives with the async REST load.
    // Unknown means DON'T adopt — the bundle fills the slices right after.
    useEditorStore.setState({ projectId: null });
    feedLayer({ op: 'upsert', id: 'l3', doc: layerDoc('l3', 'p1') });
    expect(useEditorStore.getState().composeLayers).toEqual([]);
  });

  it('still applies edits to a layer it already holds', async () => {
    const { addComposeLayer } = useEditorStore.getState();
    addComposeLayer(layerDoc('l1', 'p1') as never);
    feedLayer({
      op: 'upsert',
      id: 'l1',
      doc: { ...layerDoc('l1', 'p1'), name: 'renamed' },
    });
    expect(useEditorStore.getState().composeLayers[0].name).toBe('renamed');
  });
});

// ── runtime_override ──────────────────────────────────────────────────────────

/**
 * Graph-driven param overrides used to arrive as three WS kinds — `_set`,
 * `_clear`, and a `_snapshot` replayed on every reconnect. They are retained
 * mesh documents now, one per overridden path, so the feeder has only two cases
 * and the snapshot is just the applies the subscription delivers.
 *
 * The remove case is the one worth pinning: there is no document left to read
 * the target off, so the id has to be parsed — and a paramPath contains dots,
 * which is exactly the sort of thing a naive `split(':')` gets wrong.
 */
describe('meshStoreFeeder — runtime_override routing', () => {
  const feedOverride = (op: Op) => observers.get('runtime_override')!(op);

  beforeEach(async () => {
    await startFeeder();
    useEditorStore.setState({
      runtimeNodeOverrides: {},
      runtimeLayerOverrides: {},
    });
  });

  it('applies an override document to the node slice', () => {
    feedOverride({
      op: 'upsert',
      id: 'scene_node:n1:opacity',
      doc: {
        id: 'scene_node:n1:opacity',
        targetKind: 'scene_node',
        targetId: 'n1',
        paramPath: 'opacity',
        value: 0.5,
      },
    });
    expect(useEditorStore.getState().runtimeNodeOverrides).toEqual({
      n1: { opacity: 0.5 },
    });
  });

  it('routes a compose_layer override to the layer slice', () => {
    feedOverride({
      op: 'upsert',
      id: 'compose_layer:l1:x',
      doc: {
        id: 'compose_layer:l1:x',
        targetKind: 'compose_layer',
        targetId: 'l1',
        paramPath: 'x',
        value: 100,
      },
    });
    expect(useEditorStore.getState().runtimeLayerOverrides).toEqual({
      l1: { x: 100 },
    });
  });

  it('clears one path from the id when the document is removed', () => {
    // A dotted paramPath: the id splits on the FIRST two colons, not on every
    // one, and the remainder is the path verbatim.
    feedOverride({
      op: 'upsert',
      id: 'scene_node:n1:text.content',
      doc: {
        id: 'scene_node:n1:text.content',
        targetKind: 'scene_node',
        targetId: 'n1',
        paramPath: 'text.content',
        value: 'hi',
      },
    });
    feedOverride({
      op: 'upsert',
      id: 'scene_node:n1:opacity',
      doc: {
        id: 'scene_node:n1:opacity',
        targetKind: 'scene_node',
        targetId: 'n1',
        paramPath: 'opacity',
        value: 0.5,
      },
    });

    feedOverride({ op: 'remove', id: 'scene_node:n1:text.content' });

    expect(useEditorStore.getState().runtimeNodeOverrides).toEqual({
      n1: { opacity: 0.5 },
    });
  });

  it('ignores a remove whose id is not an override key', () => {
    feedOverride({ op: 'upsert', id: 'scene_node:n1:opacity', doc: {
      id: 'scene_node:n1:opacity',
      targetKind: 'scene_node',
      targetId: 'n1',
      paramPath: 'opacity',
      value: 0.5,
    } });
    feedOverride({ op: 'remove', id: 'nonsense' });
    expect(useEditorStore.getState().runtimeNodeOverrides).toEqual({
      n1: { opacity: 0.5 },
    });
  });
});

// ── data_field ────────────────────────────────────────────────────────────────

/**
 * Published data fields, same collapse as overrides: `data_channel_set` /
 * `_clear` / `_snapshot` become upserts and removes of one document per
 * (scope, field).
 */
describe('meshStoreFeeder — data_field routing', () => {
  const feedField = (op: Op) => observers.get('data_field')!(op);

  beforeEach(async () => {
    await startFeeder();
    useEditorStore.setState({ dataChannels: {} });
  });

  it('merges a field into its scope', () => {
    feedField({
      op: 'upsert',
      id: 'n1:headline',
      doc: { id: 'n1:headline', scope: 'n1', field: 'headline', value: 'hi' },
    });
    feedField({
      op: 'upsert',
      id: 'n1:sub',
      doc: { id: 'n1:sub', scope: 'n1', field: 'sub', value: 2 },
    });
    // Two producers, two documents, one merged scope — the merge is the
    // store's, and neither field can clobber the other.
    expect(useEditorStore.getState().dataChannels).toEqual({
      n1: { headline: 'hi', sub: 2 },
    });
  });

  it('routes a global field to the empty scope', () => {
    feedField({
      op: 'upsert',
      id: ':ticker',
      doc: { id: ':ticker', scope: '', field: 'ticker', value: 'x' },
    });
    expect(useEditorStore.getState().dataChannels).toEqual({
      '': { ticker: 'x' },
    });
  });

  it('clears one field from the id when its document is removed', () => {
    feedField({
      op: 'upsert',
      id: 'n1:a',
      doc: { id: 'n1:a', scope: 'n1', field: 'a', value: 1 },
    });
    feedField({
      op: 'upsert',
      id: 'n1:b',
      doc: { id: 'n1:b', scope: 'n1', field: 'b', value: 2 },
    });
    feedField({ op: 'remove', id: 'n1:a' });
    expect(useEditorStore.getState().dataChannels).toEqual({ n1: { b: 2 } });
  });

  it('keeps a field label containing a colon intact on remove', () => {
    // The id splits on the FIRST colon; everything after it is the label.
    feedField({
      op: 'upsert',
      id: 'n1:a:b',
      doc: { id: 'n1:a:b', scope: 'n1', field: 'a:b', value: 1 },
    });
    feedField({ op: 'remove', id: 'n1:a:b' });
    expect(useEditorStore.getState().dataChannels.n1 ?? {}).toEqual({});
  });
});
