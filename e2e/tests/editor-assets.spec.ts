import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene } from '../fixtures/seed';
import type { APIRequestContext } from '@playwright/test';

/**
 * Editor-flow E2E (Phase 8): asset manager — uploading assets via the file
 * input on the Images and Models tabs and verifying the uploads via REST
 * read-back and the AssetManager list UI.
 *
 * Test plan:
 *   1. Upload a PNG image via the Images tab hidden file input → asset card
 *      appears in the Images tab AND persists via GET /api/projects/:id/assets.
 *   2. Upload a minimal GLB model via the Models tab hidden file input → asset
 *      card appears in the Models tab AND persists via REST.
 *   3. API-seeded asset renders in the Images tab list without uploading via UI.
 *
 * Notes on the upload mechanism:
 *   The AssetManager renders a visually-hidden <input type="file"> for each
 *   asset tab (imageInputRef, modelInputRef, etc.). Playwright's setInputFiles()
 *   works on hidden inputs, so we locate them by their `accept` attribute which
 *   is unique per tab. The UI button only calls .click() on the ref — the
 *   change handler does the actual upload.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tiny valid 1×1 PNG (8-byte IHDR + IDAT + IEND). */
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000a49444154789c6260000000020001e221bc330000000049454e44ae426082',
  'hex'
);

/**
 * Minimal valid GLB (GLTF Binary) — 28 bytes total.
 * Header: magic (glTF), version (2), total length (28)
 * Single JSON chunk with empty scene: {"asset":{"version":"2.0"}}
 */
const TINY_GLB = Buffer.from(
  '676c5446' + // magic: "glTF"
    '02000000' + // version: 2
    '1c000000' + // total length: 28
    '0c000000' + // JSON chunk length: 12
    '4a534f4e' + // JSON chunk type: "JSON"
    '7b22617373657422 3a 7b 22 76 65 72 73 69 6f 6e 22 3a 22 32 2e 30 22 7d 7d'
      .replace(/\s/g, ''),
  'hex'
);

type AssetRow = {
  id: string;
  original_name: string;
  mime_type: string;
  kind?: string;
};

async function listAssets(
  request: APIRequestContext,
  projectId: string
): Promise<AssetRow[]> {
  const res = await request.get(`/api/projects/${projectId}/assets`);
  return (await res.json()).data as AssetRow[];
}

// ---------------------------------------------------------------------------
// Test 1: Upload PNG via the Images tab file input
// ---------------------------------------------------------------------------
test('image upload: file input on Images tab creates asset card and persists', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  // Wait for the editor to fully load (seeded "Scene" in the tree).
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Switch bottom dock to the "Images" tab so the hidden input is rendered.
  await page.getByRole('button', { name: 'Images', exact: true }).click();

  // The hidden file input for images accepts image MIME types.
  // Playwright setInputFiles works on display:none inputs.
  const fileName = `e2e-test-${Date.now()}.png`;
  const imageInput = page.locator('input[type="file"][accept*=".png"]');
  await imageInput.setInputFiles({
    name: fileName,
    mimeType: 'image/png',
    buffer: TINY_PNG,
  });

  // The asset card must appear in the Images tab list by file name.
  // The name is truncated with ellipsis, so use a substring match via
  // a locator that finds it within the dock content area.
  await expect(page.getByText(fileName, { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // REST read-back: the upload reached the backend.
  await expect
    .poll(
      async () => {
        const assets = await listAssets(request, projectId);
        return assets.some((a) => a.original_name === fileName);
      },
      { timeout: 15_000 }
    )
    .toBe(true);
});

// ---------------------------------------------------------------------------
// Test 2: Upload GLB via the Models tab file input
// ---------------------------------------------------------------------------
test('model upload: file input on Models tab creates asset card and persists', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Switch to the "Models" tab.
  await page.getByRole('button', { name: 'Models', exact: true }).click();

  // The hidden file input for models accepts .vrm/.glb/.gltf.
  const fileName = `e2e-model-${Date.now()}.glb`;
  const modelInput = page.locator('input[type="file"][accept*=".glb"]');
  await modelInput.setInputFiles({
    name: fileName,
    mimeType: 'model/gltf-binary',
    buffer: TINY_GLB,
  });

  // The asset card appears in the Models tab list.
  await expect(page.getByText(fileName, { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // REST read-back: the model asset persisted.
  await expect
    .poll(
      async () => {
        const assets = await listAssets(request, projectId);
        return assets.some((a) => a.original_name === fileName);
      },
      { timeout: 15_000 }
    )
    .toBe(true);
});

// ---------------------------------------------------------------------------
// Test 3: API-seeded image asset renders in the Images tab list
// ---------------------------------------------------------------------------
test('images tab: API-seeded image asset renders in the AssetManager list', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  // Seed an image asset directly via the REST API (base64 TINY_PNG).
  const fileName = `seeded-image-${Date.now()}.png`;
  const uploadRes = await request.post(`/api/projects/${projectId}/assets`, {
    data: {
      name: fileName,
      mimeType: 'image/png',
      data: TINY_PNG.toString('base64'),
    },
  });
  expect(uploadRes.status()).toBe(201);

  // Load the editor.
  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Switch to the "Images" tab.
  await page.getByRole('button', { name: 'Images', exact: true }).click();

  // The seeded asset must appear in the list.
  await expect(page.getByText(fileName, { exact: true })).toBeVisible({
    timeout: 10_000,
  });
});
