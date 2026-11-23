import { test, expect } from '../fixtures/controlCoverage';
import type { APIRequestContext, Page } from '@playwright/test';
import { seedProjectScene, seedNode } from '../fixtures/seed';

/**
 * Control-coverage spec: the Lipsync behavior's audio input (PropertiesPanel.tsx
 * → lipsync section).
 *
 * The behavior is seeded via REST and selected in the scene graph so the panel
 * renders. Both controls persist through the behavior PUT, so every assertion
 * on stored state is a REST read-back poll.
 *
 * Controls targeted:
 *   vs-lipsync-input-mode       — browser / pipewire select (config.inputMode)
 *   vs-lipsync-pipewire-source  — source name, saved on blur (config.pipewireSource)
 *
 * The source used here does not exist, so the test backend's `parec` (or its
 * absence) only logs and retries; nothing is asserted about capture itself.
 */

type LipsyncConfig = { inputMode?: string; pipewireSource?: string };

/** REST read-back of the lipsync behavior's config. The list route returns raw
 *  `behaviors` rows, so `config` may arrive as a JSON string. */
async function readConfig(
  request: APIRequestContext,
  nodeId: string
): Promise<LipsyncConfig> {
  const res = await request.get(`/api/scene-nodes/${nodeId}/behaviors`);
  const body = (await res.json()) as {
    data: { kind: string; config: string | LipsyncConfig }[];
  };
  const beh = body.data.find((b) => b.kind === 'lipsync_processor');
  if (!beh) return {};
  return (
    typeof beh.config === 'string' ? JSON.parse(beh.config) : beh.config
  ) as LipsyncConfig;
}

/** Seed a project + avatar + Lipsync behavior, open its panel. */
async function openPanel(page: Page, request: APIRequestContext) {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'SpeakingAvatar', 'avatar');
  const created = await request.post(`/api/scene-nodes/${nodeId}/behaviors`, {
    data: { kind: 'lipsync_processor' },
  });
  expect(created.ok()).toBe(true);

  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('SpeakingAvatar', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.locator('button[title="Show components"]').first().click();
  const row = page.getByText('Lipsync', { exact: true }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();

  await expect(page.locator('.vs-lipsync-input-mode')).toBeVisible({
    timeout: 10_000,
  });
  return { nodeId };
}

test('lipsync input: browser by default, PipeWire mode and source persist', async ({
  page,
  request,
}) => {
  const { nodeId } = await openPanel(page, request);
  const mediaInput = page.getByRole('button', { name: /Open Media Input/ });
  const source = page.locator('.vs-lipsync-pipewire-source');

  // Browser input: the media-input window button, no source field.
  await expect(page.locator('.vs-lipsync-input-mode')).toHaveValue('browser');
  await expect(mediaInput).toBeVisible();
  await expect(source).toHaveCount(0);

  await page.locator('.vs-lipsync-input-mode').selectOption('pipewire');
  await expect
    .poll(async () => (await readConfig(request, nodeId)).inputMode, {
      timeout: 10_000,
    })
    .toBe('pipewire');
  await expect(source).toBeVisible();
  await expect(mediaInput).toHaveCount(0);

  // Saved on blur, trimmed.
  await source.fill('  e2e_sink.monitor ');
  await source.blur();
  await expect
    .poll(async () => (await readConfig(request, nodeId)).pipewireSource, {
      timeout: 10_000,
    })
    .toBe('e2e_sink.monitor');

  // Back to the browser: the source is kept for next time, the field hides.
  await page.locator('.vs-lipsync-input-mode').selectOption('browser');
  await expect
    .poll(async () => (await readConfig(request, nodeId)).inputMode, {
      timeout: 10_000,
    })
    .toBe('browser');
  await expect(source).toHaveCount(0);
  expect((await readConfig(request, nodeId)).pipewireSource).toBe(
    'e2e_sink.monitor'
  );
});
