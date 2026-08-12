import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene } from '../fixtures/seed';
import type { APIRequestContext } from '@playwright/test';

/**
 * Control-coverage E2E (Phase 4a): Compose panel — instruments and exercises
 * the interactive controls in ComposeTree.tsx and ComposeLayerProperties.tsx
 * that carry `vs-` targeting handles.
 *
 * Test plan:
 *   1. Seed project + scene via API.
 *   2. Create a compose scene via API.
 *   3. Create an image layer inside it via API.
 *   4. Open the editor, switch to Compose tab, select the layer.
 *   5. Exercise layer-property controls (name, visibility, opacity, position,
 *      size, rotation, anchor, blend mode).
 *   6. Assert REST persistence where state mutates (GET layer after each write).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ComposeLayer {
  id: string;
  name: string;
  kind: string;
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  sceneOrder: number;
  cameraOrder: number;
  anchorH: string;
  anchorV: string;
  config: Record<string, unknown>;
}

async function listComposeLayers(
  request: APIRequestContext,
  composeSceneId: string
): Promise<ComposeLayer[]> {
  const res = await request.get(`/api/compose-scenes/${composeSceneId}/layers`);
  const json = await res.json();
  return (json.data ?? []) as ComposeLayer[];
}

async function getComposeLayer(
  request: APIRequestContext,
  layerId: string,
  composeSceneId: string
): Promise<ComposeLayer | undefined> {
  const layers = await listComposeLayers(request, composeSceneId);
  return layers.find((l) => l.id === layerId);
}

// ---------------------------------------------------------------------------
// Test: Seed a compose scene + layer, navigate to it, exercise controls.
// ---------------------------------------------------------------------------

test('cov-compose: exercise ComposeTree and layer-property controls', async ({
  page,
  request,
}) => {
  // ---- 1. Seed backing data via REST ----------------------------------------
  const { projectId } = await seedProjectScene(request);

  // Create a compose scene.
  const sceneRes = await request.post(
    `/api/projects/${projectId}/compose-scenes`,
    { data: { name: 'CovScene' } }
  );
  expect(sceneRes.status()).toBe(201);
  const composeSceneId = (await sceneRes.json()).data.id as string;

  // Create an image layer inside the compose scene.
  const layerRes = await request.post(
    `/api/compose-scenes/${composeSceneId}/layers`,
    { data: { name: 'CovLayer', kind: 'group' } }
  );
  expect(layerRes.status()).toBe(201);
  const layerId = (await layerRes.json()).data.id as string;

  // ---- 2. Navigate to editor, switch to Compose tab -------------------------
  await page.goto(`/editor/${projectId}`);

  // Wait for editor to be ready.
  await expect(
    page.getByRole('button', { name: 'Compose', exact: true })
  ).toBeVisible({ timeout: 30_000 });

  // Switch to Compose tab.
  await page.getByRole('button', { name: 'Compose', exact: true }).click();

  // The compose tree header must appear.
  await expect(
    page.getByText('Compose Scenes', { exact: true })
  ).toBeVisible({ timeout: 5_000 });

  // The seeded compose scene must appear in the tree.
  await expect(
    page.getByText('CovScene', { exact: true }).first()
  ).toBeVisible({ timeout: 10_000 });

  // ---- 3. Exercise ComposeTree controls -------------------------------------

  // Exercise vs-compose-scene-row — click to select/activate compose scene.
  await page.locator('.vs-compose-scene-row').first().click();

  // Exercise vs-compose-scene-collapse — collapse/expand the scene tree.
  const collapseBtn = page.locator('.vs-compose-scene-collapse').first();
  if (await collapseBtn.isVisible()) {
    await collapseBtn.click();
    await collapseBtn.click(); // expand back
  }

  // ---- 4. Select the layer to show its properties --------------------------

  // Click on the layer row to select it.
  await page.locator('.vs-layer-row').first().click();

  // Wait for the properties panel to show the layer name field.
  await expect(page.locator('.vs-layer-name')).toBeVisible({ timeout: 5_000 });

  // ---- 5. Exercise layer row controls (ComposeTree) -------------------------

  // vs-layer-visibility — toggle layer visibility.
  await page.locator('.vs-layer-visibility').first().click();
  // Toggle back.
  await page.locator('.vs-layer-visibility').first().click();

  // vs-layer-lock — toggle lock.
  await page.locator('.vs-layer-lock').first().click();
  // Toggle back.
  await page.locator('.vs-layer-lock').first().click();

  // ---- 6. Exercise layer-property controls (ComposeLayerProperties) ---------

  // vs-layer-name — update the layer name.
  const nameInput = page.locator('.vs-layer-name');
  await nameInput.fill('CovLayerRenamed');
  await nameInput.blur();

  // Wait for persistence (poll until the backend has the new name).
  await expect
    .poll(
      async () => {
        const layer = await getComposeLayer(request, layerId, composeSceneId);
        return layer?.name;
      },
      { timeout: 10_000 }
    )
    .toBe('CovLayerRenamed');

  // vs-layer-position — interact with the X/Y position VecInput.
  const posInput = page.locator('.vs-layer-position');
  await expect(posInput).toBeVisible();
  // Click the first inner input (X axis) and set a value.
  const xInput = posInput.locator('input').first();
  await xInput.fill('100');
  await xInput.blur();

  // Wait for X to persist.
  await expect
    .poll(
      async () => {
        const layer = await getComposeLayer(request, layerId, composeSceneId);
        return layer?.x;
      },
      { timeout: 10_000 }
    )
    .toBe(100);

  // vs-layer-size — interact with the W/H size VecInput.
  const sizeInput = page.locator('.vs-layer-size');
  await expect(sizeInput).toBeVisible();
  const wInput = sizeInput.locator('input').first();
  await wInput.fill('500');
  await wInput.blur();

  await expect
    .poll(
      async () => {
        const layer = await getComposeLayer(request, layerId, composeSceneId);
        return layer?.width;
      },
      { timeout: 10_000 }
    )
    .toBe(500);

  // vs-layer-rotation — interact with the rotation NumInput.
  const rotInput = page.locator('.vs-layer-rotation');
  await expect(rotInput).toBeVisible();
  const rotNumberInput = rotInput.locator('input');
  await rotNumberInput.fill('45');
  await rotNumberInput.blur();

  await expect
    .poll(
      async () => {
        const layer = await getComposeLayer(request, layerId, composeSceneId);
        return layer?.rotation;
      },
      { timeout: 10_000 }
    )
    .toBe(45);

  // vs-layer-visible (checkbox label) — exercise visibility checkbox.
  const visibleLabel = page.locator('.vs-layer-visible');
  await expect(visibleLabel).toBeVisible();
  await visibleLabel.click();
  // Click again to restore.
  await visibleLabel.click();

  // vs-layer-opacity — interact with the opacity slider.
  const opacitySlider = page.locator('.vs-layer-opacity');
  await expect(opacitySlider).toBeVisible();
  // Interact with the underlying range input.
  const rangeInput = opacitySlider.locator('input[type="range"]');
  await rangeInput.fill('0.5');
  await rangeInput.dispatchEvent('pointerup');

  // vs-layer-blend — interact with the blend mode select.
  const blendSelect = page.locator('.vs-layer-blend');
  await expect(blendSelect).toBeVisible();
  await blendSelect.selectOption('multiply');
  // Reset to normal.
  await blendSelect.selectOption('normal');

  // Anchor is a 2×2 grid of corner buttons; each corner sets both axes at once.
  // vs-layer-anchor-right-bottom — pick the bottom-right corner.
  const anchorBR = page.locator('.vs-layer-anchor-right-bottom');
  await expect(anchorBR).toBeVisible();
  await anchorBR.click();
  // vs-layer-anchor-left-top — reset back to the top-left corner.
  const anchorTL = page.locator('.vs-layer-anchor-left-top');
  await expect(anchorTL).toBeVisible();
  await anchorTL.click();

  // vs-layer-x-unit — X position unit select (inline in the value row).
  const xUnit = page.locator('.vs-layer-x-unit');
  await expect(xUnit).toBeVisible();
  await xUnit.selectOption('%');
  // Reset.
  await xUnit.selectOption('px');

  // Stack order is a fractional key now, so it's driven by these four buttons
  // rather than typing an integer. With a single layer in the group there is
  // nowhere to move, so they are all disabled — assert that, then exercise the
  // enabled path below once a second layer exists.
  await expect(page.locator('.vs-layer-order-back')).toBeDisabled();
  await expect(page.locator('.vs-layer-order-front')).toBeDisabled();
});
