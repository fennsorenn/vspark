import {
  test,
  expect,
  request as pw,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';
import { SERVERS } from '../playwright.multiplayer.config';

/**
 * Two servers, A and B, paired through a local rendezvous; A shares a scene for
 * collaboration and B mounts it. Every assertion reads back through REST on the
 * OTHER server, so a pass means the change crossed the server↔server mesh link
 * (WebRTC) and was persisted there.
 *
 * Receiver→author (B edits, A must follow) is the direction documented as
 * intermittently failing in dev-notes/modules/multiplayer.md; this suite is
 * the repro harness for it.
 */

type Name = 'a' | 'b';

async function data<T = Record<string, unknown>>(res: APIResponse): Promise<T> {
  const body = (await res.json()) as { ok: boolean; data: T; error?: unknown };
  if (!body.ok) throw new Error(`${res.url()} → ${JSON.stringify(body.error)}`);
  return body.data;
}

const api = (name: Name): Promise<APIRequestContext> =>
  pw.newContext({ baseURL: `http://localhost:${SERVERS[name].backend}` });

async function identity(c: APIRequestContext): Promise<string> {
  return (
    await data<{ peerId: string }>(await c.get('/api/connections/identity'))
  ).peerId;
}

async function nodeIn(
  c: APIRequestContext,
  sceneId: string,
  nodeId: string
): Promise<Record<string, unknown> | undefined> {
  const res = await c.get(`/api/scenes/${sceneId}/nodes`);
  if (!res.ok()) return undefined;
  const rows = (await res.json()) as { data?: Record<string, unknown>[] };
  return rows.data?.find((n) => n.id === nodeId);
}

/** Pair A and B and bring their WebRTC link up. */
async function pairAndConnect(
  A: APIRequestContext,
  B: APIRequestContext
): Promise<{ idA: string; idB: string }> {
  // Both must be registered at the rendezvous first.
  for (const c of [A, B])
    await expect
      .poll(
        async () =>
          (
            await data<{ status: string }>(
              await c.get('/api/connections/status')
            )
          ).status,
        {
          timeout: 30_000,
        }
      )
      .toBe('ready');
  const idA = await identity(A);
  const idB = await identity(B);
  const { code } = await data<{ code: string }>(
    await A.post('/api/connections/pair/create')
  );
  await data(await B.post('/api/connections/pair/join', { data: { code } }));
  // A learns about B from the rendezvous once the pairing completes.
  await expect
    .poll(
      async () =>
        (
          await data<{ peerId: string }[]>(
            await A.get('/api/connections/peers')
          )
        ).some((p) => p.peerId === idB),
      { timeout: 30_000 }
    )
    .toBe(true);
  // B dials; A accepts the prompted inbound connection.
  await data(await B.post(`/api/connections/peers/${idA}/connect`));
  await expect
    .poll(
      async () => {
        await A.post(`/api/connections/peers/${idB}/accept`);
        const peers = await data<{ peerId: string; connected: boolean }[]>(
          await A.get('/api/connections/peers')
        );
        return peers.find((p) => p.peerId === idB)?.connected ?? false;
      },
      { timeout: 45_000, intervals: [1000] }
    )
    .toBe(true);
  return { idA, idB };
}

let A: APIRequestContext;
let B: APIRequestContext;
let idA = '';
let idB = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  A = await api('a');
  B = await api('b');
  ({ idA, idB } = await pairAndConnect(A, B));
});

test.afterAll(async () => {
  await A.dispose();
  await B.dispose();
});

/** A scene with one node on A, shared with B and mounted into a B project. */
async function sharedScene(
  nodeName: string
): Promise<{ projA: string; projB: string; sceneId: string; nodeId: string }> {
  const projA = await data<{ id: string }>(
    await A.post('/api/projects', { data: { name: 'Studio A' } })
  );
  const scene = await data<{ id: string }>(
    await A.post(`/api/projects/${projA.id}/scenes`, {
      data: { name: 'Shared stage' },
    })
  );
  const node = await data<{ id: string }>(
    await A.post(`/api/scenes/${scene.id}/nodes`, {
      data: { name: nodeName, kind: 'group' },
    })
  );
  await data(
    await A.post(`/api/connections/scenes/${scene.id}/share-collab`, {
      data: { granteePeerId: idB },
    })
  );
  const projB = await data<{ id: string }>(
    await B.post('/api/projects', { data: { name: 'Studio B' } })
  );
  await data(
    await B.post('/api/connections/collab/mount', {
      data: { ownerPeerId: idA, sceneId: scene.id, projectId: projB.id },
    })
  );
  await expect
    .poll(async () => (await nodeIn(B, scene.id, node.id))?.name, {
      timeout: 30_000,
    })
    .toBe(nodeName);
  return {
    projA: projA.id,
    projB: projB.id,
    sceneId: scene.id,
    nodeId: node.id,
  };
}

test('a collab scene syncs both ways across two servers', async () => {
  const { sceneId, nodeId } = await sharedScene('Prop');
  const scene = { id: sceneId };
  const node = { id: nodeId };

  // Author → receiver.
  await data(
    await A.put(`/api/scene-nodes/${node.id}`, {
      data: { name: 'Renamed on A' },
    })
  );
  await expect
    .poll(async () => (await nodeIn(B, scene.id, node.id))?.name, {
      timeout: 20_000,
    })
    .toBe('Renamed on A');

  // Receiver → author (the direction multiplayer.md reports as flaky).
  await data(
    await B.put(`/api/scene-nodes/${node.id}`, {
      data: { name: 'Renamed on B' },
    })
  );
  await expect
    .poll(async () => (await nodeIn(A, scene.id, node.id))?.name, {
      timeout: 20_000,
    })
    .toBe('Renamed on B');

  // A node created on B appears on A; deleting it on A removes it on B.
  const made = await data<{ id: string }>(
    await B.post(`/api/scenes/${scene.id}/nodes`, {
      data: { name: 'Made on B', kind: 'group' },
    })
  );
  await expect
    .poll(async () => (await nodeIn(A, scene.id, made.id))?.name, {
      timeout: 20_000,
    })
    .toBe('Made on B');
  await A.delete(`/api/scene-nodes/${made.id}`);
  await expect
    .poll(async () => await nodeIn(B, scene.id, made.id), { timeout: 20_000 })
    .toBeUndefined();
});

test("a rename in B's editor shows up in A's editor", async ({ browser }) => {
  const { projA, projB, nodeId } = await sharedScene('Lamp');
  const ctxA = await browser.newContext({
    baseURL: `http://localhost:${SERVERS.a.frontend}`,
  });
  const ctxB = await browser.newContext({
    baseURL: `http://localhost:${SERVERS.b.frontend}`,
  });
  const tabA = await ctxA.newPage();
  const tabB = await ctxB.newPage();
  await tabA.goto(`/editor/${projA}`);
  await tabB.goto(`/editor/${projB}`);
  await expect(tabA.getByText('Lamp', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(tabB.getByText('Lamp', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  await tabB.getByText('Lamp', { exact: true }).click();
  const name = tabB.locator('.vs-node-name');
  await expect(name).toHaveValue('Lamp');
  await name.fill('Lantern');
  await name.blur();

  // Tab B → server B → server A → tab A.
  await expect(tabA.getByText('Lantern', { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  expect(nodeId).toBeTruthy();
  await ctxA.close();
  await ctxB.close();
});

test("a drag in A's editor previews live in B's editor before it commits", async ({
  browser,
}) => {
  const { projA, projB, sceneId, nodeId } = await sharedScene('Crate');
  const ctxA = await browser.newContext({
    baseURL: `http://localhost:${SERVERS.a.frontend}`,
  });
  const ctxB = await browser.newContext({
    baseURL: `http://localhost:${SERVERS.b.frontend}`,
  });
  const tabA = await ctxA.newPage();
  const tabB = await ctxB.newPage();
  for (const [tab, proj] of [
    [tabA, projA],
    [tabB, projB],
  ] as const) {
    await tab.goto(`/editor/${proj}`);
    await tab.getByText('Crate', { exact: true }).click({ timeout: 30_000 });
    await expect(tab.locator('.vs-node-name')).toHaveValue('Crate');
  }
  const x = (tab: typeof tabA) =>
    tab.locator('.vs-transform-position input').nth(0);

  // In flight: `fill` previews (onChange) without committing (no blur).
  await x(tabA).fill('4.25');
  await expect
    .poll(async () => Number(await x(tabB).inputValue()), { timeout: 20_000 })
    .toBeCloseTo(4.25, 2);
  // Nothing persisted on either server yet.
  for (const c of [A, B]) {
    const row = await nodeIn(c, sceneId, nodeId);
    expect(row).toBeDefined();
    const comps =
      typeof row!.components === 'string'
        ? (JSON.parse(row!.components) as { transform?: { x?: number } })
        : (row!.components as { transform?: { x?: number } } | undefined);
    expect(comps?.transform?.x ?? 0).toBe(0);
  }

  await ctxA.close();
  await ctxB.close();
});
