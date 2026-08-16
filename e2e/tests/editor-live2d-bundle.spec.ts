import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene } from '../fixtures/seed';
import type { APIRequestContext } from '@playwright/test';

/**
 * Live2D bundle ingestion E2E — the manifest completeness check.
 *
 * A Live2D model is a bundle whose `*.model3.json` names every other file by a
 * path relative to itself. Before this check existed, a bundle whose references
 * didn't resolve uploaded "successfully" and then rendered as a blank
 * placeholder with nothing saying why.
 *
 * Test plan:
 *   1. UI — a flattened bundle (files present, wrong paths) dropped into the
 *      Models tab's Live2D picker opens the report window naming the paths the
 *      manifest expected, and registers no asset.
 *   2. UI — a bundle missing only motions uploads successfully AND opens the
 *      report as a warning.
 *   3. REST — a complete bundle is accepted with an empty `missingOptional`.
 *   4. REST — a manifest reference escaping the bundle is rejected and nothing
 *      is written.
 *
 * Note on the upload mechanism: the Live2D picker is a `webkitdirectory` input,
 * and `File.name` cannot contain a path separator, so files pushed through it
 * from Playwright always land at the bundle root. That is precisely the
 * flattened-download shape this check exists to catch, which makes it the right
 * fixture for tests 1 and 2; subdirectory layouts are covered over REST.
 */

const b64 = (s: string) => Buffer.from(s).toString('base64');

interface BundleFile {
  relPath: string;
  data: string;
}

const manifestOf = (fileReferences: Record<string, unknown>) =>
  JSON.stringify({ Version: 3, FileReferences: fileReferences });

async function postBundle(
  request: APIRequestContext,
  projectId: string,
  files: BundleFile[],
  rootName = 'e2e-model'
) {
  const res = await request.post(`/api/projects/${projectId}/assets/bundle`, {
    data: { rootName, kind: 'live2d', files },
  });
  return { status: res.status(), body: await res.json() };
}

async function listAssets(request: APIRequestContext, projectId: string) {
  const res = await request.get(`/api/projects/${projectId}/assets`);
  return (await res.json()).data as { original_name: string }[];
}

/** Open the editor on a seeded project and switch to the Models tab. */
async function openModelsTab(
  page: import('@playwright/test').Page,
  projectId: string
) {
  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Models', exact: true }).click();
}

/** The Live2D bundle picker — the only `webkitdirectory` input in the dock. */
const live2dInput = (page: import('@playwright/test').Page) =>
  page.locator('input[type="file"][webkitdirectory]');

// ---------------------------------------------------------------------------
// Test 1: a flattened bundle is refused, and says which paths were expected
// ---------------------------------------------------------------------------
test('live2d: a flattened bundle opens the report instead of uploading blank', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openModelsTab(page, projectId);

  // The manifest wants its texture in a subfolder; the upload has it loose.
  await live2dInput(page).setInputFiles([
    {
      name: 'model.model3.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        manifestOf({
          Moc: 'model.moc3',
          Textures: ['model.2048/texture_00.png'],
          Motions: { Idle: [{ File: 'motion/m01.motion3.json' }] },
        })
      ),
    },
    {
      name: 'model.moc3',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('moc'),
    },
    {
      name: 'texture_00.png',
      mimeType: 'image/png',
      buffer: Buffer.from('png'),
    },
  ]);

  const report = page.locator('.vs-live2d-report');
  await expect(report).toBeVisible({ timeout: 15_000 });
  // The path the manifest expected, not the one the user supplied.
  await expect(report.locator('.vs-live2d-report-required')).toContainText(
    'model.2048/texture_00.png'
  );
  // The motion gap is listed separately, as optional.
  await expect(report.locator('.vs-live2d-report-optional')).toContainText(
    'motion/m01.motion3.json'
  );

  // Nothing was stored: the bundle is rejected before any write.
  expect(await listAssets(request, projectId)).toEqual([]);

  // The window is dismissable.
  await report.locator('.vs-live2d-report-dismiss').click();
  await expect(report).toBeHidden();
});

// ---------------------------------------------------------------------------
// Test 2: only optional files missing → uploads AND warns
// ---------------------------------------------------------------------------
test('live2d: a bundle missing only motions uploads and warns', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openModelsTab(page, projectId);

  await live2dInput(page).setInputFiles([
    {
      name: 'warned.model3.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        manifestOf({
          Moc: 'warned.moc3',
          Textures: ['t.png'],
          Motions: { Idle: [{ File: 'motion/m01.motion3.json' }] },
        })
      ),
    },
    {
      name: 'warned.moc3',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('moc'),
    },
    { name: 't.png', mimeType: 'image/png', buffer: Buffer.from('png') },
  ]);

  const report = page.locator('.vs-live2d-report');
  await expect(report).toBeVisible({ timeout: 15_000 });
  await expect(report.locator('.vs-live2d-report-optional')).toContainText(
    'motion/m01.motion3.json'
  );
  // No required section — the model renders.
  await expect(report.locator('.vs-live2d-report-required')).toHaveCount(0);

  // …and unlike test 1, the asset really was stored.
  await expect
    .poll(
      async () =>
        (await listAssets(request, projectId)).map((a) => a.original_name),
      {
        timeout: 15_000,
      }
    )
    .toEqual(['warned.model3.json']);

  await report.locator('.vs-live2d-report-close').click();
  await expect(report).toBeHidden();
});

// ---------------------------------------------------------------------------
// Test 3: a complete bundle with a subdirectory layout is accepted (REST)
// ---------------------------------------------------------------------------
test('live2d: a complete bundle with subfolders is accepted with no warnings', async ({
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  const { status, body } = await postBundle(request, projectId, [
    {
      relPath: 'model.model3.json',
      data: b64(
        manifestOf({
          Moc: 'model.moc3',
          Textures: ['model.2048/texture_00.png'],
        })
      ),
    },
    { relPath: 'model.moc3', data: b64('moc') },
    { relPath: 'model.2048/texture_00.png', data: b64('png') },
  ]);

  expect(status).toBe(201);
  expect(body.data.missingOptional).toEqual([]);
  expect(
    (await listAssets(request, projectId)).map((a) => a.original_name)
  ).toEqual(['model.model3.json']);
});

// ---------------------------------------------------------------------------
// Test 4: a manifest pointing outside its bundle is rejected (REST)
// ---------------------------------------------------------------------------
test('live2d: a manifest reference escaping the bundle is rejected', async ({
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  const { status, body } = await postBundle(request, projectId, [
    {
      relPath: 'evil.model3.json',
      data: b64(
        manifestOf({ Moc: '../../../etc/passwd', Textures: ['t.png'] })
      ),
    },
    { relPath: 't.png', data: b64('png') },
  ]);

  expect(status).toBe(400);
  expect(body.error.code).toBe('LIVE2D_BUNDLE_INCOMPLETE');
  expect(body.error.details.errors).toContain(
    'unsafe manifest reference: ../../../etc/passwd'
  );
  expect(await listAssets(request, projectId)).toEqual([]);
});
