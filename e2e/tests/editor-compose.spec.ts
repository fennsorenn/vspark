import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene } from '../fixtures/seed';
import type { APIRequestContext } from '@playwright/test';

/**
 * Editor-flow E2E (Phase 8): compose view — switching to the Compose tab,
 * creating a compose scene (via UI), seeing it rendered, adding a layer via
 * the Create palette, and verifying the layer via REST read-back.
 *
 * Test plan:
 *   1. Seed project + 3-D scene (standard seed fixture).
 *   2. Open the editor, switch to the Compose tab.
 *   3. Create a compose scene via the "+ Scene" button in the Compose tree.
 *   4. Assert the compose scene appears in the tree AND via REST.
 *   5. Add an Image layer via the Create palette (bottom dock "Create" tab).
 *   6. Assert the new layer appears in the compose tree AND via REST.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function listComposeScenes(
  request: APIRequestContext,
  projectId: string
): Promise<{ id: string; name: string; kind: string }[]> {
  const res = await request.get(`/api/projects/${projectId}/compose-scenes`);
  return ((await res.json()).data ?? []) as { id: string; name: string; kind: string }[];
}

async function listComposeLayers(
  request: APIRequestContext,
  composeSceneId: string
): Promise<{ id: string; name: string; kind: string }[]> {
  const res = await request.get(`/api/compose-scenes/${composeSceneId}/layers`);
  return ((await res.json()).data ?? []) as { id: string; name: string; kind: string }[];
}

// ---------------------------------------------------------------------------
// Test 1: Switch to Compose tab → empty state shown
// ---------------------------------------------------------------------------
test('compose tab: switching shows Compose tree with empty-state text', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  // Wait for the editor to load (seeded "Scene" appears in the Stage tree).
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Click the "Compose" tab in the left-panel header.
  await page.getByRole('button', { name: 'Compose', exact: true }).click();

  // The compose tree header "Compose Scenes" must be visible.
  await expect(
    page.getByText('Compose Scenes', { exact: true })
  ).toBeVisible({ timeout: 5_000 });

  // With no compose scenes seeded, the empty-state text is shown.
  // The two i18n keys render inside a single <div>, so match as a substring.
  await expect(
    page.locator('text=No compose scenes yet.')
  ).toBeVisible({ timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// Test 2: Create a compose scene via UI → persisted via REST
// ---------------------------------------------------------------------------
test('compose scene creation: "+ Scene" button creates scene and persists', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Switch to Compose tab.
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await expect(page.getByText('Compose Scenes', { exact: true })).toBeVisible({
    timeout: 5_000,
  });

  // Click the "+ Scene" button inside the compose tree header.
  // There may be multiple "+ Scene" buttons (e.g. Stage tree's "+ Scene" is
  // hidden because we're on the Compose tab, but guard with .first() anyway).
  await page.getByRole('button', { name: '+ Scene', exact: true }).first().click();

  // A prompt dialog appears; fill in a unique name and confirm.
  const sceneName = `Compose E2E ${Date.now()}`;
  const dialog = page.locator('[style*="position: fixed"][style*="inset: 0"]');
  await dialog.getByRole('textbox').fill(sceneName);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();

  // The new compose scene appears in the tree by name.
  // The scene name also appears in the compose view header, so use .first()
  // to resolve to the tree row (earlier in DOM order).
  await expect(
    page.getByText(sceneName, { exact: true }).first()
  ).toBeVisible({ timeout: 10_000 });

  // The "No layers" placeholder appears because the scene is empty.
  await expect(
    page.getByText('No layers', { exact: true })
  ).toBeVisible({ timeout: 5_000 });

  // REST read-back: the compose scene was persisted.
  await expect
    .poll(
      async () => {
        const scenes = await listComposeScenes(request, projectId);
        return scenes.some((s) => s.name === sceneName);
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});

// ---------------------------------------------------------------------------
// Test 3: Add a layer via the Create palette → appears in tree + persisted
// ---------------------------------------------------------------------------
test('compose layer creation: palette tile adds layer to tree and persists', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Switch to Compose tab.
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await expect(page.getByText('Compose Scenes', { exact: true })).toBeVisible({
    timeout: 5_000,
  });

  // Create a compose scene via API so we don't depend on the prompt dialog here.
  const sceneName = `LayerTest ${Date.now()}`;
  const createRes = await request.post(
    `/api/projects/${projectId}/compose-scenes`,
    { data: { name: sceneName } }
  );
  expect(createRes.status()).toBe(201);
  const composeSceneId = (await createRes.json()).data.id as string;

  // Reload the page so the newly API-created compose scene appears in the store.
  await page.reload();
  // Wait for the editor to be ready: the "Compose" tab button is always in the
  // header regardless of which left tab is active.
  await expect(
    page.getByRole('button', { name: 'Compose', exact: true })
  ).toBeVisible({ timeout: 30_000 });

  // Switch to Compose tab (the reload may have reset the left-tab state).
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await expect(page.getByText('Compose Scenes', { exact: true })).toBeVisible({
    timeout: 5_000,
  });

  // The compose scene is visible in the tree.
  // The scene name also appears in the compose view header, so use .first()
  // to resolve to the tree row.
  await expect(
    page.getByText(sceneName, { exact: true }).first()
  ).toBeVisible({ timeout: 10_000 });

  // Click the compose scene row to make it the active scene (so the Create
  // palette will target it).
  await page.getByText(sceneName, { exact: true }).first().click();

  // Open the bottom-dock "Create" tab.
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  // Wait for the compose-layer palette to appear — the "Camera View" tile is
  // always present in compose mode and uniquely identifies the palette.
  await expect(
    page.getByRole('button', { name: /Camera View/ })
  ).toBeVisible({ timeout: 5_000 });

  // Click the "Image" tile (label: "🖼 Image"). Scope to the palette by looking
  // for the tile button that contains the text "Image" but is NOT the "Images"
  // asset-manager tab. The compose palette tiles are buttons inside the dock
  // content area; use the "Camera View" sibling to find the grid, then click.
  // Palette tiles render a Lucide icon (no accessible text) plus the label, so
  // the button's accessible name is the label alone.
  await page.getByRole('button', { name: 'Image', exact: true }).click();

  // The new layer appears in the compose tree.  The default name is "Image Layer".
  const layerRow = page.getByText('Image Layer', { exact: true });
  await expect(layerRow).toBeVisible({ timeout: 10_000 });

  // REST read-back: the layer was persisted to the backend.
  await expect
    .poll(
      async () => {
        const layers = await listComposeLayers(request, composeSceneId);
        return layers.some((l) => l.kind === 'image');
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});

// ---------------------------------------------------------------------------
// Test 4: API-seeded compose scene + layer → both rendered in the Compose tree
// ---------------------------------------------------------------------------
test('compose tree: API-seeded scene and layer are rendered in the UI', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  // Seed a compose scene via API.
  const sceneName = `Seeded Scene ${Date.now()}`;
  const sceneRes = await request.post(
    `/api/projects/${projectId}/compose-scenes`,
    { data: { name: sceneName } }
  );
  expect(sceneRes.status()).toBe(201);
  const composeSceneId = (await sceneRes.json()).data.id as string;

  // Seed a layer inside that compose scene via API.
  const layerName = `Seeded Layer ${Date.now()}`;
  const layerRes = await request.post(
    `/api/compose-scenes/${composeSceneId}/layers`,
    { data: { name: layerName, kind: 'group' } }
  );
  expect(layerRes.status()).toBe(201);

  // Load the editor.
  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Switch to Compose tab.
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await expect(page.getByText('Compose Scenes', { exact: true })).toBeVisible({
    timeout: 5_000,
  });

  // The seeded compose scene must appear in the tree.
  // The scene name may also appear in the compose view header so use .first().
  await expect(
    page.getByText(sceneName, { exact: true }).first()
  ).toBeVisible({ timeout: 10_000 });

  // The seeded layer must appear in the tree.
  await expect(
    page.getByText(layerName, { exact: true })
  ).toBeVisible({ timeout: 10_000 });
});
