import { describe, it, expect } from 'vitest';
import {
  compareHLC,
  makeHlcClock,
  makeClientParticipantId,
  isClientParticipant,
  participantServer,
  estimateClockOffset,
  makeOffsetTracker,
  localizeAnchor,
  makeKey,
  parseKey,
  keyMatches,
  pathCovers,
  grantAllows,
  evaluateAccess,
  granteeCandidates,
  grantCoversSubscription,
  subscriptionMatches,
  SubscriptionHub,
  randomUUID,
  type HLC,
  type Grant,
  type Subscription,
  type IsDescendant,
} from '../src/sync.js';

describe('HLC', () => {
  const hlc = (t: number, c: number, n: string): HLC => ({ t, c, n });

  it('orders by time, then counter, then peer id', () => {
    expect(compareHLC(hlc(2, 0, 'a'), hlc(1, 9, 'a'))).toBeGreaterThan(0);
    expect(compareHLC(hlc(1, 0, 'a'), hlc(1, 5, 'a'))).toBeLessThan(0);
    expect(compareHLC(hlc(1, 0, 'a'), hlc(1, 0, 'b'))).toBeLessThan(0);
    expect(compareHLC(hlc(1, 0, 'a'), hlc(1, 0, 'a'))).toBe(0);
  });

  it('makeHlcClock is strictly monotonic even within one millisecond', () => {
    const clock = makeHlcClock('peer1');
    const a = clock();
    const b = clock();
    const c = clock();
    expect(compareHLC(b, a)).toBeGreaterThan(0);
    expect(compareHLC(c, b)).toBeGreaterThan(0);
    expect(a.n).toBe('peer1');
  });
});

describe('participants', () => {
  it('mints + recognises client participant ids', () => {
    const id = makeClientParticipantId('srv', 'uuid-1');
    expect(id).toBe('srv#uuid-1');
    expect(isClientParticipant(id)).toBe(true);
    expect(isClientParticipant('srv')).toBe(false);
    expect(participantServer(id)).toBe('srv');
    expect(participantServer('srv')).toBe('srv');
  });
});

describe('clock offset', () => {
  it('estimates offset assuming symmetric latency', () => {
    // sent@100, recv@200 (midpoint 150); remote sampled 1150 → offset 1000.
    expect(estimateClockOffset(100, 1150, 200)).toBe(1000);
  });

  it('offset tracker seeds then EMA-smooths', () => {
    const tr = makeOffsetTracker(0.5);
    expect(tr.offset()).toBe(0);
    tr.observe(0, 1000, 0); // sample = 1000 → seed
    expect(tr.offset()).toBe(1000);
    tr.observe(0, 2000, 0); // sample = 2000 → 1000 + 0.5*(2000-1000)=1500
    expect(tr.offset()).toBe(1500);
  });

  it('localizeAnchor subtracts the offset', () => {
    expect(localizeAnchor(5000, 1000)).toBe(4000);
  });
});

describe('addressing', () => {
  it('makeKey / parseKey round-trip with and without subPath', () => {
    expect(makeKey('scene_node', 'abc')).toBe('scene_node:abc');
    expect(makeKey('scene_node', 'abc', 'position.x')).toBe(
      'scene_node:abc:position.x'
    );
    expect(parseKey('scene_node:abc')).toEqual({
      rtype: 'scene_node',
      id: 'abc',
    });
    expect(parseKey('scene_node:abc:position.x')).toEqual({
      rtype: 'scene_node',
      id: 'abc',
      subPath: 'position.x',
    });
    expect(parseKey('bareword')).toEqual({ rtype: 'bareword', id: '' });
  });

  it('keyMatches: wildcards, exact, and boundary safety', () => {
    expect(keyMatches('anything', '')).toBe(true);
    expect(keyMatches('anything', '**')).toBe(true);
    expect(keyMatches('scene_node:ab', 'scene_node:ab')).toBe(true);
    expect(keyMatches('scene_node:ab:position.x', 'scene_node:ab')).toBe(true);
    expect(keyMatches('scene_node:ab.foo', 'scene_node:ab')).toBe(true);
    // boundary: prefix must not bleed across id chars
    expect(keyMatches('scene_node:abc', 'scene_node:ab')).toBe(false);
    expect(keyMatches('scene_node:ab', 'scene_node:*')).toBe(true);
  });
});

describe('grants', () => {
  const noDesc: IsDescendant = () => false;
  const grant = (over: Partial<Grant> = {}): Grant => ({
    grantee: '*',
    entityRtype: 'scene_node',
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true },
    ...over,
  });

  it('pathCovers: empty covers all; exact and prefix-with-dot', () => {
    expect(pathCovers('', 'position.x')).toBe(true);
    expect(pathCovers('position', 'position')).toBe(true);
    expect(pathCovers('position', 'position.x')).toBe(true);
    expect(pathCovers('position', 'positionX')).toBe(false);
  });

  it('grantAllows checks right, rtype, entity, then path', () => {
    const g = grant();
    expect(grantAllows(g, 'scene_node:a:position.x', 'read', noDesc)).toBe(
      true
    );
    // missing right
    expect(grantAllows(g, 'scene_node:a:position.x', 'update', noDesc)).toBe(
      false
    );
    // wrong rtype
    expect(grantAllows(g, 'override:a', 'read', noDesc)).toBe(false);
  });

  it('entity id match + descendants axis', () => {
    const isDesc: IsDescendant = (_rt, child, anc) =>
      child === 'kid' && anc === 'parent';
    const exact = grant({ entityId: 'a' });
    expect(grantAllows(exact, 'scene_node:a', 'read', noDesc)).toBe(true);
    expect(grantAllows(exact, 'scene_node:b', 'read', noDesc)).toBe(false);

    const subtree = grant({ entityId: 'parent', includeDescendants: true });
    expect(grantAllows(subtree, 'scene_node:kid', 'read', isDesc)).toBe(true);
    expect(grantAllows(subtree, 'scene_node:other', 'read', isDesc)).toBe(
      false
    );
  });

  it('create/delete are structural (path-independent)', () => {
    const g = grant({
      pathPrefix: 'position',
      rights: { create: true, delete: true },
    });
    expect(grantAllows(g, 'scene_node:a:anything.else', 'create', noDesc)).toBe(
      true
    );
    expect(grantAllows(g, 'scene_node:a', 'delete', noDesc)).toBe(true);
  });

  it('evaluateAccess unions grants', () => {
    const grants = [
      grant({ rights: { read: true }, pathPrefix: 'position' }),
      grant({ rights: { update: true }, pathPrefix: 'rotation' }),
    ];
    expect(
      evaluateAccess(grants, 'scene_node:a:rotation.x', 'update', noDesc)
    ).toBe(true);
    expect(
      evaluateAccess(grants, 'scene_node:a:scale.x', 'update', noDesc)
    ).toBe(false);
  });

  it('granteeCandidates: self+star for servers, +server for clients', () => {
    expect(granteeCandidates('srv')).toEqual(['srv', '*']);
    expect(granteeCandidates('srv#tab')).toEqual(['srv#tab', 'srv', '*']);
  });
});

describe('subscriptions', () => {
  const noDesc: IsDescendant = () => false;
  const grant = (over: Partial<Grant> = {}): Grant => ({
    grantee: '*',
    entityRtype: 'scene_node',
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true },
    ...over,
  });
  const sub = (over: Partial<Subscription> = {}): Subscription => ({
    entityRtype: 'scene_node',
    entityId: 'a',
    includeDescendants: false,
    pathPrefix: '',
    ...over,
  });

  it('grantCoversSubscription requires read + entity + path containment', () => {
    expect(grantCoversSubscription(grant(), sub(), noDesc)).toBe(true);
    // no read right
    expect(
      grantCoversSubscription(
        grant({ rights: { update: true } }),
        sub(),
        noDesc
      )
    ).toBe(false);
    // sub asks for descendants but grant is exact-only
    expect(
      grantCoversSubscription(
        grant({ entityId: 'a' }),
        sub({ includeDescendants: true }),
        noDesc
      )
    ).toBe(false);
  });

  it('subscriptionMatches treats the sub as a read grant', () => {
    expect(subscriptionMatches(sub(), 'scene_node:a:position.x', noDesc)).toBe(
      true
    );
    expect(subscriptionMatches(sub(), 'scene_node:b', noDesc)).toBe(false);
  });
});

describe('SubscriptionHub', () => {
  const noDesc: IsDescendant = () => false;
  const readAll: Grant = {
    grantee: '*',
    entityRtype: '*',
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true },
  };
  const sub = (id: string): Subscription => ({
    entityRtype: 'scene_node',
    entityId: id,
    includeDescendants: false,
    pathPrefix: '',
  });

  it('admits covered subscriptions, rejects uncovered, routes by interest', () => {
    let grants: Grant[] = [readAll];
    const hub = new SubscriptionHub(() => grants, noDesc);

    expect(hub.subscribe('p1', sub('a'))).toBe(true);
    expect(hub.subscribe('p1', sub('a'))).toBe(true); // idempotent (no dup)
    expect(hub.subscriptionsOf('p1')).toHaveLength(1);

    // No grants → rejected.
    grants = [];
    expect(hub.subscribe('p2', sub('b'))).toBe(false);
    grants = [readAll];

    hub.subscribe('p2', sub('b'));
    expect(hub.route('scene_node:a:position.x')).toEqual(['p1']);
    expect(hub.route('scene_node:b')).toEqual(['p2']);
    expect(hub.route('scene_node:zzz')).toEqual([]);
    expect(hub.participants().sort()).toEqual(['p1', 'p2']);
  });

  it('unsubscribe and removeParticipant prune state', () => {
    const hub = new SubscriptionHub(() => [readAll], noDesc);
    hub.subscribe('p1', sub('a'));
    hub.subscribe('p1', sub('b'));
    hub.unsubscribe('p1', sub('a'));
    expect(hub.subscriptionsOf('p1').map((s) => s.entityId)).toEqual(['b']);
    hub.unsubscribe('p1', sub('b'));
    expect(hub.participants()).toEqual([]);
    hub.unsubscribe('ghost', sub('x')); // no-op
    hub.subscribe('p3', sub('a'));
    hub.removeParticipant('p3');
    expect(hub.participants()).toEqual([]);
  });

  it('revalidate evicts subscriptions whose covering grant was revoked', () => {
    let grants: Grant[] = [readAll];
    const hub = new SubscriptionHub(() => grants, noDesc);
    hub.subscribe('p1', sub('a'));
    expect(hub.revalidate('p1')).toEqual([]); // still covered
    grants = []; // revoke
    const dropped = hub.revalidate('p1');
    expect(dropped).toHaveLength(1);
    expect(hub.participants()).toEqual([]);
    expect(hub.revalidate('nobody')).toEqual([]);
  });
});

describe('randomUUID', () => {
  const V4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('returns a well-formed v4 UUID', () => {
    expect(randomUUID()).toMatch(V4);
  });

  it('is unique across calls', () => {
    const set = new Set(Array.from({ length: 1000 }, () => randomUUID()));
    expect(set.size).toBe(1000);
  });

  it('falls back to getRandomValues when crypto.randomUUID is absent (non-secure context)', () => {
    const real = globalThis.crypto;
    // Simulate a plain-HTTP LAN origin: getRandomValues present, randomUUID not.
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues: real.getRandomValues.bind(real) },
    });
    try {
      expect(randomUUID()).toMatch(V4);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: real,
      });
    }
  });
});
