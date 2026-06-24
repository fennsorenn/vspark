import { test, expect } from '../fixtures/controlCoverage';
import type { APIRequestContext } from '@playwright/test';
import { seedProjectScene, seedNode, listNodes } from '../fixtures/seed';

/**
 * Control-coverage spec (Phase 4a): instruments and exercises the common +
 * kind-specific controls in PropertiesPanel.tsx (the editor's largest control
 * surface). Each control carries a `vs-` targeting handle; this spec selects a
 * seeded node, drives the control, and — where the change persists — asserts
 * via a REST read-back poll against the scene-nodes API.
 *
 * Controls targeted:
 *   vs-node-name              — node name text input (rename, persists)
 *   vs-transform-position     — position VecInput (X/Y/Z, persists components.transform)
 *   vs-transform-rotation     — rotation VecInput (degrees → radians, persists)
 *   vs-transform-scale        — scale VecInput (persists)
 *   vs-transform-opacity      — opacity SliderInput (persists)
 *   vs-transform-cast-shadow  — cast-shadow checkbox (persists)
 *   vs-transform-receive-shadow — receive-shadow checkbox (persists)
 *   vs-light-type             — light type select (persists components.light)
 *   vs-light-color            — light color input
 *   vs-light-intensity        — light intensity NumInput (persists)
 *   vs-light-cast-shadow      — light cast-shadow checkbox (persists)
 *   vs-camera-projection      — camera projection select (persists components.camera)
 *   vs-camera-fov             — camera FOV NumInput (persists)
 *   vs-camera-near            — camera near-plane NumInput (persists)
 *   vs-camera-far             — camera far-plane NumInput (persists)
 *   vs-camera-shadows-enable  — camera shadows-enable checkbox (persists)
 *
 * The shadow checkboxes are PATCH-controlled (state reflects the persisted
 * value), so we use .click() + a REST poll, never .check() (whose synchronous
 * state assertion would race the round-trip).
 *
 * Skipped: material editor / MToon-PBR rows (require a loaded VRM — no model
 * upload in headless), VMC / lipsync / mediapipe behavior sub-panels (live
 * behind a behavior add + their own large surfaces — out of scope for this
 * unit), ARKit mapper editor, calibration wizard, camera env/shadow-quality
 * sub-controls (only render after enabling shadows; the enable toggle is the
 * relevant gate here).
 */

// ---------------------------------------------------------------------------
// Helper — REST read-back: raw scene_nodes row carries `components` as a JSON
// string; parse it to read the persisted transform / light / camera blocks.
// ---------------------------------------------------------------------------
type RawNode = {
  id: string;
  name: string;
  kind: string;
  components?: string | Record<string, unknown>;
};

async function getNode(
  request: APIRequestContext,
  sceneId: string,
  nodeId: string
): Promise<RawNode | undefined> {
  const nodes = (await listNodes(request, sceneId)) as unknown as RawNode[];
  return nodes.find((n) => n.id === nodeId);
}

function components(node: RawNode | undefined): Record<string, unknown> {
  if (!node?.components) return {};
  if (typeof node.components === 'string') {
    try {
      return JSON.parse(node.components) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return node.components;
}

// ---------------------------------------------------------------------------
// 1. vs-node-name — rename a node and assert it persists.
// ---------------------------------------------------------------------------
test('cov-properties: vs-node-name renames the node and persists via REST', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'PropNode1', 'group');

  await page.goto(`/editor/${projectId}`);

  const row = page.getByText('PropNode1', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  const nameInput = page.locator('.vs-node-name');
  await expect(nameInput).toBeVisible({ timeout: 10_000 });
  await nameInput.fill('RenamedNode');
  await nameInput.press('Tab');

  await expect
    .poll(
      async () => {
        const node = await getNode(request, sceneId, nodeId);
        return node?.name;
      },
      { timeout: 10_000 }
    )
    .toBe('RenamedNode');
});

// ---------------------------------------------------------------------------
// 2. vs-transform-position / rotation / scale — the transform vector inputs.
// ---------------------------------------------------------------------------
test('cov-properties: transform position/rotation/scale persist via REST', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'PropNode2', 'group');

  await page.goto(`/editor/${projectId}`);
  const row = page.getByText('PropNode2', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  // Position X (first NumInput inside the position group).
  const posX = page.locator('.vs-transform-position input').first();
  await expect(posX).toBeVisible({ timeout: 10_000 });
  await posX.fill('3');
  await posX.press('Enter');

  await expect
    .poll(
      async () => {
        const t = components(await getNode(request, sceneId, nodeId))
          .transform as { x?: number } | undefined;
        return t?.x;
      },
      { timeout: 10_000 }
    )
    .toBe(3);

  // Rotation Y (degrees in the UI → radians persisted).
  const rotY = page.locator('.vs-transform-rotation input').nth(1);
  await rotY.fill('90');
  await rotY.press('Enter');

  await expect
    .poll(
      async () => {
        const t = components(await getNode(request, sceneId, nodeId))
          .transform as { ry?: number } | undefined;
        return t?.ry !== undefined && Math.abs(t.ry - Math.PI / 2) < 0.01;
      },
      { timeout: 10_000 }
    )
    .toBe(true);

  // Scale Z.
  const scaleZ = page.locator('.vs-transform-scale input').nth(2);
  await scaleZ.fill('2');
  await scaleZ.press('Enter');

  await expect
    .poll(
      async () => {
        const t = components(await getNode(request, sceneId, nodeId))
          .transform as { sz?: number } | undefined;
        return t?.sz;
      },
      { timeout: 10_000 }
    )
    .toBe(2);
});

// ---------------------------------------------------------------------------
// 3. vs-transform-opacity — the opacity slider.
// ---------------------------------------------------------------------------
test('cov-properties: opacity slider persists via REST', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'PropNode3', 'group');

  await page.goto(`/editor/${projectId}`);
  const row = page.getByText('PropNode3', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  // Double-click the readout to edit the value directly (slider range drag is
  // unreliable headless; the click-to-edit input commits a precise value).
  const opacity = page.locator('.vs-transform-opacity');
  await expect(opacity).toBeVisible({ timeout: 10_000 });
  await opacity.getByText('1', { exact: true }).dblclick();
  const editor = opacity.locator('input[type="text"]');
  await expect(editor).toBeVisible({ timeout: 5_000 });
  await editor.fill('0.5');
  await editor.press('Enter');

  await expect
    .poll(
      async () => {
        const t = components(await getNode(request, sceneId, nodeId))
          .transform as { opacity?: number } | undefined;
        return t?.opacity;
      },
      { timeout: 10_000 }
    )
    .toBe(0.5);
});

// ---------------------------------------------------------------------------
// 4. vs-transform-cast-shadow / receive-shadow — only render when a camera in
//    the scene has shadows enabled. Seed a camera with shadows on first.
// ---------------------------------------------------------------------------
test('cov-properties: cast/receive shadow toggles persist via REST', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  // A camera with shadows enabled makes the per-node shadow flags visible.
  await request.post(`/api/scenes/${sceneId}/nodes`, {
    data: {
      name: 'ShadowCam',
      kind: 'camera',
      components: { camera: { type: 'camera', shadowsEnabled: true } },
    },
  });
  const nodeId = await seedNode(request, sceneId, 'PropNode4', 'group');

  await page.goto(`/editor/${projectId}`);
  const row = page.getByText('PropNode4', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  // castShadow defaults true → click flips to false.
  const castShadow = page.locator('.vs-transform-cast-shadow');
  await expect(castShadow).toBeVisible({ timeout: 10_000 });
  await castShadow.click();
  await expect
    .poll(
      async () => {
        const t = components(await getNode(request, sceneId, nodeId))
          .transform as { castShadow?: boolean } | undefined;
        return t?.castShadow;
      },
      { timeout: 10_000 }
    )
    .toBe(false);

  // receiveShadow defaults true → click flips to false.
  const receiveShadow = page.locator('.vs-transform-receive-shadow');
  await receiveShadow.click();
  await expect
    .poll(
      async () => {
        const t = components(await getNode(request, sceneId, nodeId))
          .transform as { receiveShadow?: boolean } | undefined;
        return t?.receiveShadow;
      },
      { timeout: 10_000 }
    )
    .toBe(false);
});

// ---------------------------------------------------------------------------
// 5. Light kind: type / color / intensity / cast-shadow.
// ---------------------------------------------------------------------------
test('cov-properties: light controls (type/color/intensity/cast-shadow) persist via REST', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'PropLight', 'light');

  await page.goto(`/editor/${projectId}`);
  const row = page.getByText('PropLight', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  // Type select → directional.
  const typeSel = page.locator('.vs-light-type');
  await expect(typeSel).toBeVisible({ timeout: 10_000 });
  await typeSel.selectOption('directional');
  await expect
    .poll(
      async () => {
        const l = components(await getNode(request, sceneId, nodeId)).light as
          | { lightType?: string }
          | undefined;
        return l?.lightType;
      },
      { timeout: 10_000 }
    )
    .toBe('directional');

  // Color input — exercise the handle (value committed on blur).
  const color = page.locator('.vs-light-color');
  await color.fill('#ff0000');
  await color.blur();

  // Intensity NumInput.
  const intensity = page.locator('.vs-light-intensity input');
  await intensity.fill('2.5');
  await intensity.press('Enter');
  await expect
    .poll(
      async () => {
        const l = components(await getNode(request, sceneId, nodeId)).light as
          | { intensity?: number }
          | undefined;
        return l?.intensity;
      },
      { timeout: 10_000 }
    )
    .toBe(2.5);

  // Cast-shadow checkbox (visible now that the light is directional, not ambient).
  const castShadow = page.locator('.vs-light-cast-shadow');
  await expect(castShadow).toBeVisible({ timeout: 10_000 });
  await castShadow.click();
  await expect
    .poll(
      async () => {
        const l = components(await getNode(request, sceneId, nodeId)).light as
          | { castShadow?: boolean }
          | undefined;
        return l?.castShadow;
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});

// ---------------------------------------------------------------------------
// 6. Camera kind: projection / fov / near / far / shadows-enable.
// ---------------------------------------------------------------------------
test('cov-properties: camera controls (projection/fov/near/far/shadows) persist via REST', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'PropCamera', 'camera');

  await page.goto(`/editor/${projectId}`);
  const row = page.getByText('PropCamera', { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  // FOV (perspective is default) — set first while projection is perspective.
  const fov = page.locator('.vs-camera-fov input');
  await expect(fov).toBeVisible({ timeout: 10_000 });
  await fov.fill('75');
  await fov.press('Enter');
  await expect
    .poll(
      async () => {
        const c = components(await getNode(request, sceneId, nodeId)).camera as
          | { fov?: number }
          | undefined;
        return c?.fov;
      },
      { timeout: 10_000 }
    )
    .toBe(75);

  // Near / far planes.
  const near = page.locator('.vs-camera-near input');
  await near.fill('0.5');
  await near.press('Enter');
  await expect
    .poll(
      async () => {
        const c = components(await getNode(request, sceneId, nodeId)).camera as
          | { near?: number }
          | undefined;
        return c?.near;
      },
      { timeout: 10_000 }
    )
    .toBe(0.5);

  const far = page.locator('.vs-camera-far input');
  await far.fill('500');
  await far.press('Enter');
  await expect
    .poll(
      async () => {
        const c = components(await getNode(request, sceneId, nodeId)).camera as
          | { far?: number }
          | undefined;
        return c?.far;
      },
      { timeout: 10_000 }
    )
    .toBe(500);

  // Shadows-enable checkbox.
  const shadows = page.locator('.vs-camera-shadows-enable');
  await shadows.click();
  await expect
    .poll(
      async () => {
        const c = components(await getNode(request, sceneId, nodeId)).camera as
          | { shadowsEnabled?: boolean }
          | undefined;
        return c?.shadowsEnabled;
      },
      { timeout: 10_000 }
    )
    .toBe(true);

  // Projection select → orthographic (changes which size/fov field renders;
  // do this last so the fov assertions above ran while perspective).
  const projection = page.locator('.vs-camera-projection');
  await projection.selectOption('orthographic');
  await expect
    .poll(
      async () => {
        const c = components(await getNode(request, sceneId, nodeId)).camera as
          | { projection?: string }
          | undefined;
        return c?.projection;
      },
      { timeout: 10_000 }
    )
    .toBe('orthographic');
});
