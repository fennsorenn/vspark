/**
 * behavior + camera_effect authored on the mesh.
 *
 * Both were REST-only until now, which meant every attach, toggle and config
 * edit was authored by the SERVER and so landed on nobody's undo stack. Adding
 * a bloom effect, switching a behavior off, dragging a sensitivity slider —
 * none of it could be undone.
 *
 * These pin that the tab authors them.
 *
 * Note what is deliberately NOT asserted on the mesh path: the local store. A
 * mesh write is mirrored into the store by the feeder observing the replica —
 * "the feeder mirrors the replica into the store; nothing to apply here", as
 * commitDocCreate puts it — so a test with no feeder sees the write and no
 * store change. That is also why the optimistic store writes those call sites
 * used to do could be removed. The REST fallback is the exception: nothing
 * else will apply it, so the helper does, and that IS asserted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Write {
  rtype: string;
  id: string;
  path?: string;
  value?: unknown;
  op: 'set' | 'update' | 'remove';
}

const writes: Write[] = [];
let canWrite = true;
const docs = new Map<string, object>();

const collectionFor = (rtype: string) => ({
  canWrite: () => canWrite,
  get: (id: string) => docs.get(id),
  set: (id: string, path: string, value: unknown) => {
    writes.push({ rtype, id, path, value, op: 'set' });
    docs.set(id, value as object);
    return { ack: Promise.resolve({ status: 'acked' }) };
  },
  update: (id: string, partial: object) => {
    writes.push({ rtype, id, value: partial, op: 'update' });
    return { ack: Promise.resolve({ status: 'acked' }) };
  },
  remove: (id: string) => {
    writes.push({ rtype, id, op: 'remove' });
    docs.delete(id);
    return { ack: Promise.resolve({ status: 'acked' }) };
  },
});

vi.mock('../src/mesh/peer', () => ({
  getMeshHandles: () => ({
    peer: {},
    serverPeerId: 'server',
    collections: {
      behavior: collectionFor('behavior'),
      camera_effect: collectionFor('camera_effect'),
    },
  }),
  meshBatch: <T>(fn: () => T): T => fn(),
}));

vi.mock('../src/api/client', () => ({
  api: {
    createBehavior: vi.fn(() => Promise.resolve({})),
    updateBehavior: vi.fn(() => Promise.resolve({})),
    deleteBehavior: vi.fn(() => Promise.resolve({})),
    createCameraEffect: vi.fn(() => Promise.resolve({})),
    updateCameraEffect: vi.fn(() => Promise.resolve({})),
    deleteCameraEffect: vi.fn(() => Promise.resolve({})),
  },
}));

const of = (rtype: string) => writes.filter((w) => w.rtype === rtype);

describe('behavior writes', () => {
  beforeEach(() => {
    writes.length = 0;
    canWrite = true;
    docs.clear();
  });

  it('creating authors on the mesh', async () => {
    const { useEditorStore } = await import('../src/store/editorStore');
    useEditorStore.setState({ behaviors: [] });
    const { commitBehaviorCreate } = await import('../src/mesh/behaviorWrites');

    await commitBehaviorCreate('node-1', { kind: 'breathing' });

    expect(of('behavior')).toHaveLength(1);
    expect(of('behavior')[0].value).toMatchObject({
      nodeId: 'node-1',
      kind: 'breathing',
    });
  });

  it('mints its own id, so the create is authored by this tab', async () => {
    const { useEditorStore } = await import('../src/store/editorStore');
    useEditorStore.setState({ behaviors: [] });
    const { commitBehaviorCreate } = await import('../src/mesh/behaviorWrites');

    const made = await commitBehaviorCreate('node-1', { kind: 'breathing' });
    // A server-minted id would mean a server-authored create — and no undo.
    expect(of('behavior')[0].id).toBe(made.id);
  });

  it('a config edit is exactly one committed write', async () => {
    const { useEditorStore } = await import('../src/store/editorStore');
    useEditorStore.setState({
      behaviors: [
        {
          id: 'b1',
          nodeId: 'n1',
          kind: 'breathing',
          enabled: true,
          config: {},
        },
      ],
    });
    docs.set('b1', {});
    const { commitBehaviorPatch } = await import('../src/mesh/behaviorWrites');

    commitBehaviorPatch('b1', { config: { rate: 2 } });

    // One merge-patch, not a write per field: a settled edit is one undo step.
    expect(of('behavior')).toHaveLength(1);
    expect(of('behavior')[0].op).toBe('update');
    expect(of('behavior')[0].value).toEqual({ config: { rate: 2 } });
  });

  it('deleting authors a remove on the mesh', async () => {
    const { useEditorStore } = await import('../src/store/editorStore');
    useEditorStore.setState({
      behaviors: [
        {
          id: 'b1',
          nodeId: 'n1',
          kind: 'breathing',
          enabled: true,
          config: {},
        },
      ],
    });
    docs.set('b1', {});
    const { commitBehaviorDelete } = await import('../src/mesh/behaviorWrites');

    await commitBehaviorDelete('b1');

    expect(of('behavior').some((w) => w.op === 'remove')).toBe(true);
  });
});

describe('camera_effect writes', () => {
  beforeEach(() => {
    writes.length = 0;
    canWrite = true;
    docs.clear();
  });

  it('creating authors on the mesh', async () => {
    const { useEditorStore } = await import('../src/store/editorStore');
    useEditorStore.setState({ cameraEffects: [] });
    const { commitEffectCreate } = await import('../src/mesh/effectWrites');

    await commitEffectCreate('cam-1', { kind: 'bloom' });

    expect(of('camera_effect')).toHaveLength(1);
    expect(of('camera_effect')[0].value).toMatchObject({
      nodeId: 'cam-1',
      kind: 'bloom',
    });
  });

  it('toggling off is one committed write', async () => {
    const { useEditorStore } = await import('../src/store/editorStore');
    useEditorStore.setState({
      cameraEffects: [
        { id: 'e1', nodeId: 'n1', kind: 'bloom', enabled: true, config: {} },
      ],
    });
    docs.set('e1', {});
    const { commitEffectPatch } = await import('../src/mesh/effectWrites');

    commitEffectPatch('e1', { enabled: false });

    expect(of('camera_effect')).toHaveLength(1);
    expect(of('camera_effect')[0].value).toEqual({ enabled: false });
  });

  it('falls back to REST when the peer cannot author', async () => {
    // The write still lands — it just is not undoable, which is the honest
    // consequence of the server authoring it.
    const { useEditorStore } = await import('../src/store/editorStore');
    const { api } = await import('../src/api/client');
    useEditorStore.setState({
      cameraEffects: [
        { id: 'e1', nodeId: 'n1', kind: 'bloom', enabled: true, config: {} },
      ],
    });
    canWrite = false;

    const { commitEffectPatch } = await import('../src/mesh/effectWrites');
    commitEffectPatch('e1', { enabled: false });

    expect(of('camera_effect')).toHaveLength(0);
    expect(api.updateCameraEffect).toHaveBeenCalled();
    expect(useEditorStore.getState().cameraEffects[0].enabled).toBe(false);
  });
});
