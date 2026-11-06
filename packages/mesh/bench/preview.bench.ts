/**
 * W3 benchmark: what does a mocap frame cost on the mesh `preview` channel,
 * compared with today's `/ws` broadcast? (plans/mesh-sole-channel.md, W3:
 * "benchmark first; optimize the channel where it falls short").
 *
 * Both paths run in-process with real serialization, no network:
 *
 *  - ws:   today's broadcast — one JSON.stringify of `{kind, payload}` per
 *          frame, the same string written to every client, one JSON.parse per
 *          client on receipt.
 *  - mesh: a server peer writes the frame on `preview`; it fans out to N tab
 *          peers over a transport that stringifies per link and parses on
 *          receipt (what WsServerTransport / WsBackendTransport do), and each
 *          tab runs its full receive path (dedup, admission, overlay apply,
 *          observer notify).
 *
 * Run: pnpm --filter @vspark/mesh exec tsx bench/preview.bench.ts
 */
import { createMeshPeer, type MeshPeer } from '../src/peer.js';
import { encode, type MeshMessage } from '../src/wire.js';
import type { MeshTransport, TransportHandlers } from '../src/transport.js';

const BONES = 55; // VRM humanoid bone count
const FRAMES = 20_000;

function poseFrame(i: number): Record<string, unknown> {
  const bones: Record<string, [number, number, number, number]> = {};
  for (let b = 0; b < BONES; b++) {
    const t = (i + b) * 0.001;
    bones[`bone${b}`] = [
      Math.sin(t),
      Math.cos(t),
      Math.sin(t * 2),
      Math.cos(t * 2),
    ];
  }
  return { nodeId: 'avatar-1', bones };
}

/** A synchronous transport pair that serializes like the WS transports. */
function jsonPair(
  aId: string,
  bId: string
): { a: MeshTransport; b: MeshTransport; bytes: () => number } {
  let ha: TransportHandlers | null = null;
  let hb: TransportHandlers | null = null;
  let bytes = 0;
  const link = (from: string, to: () => TransportHandlers | null) => ({
    send: (m: MeshMessage) => {
      const s = encode(m);
      bytes += s.length;
      to()?.message(from, JSON.parse(s) as MeshMessage);
    },
  });
  const connect = () => {
    if (!ha || !hb) return;
    ha.peerConnected(
      bId,
      link(aId, () => hb)
    );
    hb.peerConnected(
      aId,
      link(bId, () => ha)
    );
  };
  return {
    a: {
      start: (h) => {
        ha = h;
        connect();
      },
      stop: () => (ha = null),
    },
    b: {
      start: (h) => {
        hb = h;
        connect();
      },
      stop: () => (hb = null),
    },
    bytes: () => bytes,
  };
}

function benchWs(clients: number): {
  usPerFrame: number;
  bytesPerFrame: number;
} {
  let sink = 0;
  const t0 = performance.now();
  let bytes = 0;
  for (let i = 0; i < FRAMES; i++) {
    const s = JSON.stringify({ kind: 'vmc_pose', payload: poseFrame(i) });
    bytes += s.length * clients;
    for (let c = 0; c < clients; c++)
      sink += (JSON.parse(s) as { kind: string }).kind.length;
  }
  const us = ((performance.now() - t0) * 1000) / FRAMES;
  if (sink < 0) console.log(sink);
  return { usPerFrame: us, bytesPerFrame: bytes / FRAMES };
}

async function benchMesh(
  tabs: number
): Promise<{ usPerFrame: number; bytesPerFrame: number }> {
  const server = createMeshPeer({ identity: { peerId: 'S' } });
  const frames = server.collection<Record<string, unknown> & { id: string }>(
    'node_stream',
    {
      channels: ['preview'],
      clients: { read: true },
    }
  );
  const pairs: ReturnType<typeof jsonPair>[] = [];
  const peers: MeshPeer[] = [];
  let received = 0;
  for (let t = 0; t < tabs; t++) {
    const id = `S#tab${t}`;
    const p = jsonPair('S', id);
    pairs.push(p);
    server.addTransport(p.a);
    const tab = createMeshPeer({
      identity: { peerId: id },
      home: 'S',
      transports: [p.b],
    });
    const col = tab.collection<Record<string, unknown> & { id: string }>(
      'node_stream',
      {
        channels: ['preview'],
        authority: 'S',
      }
    );
    col.observe('**', () => received++);
    // subscribe resolves synchronously through the sync transport
    await tab.subscribe('S', {
      entityRtype: 'node_stream',
      entityId: '*',
      includeDescendants: false,
      pathPrefix: '',
      channels: ['preview'],
    } as never);
    peers.push(tab);
  }
  const before = pairs.reduce((n, p) => n + p.bytes(), 0);
  const t0 = performance.now();
  for (let i = 0; i < FRAMES; i++)
    frames.set(
      'avatar-1',
      '',
      { id: 'avatar-1', ...poseFrame(i) },
      { channel: 'preview' }
    );
  const us = ((performance.now() - t0) * 1000) / FRAMES;
  const bytes = pairs.reduce((n, p) => n + p.bytes(), 0) - before;
  if (received !== FRAMES * tabs)
    throw new Error(`expected ${FRAMES * tabs} deliveries, got ${received}`);
  server.close();
  for (const p of peers) p.close();
  return { usPerFrame: us, bytesPerFrame: bytes / FRAMES };
}

async function main(): Promise<void> {
  // Warm up the JIT on both paths.
  benchWs(1);
  await benchMesh(1);
  console.log(`${FRAMES} frames, ${BONES} bones each\n`);
  console.log(
    'clients | ws µs/frame | mesh µs/frame | ratio | ws bytes/frame | mesh bytes/frame'
  );
  for (const n of [1, 4, 10]) {
    const ws = benchWs(n);
    const mesh = await benchMesh(n);
    console.log(
      `${String(n).padStart(7)} | ${ws.usPerFrame.toFixed(1).padStart(11)} | ${mesh.usPerFrame
        .toFixed(1)
        .padStart(
          13
        )} | ${(mesh.usPerFrame / ws.usPerFrame).toFixed(2).padStart(5)} | ${Math.round(
        ws.bytesPerFrame
      )
        .toString()
        .padStart(
          14
        )} | ${Math.round(mesh.bytesPerFrame).toString().padStart(16)}`
    );
  }
}

void main();
