import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene, seedNode, listNodes } from '../fixtures/seed';

/**
 * Editor-flow E2E (Phase 8): transform-edit round-trip.
 *
 * Seeds a group node, loads the editor, selects the node in the scene graph,
 * edits the X-position axis input in the Properties panel (.vs-transform-position),
 * commits the value on blur, then reads back the persisted transform via REST
 * (GET /api/scenes/:sceneId/nodes → components.transform.x).
 *
 * The VecInput wraps three NumInput boxes for X/Y/Z. We address the X-axis
 * input via `.vs-transform-position input` scoped to the first element (.nth(0)).
 * Commit fires on blur (NumInput.onBlur → commit → onCommit → saveTransform).
 */

/** Read all nodes for a scene and return the raw DB row for a given node id. */
async function getNodeRow(
  request: APIRequestContext,
  sceneId: string,
  nodeId: string
): Promise<Record<string, unknown> | undefined> {
  const res = await request.get(`/api/scenes/${sceneId}/nodes`);
  const json = (await res.json()) as { ok: boolean; data: Record<string, unknown>[] };
  return json.data.find((n) => n.id === nodeId);
}

test('transform: edit X position and assert persisted via REST read-back', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'TransformTestNode', 'group');

  await page.goto(`/editor/${projectId}`);

  // Wait for the editor to load and the node to appear in the scene graph.
  const row = page.getByText('TransformTestNode', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });

  // Click the node to select it — opens the Properties panel.
  await row.click();

  // Wait for the name input to confirm the Properties panel opened for this node.
  const nameInput = page.locator('.vs-node-name');
  await expect(nameInput).toHaveValue('TransformTestNode');

  // The position VecInput (.vs-transform-position) contains three <input> elements
  // for X, Y, Z. Index 0 is X.
  const positionInputs = page.locator('.vs-transform-position input');
  const xInput = positionInputs.nth(0);
  await expect(xInput).toBeVisible();

  // Fill the X axis to a known value then blur to commit (NumInput.onBlur → commit
  // → onCommit fires → saveTransform → api.updateNode).
  await xInput.fill('3.14');
  await xInput.blur();

  // REST read-back: the transform write landed in SQLite via the mesh collection.
  // The DB row has `components` as a JSON string; we parse it and check x.
  await expect
    .poll(
      async () => {
        const row = await getNodeRow(request, sceneId, nodeId);
        if (!row) return undefined;
        const comps =
          typeof row.components === 'string'
            ? (JSON.parse(row.components) as Record<string, unknown>)
            : (row.components as Record<string, unknown>);
        const xform = comps?.transform as Record<string, unknown> | undefined;
        return xform?.x;
      },
      { timeout: 10_000 }
    )
    .toBe(3.14);
});

test('transform: edit Y rotation (degrees) and assert persisted as radians via REST', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'RotationTestNode', 'group');

  await page.goto(`/editor/${projectId}`);

  const row = page.getByText('RotationTestNode', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  const nameInput = page.locator('.vs-node-name');
  await expect(nameInput).toHaveValue('RotationTestNode');

  // Rotation VecInput: index 1 is Y (ry). UI edits in degrees; stored as radians.
  const rotationInputs = page.locator('.vs-transform-rotation input');
  const ryInput = rotationInputs.nth(1);
  await expect(ryInput).toBeVisible();

  // 90 degrees = Math.PI / 2 ≈ 1.5707963...
  await ryInput.fill('90');
  await ryInput.blur();

  await expect
    .poll(
      async () => {
        const row = await getNodeRow(request, sceneId, nodeId);
        if (!row) return undefined;
        const comps =
          typeof row.components === 'string'
            ? (JSON.parse(row.components) as Record<string, unknown>)
            : (row.components as Record<string, unknown>);
        const xform = comps?.transform as Record<string, unknown> | undefined;
        const ry = xform?.ry as number | undefined;
        // Round to 4 dp to avoid floating-point noise in the assertion.
        return ry !== undefined ? Math.round(ry * 10000) / 10000 : undefined;
      },
      { timeout: 10_000 }
    )
    // Math.PI / 2 rounded to 4 dp
    .toBe(Math.round((Math.PI / 2) * 10000) / 10000);
});
