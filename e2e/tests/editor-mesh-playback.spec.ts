import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene, seedNode } from '../fixtures/seed';

/**
 * Two-tab E2E: clip transport as a synced document.
 *
 * The property under test is the one the whole migration rests on — **sync the
 * inputs, derive the outputs**. Nothing ships an evaluated playhead any more:
 * each tab holds the clip and its `clip_playback` document and computes the
 * same number for itself. So the assertions are about the INPUTS arriving
 * (state and anchor) rather than about frames, which is what makes them stable
 * without freezing a clock.
 *
 * Two tabs because a one-tab test cannot distinguish a document that replicated
 * from one that merely updated locally — the same blind spot that let rotation
 * previews ship broken.
 *
 * These are also the regression net for deleting `shared_node_transform`: if
 * subscribers stop receiving the inputs they need to evaluate, playback stops
 * agreeing across tabs and these fail.
 */

async function seedClip(
  request: APIRequestContext,
  nodeId: string,
  name: string
): Promise<string> {
  const res = await request.post(`/api/scene-nodes/${nodeId}/track-clips`, {
    data: { name, duration: 30 },
  });
  return (await res.json()).data.id as string;
}

/** Open the editor, select the node, and open its clip in the timeline editor.
 *  The clips list sits behind the components toggle. */
async function openWithClip(
  page: Page,
  projectId: string,
  nodeName: string
): Promise<void> {
  await page.goto(`/editor/${projectId}`);
  const row = page.getByText(nodeName, { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  await page.locator('button[title="Show components"]').first().click();

  const clipRow = page.locator('.vs-clip-row').first();
  await expect(clipRow).toBeVisible({ timeout: 15_000 });
  await clipRow.click();
  await expect(page.locator('.vs-clip-play, .vs-clip-pause')).not.toHaveCount(
    0,
    { timeout: 15_000 }
  );
}

const playBtn = (p: Page) => p.locator('.vs-clip-play');
const pauseBtn = (p: Page) => p.locator('.vs-clip-pause');
const stopBtn = (p: Page) => p.locator('.vs-clip-stop');

test('playback: pressing play in one tab reaches the other', async ({
  browser,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'ClipNode', 'group');
  await seedClip(request, nodeId, 'TransportClip');

  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await openWithClip(tabA, projectId, 'ClipNode');
  await openWithClip(tabB, projectId, 'ClipNode');

  // Both tabs start with the clip stopped, so both show Play.
  await expect(playBtn(tabA)).toBeVisible();
  await expect(playBtn(tabB)).toBeVisible();

  await playBtn(tabA).click();

  // The other tab swaps to the playing transport — it learned the state from
  // the document, not from a broadcast frame.
  await expect(pauseBtn(tabB)).toBeVisible({ timeout: 15_000 });
  await expect(stopBtn(tabB)).toBeVisible();

  await context.close();
});

test('playback: pause and stop propagate the same way', async ({
  browser,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'PauseNode', 'group');
  await seedClip(request, nodeId, 'PauseClip');

  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await openWithClip(tabA, projectId, 'PauseNode');
  await openWithClip(tabB, projectId, 'PauseNode');

  await playBtn(tabA).click();
  await expect(pauseBtn(tabB)).toBeVisible({ timeout: 15_000 });

  // Pausing in the SECOND tab drives the first: the document has no owner.
  await pauseBtn(tabB).click();
  await expect(playBtn(tabA)).toBeVisible({ timeout: 15_000 }); // reads "Resume"

  await stopBtn(tabA).click();
  await expect(pauseBtn(tabB)).toBeHidden({ timeout: 15_000 });

  await context.close();
});

test('playback: transport is not undoable', async ({ browser, request }) => {
  // Decided: transport is a view action, not a document edit. Pressing Play
  // must not put anything on the undo stack, or Ctrl+Z after it un-pauses
  // instead of undoing the user's last real edit.
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'UndoClipNode', 'group');
  await seedClip(request, nodeId, 'UndoClip');

  const context = await browser.newContext();
  const tab = await context.newPage();
  await openWithClip(tab, projectId, 'UndoClipNode');

  const undo = tab.locator('.vs-topbar-undo');
  await expect(undo).toBeDisabled();

  await playBtn(tab).click();
  await expect(pauseBtn(tab)).toBeVisible({ timeout: 15_000 });
  await pauseBtn(tab).click();
  await expect(playBtn(tab)).toBeVisible({ timeout: 15_000 });

  // Three committed transport writes later, still nothing to undo.
  await expect(undo).toBeDisabled();

  await context.close();
});

test('playback: an outside service driving REST moves both tabs', async ({
  browser,
  request,
}) => {
  // /api stays a public surface. The endpoints no longer drive a private
  // playhead — they write the same document the UI does — so an integration
  // calling them is indistinguishable from a click.
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'RestNode', 'group');
  const clipId = await seedClip(request, nodeId, 'RestClip');

  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await openWithClip(tabA, projectId, 'RestNode');
  await openWithClip(tabB, projectId, 'RestNode');

  const trigger = await request.post(`/api/track-clips/${clipId}/trigger`);
  expect(trigger.ok()).toBe(true);

  await expect(pauseBtn(tabA)).toBeVisible({ timeout: 15_000 });
  await expect(pauseBtn(tabB)).toBeVisible({ timeout: 15_000 });

  const stopped = await request.post(`/api/track-clips/${clipId}/stop`);
  expect(stopped.ok()).toBe(true);
  await expect(playBtn(tabA)).toBeVisible({ timeout: 15_000 });

  await context.close();
});

test('playback: the anchor persists, so a reload resumes in phase', async ({
  browser,
  request,
}) => {
  // The reason the collection is persisted rather than replicate-only: an
  // unattended scene comes back mid-loop rather than silent.
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'ReloadNode', 'group');
  await seedClip(request, nodeId, 'ReloadClip');

  const context = await browser.newContext();
  const tab = await context.newPage();
  await openWithClip(tab, projectId, 'ReloadNode');

  await playBtn(tab).click();
  await expect(pauseBtn(tab)).toBeVisible({ timeout: 15_000 });

  await tab.reload();
  await openWithClip(tab, projectId, 'ReloadNode');
  // Still playing after a fresh load — the anchor came from the document, not
  // from anything held in the page.
  await expect(pauseBtn(tab)).toBeVisible({ timeout: 20_000 });

  await context.close();
});
