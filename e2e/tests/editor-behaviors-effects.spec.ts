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
