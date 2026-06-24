/**
 * MeshRouter — transport-agnostic pub/sub routing.
 *
 * MeshRouter wraps a SubscriptionHub (from @vspark/shared/sync) with a
 * grant-aware admission layer and per-participant transport links.
 *
 * All dependencies are injected:
 *  - `grantsFor` is a pure in-memory function
 *  - `isDescendant` is a no-op (flat namespace is enough for these tests)
 *  - Transport links are simple spy functions
 *
 * No DB, no file I/O, no sockets.
 */

import { describe, it, expect, vi } from 'vitest';
import { MeshRouter } from '../src/sync/meshRouter.js';
import type { Grant, Subscription, SyncEnvelope } from '@vspark/shared/sync';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const noDescendant = () => false;

function makeRouter(grants: Grant[] = []) {
  const router = new MeshRouter(() => grants, noDescendant);
  return router;
}

function makeEnvelope(key: string, overrides?: Partial<SyncEnvelope>): SyncEnvelope {
  return {
    rtype: 'scene_node',
    op: 'upsert',
    key,
    ...overrides,
  };
}

function sub(entityId: string, entityRtype = 'scene_node'): Subscription {
  return {
    entityRtype,
    entityId,
    includeDescendants: false,
    pathPrefix: '',
  };
}

function readGrant(grantee: string, entityId: string): Grant {
  return {
    grantee,
    entityRtype: 'scene_node',
    entityId,
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true, update: false, create: false, delete: false },
  };
}

// ---------------------------------------------------------------------------
// attach / detach.
// ---------------------------------------------------------------------------

describe('MeshRouter attach / detach', () => {
  it('a detached participant receives no envelopes', () => {
    const grants = [readGrant('alice', 'node-1')];
    const router = makeRouter(grants);
    const received: SyncEnvelope[] = [];
    router.attach('alice', (env) => received.push(env));
    router.subscribe('alice', sub('node-1'));
    router.detach('alice');

    router.publish(makeEnvelope('scene_node:node-1'));
    expect(received).toHaveLength(0);
  });

  it('detach removes all subscriptions', () => {
    const grants = [readGrant('alice', 'node-1')];
    const router = makeRouter(grants);
    router.attach('alice', () => {});
    router.subscribe('alice', sub('node-1'));
    router.detach('alice');
    expect(router.subscriptionsOf('alice')).toHaveLength(0);
    expect(router.participants()).not.toContain('alice');
  });
});

// ---------------------------------------------------------------------------
// subscribe — admission.
// ---------------------------------------------------------------------------

describe('MeshRouter subscribe — admission', () => {
  it('admitted when a read grant covers the subscription', () => {
    const grants = [readGrant('alice', 'node-1')];
    const router = makeRouter(grants);
    router.attach('alice', () => {});
    expect(router.subscribe('alice', sub('node-1'))).toBe(true);
    expect(router.subscriptionsOf('alice')).toHaveLength(1);
  });

  it('denied when no grant exists for the entity', () => {
    const router = makeRouter([]); // no grants
    router.attach('alice', () => {});
    expect(router.subscribe('alice', sub('node-X'))).toBe(false);
    expect(router.subscriptionsOf('alice')).toHaveLength(0);
  });

  it('wildcard grantee ("*") admits any participant', () => {
    const wildcardGrant: Grant = {
      grantee: '*',
      entityRtype: 'scene_node',
      entityId: 'public-node',
      includeDescendants: false,
      pathPrefix: '',
      rights: { read: true, update: false, create: false, delete: false },
    };
    const router = makeRouter([wildcardGrant]);
    router.attach('anybody', () => {});
    expect(router.subscribe('anybody', sub('public-node'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// publish — fan-out to matching subscribers.
// ---------------------------------------------------------------------------

describe('MeshRouter publish — fan-out', () => {
  it('delivers to exactly the participants whose subscription matches', () => {
    const grants = [
      readGrant('alice', 'node-A'),
      readGrant('bob', 'node-B'),
    ];
    const router = makeRouter(grants);

    const aliceRcv: SyncEnvelope[] = [];
    const bobRcv: SyncEnvelope[] = [];
    router.attach('alice', (e) => aliceRcv.push(e));
    router.attach('bob', (e) => bobRcv.push(e));
    router.subscribe('alice', sub('node-A'));
    router.subscribe('bob', sub('node-B'));

    router.publish(makeEnvelope('scene_node:node-A'));
    expect(aliceRcv).toHaveLength(1);
    expect(bobRcv).toHaveLength(0);

    router.publish(makeEnvelope('scene_node:node-B'));
    expect(aliceRcv).toHaveLength(1);
    expect(bobRcv).toHaveLength(1);
  });

  it('does not deliver to a participant without an attached link', () => {
    const grants = [readGrant('ghost', 'node-1')];
    const router = makeRouter(grants);
    // subscribe without attach (no link registered).
    router.subscribe('ghost', sub('node-1'));
    // Should not throw.
    router.publish(makeEnvelope('scene_node:node-1'));
  });
});

// ---------------------------------------------------------------------------
// publishStream — lossy link fan-out.
// ---------------------------------------------------------------------------

describe('MeshRouter publishStream', () => {
  it('delivers stream frames to participants with a stream link', () => {
    const grants = [readGrant('alice', 'node-S')];
    const router = makeRouter(grants);

    const frames: Record<string, unknown>[] = [];
    router.attach('alice', () => {}, (f) => frames.push(f));
    router.subscribe('alice', sub('node-S'));

    router.publishStream('scene_node:node-S', { kind: 'vmc_pose', data: {} });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: 'vmc_pose' });
  });

  it('silently skips participants with no stream link', () => {
    const grants = [readGrant('alice', 'node-S')];
    const router = makeRouter(grants);
    router.attach('alice', () => {}); // no stream link
    router.subscribe('alice', sub('node-S'));
    // Should not throw.
    router.publishStream('scene_node:node-S', { kind: 'vmc_pose', data: {} });
  });
});

// ---------------------------------------------------------------------------
// unsubscribe.
// ---------------------------------------------------------------------------

describe('MeshRouter unsubscribe', () => {
  it('removes the subscription so subsequent publishes skip that participant', () => {
    const grants = [readGrant('alice', 'node-U')];
    const router = makeRouter(grants);

    const received: SyncEnvelope[] = [];
    router.attach('alice', (e) => received.push(e));
    router.subscribe('alice', sub('node-U'));
    router.unsubscribe('alice', sub('node-U'));

    router.publish(makeEnvelope('scene_node:node-U'));
    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// revalidate — evict subscriptions whose grant was revoked.
// ---------------------------------------------------------------------------

describe('MeshRouter revalidate', () => {
  it('returns dropped subscriptions when grants become empty', () => {
    // Start with a grant; subscribe; then simulate revocation by using a router
    // whose grantsFor now returns [].
    const grants: Grant[] = [readGrant('alice', 'node-R')];
    const router = new MeshRouter(() => grants, noDescendant);
    router.attach('alice', () => {});
    router.subscribe('alice', sub('node-R'));

    // Simulate grant revocation by clearing the array in place.
    grants.length = 0;

    const dropped = router.revalidate('alice');
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped[0].entityId).toBe('node-R');
    expect(router.subscriptionsOf('alice')).toHaveLength(0);
  });

  it('keeps subscriptions whose grant is still active', () => {
    const grants: Grant[] = [readGrant('alice', 'node-K')];
    const router = new MeshRouter(() => grants, noDescendant);
    router.attach('alice', () => {});
    router.subscribe('alice', sub('node-K'));

    const dropped = router.revalidate('alice');
    expect(dropped).toHaveLength(0);
    expect(router.subscriptionsOf('alice')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// participants().
// ---------------------------------------------------------------------------

describe('MeshRouter participants', () => {
  it('lists only participants with admitted subscriptions', () => {
    const grants = [readGrant('alice', 'node-P')];
    const router = makeRouter(grants);
    router.attach('alice', () => {});
    router.attach('bob', () => {});
    router.subscribe('alice', sub('node-P'));
    // bob has no subscription.
    expect(router.participants()).toContain('alice');
    expect(router.participants()).not.toContain('bob');
  });
});
