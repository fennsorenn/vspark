/**
 * End-to-end over real sockets: a backend mesh peer (authority + fake-DB tap)
 * serving a browser-tab peer through WsServerTransport ↔ WsBackendTransport.
 */
import { createServer, type Server } from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMeshPeer, type Collection, type MeshPeer } from '@vspark/mesh';
import { makeClientParticipantId } from '@vspark/shared/sync';
import { WsServerTransport } from '../src/wsServer.js';
import { WsBackendTransport } from '../src/wsClient.js';

interface Node {
  id: string;
  name: string;
  [k: string]: unknown;
}

const SERVER_ID = 'srv-1';

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let http: Server;
let backend: MeshPeer;
let tab: MeshPeer;
let serverNodes: Collection<Node>;
let tabNodes: Collection<Node>;
const db = new Map<string, Node>();

beforeAll(async () => {
  const transport = new WsServerTransport(SERVER_ID);
  http = createServer();
  http.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/mesh')) transport.upgrade(req, socket, head);
    else socket.destroy();
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;

  backend = createMeshPeer({
    identity: { peerId: SERVER_ID },
    transports: [transport],
  });
  serverNodes = backend.collection<Node>('node', { authority: 'self' });
  serverNodes.onCommitted((c) => {
    if (c.op === 'remove') db.delete(c.id);
    else db.set(c.id, c.doc as Node);
  });
  // One grant covers every tab of this server (grantee = the server peer id).
  backend.grants.grant({
    grantee: SERVER_ID,
    entityRtype: 'node',
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true, update: true, create: true, delete: true },
  });

  const participantId = makeClientParticipantId(SERVER_ID, 'tab-1');
  tab = createMeshPeer({
    identity: { peerId: participantId },
    transports: [
      new WsBackendTransport({
        url: `ws://127.0.0.1:${port}/mesh`,
        participantId,
        serverPeerId: SERVER_ID,
      }),
    ],
  });
  tabNodes = tab.collection<Node>('node', { authority: SERVER_ID });
  await waitFor(() => tab.status().peers.some((p) => p.id === SERVER_ID));
});

afterAll(async () => {
  tab.close();
  backend.close();
  await new Promise((r) => http.close(r));
});

describe('ws transport pair', () => {
  it('handshakes, snapshots, and streams live ops to the tab', async () => {
    serverNodes.create({ id: 'n1', name: 'first' });
    await tab.subscribe(SERVER_ID, {
      entityRtype: 'node',
      entityId: '*',
      includeDescendants: false,
      pathPrefix: '',
    });
    expect(tabNodes.get('n1')?.name).toBe('first');

    serverNodes.set('n1', 'name', 'renamed');
    await waitFor(() => tabNodes.get('n1')?.name === 'renamed');
  });

  it('tab writes ack and persist on the backend', async () => {
    const outcome = await tabNodes.update('n1', { name: 'from-tab' }).ack;
    expect(outcome.status).toBe('acked');
    expect(serverNodes.get('n1')?.name).toBe('from-tab');
    expect(db.get('n1')?.name).toBe('from-tab');
  });

  it('tab creates flow home and removes propagate back', async () => {
    expect((await tabNodes.create({ id: 'n2', name: 'tab-made' }).ack).status).toBe(
      'acked'
    );
    expect(db.get('n2')?.name).toBe('tab-made');

    serverNodes.remove('n2');
    await waitFor(() => tabNodes.get('n2') === undefined);
    expect(db.has('n2')).toBe(false);
  });
});
