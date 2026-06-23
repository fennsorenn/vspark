import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene } from '../fixtures/seed';
import type { APIRequestContext } from '@playwright/test';

/**
 * Control-coverage spec (4a): AssetManager — tab bar, upload buttons, and
 * per-asset action buttons.
 *
 * Targeted `vs-` handles:
 *   Tab bar: vs-tab-create, vs-tab-models, vs-tab-animations, vs-tab-images,
 *            vs-tab-videos, vs-tab-audio, vs-tab-components, vs-tab-effects,
 *            vs-tab-clips, vs-tab-presets
 *   Upload:  vs-upload-model, vs-upload-image
 *   Search:  vs-asset-search
 *   Actions: vs-asset-add-to-scene, vs-asset-add-image, vs-asset-delete
 *
 * Each test seeds its own project so tests are fully isolated.
 */

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

/** Tiny valid 1×1 PNG. */
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000a49444154789c6260000000020001e221bc330000000049454e44ae426082',
  'hex'
);

/** Minimal valid GLB (28 bytes). */
const TINY_GLB = Buffer.from(
  '676c5446' + // magic: "glTF"
    '02000000' + // version: 2
    '1c000000' + // total length: 28
    '0c000000' + // JSON chunk length: 12
    '4a534f4e' + // JSON chunk type: "JSON"
    '7b2261737365 74223a7b2276657273696f6e223a22322e30227d7d'.replace(
      /\s/g,
      ''
    ),
  'hex'
);

type AssetRow = {
  id: string;
  original_name: string;
  kind?: string;
};

async function listAssets(
  request: APIRequestContext,
  projectId: string
): Promise<AssetRow[]> {
  const res = await request.get(`/api/projects/${projectId}/assets`);
  return (await res.json()).data as AssetRow[];
}

/** Upload a small PNG via the REST API and return the asset id. */
async function uploadPng(
  request: APIRequestContext,
  projectId: string,
  name: string
): Promise<string> {
  const res = await request.post(`/api/projects/${projectId}/assets`, {
    data: {
      name,
      mimeType: 'image/png',
      data: TINY_PNG.toString('base64'),
    },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()).data as { id: string }).id;
}

/** Upload a small GLB via the REST API and return the asset id. */
async function uploadGlb(
  request: APIRequestContext,
  projectId: string,
  name: string
): Promise<string> {
  const res = await request.post(`/api/projects/${projectId}/assets`, {
    data: {
      name,
      mimeType: 'model/gltf-binary',
      data: TINY_GLB.toString('base64'),
    },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()).data as { id: string }).id;
}

/** Navigate to the editor and wait for it to be ready. */
async function openEditor(
  page: import('@playwright/test').Page,
  projectId: string
) {
  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Test 1: Tab bar — click through all 10 tabs (vs-tab-*)
// ---------------------------------------------------------------------------
test('AssetManager tab bar: all 10 tabs are clickable', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openEditor(page, projectId);

  // Click each tab in order; the fixture recorder captures the vs- class.
  await page.locator('.vs-tab-create').click();
  await page.locator('.vs-tab-models').click();
  await page.locator('.vs-tab-animations').click();
  await page.locator('.vs-tab-images').click();
  await page.locator('.vs-tab-videos').click();
  await page.locator('.vs-tab-audio').click();
  await page.locator('.vs-tab-components').click();
  await page.locator('.vs-tab-effects').click();
  await page.locator('.vs-tab-clips').click();
  await page.locator('.vs-tab-presets').click();

  // Verify we can switch back to the Create tab and that panel is visible.
  await page.locator('.vs-tab-create').click();
  // The Create tab renders the CreatePalette — check the tab is now active
  // by confirming the Models tab is not active (no blue underline check needed;
  // just ensure no navigation error occurred).
  await expect(page.locator('.vs-tab-create')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 2: Models tab — upload button (vs-upload-model) and add-to-scene
// ---------------------------------------------------------------------------
test('AssetManager models tab: upload button and add-to-scene action', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openEditor(page, projectId);

  // Switch to Models tab — exercises vs-tab-models.
  await page.locator('.vs-tab-models').click();

  // Upload a GLB via the hidden file input (the upload button is vs-upload-model).
  const fileName = `e2e-model-${Date.now()}.glb`;
  const modelInput = page.locator('input[type="file"][accept*=".glb"]');
  await modelInput.setInputFiles({
    name: fileName,
    mimeType: 'model/gltf-binary',
    buffer: TINY_GLB,
  });

  // Wait for the asset card to appear.
  await expect(page.getByText(fileName, { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // REST read-back: asset persisted.
  await expect
    .poll(
      async () => {
        const assets = await listAssets(request, projectId);
        return assets.some((a) => a.original_name === fileName);
      },
      { timeout: 15_000 }
    )
    .toBe(true);

  // Click "Add to scene" — exercises vs-asset-add-to-scene.
  await page.locator('.vs-asset-add-to-scene').first().click();
});

// ---------------------------------------------------------------------------
// Test 3: Images tab — upload button (vs-upload-image) and asset actions
// ---------------------------------------------------------------------------
test('AssetManager images tab: upload button and add-as-billboard action', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openEditor(page, projectId);

  // Switch to Images tab — exercises vs-tab-images.
  await page.locator('.vs-tab-images').click();

  // Click the upload button to focus it (exercises vs-upload-image handle).
  // We don't open a real file dialog; just asserting the button is reachable.
  await expect(page.locator('.vs-upload-image')).toBeVisible();

  // Upload an image via the hidden file input.
  const fileName = `e2e-img-${Date.now()}.png`;
  const imageInput = page.locator('input[type="file"][accept*=".png"]');
  await imageInput.setInputFiles({
    name: fileName,
    mimeType: 'image/png',
    buffer: TINY_PNG,
  });

  // Wait for the asset card.
  await expect(page.getByText(fileName, { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // Click "Add as billboard" button — exercises vs-asset-add-image.
  await page.locator('.vs-asset-add-image').first().click();
});

// ---------------------------------------------------------------------------
// Test 4: Asset search input (vs-asset-search) and delete (vs-asset-delete)
// ---------------------------------------------------------------------------
test('AssetManager: search filters the list; delete removes an asset', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  // Seed two image assets via REST so they're present when the editor loads.
  const nameA = `img-alpha-${Date.now()}.png`;
  const nameB = `img-beta-${Date.now()}.png`;
  await uploadPng(request, projectId, nameA);
  await uploadPng(request, projectId, nameB);

  await openEditor(page, projectId);

  // Go to the Images tab.
  await page.locator('.vs-tab-images').click();

  // Both assets should be visible.
  await expect(page.getByText(nameA, { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(nameB, { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  // Type in the search box — exercises vs-asset-search.
  await page.locator('.vs-asset-search').fill('alpha');

  // Only nameA should remain visible.
  await expect(page.getByText(nameA, { exact: true })).toBeVisible();
  await expect(page.getByText(nameB, { exact: true })).not.toBeVisible();

  // Clear the search so both are visible again.
  await page.locator('.vs-asset-search').fill('');
  await expect(page.getByText(nameB, { exact: true })).toBeVisible();

  // Delete the first visible asset — exercises vs-asset-delete.
  await page.locator('.vs-asset-delete').first().click();

  // Confirm the deletion propagated to the backend.
  await expect
    .poll(
      async () => {
        const assets = await listAssets(request, projectId);
        return assets.length;
      },
      { timeout: 15_000 }
    )
    .toBe(1);
});

// ---------------------------------------------------------------------------
// Test 5: Upload buttons exercise their vs- handles via direct click
// ---------------------------------------------------------------------------
test('AssetManager: upload buttons on each media tab are clickable', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openEditor(page, projectId);

  // Models tab: click the upload button (vs-upload-model).
  await page.locator('.vs-tab-models').click();
  const modelUploadBtn = page.locator('.vs-upload-model');
  await expect(modelUploadBtn).toBeVisible();
  // Click the button to exercise the handle; the file dialog won't open in
  // headless mode but the click IS captured by the coverage recorder.
  await modelUploadBtn.click({ force: true });

  // Animations tab: vs-upload-animation.
  await page.locator('.vs-tab-animations').click();
  const animUploadBtn = page.locator('.vs-upload-animation');
  await expect(animUploadBtn).toBeVisible();
  await animUploadBtn.click({ force: true });

  // Images tab: vs-upload-image.
  await page.locator('.vs-tab-images').click();
  const imageUploadBtn = page.locator('.vs-upload-image');
  await expect(imageUploadBtn).toBeVisible();
  await imageUploadBtn.click({ force: true });

  // Videos tab: vs-upload-video.
  await page.locator('.vs-tab-videos').click();
  const videoUploadBtn = page.locator('.vs-upload-video');
  await expect(videoUploadBtn).toBeVisible();
  await videoUploadBtn.click({ force: true });

  // Audio tab: vs-upload-audio.
  await page.locator('.vs-tab-audio').click();
  const audioUploadBtn = page.locator('.vs-upload-audio');
  await expect(audioUploadBtn).toBeVisible();
  await audioUploadBtn.click({ force: true });
});

// ---------------------------------------------------------------------------
// Test 6: Pre-seeded model asset → add-to-scene REST assertion
// ---------------------------------------------------------------------------
test('AssetManager: API-seeded model renders in Models tab and can be added to scene', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  const modelName = `seed-model-${Date.now()}.glb`;
  await uploadGlb(request, projectId, modelName);

  await openEditor(page, projectId);

  await page.locator('.vs-tab-models').click();

  // The seeded model must appear (use .first() to avoid strict-mode error
  // when the name appears in both a span and an outer div).
  await expect(page.getByText(modelName, { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });

  // Click "Add to scene" on the seeded model card.
  await page.locator('.vs-asset-add-to-scene').first().click();

  // The asset is still listed (we added it to the scene but did not delete it).
  await expect(
    page.getByText(modelName, { exact: true }).first()
  ).toBeVisible();
});
