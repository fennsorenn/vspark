import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene, seedNode } from '../fixtures/seed';
import type { APIRequestContext } from '@playwright/test';

/**
 * Editor-flow E2E (Phase 8): Preset Library — saving a preset from a selected
 * node, verifying it appears in the list UI and via REST, and (optionally)
 * instantiating it back into the scene.
 *
 * Test plan:
 *   1. Seed a project + scene + node. Load the editor.
 *   2. Open the bottom-dock "Presets" tab.
 *   3. Select the seeded node in the scene graph.
 *   4. Click "Save" in the Preset Library header to open the save modal.
 *   5. Fill in a preset name and confirm. Assert the card appears in the list.
 *   6. REST read-back: GET /api/projects/:projectId/presets confirms persistence.
 *   7. (Optional) Instantiate back: skipped — the "Use" button requires an active
 *      scene selection AND the node to be mounted in the WebGL viewport before
 *      the store allows it; the round-trip adds entanglement without new signal
 *      coverage. Covered by unit/integration tests for the instantiatePreset API.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function listPresets(
  request: APIRequestContext,
  projectId: string
): Promise<{ id: string; name: string; rootKind: string }[]> {
  const res = await request.get(`/api/projects/${projectId}/presets`);
  return ((await res.json()).data ?? []) as {
    id: string;
    name: string;
    rootKind: string;
  }[];
}

// ---------------------------------------------------------------------------
// Test 1: Presets tab opens and shows the Preset Library
// ---------------------------------------------------------------------------
test('presets tab: switching shows Preset Library with empty state', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  // Wait for the editor to load (seeded "Scene" appears in the left-panel tree).
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Click the "Presets" tab in the bottom dock.
  await page.getByRole('button', { name: 'Presets', exact: true }).click();

  // The Preset Library header must be visible (the span also contains a help
  // button child so match as a substring, not exact).
  await expect(
    page.locator('text=Preset Library').first()
  ).toBeVisible({ timeout: 5_000 });

  // With no presets and no node selected, the empty-state text is shown.
  await expect(
    page.locator('text=No presets saved yet.')
  ).toBeVisible({ timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// Test 2: Save a preset from a selected node → card appears in list + REST
// ---------------------------------------------------------------------------
test('preset creation: saving selected node creates preset card and persists', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  await seedNode(request, sceneId, 'PresetSource', 'group');

  await page.goto(`/editor/${projectId}`);

  // Wait for the editor to load.
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Select the seeded node in the scene graph (left panel).
  const nodeRow = page.getByText('PresetSource', { exact: true });
  await expect(nodeRow).toBeVisible({ timeout: 10_000 });
  await nodeRow.click();

  // Switch bottom dock to the "Presets" tab.
  await page.getByRole('button', { name: 'Presets', exact: true }).click();

  // The Preset Library header must be visible (span contains a help button
  // child so match as a substring, not exact).
  await expect(
    page.locator('text=Preset Library').first()
  ).toBeVisible({ timeout: 5_000 });

  // The "Save" button should be enabled because a node is selected.
  const saveBtn = page.getByRole('button', { name: 'Save', exact: true }).first();
  await expect(saveBtn).toBeEnabled({ timeout: 5_000 });

  // Click "Save" to open the save-as-preset modal.
  await saveBtn.click();

  // The save modal appears (fixed overlay with "Save as Preset" title).
  const modal = page.locator('[style*="position: fixed"][style*="inset: 0"]');
  await expect(modal).toBeVisible({ timeout: 5_000 });
  await expect(modal.getByText('Save as Preset', { exact: true })).toBeVisible({
    timeout: 5_000,
  });

  // Fill in a unique preset name.
  const presetName = `E2E Preset ${Date.now()}`;
  await modal.getByPlaceholder('Preset name').fill(presetName);

  // Click the blue "Save" button inside the modal (different from the header "Save").
  await modal.getByRole('button', { name: 'Save', exact: true }).click();

  // The modal closes after a successful save.
  await expect(modal).not.toBeVisible({ timeout: 10_000 });

  // The new preset card appears in the list with the preset name.
  await expect(
    page.getByText(presetName, { exact: false })
  ).toBeVisible({ timeout: 10_000 });

  // REST read-back: the preset was persisted to the backend.
  await expect
    .poll(
      async () => {
        const presets = await listPresets(request, projectId);
        return presets.some((p) => p.name === presetName);
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});

// ---------------------------------------------------------------------------
// Test 3: Saved preset has rootKind = "scene_node" (REST shape)
// ---------------------------------------------------------------------------
test('preset REST shape: saved preset has correct rootKind', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  await seedNode(request, sceneId, 'ShapeTestNode', 'group');

  await page.goto(`/editor/${projectId}`);

  // Wait for editor load.
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Select the seeded node.
  const nodeRow = page.getByText('ShapeTestNode', { exact: true });
  await expect(nodeRow).toBeVisible({ timeout: 10_000 });
  await nodeRow.click();

  // Open the Presets tab and save.
  await page.getByRole('button', { name: 'Presets', exact: true }).click();
  await expect(
    page.locator('text=Preset Library').first()
  ).toBeVisible({ timeout: 5_000 });

  const saveBtn = page.getByRole('button', { name: 'Save', exact: true }).first();
  await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
  await saveBtn.click();

  const modal = page.locator('[style*="position: fixed"][style*="inset: 0"]');
  await expect(modal).toBeVisible({ timeout: 5_000 });

  const presetName = `Shape E2E ${Date.now()}`;
  await modal.getByPlaceholder('Preset name').fill(presetName);
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).not.toBeVisible({ timeout: 10_000 });

  // Verify via REST that rootKind is "scene_node".
  await expect
    .poll(
      async () => {
        const presets = await listPresets(request, projectId);
        const p = presets.find((x) => x.name === presetName);
        return p?.rootKind;
      },
      { timeout: 10_000 }
    )
    .toBe('scene_node');
});

// ---------------------------------------------------------------------------
// Test 4: Preset list shows the saved preset card after page reload
// ---------------------------------------------------------------------------
test('preset list: saved preset persists across page reload', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  await seedNode(request, sceneId, 'PersistNode', 'group');

  await page.goto(`/editor/${projectId}`);

  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Select the node, open Presets, save.
  await page.getByText('PersistNode', { exact: true }).click();
  await page.getByRole('button', { name: 'Presets', exact: true }).click();
  await expect(
    page.locator('text=Preset Library').first()
  ).toBeVisible({ timeout: 5_000 });

  const saveBtn = page.getByRole('button', { name: 'Save', exact: true }).first();
  await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
  await saveBtn.click();

  const modal = page.locator('[style*="position: fixed"][style*="inset: 0"]');
  await expect(modal).toBeVisible({ timeout: 5_000 });

  const presetName = `Reload E2E ${Date.now()}`;
  await modal.getByPlaceholder('Preset name').fill(presetName);
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(modal).not.toBeVisible({ timeout: 10_000 });

  // Reload the page and re-open the Presets tab.
  await page.reload();
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole('button', { name: 'Presets', exact: true }).click();
  await expect(
    page.locator('text=Preset Library').first()
  ).toBeVisible({ timeout: 5_000 });

  // The preset card must be visible after reload (loaded from backend).
  await expect(
    page.getByText(presetName, { exact: false })
  ).toBeVisible({ timeout: 10_000 });
});
