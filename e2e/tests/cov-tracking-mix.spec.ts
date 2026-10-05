import { test, expect } from '../fixtures/controlCoverage';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { listNodes, seedProjectScene, seedNode } from '../fixtures/seed';

/**
 * Control-coverage spec: the Tracking Mix (TrackingMix.tsx) — the avatar's
 * sidebar block and the mixer modal.
 *
 * An avatar is seeded with a Breathing behavior (a bone source that needs no
 * network or device, unlike the receivers). Every edit persists as the avatar's
 * `properties.trackingMix`, so each assertion is a REST read-back poll.
 *
 * Controls targeted:
 *   vs-mix-master         — sidebar per-source slider (persists every bone)
 *   vs-mix-master-reset   — sidebar "Custom" reset (persists)
 *   vs-mix-open           — opens the mixer
 *   vs-mix-group-cell     — region slider in the Body tab (persists)
 *   vs-mix-expand         — expands a region to its bones
 *   vs-mix-member-cell    — single-bone slider (persists)
 *   vs-mix-group-reset    — region "Custom" reset (persists)
 *   vs-mix-tab-face / vs-mix-tab-body — tab switch
 *   vs-mix-close          — closes the mixer
 *
 * Not targeted: vs-mix-order-up/-down need two bone sources (a second one would
 * be a network receiver) — covered by the jsdom test in
 * packages/frontend/test/components.trackingMix.test.tsx; vs-mix-backdrop is the
 * same close path as vs-mix-close.
 */

type Mix = {
  order?: string[];
  sources?: Record<string, { bones?: Record<string, number> }>;
};

async function readMix(
  request: APIRequestContext,
  sceneId: string,
  nodeId: string
): Promise<Mix> {
  const nodes = (await listNodes(request, sceneId)) as unknown as {
    id: string;
    properties?: string | Record<string, unknown>;
  }[];
  const node = nodes.find((n) => n.id === nodeId);
  const props =
    typeof node?.properties === 'string'
      ? (JSON.parse(node.properties) as Record<string, unknown>)
      : (node?.properties ?? {});
  return (props.trackingMix as Mix | undefined) ?? {};
}

/** Type a value into a SliderInput via its click-to-edit readout. */
async function setSlider(slider: Locator, value: string) {
  await slider.getByText(/^\d+\.\d+$/).dblclick();
  const editor = slider.locator('input[type="text"]');
  await expect(editor).toBeVisible({ timeout: 5_000 });
  await editor.fill(value);
  await editor.press('Enter');
}

async function openAvatar(page: Page, request: APIRequestContext) {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'MixAvatar', 'avatar');
  const created = await request.post(`/api/scene-nodes/${nodeId}/behaviors`, {
    data: { kind: 'breathing' },
  });
  expect(created.ok()).toBe(true);
  const behaviorId = ((await created.json()) as { data: { id: string } }).data
    .id;

  await page.goto(`/editor/${projectId}`);
  const row = page.getByText('MixAvatar', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.locator('.vs-mix-master').first()).toBeVisible({
    timeout: 10_000,
  });
  return { sceneId, nodeId, behaviorId };
}

test('cov-tracking-mix: sidebar master slider and reset persist', async ({
  page,
  request,
}) => {
  const { sceneId, nodeId, behaviorId } = await openAvatar(page, request);

  // Masters: [Animation, Breathing].
  await setSlider(page.locator('.vs-mix-master').nth(1), '0.5');
  await expect
    .poll(
      async () =>
        (await readMix(request, sceneId, nodeId)).sources?.[behaviorId]?.bones
          ?.head,
      { timeout: 10_000 }
    )
    .toBe(0.5);

  // Open the mixer, nudge one bone → the Breathing master turns Custom.
  await page.locator('.vs-mix-open').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('.vs-mix-expand').first().click(); // Head
  // Head bones × [Animation, Breathing]; row 2 = head, column 2 = Breathing.
  await setSlider(dialog.locator('.vs-mix-member-cell').nth(3), '1.5');
  await expect
    .poll(
      async () =>
        (await readMix(request, sceneId, nodeId)).sources?.[behaviorId]?.bones
          ?.head,
      { timeout: 10_000 }
    )
    .toBe(1.5);
  await dialog.locator('.vs-mix-close').click();
  await expect(dialog).toBeHidden();

  // Sidebar reset → most common value (0.5) everywhere.
  await page.locator('.vs-mix-master-reset').click();
  await expect
    .poll(
      async () =>
        (await readMix(request, sceneId, nodeId)).sources?.[behaviorId]?.bones
          ?.head,
      { timeout: 10_000 }
    )
    .toBe(0.5);
});

test('cov-tracking-mix: region cell, region reset and tabs in the mixer', async ({
  page,
  request,
}) => {
  const { sceneId, nodeId } = await openAvatar(page, request);
  await page.locator('.vs-mix-open').click();
  const dialog = page.getByRole('dialog');

  // Region cells: Head × [Animation, Breathing], Gaze × …; Legs is last.
  const legsAnim = dialog.locator('.vs-mix-group-cell').nth(10);
  await setSlider(legsAnim, '0');
  await expect
    .poll(
      async () =>
        (await readMix(request, sceneId, nodeId)).sources?.animation?.bones
          ?.hips,
      { timeout: 10_000 }
    )
    .toBe(0);

  // One leg bone back to 1 → Legs × Animation shows Custom; reset → 0.
  await dialog.locator('.vs-mix-expand').last().click();
  await setSlider(dialog.locator('.vs-mix-member-cell').first(), '1');
  const reset = dialog.locator('.vs-mix-group-reset');
  await expect(reset).toBeVisible();
  await reset.click();
  await expect
    .poll(
      async () =>
        (await readMix(request, sceneId, nodeId)).sources?.animation?.bones
          ?.hips,
      { timeout: 10_000 }
    )
    .toBe(0);

  await dialog.locator('.vs-mix-tab-face').click();
  await expect(dialog.locator('.vs-mix-group-cell')).toHaveCount(0);
  await dialog.locator('.vs-mix-tab-body').click();
  await expect(dialog.locator('.vs-mix-group-cell').first()).toBeVisible();
});
