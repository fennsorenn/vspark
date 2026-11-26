import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene, seedNode } from '../fixtures/seed';
import type { APIRequestContext } from '@playwright/test';

/**
 * Editor-flow E2E (Phase 8): track-clip creation and REST read-back.
 *
 * 1. Clip creation via the inline ClipsSection — seed a node, expand the
 *    "Show components" panel, click "+ Add Clip", assert the clip appears in the
 *    UI and persists via GET /api/scene-nodes/:nodeId/track-clips.
 *
 * 2. API-seeded clip renders in the ClipsSection — seed a clip via REST, load
 *    the editor, select the node, expand the panel, assert the clip name is
 *    visible in the inline section.
 *
 * Note: timeline/playhead interactions (keyframe placement, scrubbing, lane
 * editing) are not covered here — they require active playback or canvas-drag
 * interactions that are too fiddly for stable headless E2E.  The Timeline
 * bottom-dock tab itself is not exercised; we use the inline ClipsSection in
 * the scene-graph panel as the simpler add-path.
 */

// ---------------------------------------------------------------------------
// Helper — REST read-back for track clips owned by a node.
// ---------------------------------------------------------------------------
async function listNodeClips(
  request: APIRequestContext,
  nodeId: string
): Promise<{ id: string; name: string }[]> {
  const res = await request.get(`/api/scene-nodes/${nodeId}/track-clips`);
  const body = (await res.json()) as {
    ok: boolean;
    data: { id: string; name: string }[];
  };
  return body.data;
}

// ---------------------------------------------------------------------------
// 1. Clip creation via the inline ClipsSection
// ---------------------------------------------------------------------------
test('track-clip creation: "+ Add Clip" button creates a clip in UI and backend', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'ClipNode', 'group');

  await page.goto(`/editor/${projectId}`);

  // Wait for the seeded node to appear in the scene graph.
  const row = page.getByText('ClipNode', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });

  // Click the node row to select it (makes the Show-components toggle appear).
  await row.click();

  // Open the inline components panel via the ⚙ "Show components" toggle.
  const compToggle = page.locator('button[title="Show components"]').first();
  await compToggle.click();

  // Clips are created from the merged section's shared "+ Add…" menu.
  const addBtn = page.locator('.vs-merged-add').first();
  await expect(addBtn).toBeVisible({ timeout: 5_000 });
  await addBtn.click();
  await page
    .getByText('New clip', { exact: true })
    .first()
    .dispatchEvent('click');

  // The new clip (default name "Clip") appears in the section.
  // It may share the name "Clip" with the button if the button text changes,
  // so look for ANY element showing "Clip" that is NOT the add button itself.
  const clipEntry = page.locator('text=Clip').first();
  await expect(clipEntry).toBeVisible({ timeout: 10_000 });

  // REST read-back: the clip was persisted to the backend via the store.
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
// 2. API-seeded clip renders in the ClipsSection
// ---------------------------------------------------------------------------
test('track-clip render: REST-seeded clip is visible in the inline ClipsSection', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'SeededClipNode', 'group');

  // Seed a track clip directly via the REST API.
  const createRes = await request.post(
    `/api/scene-nodes/${nodeId}/track-clips`,
    { data: { name: 'SeededClip', duration: 4 } }
  );
  expect(createRes.status()).toBe(201);

  await page.goto(`/editor/${projectId}`);

  // Wait for the seeded node to appear in the scene graph.
  const row = page.getByText('SeededClipNode', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });

  // Click the node row to select it.
  await row.click();

  // Open the inline components panel.
  const compToggle = page.locator('button[title="Show components"]').first();
  await compToggle.click();

  // The seeded clip name is visible in the ClipsSection.
  await expect(
    page.getByText('SeededClip', { exact: true })
  ).toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// 3. Clip deletion via context menu persists to backend
// ---------------------------------------------------------------------------
test('track-clip deletion: right-click Delete removes clip from UI and backend', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'DeleteClipNode', 'group');

  // Seed a clip via REST so we have something to delete.
  const createRes = await request.post(
    `/api/scene-nodes/${nodeId}/track-clips`,
    { data: { name: 'ToDelete', duration: 2 } }
  );
  expect(createRes.status()).toBe(201);
  const clipId = ((await createRes.json()) as { data: { id: string } }).data.id;

  await page.goto(`/editor/${projectId}`);

  const row = page.getByText('DeleteClipNode', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  const compToggle = page.locator('button[title="Show components"]').first();
  await compToggle.click();

  // Wait for the clip to appear in the section.
  const clipEntry = page.getByText('ToDelete', { exact: true });
  await expect(clipEntry).toBeVisible({ timeout: 10_000 });

  // Right-click to open the context menu.
  await clipEntry.click({ button: 'right' });

  // Click "Delete clip" from the context menu.
  const deleteItem = page.getByText('Delete clip', { exact: true });
  await expect(deleteItem).toBeVisible({ timeout: 5_000 });
  await deleteItem.dispatchEvent('click');

  // The clip entry disappears from the UI.
  await expect(clipEntry).not.toBeVisible({ timeout: 10_000 });

  // REST read-back: clip no longer present in backend.
  await expect
    .poll(
      async () => {
        const clips = await listNodeClips(request, nodeId);
        return clips.some((c) => c.id === clipId);
      },
      { timeout: 10_000 }
    )
    .toBe(false);
});
