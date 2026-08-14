import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene } from '../fixtures/seed';
import type { APIRequestContext } from '@playwright/test';

/**
 * Editor-flow E2E (Phase 8): logic graph editing — switching to the Logic tab,
 * creating a project-level logic graph via the UI prompt, verifying the graph
 * appears in the list and is persisted via REST read-back.
 *
 * Test plan:
 *   1. Seed project + scene. Load editor. Switch to the Logic tab.
 *   2. Assert the Logic panel renders (Global Logic section visible).
 *   3. Create a graph via the "+" button → prompt dialog → confirm.
 *   4. Assert the graph name appears in the Logic list.
 *   5. REST read-back: GET /api/projects/:projectId/logic confirms persistence.
 *
 * Node-add via NodePalette is SKIPPED: the palette is drag-only (draggable cards
 * dropped onto a React-Flow canvas); click-to-add is not implemented. Drag
 * interactions on React-Flow in headless Playwright are too flakey to be
 * reliable without injecting synthetic pointer events at exact canvas coordinates.
 */

// ---------------------------------------------------------------------------
// Helper: list project-level logic graphs via REST
// ---------------------------------------------------------------------------
async function listProjectLogic(
  request: APIRequestContext,
  projectId: string
): Promise<{ id: string; name: string; enabled: boolean }[]> {
  const res = await request.get(`/api/projects/${projectId}/logic`);
  const body = (await res.json()) as {
    ok: boolean;
    data: { id: string; name: string; enabled: boolean }[];
  };
  return body.data;
}

// ---------------------------------------------------------------------------
// Test 1: Switch to Logic tab → panel renders
// ---------------------------------------------------------------------------
test('logic tab: switching shows the Logic panel with Global Logic section', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  // Wait for the editor to load: the seeded "Scene" row appears in the Stage tree.
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // The left-panel tab labelled "Logic" switches to the Graphs/Logic panel.
  await page.getByRole('button', { name: 'Logic', exact: true }).click();

  // The Logic panel renders a "Global Logic" section header.
  await expect(
    page.getByText('Global Logic', { exact: true })
  ).toBeVisible({ timeout: 5_000 });

  // With no graphs yet, the empty-state text is shown.
  await expect(
    page.getByText('No project graphs yet.', { exact: true })
  ).toBeVisible({ timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// Test 2: Create a logic graph via UI → appears in list + persisted via REST
// ---------------------------------------------------------------------------
test('logic graph creation: "+" button creates graph and persists via REST', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Switch to the Logic tab.
  await page.getByRole('button', { name: 'Logic', exact: true }).click();
  await expect(page.getByText('Global Logic', { exact: true })).toBeVisible({
    timeout: 5_000,
  });

  // Click the "+" button (title: "New logic") in the Global Logic section header.
  await page.getByTitle('New logic').click();

  // A prompt dialog appears with a text input pre-filled with "Untitled Logic".
  // Fill in a unique name and confirm.
  const graphName = `E2E Logic ${Date.now()}`;
  // The DialogHost renders inside a fixed overlay; scope to it for safety.
  const dialog = page.locator('[style*="position: fixed"][style*="inset: 0"]');
  await dialog.getByRole('textbox').fill(graphName);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();

  // The new graph name appears in the Logic list.
  await expect(
    page.getByText(graphName, { exact: true })
  ).toBeVisible({ timeout: 10_000 });

  // REST read-back: the graph was persisted to the backend.
  await expect
    .poll(
      async () => {
        const graphs = await listProjectLogic(request, projectId);
        return graphs.some((g) => g.name === graphName);
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});

// ---------------------------------------------------------------------------
// Test 3: API-seeded graph → visible in the Logic tab list
// ---------------------------------------------------------------------------
test('logic tab: API-seeded graph is visible in the Logic list', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  // Seed a logic graph directly via the REST API.
  const graphName = `Seeded Logic ${Date.now()}`;
  const createRes = await request.post(`/api/projects/${projectId}/logic`, {
    data: { name: graphName },
  });
  expect(createRes.status()).toBe(201);

  // Load the editor.
  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Switch to the Logic tab.
  await page.getByRole('button', { name: 'Logic', exact: true }).click();
  await expect(page.getByText('Global Logic', { exact: true })).toBeVisible({
    timeout: 5_000,
  });

  // The seeded graph must appear in the list.
  await expect(
    page.getByText(graphName, { exact: true })
  ).toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Test 4: dragging a node commits ONE element of the descriptor
//
// This is the whole point of keying the descriptor's nodes by id: a move
// writes `descriptor.nodes.<id>`, not the program. The read-back checks both
// halves — that the position landed, and that the node it did NOT touch is
// still there (a whole-descriptor write that dropped a node would look
// identical from the moved node alone).
// ---------------------------------------------------------------------------
test('logic canvas: dragging a node persists just that node', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  const created = await request.post(`/api/projects/${projectId}/logic`, {
    data: { name: `Drag ${Date.now()}` },
  });
  const graphId = ((await created.json()) as { data: { id: string } }).data.id;

  // Seed a two-node program over REST, in the runtime (list) shape an outside
  // service would send.
  await request.put(`/api/logic/${graphId}`, {
    data: {
      descriptor: {
        id: graphId,
        label: 'Drag',
        readonly: false,
        nodes: [
          { id: 'a', kind: 'clock', position: { x: 80, y: 80 } },
          { id: 'b', kind: 'clock', position: { x: 80, y: 260 } },
        ],
        edges: [],
      },
    },
  });

  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Logic', exact: true }).click();
  await page.getByText('Drag', { exact: false }).first().click();

  const node = page.locator('.react-flow__node[data-id="a"]');
  await expect(node).toBeVisible({ timeout: 15_000 });

  const box = await node.boundingBox();
  if (!box) throw new Error('node has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 10, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/logic/${graphId}`);
        const body = (await res.json()) as {
          data: {
            descriptor: {
              nodes: Record<string, { position: { x: number } } | null>;
            };
          };
        };
        const nodes = body.data.descriptor.nodes;
        // Keyed by id in the document, so this is a direct lookup.
        return nodes.a && nodes.b ? nodes.a.position.x : -1;
      },
      { timeout: 10_000 }
    )
    .toBeGreaterThan(80);
});
