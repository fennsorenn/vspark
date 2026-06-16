import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene, seedNode, listNodes } from '../fixtures/seed';

/**
 * Editor-flow E2E (Phase 8): a real cross-stack round-trip — seed a node via the
 * API, load the editor, select the node in the scene graph, rename it in the
 * Properties panel, and confirm the rename PERSISTED via a REST read-back (so
 * the UI → store → mesh write-through → DB path is all exercised).
 */
test('scene graph: select a node and rename it via Properties (persists)', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'Cube A', 'group');

  await page.goto(`/editor/${projectId}`);

  // The seeded node appears in the scene graph (editor loaded it from REST).
  const row = page.getByText('Cube A', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });

  // Selecting it opens the Properties inspector (its name field carries the value).
  await row.click();
  const nameInput = page.locator('.vs-node-name');
  await expect(nameInput).toHaveValue('Cube A');

  // Rename + commit on blur.
  await nameInput.fill('Cube Renamed');
  await nameInput.blur();

  // REST read-back: the rename reached the backend (mesh write-through → DB).
  await expect
    .poll(
      async () => (await listNodes(request, sceneId)).find((n) => n.id === nodeId)?.name,
      { timeout: 10_000 }
    )
    .toBe('Cube Renamed');
});
