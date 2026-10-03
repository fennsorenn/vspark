/**
 * meshPreviewFields.test.ts — previewDocFields / previewNodeTransform.
 *
 * The rule these pin: ONE OVERLAY PER PATH, at the depth of the value being
 * driven. Two ways to get it wrong, both of which look fine until another peer
 * watches the gesture:
 *
 *  - A pathless ephemeral write is a ROOT overlay. It clears the per-path
 *    overlays and replaces the composed doc wholesale, so `{x: 400}` composes to
 *    a doc that is ONLY `{x: 400}` — the id included.
 *  - An overlay at `components.transform` blanks that component's other fields
 *    (opacity, castShadow, receiveShadow) for the whole gesture on every
 *    watching tab. It is the live-preview twin of the commit bug that
 *    `mergedTransform` fixes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface SetCall {
  id: string;
  path: string;
  value: unknown;
  opts?: { channel?: string };
}

const calls: SetCall[] = [];
let canWrite = true;
let held: Record<string, unknown> | undefined;

vi.mock('../src/mesh/peer', () => ({
  getMeshHandles: () => ({
    collections: {
      scene_node: {
        canWrite: () => canWrite,
        get: () => held,
        set: (id: string, path: string, value: unknown, opts?: object) =>
          calls.push({ id, path, value, opts }),
        update: () => undefined,
      },
    },
  }),
  initMeshPeer: () => Promise.resolve({ collections: {} }),
}));

const NODE = {
  id: 'n1',
  projectId: 'p1',
  name: 'N',
  kind: 'group',
  rootSceneNodeId: 's1',
  components: {
    transform: {
      type: 'transform',
      x: 0,
      y: 0,
      z: 0,
      opacity: 0.3,
      castShadow: false,
    },
  },
};

describe('previewNodeTransform', () => {
  beforeEach(async () => {
    calls.length = 0;
    canWrite = true;
    held = NODE;
    const { useEditorStore } = await import('../src/store/editorStore');
    useEditorStore.setState({ projectId: 'p1', nodes: [NODE as never] });
  });

  it('writes one overlay per scalar, on the preview channel', async () => {
    const { previewNodeTransform } = await import('../src/mesh/writes');
    previewNodeTransform('n1', { x: 4, y: 5 });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.path)).toEqual([
      'components.transform.x',
      'components.transform.y',
    ]);
    expect(calls.map((c) => c.value)).toEqual([4, 5]);
    for (const c of calls) expect(c.opts?.channel).toBe('preview');
  });

  it('never writes a pathless (root) overlay', async () => {
    const { previewNodeTransform } = await import('../src/mesh/writes');
    previewNodeTransform('n1', { x: 4 });
    for (const c of calls) expect(c.path).not.toBe('');
  });

  it('never writes at the component level, only below it', async () => {
    // An overlay AT components.transform would blank opacity and the shadow
    // flags for the duration of the gesture on every watching tab.
    const { previewNodeTransform } = await import('../src/mesh/writes');
    previewNodeTransform('n1', { x: 4, ry: 1.2, sx: 2 });
    for (const c of calls) {
      expect(c.path).not.toBe('components.transform');
      expect(c.path.startsWith('components.transform.')).toBe(true);
    }
  });

  it('emits nothing when the replica does not hold the doc', async () => {
    held = undefined;
    const { previewNodeTransform } = await import('../src/mesh/writes');
    previewNodeTransform('n1', { x: 4 });
    expect(calls).toHaveLength(0);
  });

  it('falls back to a local apply when the peer cannot author', async () => {
    canWrite = false;
    const { useEditorStore } = await import('../src/store/editorStore');
    const { previewNodeTransform } = await import('../src/mesh/writes');
    previewNodeTransform('n1', { x: 7, y: 8 });

    expect(calls).toHaveLength(0);
    const t = (
      useEditorStore.getState().nodes[0].components as Record<string, unknown>
    ).transform as Record<string, unknown>;
    // Both sibling paths survive: accumulating matters here, because each one
    // rebuilds `components` from the stored doc and would otherwise drop the
    // ones before it.
    expect(t.x).toBe(7);
    expect(t.y).toBe(8);
    // ...and the fields the gesture does not drive are untouched.
    expect(t.opacity).toBe(0.3);
    expect(t.castShadow).toBe(false);
  });
});
