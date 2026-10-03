/**
 * Runtime overrides as retained mesh documents.
 *
 * They used to ride three transports at once — the `/ws` broadcast with a
 * `_snapshot` replayed per client, the collab `runtime_control` relay, and the
 * object-share `_share_override` envelope — with the manager holding a fourth
 * copy so it could answer the snapshot. All four are one retained collection
 * now.
 *
 * What these pin is the part that is easy to get silently wrong:
 *
 *  - the CHANNEL. Retained is the whole point (a late joiner must see the
 *    current value), and no `ack` is equally deliberate: an acked write is a
 *    logged one, and a graph firing overrides would otherwise bury the
 *    authoring tab's undo stack under writes the user never made.
 *  - the KEY, one document per overridden path, which is what stops two graphs
 *    overriding different params of one node from clobbering each other.
 *  - CONTAINMENT, which is what lets an override ride an existing scene-subtree
 *    grant instead of needing a route of its own.
 *
 * A second peer stands in for a collab peer / a tab: subscribing to the rtype
 * must deliver the overrides that were set BEFORE it subscribed. That is the
 * property the `_snapshot` message used to provide by hand.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createLoopbackPair,
  createMeshPeer,
  type MeshPeer,
} from '@vspark/mesh';
import {
  dataFieldCollection,
  dataFieldKey,
  dataFieldParent,
  initMeshRuntime,
  overrideCollection,
  parseDataFieldKey,
  overrideKey,
  parseOverrideKey,
  resetMeshRuntime,
  RUNTIME_CHANNEL,
  RUNTIME_OVERRIDE_RTYPE,
  type RuntimeOverrideDoc,
} from '../src/mesh/runtime.js';
import { RuntimeOverrideManager } from '../src/runtime_overrides/manager.js';
import { DataChannelManager } from '../src/data_channels/manager.js';

const CHANNEL_PROPS = {
  transport: 'reliable',
  stamped: true,
  retained: true,
} as const;

describe('runtime_override collection', () => {
  let server: MeshPeer;
  let manager: RuntimeOverrideManager;

  beforeEach(() => {
    resetMeshRuntime();
    server = createMeshPeer({
      identity: { peerId: 'server' },
      transports: [],
    });
    initMeshRuntime(server);
    manager = new RuntimeOverrideManager();
    manager.init();
    manager.registerTarget('node-1', 'scene-1');
  });

  afterEach(() => {
    resetMeshRuntime();
  });

  it('is registered on a retained channel with no ack', () => {
    // Retained: a late joiner gets the current value. No ack: the write never
    // reaches an undo stack. Both are load-bearing, so both are asserted here
    // rather than left to the registration site.
    const props = server.channels.get(RUNTIME_CHANNEL);
    expect(props).toEqual(CHANNEL_PROPS);
    expect(props?.ack).toBeUndefined();
  });

  it('keys one document per (target, paramPath)', () => {
    manager.set('scene_node', 'node-1', 'position.x', 1);
    manager.set('scene_node', 'node-1', 'opacity', 0.5);

    expect(
      overrideCollection()!
        .all()
        .map((d) => d.id)
        .sort()
    ).toEqual(['scene_node:node-1:opacity', 'scene_node:node-1:position.x']);
  });

  it('round-trips a key whose paramPath contains dots', () => {
    // targetKind and targetId are colon-free, so the two splits are safe even
    // though a paramPath is dotted — which is why the id can be a plain string
    // instead of something escaped.
    const id = overrideKey('compose_layer', 'layer-9', 'text.content');
    expect(parseOverrideKey(id)).toEqual({
      targetKind: 'compose_layer',
      targetId: 'layer-9',
      paramPath: 'text.content',
    });
  });

  it('parents each override to the entity it overrides', () => {
    manager.set('scene_node', 'node-1', 'opacity', 0.5);
    // Containment, not a bespoke route, is what carries an override to a peer
    // that holds a subtree grant on the scene.
    expect(
      server.parentIdOf(overrideKey('scene_node', 'node-1', 'opacity'))
    ).toBe('node-1');
  });

  it('delivers overrides set BEFORE a peer subscribed', async () => {
    // A second peer stands in for a tab or a collab peer. It has to be wired
    // before the server writes, so build it here rather than in beforeEach.
    const lb = createLoopbackPair('server', 'client');
    const wired = createMeshPeer({
      identity: { peerId: 'server' },
      transports: [lb.a],
    });
    resetMeshRuntime();
    initMeshRuntime(wired);
    const m = new RuntimeOverrideManager();
    m.init();
    m.registerTarget('node-1', 'scene-1');

    const client = createMeshPeer({
      identity: { peerId: 'client' },
      transports: [lb.b],
    });
    client.channel(RUNTIME_CHANNEL, CHANNEL_PROPS);
    const col = client.collection<RuntimeOverrideDoc>(RUNTIME_OVERRIDE_RTYPE, {
      channels: [RUNTIME_CHANNEL],
      authority: 'server',
    });

    wired.grants.grant({
      grantee: 'client',
      entityRtype: RUNTIME_OVERRIDE_RTYPE,
      entityId: '*',
      includeDescendants: false,
      pathPrefix: '',
      rights: { read: true, update: false, create: false, delete: false },
    });

    // Set FIRST, subscribe after — the ordering the snapshot has to survive.
    m.set('scene_node', 'node-1', 'opacity', 0.25);
    await lb.flush();
    await client.subscribe('server', {
      entityRtype: RUNTIME_OVERRIDE_RTYPE,
      entityId: '*',
      includeDescendants: false,
      pathPrefix: '',
    });
    await lb.flush();

    // This is what the `runtime_override_snapshot` message used to do by hand.
    expect(col.get('scene_node:node-1:opacity')?.value).toBe(0.25);

    // And a later change still arrives, so the snapshot isn't a one-shot.
    m.set('scene_node', 'node-1', 'opacity', 0.75);
    await lb.flush();
    expect(col.get('scene_node:node-1:opacity')?.value).toBe(0.75);

    // A clear is a document remove — including the whole-target form, which
    // the receiver sees as one remove per path.
    m.clear('scene_node', 'node-1');
    await lb.flush();
    expect(col.get('scene_node:node-1:opacity')).toBeUndefined();
  });

  it('keys a data field per (scope, field) and parents it to the scope', () => {
    // Same shape as an override: one document per published value, hung off
    // the entity it is scoped to. A GLOBAL field (scope '') belongs to no
    // entity and gets no parent — it reaches subscribers by rtype alone.
    const dc = new DataChannelManager();
    dc.set('', { headline: 'hello' });

    const global = dataFieldCollection()!.get(':headline');
    expect(global?.value).toBe('hello');
    expect(dataFieldParent(global!)).toBeNull();
  });

  it('splits a data-field key on the FIRST colon only', () => {
    // The scope is an entity id or '' — colon-free either way — and the field
    // label is arbitrary user text that takes the rest.
    expect(parseDataFieldKey(dataFieldKey('n1', 'a:b'))).toEqual({
      scope: 'n1',
      field: 'a:b',
    });
    expect(parseDataFieldKey(dataFieldKey('', 'x'))).toEqual({
      scope: '',
      field: 'x',
    });
  });

  it('does not log an undo entry for a graph-driven override', () => {
    // The reason the channel has no ack. A signal graph writing overrides must
    // not consume the user's undo stack.
    manager.set('scene_node', 'node-1', 'opacity', 0.5);
    expect(server.canUndo()).toBe(false);
  });
});
