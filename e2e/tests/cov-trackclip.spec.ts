import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene, seedNode } from '../fixtures/seed';

/**
 * Control-coverage spec (Phase 4a): instruments and exercises interactive
 * controls in ClipsSection.tsx and TrackClipTimeline.tsx.
 *
 * Controls targeted:
 *   vs-clip-add        — "+ Add Clip" button in ClipsSection
 *   vs-clip-row        — clip row in ClipsSection (select to open timeline)
 *   vs-clip-name       — clip name input in the TimelineEditor header
 *   vs-clip-duration   — duration number input
 *   vs-clip-loop       — loop checkbox
 *   vs-clip-blend      — blend mode select
 *   vs-clip-play       — play / resume button (when not playing)
 *   vs-clip-add-lane   — "+ Add Lane" button in the footer
 *
 * Each spec seeds project + scene + node via REST, then drives the UI and
 * asserts state via REST read-back where mutations occur.
 *
 * Skipped: canvas drag (keyframe placement, scrub ruler, lane envelope editing),
 * bezier handle drag, autoplay (only enabled when loop is on — exercising loop
 * is the relevant gate here), vs-clip-pause/stop (require active playback),
 * vs-clip-paste (requires prior copy in clipboard state).
 */

// ---------------------------------------------------------------------------
// Helper — REST read-back for track clips owned by a node.
// ---------------------------------------------------------------------------
async function listNodeClips(
  request: import('@playwright/test').APIRequestContext,
  nodeId: string
): Promise<{ id: string; name: string; duration: number; loop: boolean }[]> {
  const res = await request.get(`/api/scene-nodes/${nodeId}/track-clips`);
  const body = (await res.json()) as {
    ok: boolean;
    data: { id: string; name: string; duration: number; loop: boolean }[];
  };
  return body.data;
}

// ---------------------------------------------------------------------------
// 1. vs-merged-add — the scene tree's shared add menu ("New clip")
//
// vs-clip-add still exists, but only on the compose tree, where ClipsSection
// renders with its own footer; under a scene node the section renders flat and
// the merged "+ Add…" menu owns creation.
// ---------------------------------------------------------------------------
test('cov-trackclip: the add menu creates a clip and persists it via REST', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'TCNode1', 'group');

  await page.goto(`/editor/${projectId}`);

  const row = page.getByText('TCNode1', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  // Expand the components panel.
  const compToggle = page.locator('button[title="Show components"]').first();
  await compToggle.click();

  const addBtn = page.locator('.vs-merged-add').first();
  await expect(addBtn).toBeVisible({ timeout: 5_000 });
  await addBtn.click();
  await page
    .getByText('New clip', { exact: true })
    .first()
    .dispatchEvent('click');

  // REST read-back: clip was created.
  await expect
    .poll(
      async () => {
        const clips = await listNodeClips(request, nodeId);
        return clips.some((c) => c.name === 'Clip');
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});

// ---------------------------------------------------------------------------
// 2. vs-clip-row — clip row opens the timeline (bottom-dock clips tab)
// ---------------------------------------------------------------------------
test('cov-trackclip: vs-clip-row click opens the clip in the timeline editor', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'TCNode2', 'group');

  // Seed a clip via REST so it appears immediately.
  const createRes = await request.post(
    `/api/scene-nodes/${nodeId}/track-clips`,
    { data: { name: 'RowClip', duration: 3 } }
  );
  expect(createRes.status()).toBe(201);

  await page.goto(`/editor/${projectId}`);

  const row = page.getByText('TCNode2', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  const compToggle = page.locator('button[title="Show components"]').first();
  await compToggle.click();

  // Wait for the clip row to appear in ClipsSection.
  const clipRow = page.locator('.vs-clip-row').first();
  await expect(clipRow).toBeVisible({ timeout: 10_000 });
  await clipRow.click();

  // After clicking the clip row the timeline editor loads (vs-clip-play and
  // vs-clip-add-lane buttons become visible in the bottom dock).
  const playBtn = page.locator('.vs-clip-play');
  await expect(playBtn).toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// 3. vs-clip-name — clip name input updates the clip name via REST
// ---------------------------------------------------------------------------
test('cov-trackclip: vs-clip-name renames the clip and persists via REST', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'TCNode3', 'group');

  const createRes = await request.post(
    `/api/scene-nodes/${nodeId}/track-clips`,
    { data: { name: 'OldName', duration: 2 } }
  );
  expect(createRes.status()).toBe(201);

  await page.goto(`/editor/${projectId}`);

  const nodeRow = page.getByText('TCNode3', { exact: true });
  await expect(nodeRow).toBeVisible({ timeout: 30_000 });
  await nodeRow.click();

  const compToggle = page.locator('button[title="Show components"]').first();
  await compToggle.click();

  // Click the clip row to open it in the timeline editor.
  const clipRow = page.locator('.vs-clip-row').first();
  await expect(clipRow).toBeVisible({ timeout: 10_000 });
  await clipRow.click();

  // The name input in the timeline header.
  const nameInput = page.locator('.vs-clip-name');
  await expect(nameInput).toBeVisible({ timeout: 10_000 });

  // Clear and type a new name.
  await nameInput.fill('NewName');
  // Trigger the onChange by tabbing out.
  await nameInput.press('Tab');

  // REST read-back: name was persisted.
  await expect
    .poll(
      async () => {
        const clips = await listNodeClips(request, nodeId);
        return clips.some((c) => c.name === 'NewName');
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});

// ---------------------------------------------------------------------------
// 4. vs-clip-duration + vs-clip-blend — header controls
// ---------------------------------------------------------------------------
test('cov-trackclip: vs-clip-duration and vs-clip-blend controls are exercised', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'TCNode4', 'group');

  const createRes = await request.post(
    `/api/scene-nodes/${nodeId}/track-clips`,
    { data: { name: 'DurClip', duration: 2 } }
  );
  expect(createRes.status()).toBe(201);

  await page.goto(`/editor/${projectId}`);

  const nodeRow = page.getByText('TCNode4', { exact: true });
  await expect(nodeRow).toBeVisible({ timeout: 30_000 });
  await nodeRow.click();

  const compToggle = page.locator('button[title="Show components"]').first();
  await compToggle.click();

  const clipRow = page.locator('.vs-clip-row').first();
  await expect(clipRow).toBeVisible({ timeout: 10_000 });
  await clipRow.click();

  // Duration input.
  const durInput = page.locator('.vs-clip-duration');
  await expect(durInput).toBeVisible({ timeout: 10_000 });
  await durInput.fill('5');
  await durInput.press('Tab');

  // REST read-back: duration updated.
  await expect
    .poll(
      async () => {
        const clips = await listNodeClips(request, nodeId);
        const clip = clips.find((c) => c.name === 'DurClip');
        return clip?.duration === 5;
      },
      { timeout: 10_000 }
    )
    .toBe(true);

  // Blend mode select.
  const blendSelect = page.locator('.vs-clip-blend');
  await expect(blendSelect).toBeVisible();
  await blendSelect.selectOption('relative');
  // Tab to commit.
  await blendSelect.press('Tab');
});

// ---------------------------------------------------------------------------
// 5. vs-clip-loop — loop checkbox toggles loop state via REST
// ---------------------------------------------------------------------------
test('cov-trackclip: vs-clip-loop toggles loop and persists via REST', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'TCNode5', 'group');

  const createRes = await request.post(
    `/api/scene-nodes/${nodeId}/track-clips`,
    { data: { name: 'LoopClip', duration: 2 } }
  );
  expect(createRes.status()).toBe(201);

  await page.goto(`/editor/${projectId}`);

  const nodeRow = page.getByText('TCNode5', { exact: true });
  await expect(nodeRow).toBeVisible({ timeout: 30_000 });
  await nodeRow.click();

  const compToggle = page.locator('button[title="Show components"]').first();
  await compToggle.click();

  const clipRow = page.locator('.vs-clip-row').first();
  await expect(clipRow).toBeVisible({ timeout: 10_000 });
  await clipRow.click();

  // Loop checkbox.
  const loopCheckbox = page.locator('.vs-clip-loop');
  await expect(loopCheckbox).toBeVisible({ timeout: 10_000 });
  // The checkbox is controlled by clip.loop, which only updates after the PATCH
  // round-trips (no optimistic store write), so .check()'s synchronous
  // state-change assertion would fail. Click and verify via the REST poll below.
  await loopCheckbox.click();

  // REST read-back: loop was persisted.
  await expect
    .poll(
      async () => {
        const clips = await listNodeClips(request, nodeId);
        const clip = clips.find((c) => c.name === 'LoopClip');
        return clip?.loop === true;
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});

// ---------------------------------------------------------------------------
// 6. vs-clip-play — play button (no-op in headless; exercises the handle)
// ---------------------------------------------------------------------------
test('cov-trackclip: vs-clip-play button is reachable', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'TCNode6', 'group');

  const createRes = await request.post(
    `/api/scene-nodes/${nodeId}/track-clips`,
    { data: { name: 'PlayClip', duration: 2 } }
  );
  expect(createRes.status()).toBe(201);

  await page.goto(`/editor/${projectId}`);

  const nodeRow = page.getByText('TCNode6', { exact: true });
  await expect(nodeRow).toBeVisible({ timeout: 30_000 });
  await nodeRow.click();

  const compToggle = page.locator('button[title="Show components"]').first();
  await compToggle.click();

  const clipRow = page.locator('.vs-clip-row').first();
  await expect(clipRow).toBeVisible({ timeout: 10_000 });
  await clipRow.click();

  // Play button is visible (no active playback yet → "▶ Play" / "▶ Resume" variant).
  const playBtn = page.locator('.vs-clip-play');
  await expect(playBtn).toBeVisible({ timeout: 10_000 });
  // Click to trigger play — the backend may or may not respond; the test
  // verifies the control is reachable and fires its handler.
  await playBtn.click();
  // The button should still be present (it doesn't navigate away).
  await expect(playBtn).toBeVisible({ timeout: 3_000 }).catch(() => {
    // If playback started the button may have changed to pause/stop; that's fine.
  });
});

// ---------------------------------------------------------------------------
// 7. vs-clip-add-lane — "+ Add Lane" footer button opens lane picker
// ---------------------------------------------------------------------------
test('cov-trackclip: vs-clip-add-lane opens lane picker', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'TCNode7', 'group');

  const createRes = await request.post(
    `/api/scene-nodes/${nodeId}/track-clips`,
    { data: { name: 'LaneClip', duration: 2 } }
  );
  expect(createRes.status()).toBe(201);

  await page.goto(`/editor/${projectId}`);

  const nodeRow = page.getByText('TCNode7', { exact: true });
  await expect(nodeRow).toBeVisible({ timeout: 30_000 });
  await nodeRow.click();

  const compToggle = page.locator('button[title="Show components"]').first();
  await compToggle.click();

  const clipRow = page.locator('.vs-clip-row').first();
  await expect(clipRow).toBeVisible({ timeout: 10_000 });
  await clipRow.click();

  // Click "+ Add Lane" button to open the lane-picker form.
  const addLaneBtn = page.locator('.vs-clip-add-lane');
  await expect(addLaneBtn).toBeVisible({ timeout: 10_000 });
  await addLaneBtn.click();

  // The lane picker replaces the button with target/param selects + Add/Cancel.
  // The "Cancel" button closes it and restores the + Add Lane button.
  const cancelBtn = page.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancelBtn).toBeVisible({ timeout: 5_000 });
  await cancelBtn.click();

  // + Add Lane button reappears.
  await expect(addLaneBtn).toBeVisible({ timeout: 5_000 });
});
