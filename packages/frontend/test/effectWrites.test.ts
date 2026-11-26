/**
 * Camera-effect writes go straight onto the tab's peer — the store the app
 * reads — and land on its undo stack (helpers/mesh.ts gives each test one).
 */
import { describe, expect, it } from 'vitest';
import {
  commitEffectCreate,
  commitEffectDelete,
  commitEffectPatch,
} from '../src/mesh/effectWrites';
import { testPeer } from './helpers/mesh';
import type { CameraEffectRecord } from '../src/api/client';

const effects = () =>
  testPeer().collection<CameraEffectRecord>('camera_effect');

describe('camera_effect writes', () => {
  it('a created effect is in the store at once, and one undo removes it', async () => {
    const doc = await commitEffectCreate('cam-1', { kind: 'bloom' });
    expect(effects().get(doc.id)).toMatchObject({
      nodeId: 'cam-1',
      kind: 'bloom',
      enabled: true,
    });
    expect(testPeer().undo()).toBe(true);
    expect(effects().get(doc.id)).toBeUndefined();
  });

  it('toggling off is one committed write, undone in one step', async () => {
    const doc = await commitEffectCreate('cam-1', { kind: 'bloom' });
    commitEffectPatch(doc.id, { enabled: false });
    expect(effects().get(doc.id)?.enabled).toBe(false);
    testPeer().undo();
    expect(effects().get(doc.id)?.enabled).toBe(true);
  });

  it('deleting removes the effect; undo brings it back', async () => {
    const doc = await commitEffectCreate('cam-1', {
      kind: 'vignette',
      config: { darkness: 0.4 },
    });
    expect(await commitEffectDelete(doc.id)).toBe(true);
    expect(effects().get(doc.id)).toBeUndefined();
    testPeer().undo();
    expect(effects().get(doc.id)?.config).toEqual({ darkness: 0.4 });
  });
});
