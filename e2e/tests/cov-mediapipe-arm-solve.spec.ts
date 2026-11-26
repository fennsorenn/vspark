import { test, expect } from '../fixtures/controlCoverage';
import type { APIRequestContext } from '@playwright/test';
import { seedProjectScene, seedNode } from '../fixtures/seed';

/**
 * Control-coverage spec: the "Arm solve (experimental)" switches in the MediaPipe Tracking
 * behavior panel (PropertiesPanel.tsx → ArmSolveSwitches).
 *
 * The behavior is seeded via REST and selected in the scene graph so the panel renders. Every
 * switch persists to `config.armSolve.<field>` through the behavior PUT, so each assertion is a
 * REST read-back poll — controlled inputs are driven with .click(), never .check().
 *
 * Controls targeted:
 *   vs-mp-arm-mode            — hinge / legacy select (persists armSolve.mode)
 *   vs-mp-arm-<field>         — one checkbox per technique (persists armSolve.<field>)
 *
 * In legacy mode the hinge-only switch (planeWristGate) is disabled.
 */

const SWITCHES = [
  'keepLowVis',
  'planeWristGate',
  'handSwingOnly',
  'swingFade',
  'edgeOnConf',
  'poseDorsalConf',
  'smoothing',
  'jumpHold',
] as const;

type ArmSolve = Partial<Record<(typeof SWITCHES)[number], boolean>> & {
  mode?: string;
};

/** REST read-back of the behavior's `armSolve` config. The list route returns raw `behaviors`
 *  rows, so `config` may arrive as a JSON string. */
async function readArmSolve(
  request: APIRequestContext,
  nodeId: string
): Promise<ArmSolve> {
  const res = await request.get(`/api/scene-nodes/${nodeId}/behaviors`);
  const body = (await res.json()) as {
    data: { kind: string; config: string | { armSolve?: ArmSolve } }[];
  };
  const beh = body.data.find((b) => b.kind === 'mediapipe_tracker');
  if (!beh) return {};
  const cfg = (
    typeof beh.config === 'string' ? JSON.parse(beh.config) : beh.config
  ) as { armSolve?: ArmSolve };
  return cfg.armSolve ?? {};
}

/** Seed a project + avatar + MediaPipe Tracking behavior, open its panel. */
async function openPanel(
  page: import('@playwright/test').Page,
  request: APIRequestContext
) {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'TrackedAvatar', 'avatar');
  const created = await request.post(`/api/scene-nodes/${nodeId}/behaviors`, {
    data: { kind: 'mediapipe_tracker' },
  });
  expect(created.ok()).toBe(true);

  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('TrackedAvatar', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.locator('button[title="Show components"]').first().click();
  const row = page.getByText('MediaPipe Tracking', { exact: true }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();

  await expect(page.locator('.vs-mp-arm-mode')).toBeVisible({
    timeout: 10_000,
  });
  return { nodeId };
}

test('mediapipe arm solve: every technique switch persists', async ({
  page,
  request,
}) => {
  const { nodeId } = await openPanel(page, request);

  // All switches default to on.
  for (const field of SWITCHES)
    await expect(page.locator(`.vs-mp-arm-${field}`)).toBeChecked();

  for (const field of SWITCHES) {
    await page.locator(`.vs-mp-arm-${field}`).click();
    await expect
      .poll(async () => (await readArmSolve(request, nodeId))[field], {
        timeout: 10_000,
      })
      .toBe(false);
  }
});

test('mediapipe arm solve: legacy mode persists and disables hinge-only switches', async ({
  page,
  request,
}) => {
  const { nodeId } = await openPanel(page, request);

  await page.locator('.vs-mp-arm-mode').selectOption('legacy');
  await expect
    .poll(async () => (await readArmSolve(request, nodeId)).mode, {
      timeout: 10_000,
    })
    .toBe('legacy');
  await expect(page.locator('.vs-mp-arm-planeWristGate')).toBeDisabled();
  await expect(page.locator('.vs-mp-arm-jumpHold')).toBeEnabled();
});
