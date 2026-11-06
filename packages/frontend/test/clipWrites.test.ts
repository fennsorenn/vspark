/**
 * Track-clip edits authored on the mesh, per element.
 *
 * What these pin is the shape of the WRITES, because that is what the id-keying
 * was for. Before it, every keyframe edit re-sent the lane's whole list: two
 * people dragging different keyframes overwrote each other, a 60Hz record put
 * the entire lane on the wire per sample, and none of it was undoable because
 * the server authored it.
 *
 * A recording stand-in for the collections pins the exact op each helper
 * issues.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Write {
  id: string;
  path?: string;
  value?: unknown;
  channel?: string;
  op: 'set' | 'update' | 'remove';
}

const writes: Write[] = [];
let canWrite = true;
const docs = new Map<string, object>();

const collectionFor = (rtype: string) => ({
  canWrite: () => canWrite,
  get: (id: string) => docs.get(id),
  set: (
    id: string,
    path: string,
    value: unknown,
    opts?: { channel?: string }
  ) => {
    writes.push({ id, path, value, channel: opts?.channel, op: 'set' });
    if (path === '') docs.set(id, value as object);
    return { ack: Promise.resolve({ status: 'acked' }) };
  },
  update: (id: string, partial: object) => {
    writes.push({ id, value: partial, op: 'update' });
    return { ack: Promise.resolve({ status: 'acked' }) };
  },
  remove: (id: string) => {
    writes.push({ id, op: 'remove' });
    docs.delete(id);
    return { ack: Promise.resolve({ status: 'acked' }) };
  },
  create: (doc: { id: string }) => {
    writes.push({ id: doc.id, path: '', value: doc, op: 'set' });
    docs.set(doc.id, doc);
    return { ack: Promise.resolve({ status: 'acked' }) };
  },
  __rtype: rtype,
});
const cols: Record<string, ReturnType<typeof collectionFor>> = {
  track_clip: collectionFor('track_clip'),
  clip_playback: collectionFor('clip_playback'),
};

vi.mock('../src/mesh/peer', () => ({
  getMeshHandles: () => ({
    peer: { collection: (rtype: string) => cols[rtype] },
    serverPeerId: 'server',
    collections: cols,
  }),
  meshBatch: <T>(fn: () => T): T => fn(),
}));

vi.mock('../src/api/client', () => ({
  api: {
    createTrackClipForNode: vi.fn(() =>
      Promise.resolve({ id: 'server-minted' })
    ),
    createTrackClipForLayer: vi.fn(() =>
      Promise.resolve({ id: 'server-minted' })
    ),
    deleteTrackClip: vi.fn(() => Promise.resolve({})),
    updateTrackClip: vi.fn(() => Promise.resolve({})),
    createTrackClipLane: vi.fn(() => Promise.resolve({ id: 'server-lane' })),
    updateTrackClipLane: vi.fn(() => Promise.resolve({})),
    deleteTrackClipLane: vi.fn(() => Promise.resolve({})),
    replaceTrackClipKeyframes: vi.fn(() => Promise.resolve({})),
    replaceTrackClipEvents: vi.fn(() => Promise.resolve({})),
  },
}));

const kf = (id: string, t: number, value = 0) => ({
  id,
  t,
  value,
  easing: 'linear' as const,
  inHandleTFraction: null,
  inHandleVFraction: null,
  outHandleTFraction: null,
  outHandleVFraction: null,
});

/** A clip the (stand-in) replica holds. */
async function seedClip() {
  docs.set('c1', { id: 'c1' });
}

describe('track-clip writes', () => {
  beforeEach(async () => {
    writes.length = 0;
    canWrite = true;
    docs.clear();
  });

  it('addresses one keyframe per write, not the lane', async () => {
    await seedClip();
    const { commitKeyframe } = await import('../src/mesh/clipWrites');

    commitKeyframe('c1', 'l1', kf('k1', 0.25, 3));

    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('lanes.l1.keyframes.k1');
    expect(writes[0].value).toMatchObject({ t: 0.25, value: 3 });
    // Nothing about k2 travels — that is what lets two people drag different
    // keyframes of one lane at the same time.
    expect(JSON.stringify(writes[0].value)).not.toContain('k2');
  });

  it('drags on the preview channel and commits once', async () => {
    await seedClip();
    const { previewKeyframe, commitKeyframe } =
      await import('../src/mesh/clipWrites');

    previewKeyframe('c1', 'l1', kf('k1', 0.1));
    previewKeyframe('c1', 'l1', kf('k1', 0.2));
    commitKeyframe('c1', 'l1', kf('k1', 0.2));

    expect(writes.map((w) => w.channel)).toEqual([
      'preview',
      'preview',
      undefined,
    ]);
    // Only the last one is model state, so a drag is a single undo step.
    expect(writes.filter((w) => w.channel === undefined)).toHaveLength(1);
  });

  it('deletes a keyframe by writing a null at its path', async () => {
    await seedClip();
    const { commitKeyframeDelete } = await import('../src/mesh/clipWrites');

    commitKeyframeDelete('c1', 'l1', 'k2');

    expect(writes).toEqual([
      {
        id: 'c1',
        path: 'lanes.l1.keyframes.k2',
        value: null,
        channel: undefined,
        op: 'set',
      },
    ]);
  });

  it('creates a lane at its own path with an empty keyframe MAP', async () => {
    await seedClip();
    const { commitLaneCreate } = await import('../src/mesh/clipWrites');

    const lane = await commitLaneCreate('c1', {
      targetKind: 'scene_node',
      targetId: 'n1',
      paramPath: 'position.y',
      defaultValue: 0,
    });

    expect(writes[0].path).toBe(`lanes.${lane.id}`);
    // The document shape, not the store's: an array here would put every
    // keyframe of the new lane back on one path.
    expect((writes[0].value as { keyframes: unknown }).keyframes).toEqual({});
    // Minted locally, so the create is this tab's to undo.
    expect(lane.id).not.toBe('server-lane');
  });

  it('deletes a lane by writing a null at its path', async () => {
    await seedClip();
    const { commitLaneDelete } = await import('../src/mesh/clipWrites');

    await commitLaneDelete('c1', 'l1');

    expect(writes).toEqual([
      {
        id: 'c1',
        path: 'lanes.l1',
        value: null,
        channel: undefined,
        op: 'set',
      },
    ]);
  });

  it('writes one marker per event edit', async () => {
    await seedClip();
    const { commitEvent, commitEventDelete } =
      await import('../src/mesh/clipWrites');

    commitEvent('c1', {
      id: 'e1',
      t: 1,
      action: 'stop',
      targetKind: 'scene_node',
      targetId: 'n1',
      payload: null,
    });
    commitEventDelete('c1', 'e1');

    expect(writes.map((w) => w.path)).toEqual(['events.e1', 'events.e1']);
    expect(writes[1].value).toBeNull();
  });

  it('removes the transport document with the clip', async () => {
    await seedClip();
    docs.set('pb:c1', {});
    const { commitClipDelete } = await import('../src/mesh/clipWrites');

    await commitClipDelete('c1');

    // Leaving the playback doc behind would strand transport state for a clip
    // that no longer exists, in every replica.
    expect(
      writes
        .filter((w) => w.op === 'remove')
        .map((w) => w.id)
        .sort()
    ).toEqual(['c1', 'pb:c1']);
  });
});
