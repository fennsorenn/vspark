import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene, seedNode } from '../fixtures/seed';

/**
 * Two tabs of one editor, sharing state through the mesh only.
 *
 * What these pin, each a property a single tab cannot show:
 *
 *  - deleting a node takes everything that hangs off it (its behaviors) as
 *    ONE undoable action, and the other tab follows both the delete and the
 *    undo. Before removeTree, the behavior's row was cascade-deleted by the
 *    database while its document lived on, so undo brought the node back
 *    without its behavior;
 *  - the scene tree's hide toggle is a mesh write: the other tab and the
 *    database both follow it, and it undoes;
 *  - a compose text field commits once on blur and reaches the other tab.
 *
 * Both tabs sit in one browser context (same enrolled browser, two windows).
 * Assertions read back through REST, so a pass means the value reached SQLite.
 */

async function open(
  page: Page,
  projectId: string,
  name: string
): Promise<void> {
  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText(name, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

async function behaviorsOf(
  request: APIRequestContext,
  nodeId: string
): Promise<{ id: string; kind: string }[]> {
  const res = await request.get(`/api/scene-nodes/${nodeId}/behaviors`);
  if (!res.ok()) return [];
  return ((await res.json()) as { data: { id: string; kind: string }[] }).data;
}

async function nodeRow(
  request: APIRequestContext,
  sceneId: string,
  nodeId: string
): Promise<Record<string, unknown> | undefined> {
  const res = await request.get(`/api/scenes/${sceneId}/nodes`);
  const json = (await res.json()) as { data: Record<string, unknown>[] };
  return json.data.find((n) => n.id === nodeId);
}

const nodeRowIn = (page: Page, name: string) =>
  page.locator('.vs-node-row', { hasText: name });

test('deleting a node takes its behaviors, both tabs follow, one undo restores all', async ({
  browser,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'DoomedAvatar', 'group');
  const beh = await request.post(`/api/scene-nodes/${nodeId}/behaviors`, {
    data: { kind: 'breathing' },
  });
  expect(beh.ok()).toBe(true);
  const behaviorId = ((await beh.json()) as { data: { id: string } }).data.id;

  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await open(tabA, projectId, 'DoomedAvatar');
  await open(tabB, projectId, 'DoomedAvatar');

  // Delete in A (confirm the dialog).
  await nodeRowIn(tabA, 'DoomedAvatar').hover();
  await nodeRowIn(tabA, 'DoomedAvatar').locator('.vs-node-delete').click();
  await tabA.getByRole('button', { name: 'Delete', exact: true }).click();

  // Gone in both tabs and in the database — the behavior too.
  await expect(nodeRowIn(tabA, 'DoomedAvatar')).toHaveCount(0);
  await expect(nodeRowIn(tabB, 'DoomedAvatar')).toHaveCount(0);
  await expect
    .poll(async () => await nodeRow(request, sceneId, nodeId), {
      timeout: 15_000,
    })
    .toBeUndefined();
  await expect
    .poll(async () => (await behaviorsOf(request, nodeId)).length, {
      timeout: 15_000,
    })
    .toBe(0);

  // One undo in A brings back the node AND its behavior, everywhere.
  await tabA.locator('.vs-topbar-undo').click();
  await expect(nodeRowIn(tabA, 'DoomedAvatar')).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(nodeRowIn(tabB, 'DoomedAvatar')).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect
    .poll(async () => (await behaviorsOf(request, nodeId)).map((b) => b.id), {
      timeout: 15_000,
    })
    .toEqual([behaviorId]);

  await context.close();
});

test('the hide toggle syncs to the other tab and undoes', async ({
  browser,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'Hideable', 'group');

  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await open(tabA, projectId, 'Hideable');
  await open(tabB, projectId, 'Hideable');

  const eyeA = nodeRowIn(tabA, 'Hideable').locator('.vs-node-visibility');
  const eyeB = nodeRowIn(tabB, 'Hideable').locator('.vs-node-visibility');
  await expect(eyeB).toHaveAttribute('title', /hide/i);

  await eyeA.click();
  await expect
    .poll(async () => (await nodeRow(request, sceneId, nodeId))?.hidden, {
      timeout: 15_000,
    })
    .toBeTruthy();
  await expect(eyeB).toHaveAttribute('title', /show/i, { timeout: 15_000 });

  await tabA.locator('.vs-topbar-undo').click();
  await expect
    .poll(async () => (await nodeRow(request, sceneId, nodeId))?.hidden, {
      timeout: 15_000,
    })
    .toBeFalsy();
  await expect(eyeB).toHaveAttribute('title', /hide/i, { timeout: 15_000 });

  await context.close();
});

test('a node rename in one tab reaches the other through the mesh', async ({
  browser,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'BeforeName', 'group');

  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await open(tabA, projectId, 'BeforeName');
  await open(tabB, projectId, 'BeforeName');

  await tabA.getByText('BeforeName', { exact: true }).click();
  const name = tabA.locator('.vs-node-name');
  await name.fill('AfterName');
  await name.blur();

  await expect(tabB.getByText('AfterName', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(async () => (await nodeRow(request, sceneId, nodeId))?.name, {
      timeout: 15_000,
    })
    .toBe('AfterName');

  await context.close();
});

test('a scene created in one tab appears in the other; deleting it undoes as one step', async ({
  browser,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  for (const tab of [tabA, tabB]) {
    await tab.goto(`/editor/${projectId}`);
    await expect(tab.locator('.vs-add-scene')).toBeVisible({ timeout: 30_000 });
  }

  const sceneName = `Shared stage ${Date.now()}`;
  await tabA.locator('.vs-add-scene').click();
  const dialog = tabA.locator('[style*="position: fixed"][style*="inset: 0"]');
  await dialog.getByRole('textbox').fill(sceneName);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();

  const rowIn = (tab: Page) =>
    tab.locator('.vs-scene-row', { hasText: sceneName });
  await expect(rowIn(tabA)).toHaveCount(1, { timeout: 15_000 });
  await expect(rowIn(tabB)).toHaveCount(1, { timeout: 15_000 });
  const persisted = async () => {
    const res = await request.get(`/api/projects/${projectId}/scenes`);
    const body = (await res.json()) as { data: { scenes: { name: string }[] } };
    return body.data.scenes.some((s) => s.name === sceneName);
  };
  await expect.poll(persisted, { timeout: 15_000 }).toBe(true);

  await rowIn(tabA).hover();
  await rowIn(tabA).locator('.vs-scene-delete').click();
  await tabA.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(rowIn(tabB)).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(persisted, { timeout: 15_000 }).toBe(false);

  await tabA.locator('.vs-topbar-undo').click();
  await expect(rowIn(tabB)).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(persisted, { timeout: 15_000 }).toBe(true);

  await context.close();
});
