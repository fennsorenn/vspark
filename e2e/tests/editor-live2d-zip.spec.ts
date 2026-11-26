import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene } from '../fixtures/seed';
import type { APIRequestContext, Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { execFileSync } from 'child_process';

/**
 * Live2D zip ingestion + incremental completion (steps 3 and 4).
 *
 * Test plan:
 *   1. A zip of a complete model uploads from the Live2D Zip button, with the
 *      wrapping top-level folder stripped and subfolder paths intact.
 *   2. A zip holding two models opens the model picker; choosing one uploads
 *      only that model's files.
 *   3. A zip missing a texture opens the report; supplying the bare file
 *      completes the bundle and the model uploads — without re-picking anything
 *      the user already chose.
 *   4. A zip with no manifest is not treated as a Live2D model.
 *
 * Zips are built with the system `zip` so the fixtures are real archives rather
 * than something produced by the same library under test.
 */

const tempDirs: string[] = [];
test.afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const manifestOf = (fileReferences: Record<string, unknown>) =>
  JSON.stringify({ Version: 3, FileReferences: fileReferences });

/** Write `files` under a folder and zip it, returning the archive path. */
function makeZip(name: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'vspark-zip-'));
  tempDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const zipPath = join(root, `${name}.zip`);
  // -x excludes the archive itself if the glob would pick it up.
  execFileSync('zip', ['-rq', zipPath, '.', '-x', `${name}.zip`], {
    cwd: root,
  });
  return zipPath;
}

/** A loose file on disk, for the completion drop. */
function makeFile(name: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'vspark-file-'));
  tempDirs.push(root);
  const p = join(root, name);
  writeFileSync(p, content);
  return p;
}

async function listAssets(request: APIRequestContext, projectId: string) {
  const res = await request.get(`/api/projects/${projectId}/assets`);
  return (await res.json()).data as { original_name: string }[];
}

async function openModelsTab(page: Page, projectId: string) {
  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Models', exact: true }).click();
}

/** The zip picker — the Models tab's only `.zip`-accepting file input. */
const zipInput = (page: Page) =>
  page.locator('input[type="file"][accept*=".zip"]');

// ---------------------------------------------------------------------------
// Test 1: a zipped model uploads with no manual unzipping
// ---------------------------------------------------------------------------
test('live2d zip: a complete zipped model uploads and keeps its subfolders', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openModelsTab(page, projectId);

  // Wrapped in a top-level folder, as real distributions are.
  const zip = makeZip('hiyori', {
    'Hiyori/hiyori.model3.json': manifestOf({
      Moc: 'hiyori.moc3',
      Textures: ['hiyori.2048/texture_00.png'],
      Physics: 'hiyori.physics3.json',
    }),
    'Hiyori/hiyori.moc3': 'moc',
    'Hiyori/hiyori.2048/texture_00.png': 'png',
    'Hiyori/hiyori.physics3.json': '{}',
  });
  await zipInput(page).setInputFiles(zip);

  await expect(
    page.getByText('hiyori.model3.json', { exact: true })
  ).toBeVisible({ timeout: 20_000 });
  // Complete, so no report — the wrapping folder was stripped and every
  // reference resolved against the manifest.
  await expect(page.locator('.vs-live2d-report')).toHaveCount(0);
  expect(
    (await listAssets(request, projectId)).map((a) => a.original_name)
  ).toEqual(['hiyori.model3.json']);
});

// ---------------------------------------------------------------------------
// Test 2: two models in one archive → the user chooses
// ---------------------------------------------------------------------------
test('live2d zip: an archive with two models asks which one', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openModelsTab(page, projectId);

  const zip = makeZip('pair', {
    'modelA/a.model3.json': manifestOf({ Moc: 'a.moc3', Textures: ['a.png'] }),
    'modelA/a.moc3': 'moc',
    'modelA/a.png': 'png',
    'modelB/b.model3.json': manifestOf({ Moc: 'b.moc3', Textures: ['b.png'] }),
    'modelB/b.moc3': 'moc',
    'modelB/b.png': 'png',
  });
  await zipInput(page).setInputFiles(zip);

  const picker = page.locator('.vs-live2d-picker');
  await expect(picker).toBeVisible({ timeout: 20_000 });
  await expect(picker).toContainText('modelA/a.model3.json');
  await expect(picker).toContainText('modelB/b.model3.json');

  await picker.getByText('modelB/b.model3.json').click();

  // Only the chosen model is registered — the other is not stored alongside it.
  await expect
    .poll(
      async () =>
        (await listAssets(request, projectId)).map((a) => a.original_name),
      { timeout: 20_000 }
    )
    .toEqual(['b.model3.json']);
  await expect(page.locator('.vs-live2d-report')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Test 3: the incremental completion round-trip
// ---------------------------------------------------------------------------
test('live2d zip: supplying the missing texture completes the bundle', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openModelsTab(page, projectId);

  // The manifest wants a texture the archive never contained.
  const zip = makeZip('incomplete', {
    'Model/model.model3.json': manifestOf({
      Moc: 'model.moc3',
      Textures: ['model.2048/texture_00.png'],
    }),
    'Model/model.moc3': 'moc',
  });
  await zipInput(page).setInputFiles(zip);

  const report = page.locator('.vs-live2d-report');
  await expect(report).toBeVisible({ timeout: 20_000 });
  await expect(report.locator('.vs-live2d-report-required')).toContainText(
    'model.2048/texture_00.png'
  );
  // Refused: nothing stored.
  expect(await listAssets(request, projectId)).toEqual([]);

  // The retry is blocked until the required file arrives.
  await expect(report.locator('.vs-live2d-retry')).toBeDisabled();

  // Supply the bare file — no folder structure rebuilt by hand.
  await report
    .locator('.vs-live2d-supply-input')
    .setInputFiles(makeFile('texture_00.png', 'png'));
  await expect(report.locator('.vs-live2d-retry')).toBeEnabled();

  await report.locator('.vs-live2d-retry').click();

  // The bundle completes without re-picking the files already chosen.
  await expect
    .poll(
      async () =>
        (await listAssets(request, projectId)).map((a) => a.original_name),
      { timeout: 20_000 }
    )
    .toEqual(['model.model3.json']);
  await expect(report).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Test 4: a zip that is not a model is not treated as one
// ---------------------------------------------------------------------------
test('live2d zip: an archive with no manifest is refused as a model', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openModelsTab(page, projectId);

  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    d.dismiss();
  });

  await zipInput(page).setInputFiles(
    makeZip('notamodel', { 'notes/readme.txt': 'hello' })
  );

  await expect.poll(() => dialogs.length, { timeout: 20_000 }).toBe(1);
  expect(dialogs[0]).toContain('model3.json');
  expect(await listAssets(request, projectId)).toEqual([]);
});
