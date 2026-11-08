import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene } from '../fixtures/seed';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Control-coverage spec: the Actions panel (left-dock "Actions" tab) —
 * project-level workflows configured by a form, each owning a generated Logic
 * graph (dev-notes/modules/actions.md).
 *
 * Targeted `vs-` handles:
 *   vs-tab-actions, vs-action-add, vs-action-add-kind, vs-action-enable,
 *   vs-action-row (select → editor), vs-action-editor-enable, vs-action-name,
 *   vs-logic-action-row, vs-logic-action-enable (Logic list, Action Logic), vs-action-shortcut, vs-action-mode,
 *   vs-action-positions, vs-action-response-type, vs-action-field (-paramPath,
 *   -value), vs-action-reset, vs-action-open-graph, vs-action-delete; badges
 *   vs-action-badge-modified / -template / -missing; vs-dialog-confirm.
 *
 * Every mutation is asserted by REST read-back (the panel writes through the
 * mesh — mesh/actions.ts), never by UI state.
 */

type Json = Record<string, any>;

async function actionsOf(request: APIRequestContext, projectId: string): Promise<Json[]> {
  const res = await request.get(`/api/projects/${projectId}/actions`);
  return ((await res.json()).data as Json[]) ?? [];
}

async function first(request: APIRequestContext, projectId: string): Promise<Json | undefined> {
  return (await actionsOf(request, projectId))[0];
}

async function graphKinds(request: APIRequestContext, graphId: string): Promise<string[]> {
  const res = await request.get(`/api/logic/${graphId}`);
  if (!res.ok()) return [];
  const nodes = (await res.json()).data.descriptor.nodes;
  return (Array.isArray(nodes) ? nodes : Object.values(nodes)).map((n: Json) => n.kind);
}

/** Hand-edit the action's graph over REST: add a node (a "modification"). */
async function editGraph(request: APIRequestContext, graphId: string): Promise<void> {
  const g = (await (await request.get(`/api/logic/${graphId}`)).json()).data;
  g.descriptor.nodes.hand_edit = { id: 'hand_edit', kind: 'log', position: { x: 0, y: 600 } };
  const res = await request.put(`/api/logic/${graphId}`, { data: { descriptor: g.descriptor } });
  expect(res.ok()).toBe(true);
}

async function openActionsTab(page: Page, projectId: string): Promise<void> {
  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await page.locator('.vs-tab-actions').click();
}

test('Actions panel: add, configure, badges, reset, open graph, delete (REST-verified)', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openActionsTab(page, projectId);

  // ── add (pick kind) ────────────────────────────────────────────────────────
  await page.locator('.vs-action-add').click();
  await page.locator('.vs-action-add-kind-hotkey').click();
  await expect.poll(async () => (await first(request, projectId))?.kind).toBe('hotkey');
  const id = (await first(request, projectId))!.id as string;
  await expect.poll(async () => (await first(request, projectId))?.graphId).toBeTruthy();
  const graphId = (await first(request, projectId))!.graphId as string;
  expect(await graphKinds(request, graphId)).toContain('system_hotkey');
  await expect(page.locator('.vs-action-group-hotkey .vs-action-row')).toHaveCount(1);

  // ── enable toggle (controlled: click + poll) ───────────────────────────────
  await page.locator('.vs-action-enable').click();
  await expect.poll(async () => (await first(request, projectId))?.enabled).toBe(false);
  await page.locator('.vs-action-enable').click();
  await expect.poll(async () => (await first(request, projectId))?.enabled).toBe(true);

  // ── editor (a new action opens in the main view; a row click selects) ─────
  await expect(page.locator('.vs-action-editor .vs-action-form')).toBeVisible();
  await page.locator('.vs-action-row').click();
  await expect(page.locator('.vs-action-row')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.vs-action-editor-enable').click();
  await expect.poll(async () => (await first(request, projectId))?.enabled).toBe(false);
  await page.locator('.vs-action-editor-enable').click();
  await expect.poll(async () => (await first(request, projectId))?.enabled).toBe(true);
  await page.locator('.vs-action-name').fill('Show sign');
  await page.locator('.vs-action-name').press('Enter');
  await expect.poll(async () => (await first(request, projectId))?.name).toBe('Show sign');

  // Shortcut (value): recorded from the keyboard; the graph is untouched.
  const before = JSON.stringify((await (await request.get(`/api/logic/${graphId}`)).json()).data.descriptor);
  await page.locator('.vs-action-shortcut').click();
  await page.keyboard.press('Control+F8');
  await expect
    .poll(async () => (await first(request, projectId))?.settings.shortcut)
    .toMatchObject({ key: 'F8', ctrl: true });
  await expect(page.locator('.vs-action-preview').first()).toContainText('Ctrl + F8');
  expect(JSON.stringify((await (await request.get(`/api/logic/${graphId}`)).json()).data.descriptor)).toBe(before);

  // Response type (shape): rebuilds the unmodified graph silently.
  await page.locator('.vs-action-response-type').first().selectOption('set_property');
  await expect.poll(() => graphKinds(request, graphId)).toContain('set_scene_node_param');
  await page.locator('.vs-action-field-paramPath').first().selectOption('visible');
  await expect
    .poll(async () => (await first(request, projectId))?.settings.responses['0'].paramPath)
    .toBe('visible');
  // A Bool property turns the value field into a checkbox (controlled: click + poll).
  await page.locator('.vs-action-field-value').first().click();
  await expect
    .poll(async () => (await first(request, projectId))?.settings.responses['0'].value)
    .toBe(true);

  // Mode + positions (shape).
  await page.locator('.vs-action-mode').selectOption('cycle');
  await expect.poll(() => graphKinds(request, graphId)).toContain('cycle');
  await page.locator('.vs-action-positions').selectOption('4');
  await expect.poll(async () => (await first(request, projectId))?.settings.positions).toBe(4);
  await expect(page.locator('.vs-action-response')).toHaveCount(4);
  expect((await first(request, projectId))?.modified).toBe(false);

  // ── Modified badge after a graph edit; a shape edit then asks first ───────
  await editGraph(request, graphId);
  await expect(page.locator('.vs-action-badge-modified')).toBeVisible();
  expect((await first(request, projectId))?.modified).toBe(true);
  await page.locator('.vs-action-mode').selectOption('toggle');
  await page.locator('.vs-dialog-confirm').click();
  await expect.poll(async () => (await first(request, projectId))?.settings.mode).toBe('toggle');
  await expect.poll(async () => (await first(request, projectId))?.modified).toBe(false);
  expect(await graphKinds(request, graphId)).not.toContain('log');

  // ── Template update: a REST shape change keeps a modified graph ───────────
  await editGraph(request, graphId);
  await expect.poll(async () => (await first(request, projectId))?.modified).toBe(true);
  await request.put(`/api/actions/${id}`, { data: { settings: { mode: 'single' } } });
  await expect(page.locator('.vs-action-badge-template')).toBeVisible();
  expect((await first(request, projectId))?.templateUpdateAvailable).toBe(true);

  // ── Reset (confirmed) clears both ──────────────────────────────────────────
  await page.locator('.vs-action-reset').click();
  await page.locator('.vs-dialog-confirm').click();
  await expect
    .poll(async () => {
      const a = await first(request, projectId);
      return [a?.modified, a?.templateUpdateAvailable];
    })
    .toEqual([false, false]);
  await expect(page.locator('.vs-action-badge-modified')).toHaveCount(0);

  // ── Missing graph → Reset recreates it ─────────────────────────────────────
  await request.delete(`/api/logic/${graphId}`);
  await expect(page.locator('.vs-action-badge-missing')).toBeVisible();
  await page.locator('.vs-action-reset').click();
  await page.locator('.vs-dialog-confirm').click();
  await expect.poll(async () => (await first(request, projectId))?.missingGraph).toBe(false);

  // ── Open graph → the Logic tab shows it ────────────────────────────────────
  await page.locator('.vs-action-open-graph').click();
  await expect(page.getByText('Show sign').first()).toBeVisible();
  // Merely opening the canvas must not count as a modification.
  await page.waitForTimeout(1_000);
  expect((await first(request, projectId))?.modified).toBe(false);
  // The Logic list shows it in its own Action Logic section; the dot switches
  // the action itself (controlled: click + poll).
  await expect(page.locator('.vs-logic-action-row')).toHaveCount(1);
  await expect(page.locator('.vs-logic-action-row')).toContainText('Show sign');
  await page.locator('.vs-logic-action-enable').click();
  await expect.poll(async () => (await first(request, projectId))?.enabled).toBe(false);
  await page.locator('.vs-logic-action-enable').click();
  await expect.poll(async () => (await first(request, projectId))?.enabled).toBe(true);
  await page.locator('.vs-tab-actions').click();

  // ── Delete takes the graph along ───────────────────────────────────────────
  await page.locator('.vs-action-delete').click();
  await expect.poll(async () => (await actionsOf(request, projectId)).length).toBe(0);
  expect((await request.get(`/api/logic/${graphId}`)).status()).toBe(404);
  await expect(page.locator('.vs-action-editor-empty')).toBeVisible();
});
