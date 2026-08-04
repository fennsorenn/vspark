import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene, seedNode } from '../fixtures/seed';

/**
 * Editor-flow E2E: behaviors and camera effects.
 *
 * 1. Behavior — seed a node, open the behaviors panel via the ⚙ toggle,
 *    click "+ Add Behavior" → pick "Breathing", then assert via REST GET
 *    /api/scene-nodes/:nodeId/behaviors.
 *
 * 2. Camera effects — seed a camera node, open the behaviors panel, click
 *    "+ Add Effect" → pick "Bloom", then assert via REST GET
 *    /api/scene-nodes/:nodeId/effects.
 *
 * 3. Stylized Tracking — same add flow, then drive the behavior's own properties
 *    panel (amount / follow-through / rest-unmapped / a response knob / a rig
 *    bone override) and assert each write landed in behaviors.config via REST.
 *
 * Note: the add-menu opens upward (CSS bottom:100%) inside the scene graph
 * panel.  When the panel is short the menu items may extend above the visible
 * viewport; dispatchEvent('click') is used in those cases because it fires the
 * React onClick without enforcing viewport containment.
 */

// ---------------------------------------------------------------------------
// 1. Behavior: adding "Breathing" to an avatar node
// ---------------------------------------------------------------------------
test('behaviors: adding Breathing to a node persists via REST', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'MyAvatar', 'avatar');

  await page.goto(`/editor/${projectId}`);

  // Wait for the editor to load — seeded node visible in scene graph.
  const row = page.getByText('MyAvatar', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });

  // Click the ⚙ (Show components) toggle to open the inline behaviors panel.
  const compToggle = page.locator('button[title="Show components"]').first();
  await compToggle.click();

  // Wait for the behaviors section to appear (the "+ Add Behavior" button).
  const addBehaviorBtn = page.getByRole('button', {
    name: '+ Add Behavior',
    exact: true,
  });
  await expect(addBehaviorBtn).toBeVisible({ timeout: 5_000 });
  await addBehaviorBtn.click();

  // The add-menu opens listing behavior kinds. "Breathing" is in the list.
  // The menu may render outside the viewport (opens upward); use dispatchEvent
  // to fire the React onClick without viewport containment enforcement.
  const breathingItem = page.getByText('Breathing', { exact: true }).first();
  await expect(breathingItem).toBeVisible({ timeout: 5_000 });
  await breathingItem.dispatchEvent('click');

  // REST read-back: the behavior was persisted to the backend.
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/scene-nodes/${nodeId}/behaviors`);
        const body = (await res.json()) as {
          ok: boolean;
          data: { kind: string }[];
        };
        return body.data.some((b) => b.kind === 'breathing');
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});

// ---------------------------------------------------------------------------
// 2. Camera effect: adding "Bloom" to a camera node
// ---------------------------------------------------------------------------
test('effects: adding Bloom to a camera node persists via REST', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const cameraNodeId = await seedNode(request, sceneId, 'MainCamera', 'camera');

  await page.goto(`/editor/${projectId}`);

  // Wait for editor to load — seeded camera node appears.
  const row = page.getByText('MainCamera', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });

  // Open the inline behaviors / effects panel via the ⚙ toggle.
  const compToggle = page.locator('button[title="Show components"]').first();
  await compToggle.click();

  // The camera effects section's "+ Add Effect" button is now visible.
  const addEffectBtn = page.getByRole('button', {
    name: '+ Add Effect',
    exact: true,
  });
  await expect(addEffectBtn).toBeVisible({ timeout: 5_000 });
  await addEffectBtn.click();

  // "Bloom" appears in the dropdown. May be above the viewport; use
  // dispatchEvent to bypass viewport containment.
  const bloomItem = page.getByText('Bloom', { exact: true }).first();
  await expect(bloomItem).toBeVisible({ timeout: 5_000 });
  await bloomItem.dispatchEvent('click');

  // REST read-back: the effect was persisted.
  await expect
    .poll(
      async () => {
        const res = await request.get(
          `/api/scene-nodes/${cameraNodeId}/effects`
        );
        const body = (await res.json()) as {
          ok: boolean;
          data: { kind: string }[];
        };
        return body.data.some((e) => e.kind === 'fx_bloom');
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});

// ---------------------------------------------------------------------------
// 3. Stylized Tracking: add it, then edit its panel and read the config back
// ---------------------------------------------------------------------------
test('behaviors: Stylized Tracking panel edits persist via REST', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'StyleAvatar', 'avatar');

  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('StyleAvatar', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  await page.locator('button[title="Show components"]').first().click();
  const addBehaviorBtn = page.getByRole('button', {
    name: '+ Add Behavior',
    exact: true,
  });
  await expect(addBehaviorBtn).toBeVisible({ timeout: 5_000 });
  await addBehaviorBtn.click();

  const item = page.getByText('Stylized Tracking', { exact: true }).first();
  await expect(item).toBeVisible({ timeout: 5_000 });
  await item.dispatchEvent('click');

  // Helper: read the stylizer's stored config back over REST.
  // This route serves raw DB rows, so `config` arrives as a JSON *string* — the
  // frontend's mapBehavior() normalizes the same way.
  const readConfig = async (): Promise<Record<string, unknown>> => {
    const res = await request.get(`/api/scene-nodes/${nodeId}/behaviors`);
    const body = (await res.json()) as {
      data: { kind: string; config: string | Record<string, unknown> }[];
    };
    const raw = body.data.find((b) => b.kind === 'pose_stylizer')?.config;
    if (raw == null) return {};
    return typeof raw === 'string'
      ? (JSON.parse(raw) as Record<string, unknown>)
      : raw;
  };

  await expect
    .poll(async () => Object.keys(await readConfig()).length > 0, {
      timeout: 10_000,
    })
    .toBe(true);

  // Selecting the behavior row opens its properties panel.
  await page.getByText('Stylized Tracking', { exact: true }).first().click();
  await expect(
    page.locator('.vs-stylize-amount input[type="range"]')
  ).toBeVisible({ timeout: 10_000 });

  // --- Amount: the headline accurate ←→ stylized dial ---------------------
  // SliderInput's numeric field only exists after a double-click on the readout;
  // the range input underneath is the primary control, so drive that with the
  // keyboard (each key-up commits). Starts at 1, step 0.05 → 4 lefts = 0.8.
  const amount = page.locator('.vs-stylize-amount input[type="range"]');
  await amount.focus();
  for (let i = 0; i < 4; i++) await amount.press('ArrowLeft');
  await expect
    .poll(async () => (await readConfig()).amount, { timeout: 10_000 })
    .toBeCloseTo(0.8, 5);

  // --- Follow-through ------------------------------------------------------
  const lag = page.locator('.vs-stylize-lag input').first();
  await lag.fill('0.25');
  await lag.press('Enter');
  await expect
    .poll(async () => (await readConfig()).lag, { timeout: 10_000 })
    .toBe(0.25);

  // --- Rest-unmapped toggle (controlled by server state → click, then poll) --
  await page.locator('.vs-stylize-rest-unmapped').first().click();
  await expect
    .poll(async () => (await readConfig()).restUnmapped, { timeout: 10_000 })
    .toBe(true);

  // --- A response knob (inside the collapsed "Response" section) ------------
  await page.getByText('Response', { exact: true }).first().click();
  const maxRate = page.locator('.vs-stylize-response-maxRate input').first();
  await expect(maxRate).toBeVisible({ timeout: 5_000 });
  await maxRate.fill('2');
  await maxRate.press('Enter');
  await expect
    .poll(
      async () =>
        ((await readConfig()).response as Record<string, unknown>)?.maxRate,
      { timeout: 10_000 }
    )
    .toBe(2);

  // --- A rig bone override --------------------------------------------------
  await page.getByText('Response rig', { exact: false }).first().click();
  await page.locator('.vs-stylize-bone-head').click();
  // VecInput renders three NumInputs (text fields) — X / Y / Z; Y is the yaw column.
  const headYaw = page.locator('.vs-stylize-drv-head-headYaw input').nth(1);
  await expect(headYaw).toBeVisible({ timeout: 5_000 });
  await headYaw.fill('35');
  await headYaw.press('Enter');
  await expect
    .poll(
      async () => {
        const rig = (await readConfig()).rig as Record<
          string,
          { drivers?: Record<string, number[]> }
        > | null;
        return rig?.head?.drivers?.headYaw?.[1];
      },
      { timeout: 10_000 }
    )
    .toBe(35);
});
