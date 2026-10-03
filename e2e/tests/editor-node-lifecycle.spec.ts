import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene, seedNode, listNodes } from '../fixtures/seed';

/**
 * Editor-flow E2E (Phase 8): node/scene lifecycle — creation via the Create
 * palette, deletion via the right-click context menu, and scene creation via
 * the "+ Scene" button.  Every UI action is verified by a REST read-back so the
 * full UI → store → backend path is exercised.
 */

// ---------------------------------------------------------------------------
// 1. Node creation via the bottom-dock Create palette
// ---------------------------------------------------------------------------
test('node creation: clicking a palette tile adds node to tree and persists it', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  // Wait for the editor to load: the seeded scene ("Scene") appears in the
  // left-panel scene tree. Use this as the reliable load sentinel.
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Switch bottom dock to the "Create" tab so the palette is visible.
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  // Click the "Group" tile in the palette to add a node to the active scene.
  // The tile renders a Lucide icon (no accessible text) plus the translated
  // label, so the button's accessible name is the label alone.
  await page.getByRole('button', { name: 'Group', exact: true }).click();

  // The new node (default name "Group") appears in the scene graph tree.
  // The palette button is still visible, so scope to the first match — which is
  // the tree row (rendered before the palette below it in DOM order).
  const row = page.getByText('Group', { exact: true }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });

  // REST read-back: the node was persisted to the backend.
  await expect
    .poll(
      async () => {
        const nodes = await listNodes(request, sceneId);
        return nodes.some((n) => n.kind === 'group');
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});

// ---------------------------------------------------------------------------
// 2. Node deletion via the right-click context menu
// ---------------------------------------------------------------------------
test('node deletion: right-click → Delete removes node from tree and persists', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'DeleteMe', 'group');

  await page.goto(`/editor/${projectId}`);

  // Confirm the seeded node is visible in the scene graph.
  const row = page.getByText('DeleteMe', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });

  // Right-click to open the context menu.
  await row.click({ button: 'right' });

  // Click "Delete" in the context menu (styled div, matched by visible text).
  await page.getByText('Delete', { exact: true }).click();

  // A confirm dialog appears ("Delete \"DeleteMe\"?") — click the confirm button.
  await page.getByRole('button', { name: 'Delete', exact: true }).click();

  // The node row disappears from the tree.
  await expect(row).not.toBeVisible({ timeout: 10_000 });

  // REST read-back: the deletion reached the backend.
  await expect
    .poll(
      async () => {
        const nodes = await listNodes(request, sceneId);
        return nodes.some((n) => n.id === nodeId);
      },
      { timeout: 10_000 }
    )
    .toBe(false);
});

// ---------------------------------------------------------------------------
// 3. Scene creation via the "+ Scene" button
// ---------------------------------------------------------------------------
test('scene creation: "+ Scene" button adds a new scene via REST', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  // Wait for the editor to load: the seeded scene ("Scene") appears in the
  // left-panel scene tree.
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Click the "+ Scene" button (its text is the i18n key "scenes.newButton").
  await page.getByRole('button', { name: '+ Scene', exact: true }).click();

  // A prompt dialog appears — fill in a scene name and confirm.
  // The dialog renders in a fixed-position overlay; scope the textbox to
  // a container that has the "Create" confirm button to avoid matching the
  // bottom-dock search input.
  const sceneName = `E2E Scene ${Date.now()}`;
  const dialog = page.locator('[style*="position: fixed"][style*="inset: 0"]');
  await dialog.getByRole('textbox').fill(sceneName);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();

  // The new scene appears in the scene graph.
  await expect(page.getByText(sceneName, { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  // REST read-back: the scene was persisted.
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/projects/${projectId}/scenes`);
        const body = (await res.json()) as {
          data: { scenes: { name: string }[] };
        };
        return body.data.scenes.some((s) => s.name === sceneName);
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});
