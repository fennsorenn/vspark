import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene } from '../fixtures/seed';
import type { APIRequestContext, Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

/**
 * Live2D bundle ingestion E2E — the manifest completeness check.
 *
 * A Live2D model is a bundle whose `*.model3.json` names every other file by a
 * path relative to itself. Before this check existed, a bundle whose references
 * didn't resolve uploaded "successfully" and then rendered as a blank
 * placeholder with nothing saying why.
 *
 * Test plan:
 *   1. UI — a complete bundle with its texture in a subfolder uploads and
 *      registers, with no report shown (relative paths survive the picker).
 *   2. UI — a flattened bundle (files present, wrong paths) opens the report
 *      naming the paths the manifest expected, and registers nothing.
 *   3. UI — a bundle missing only motions uploads successfully AND warns.
 *   4. REST — a manifest reference escaping the bundle is rejected and nothing
 *      is written.
 *
 * Note on the upload mechanism: the Live2D picker is a `webkitdirectory` input,
 * so Playwright requires a real directory path — which is what makes tests 1–3
 * meaningful, since the browser then populates `webkitRelativePath` exactly as
 * it would for a user picking the folder.
 */

const b64 = (s: string) => Buffer.from(s).toString('base64');

const manifestOf = (fileReferences: Record<string, unknown>) =>
  JSON.stringify({ Version: 3, FileReferences: fileReferences });

/** Temp bundle directories created by `writeBundle`, removed after the run. */
const tempDirs: string[] = [];
test.afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Materialize a bundle on disk and return the folder to hand the picker.
 * Keys are paths relative to the bundle root; nested keys create real
 * subdirectories, which is the layout the flattening bug destroys.
 */
function writeBundle(name: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'vspark-l2d-'));
  tempDirs.push(root);
  const bundleDir = join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(bundleDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return bundleDir;
}

async function listAssets(request: APIRequestContext, projectId: string) {
  const res = await request.get(`/api/projects/${projectId}/assets`);
  return (await res.json()).data as { original_name: string }[];
}

/** Open the editor on a seeded project and switch to the Models tab. */
async function openModelsTab(page: Page, projectId: string) {
  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Models', exact: true }).click();
}

/** The Live2D bundle picker — the only `webkitdirectory` input in the dock. */
const live2dInput = (page: Page) =>
  page.locator('input[type="file"][webkitdirectory]');

const reportWindow = (page: Page) => page.locator('.vs-live2d-report');

// ---------------------------------------------------------------------------
// Test 1: a complete bundle with subfolders uploads cleanly through the UI
// ---------------------------------------------------------------------------
test('live2d: a complete bundle keeps its subfolder layout and uploads', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openModelsTab(page, projectId);

  const dir = writeBundle('good-model', {
    'good.model3.json': manifestOf({
      Moc: 'good.moc3',
      Textures: ['good.2048/texture_00.png'],
      Physics: 'good.physics3.json',
    }),
    'good.moc3': 'moc',
    'good.2048/texture_00.png': 'png',
    'good.physics3.json': '{}',
  });
  await live2dInput(page).setInputFiles(dir);

  // The asset lands in the Models tab…
  await expect(page.getByText('good.model3.json', { exact: true })).toBeVisible(
    {
      timeout: 15_000,
    }
  );
  // …and no report opens, because nothing was missing.
  await expect(reportWindow(page)).toHaveCount(0);

  expect(
    (await listAssets(request, projectId)).map((a) => a.original_name)
  ).toEqual(['good.model3.json']);
});

// ---------------------------------------------------------------------------
// Test 2: a flattened bundle is refused, and says which paths were expected
// ---------------------------------------------------------------------------
test('live2d: a flattened bundle opens the report instead of uploading blank', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openModelsTab(page, projectId);

  // The manifest wants its texture in a subfolder; the folder has it loose —
  // the real hiyori-main failure.
  const dir = writeBundle('flat-model', {
    'model.model3.json': manifestOf({
      Moc: 'model.moc3',
      Textures: ['model.2048/texture_00.png'],
      Motions: { Idle: [{ File: 'motion/m01.motion3.json' }] },
    }),
    'model.moc3': 'moc',
    'texture_00.png': 'png',
  });
  await live2dInput(page).setInputFiles(dir);

  const report = reportWindow(page);
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

  await report.locator('.vs-live2d-report-dismiss').click();
  await expect(report).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Test 3: only optional files missing → uploads AND warns
// ---------------------------------------------------------------------------
test('live2d: a bundle missing only motions uploads and warns', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openModelsTab(page, projectId);

  const dir = writeBundle('warned-model', {
    'warned.model3.json': manifestOf({
      Moc: 'warned.moc3',
      Textures: ['t.png'],
      Motions: { Idle: [{ File: 'motion/m01.motion3.json' }] },
    }),
    'warned.moc3': 'moc',
    't.png': 'png',
  });
  await live2dInput(page).setInputFiles(dir);

  const report = reportWindow(page);
  await expect(report).toBeVisible({ timeout: 15_000 });
  await expect(report.locator('.vs-live2d-report-optional')).toContainText(
    'motion/m01.motion3.json'
  );
  // No required section — the model renders.
  await expect(report.locator('.vs-live2d-report-required')).toHaveCount(0);

  // …and unlike test 2, the asset really was stored.
  await expect
    .poll(
      async () =>
        (await listAssets(request, projectId)).map((a) => a.original_name),
      { timeout: 15_000 }
    )
    .toEqual(['warned.model3.json']);

  await report.locator('.vs-live2d-report-close').click();
  await expect(report).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Test 4: a manifest pointing outside its bundle is rejected (REST)
// ---------------------------------------------------------------------------
test('live2d: a manifest reference escaping the bundle is rejected', async ({
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  const res = await request.post(`/api/projects/${projectId}/assets/bundle`, {
    data: {
      rootName: 'evil',
      kind: 'live2d',
      files: [
        {
          relPath: 'evil.model3.json',
          data: b64(
            manifestOf({ Moc: '../../../etc/passwd', Textures: ['t.png'] })
          ),
        },
        { relPath: 't.png', data: b64('png') },
      ],
    },
  });
  const body = await res.json();

  expect(res.status()).toBe(400);
  expect(body.error.code).toBe('LIVE2D_BUNDLE_INCOMPLETE');
  expect(body.error.details.errors).toContain(
    'unsafe manifest reference: ../../../etc/passwd'
  );
  expect(await listAssets(request, projectId)).toEqual([]);
});
