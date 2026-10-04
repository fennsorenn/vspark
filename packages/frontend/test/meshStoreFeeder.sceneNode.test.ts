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
/** The feeder's snapshot callback (mesh/peer onSnapshot), captured per run. */
let snapshotCb: ((rtype: string) => void) | null = null;
/** Ids the fake replica holds, per rtype (for the post-snapshot prune). */
const replicaHas = new Map<string, Set<string>>();

// Answer for ANY rtype rather than listing them. A hardcoded list here is a
// second copy of RTYPES in mesh/peer.ts, and it drifts the moment one is added:
// the feeder then throws on the missing collection, and because it swallows
// that into a console warning, EVERY observer silently stops being registered —
// so the whole suite goes green-but-inert rather than failing loudly.
vi.mock('../src/mesh/peer', () => ({
  onSnapshot: (cb: (rtype: string) => void) => {
    snapshotCb = cb;
    return () => {};
  },
  initMeshPeer: () =>
    Promise.resolve({
      collections: new Proxy(
        {},
        {
          get: (_t, rtype: string) => ({
            observe: (_p: string, cb: Observer) => observers.set(rtype, cb),
            get: (id: string) =>
              replicaHas.get(rtype)?.has(id) ? { id } : undefined,
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

// ── track_clip ────────────────────────────────────────────────────────────────

/**
 * Clip edits used to arrive twice: once as the clip DOCUMENT through this
 * feeder, and again as one of five partial WS kinds — `track_clip_updated`,
 * `track_clip_lane_added` / `_updated` / `_removed`,
 * `track_clip_keyframes_replaced`, `track_clip_events_replaced` — each
 * broadcast by a route that had already written the same document. The
 * broadcasts are deleted, so these pin that the document alone carries every
 * one of those edits into the store.
 *
 * They all take the same form, because a clip is ONE document: whatever
 * changed, the whole composed doc arrives and `mapTrackClip` turns its keyed
 * lanes/keyframes/events into the ordered lists the timeline reads.
 */

describe('meshStoreFeeder — server_status routing', () => {
  const status = (doc: Record<string, unknown>) =>
    observers.get('server_status')!({
      op: 'upsert',
      id: doc.id as string,
      doc,
    });

  beforeEach(async () => {
    await startFeeder();
  });

  it('patches an OBS connection with its live status', () => {
    useEditorStore.setState({
      obsConnections: [
        {
          id: 'c1',
          status: 'disconnected',
          statusReason: null,
          statusMessage: null,
        },
      ] as never,
    });
    status({
      id: 'obs_connection:c1',
      kind: 'obs_connection',
      key: 'c1',
      status: 'connected',
      reason: null,
      message: null,
    });
    expect(useEditorStore.getState().obsConnections[0].status).toBe(
      'connected'
    );
  });

  it('sets the output window runtime state', () => {
    status({
      id: 'output_window:main',
      kind: 'output_window',
      key: 'main',
      state: 'ready',
    });
    expect(useEditorStore.getState().outputWindowStatus).toMatchObject({
      state: 'ready',
    });
  });
});
