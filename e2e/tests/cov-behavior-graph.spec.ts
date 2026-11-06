import { test, expect } from '../fixtures/controlCoverage';
import type { APIRequestContext, Page } from '@playwright/test';
import { seedProjectScene, seedNode } from '../fixtures/seed';

/**
 * Control-coverage spec: the Graph row of a behavior's section in the
 * Properties panel (BehaviorGraphBar) — a behavior's stored, editable graph
 * (dev-notes/modules/component-managers.md → "Stored, editable graphs").
 *
 * The behavior is seeded via REST, its graph hand-edited via REST
 * (PUT /api/logic/:id, i.e. through the mesh like the canvas), and every state
 * is asserted by REST read-back of GET /api/behaviors/:id/graph.
 *
 * Controls targeted:
 *   vs-behavior-open-graph   — opens the behavior's graph on the canvas
 *   vs-behavior-reset-graph  — rebuilds the graph from its template (confirmed)
 *   vs-dialog-confirm        — the confirmation
 * Markers asserted: vs-behavior-graph, vs-behavior-badge-modified.
 */

type Json = Record<string, any>;

async function graphStatus(
  request: APIRequestContext,
  behaviorId: string
): Promise<Json> {
  const res = await request.get(`/api/behaviors/${behaviorId}/graph`);
  return (await res.json()).data as Json;
}

/** Hand-edit the behavior's graph over REST: add a node (a modification). */
async function editGraph(
  request: APIRequestContext,
  graphId: string
): Promise<void> {
  const g = (await (await request.get(`/api/logic/${graphId}`)).json()).data;
  g.descriptor.nodes.hand_edit = {
    id: 'hand_edit',
    kind: 'behavior_id',
    position: { x: 0, y: 600 },
  };
  const res = await request.put(`/api/logic/${graphId}`, {
    data: { descriptor: g.descriptor },
  });
  expect(res.ok()).toBe(true);
}

/** Seed a project + avatar + Breathing behavior and open its section. */
async function openBehavior(page: Page, request: APIRequestContext) {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'GraphAvatar', 'avatar');
  const created = await request.post(`/api/scene-nodes/${nodeId}/behaviors`, {
    data: { kind: 'breathing' },
  });
  expect(created.ok()).toBe(true);
  const behaviorId = (await created.json()).data.id as string;

  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('GraphAvatar', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.locator('button[title="Show components"]').first().click();
  const row = page.getByText('Breathing', { exact: true }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(page.locator('.vs-behavior-graph')).toBeVisible({
    timeout: 10_000,
  });
  return { behaviorId };
}

test('behavior graph: Modified badge after an edit, Reset clears it (REST-verified)', async ({
  page,
  request,
}) => {
  const { behaviorId } = await openBehavior(page, request);

  // A new behavior's graph is stored and unmodified.
  const fresh = await graphStatus(request, behaviorId);
  expect(fresh).toMatchObject({ missingGraph: false, modified: false });
  await expect(page.locator('.vs-behavior-badge-modified')).toHaveCount(0);
  await expect(page.locator('.vs-behavior-reset-graph')).toBeDisabled();

  await editGraph(request, fresh.graphId);
  await expect
    .poll(async () => (await graphStatus(request, behaviorId)).modified)
    .toBe(true);
  await expect(page.locator('.vs-behavior-badge-modified')).toBeVisible({
    timeout: 10_000,
  });

  await page.locator('.vs-behavior-reset-graph').click();
  await page.locator('.vs-dialog-confirm').click();
  await expect
    .poll(async () => (await graphStatus(request, behaviorId)).modified)
    .toBe(false);
  await expect(page.locator('.vs-behavior-badge-modified')).toHaveCount(0);
  const g = (await (await request.get(`/api/logic/${fresh.graphId}`)).json())
    .data;
  expect(Object.keys(g.descriptor.nodes)).not.toContain('hand_edit');
});

test('behavior graph: Open graph shows it on the canvas, editable', async ({
  page,
  request,
}) => {
  const { behaviorId } = await openBehavior(page, request);
  const { graphId } = await graphStatus(request, behaviorId);
  expect(graphId).toBe(`breathing:${behaviorId}`);

  await page.locator('.vs-behavior-open-graph').click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible({
    timeout: 10_000,
  });
  // Stored behavior graphs are documents, so the canvas is writable.
  await expect(page.getByText('read-only graph')).toHaveCount(0);
});
