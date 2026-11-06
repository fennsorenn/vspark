import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene } from '../fixtures/seed';
import type { APIRequestContext } from '@playwright/test';

/**
 * Control-coverage spec: the Macros panel (left-dock "Macros" tab) — a friendly
 * projection over system_hotkey→action logic graphs.
 *
 * Targeted `vs-` handles:
 *   vs-tab-macros, vs-macro-add, vs-macro-action-select, vs-macro-enable,
 *   vs-macro-delete
 *
 * Each mutation is asserted via REST read-back of the project's logic graphs
 * (the panel writes through api.updateLogic), never via UI state.
 */

type LogicRow = { id: string; name: string; descriptor: { nodes: { id: string; kind: string; defaultConfig?: Record<string, unknown> }[]; edges: unknown[] } };

async function projectLogic(request: APIRequestContext, projectId: string): Promise<LogicRow[]> {
  const res = await request.get(`/api/projects/${projectId}/logic`);
  return ((await res.json()).data as LogicRow[]) ?? [];
}

/** The nodes of the auto-created "Macros" logic graph (empty until one exists). */
async function macroNodes(request: APIRequestContext, projectId: string) {
  const graph = (await projectLogic(request, projectId)).find((g) => g.name === 'Macros');
  return graph?.descriptor.nodes ?? [];
}

test('Macros panel: add → pick action → toggle enable → delete (REST-verified)', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Open the Macros tab.
  const macrosTab = page.locator('.vs-tab-macros');
  await expect(macrosTab).toBeVisible();
  await macrosTab.click();

  // Add a macro → a "Macros" logic graph with a system_hotkey node appears.
  await page.locator('.vs-macro-add').click();
  await expect
    .poll(async () => (await macroNodes(request, projectId)).map((n) => n.kind))
    .toContain('system_hotkey');

  // Pick an action → the descriptor gains a set_expression sink node.
  await page.locator('.vs-macro-action-select').first().selectOption('set_expression');
  await expect
    .poll(async () => (await macroNodes(request, projectId)).map((n) => n.kind))
    .toContain('set_expression');

  // Disable the macro → the hotkey node's `enabled` gate flips to false.
  // (Controlled checkbox: click + REST poll, never .check().)
  await page.locator('.vs-macro-enable').first().click();
  await expect
    .poll(async () => {
      const hk = (await macroNodes(request, projectId)).find((n) => n.kind === 'system_hotkey');
      return hk?.defaultConfig?.enabled;
    })
    .toBe(false);

  // Delete the macro → the hotkey node is gone.
  await page.locator('.vs-macro-delete').first().click();
  await expect
    .poll(async () => (await macroNodes(request, projectId)).some((n) => n.kind === 'system_hotkey'))
    .toBe(false);
});
