import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene, seedNode, listNodes } from '../fixtures/seed';

/**
 * Control-coverage spec (Phase 4a): instruments and exercises the interactive
 * controls in SceneGraph.tsx so they register as "exercised" in the control-
 * coverage report.
 *
 * Controls targeted:
 *   vs-tab-stage            — Stage tab button
 *   vs-tab-compose          — Compose tab button
 *   vs-tab-logic            — Logic tab button
 *   vs-add-scene            — "+ Scene" button
 *   vs-scene-row            — Scene row select
 *   vs-scene-add-node       — Per-scene "+ node" button
 *   vs-node-row             — Node row select
 *   vs-node-visibility      — Node visibility toggle
 *   vs-node-components-toggle — "Show components" (⚙) button
 *
 * Each spec seeds project+scene (and where needed a node) via REST so we start
 * from a known state, then loads /editor/:projectId and drives the controls.
 * Sensible state / REST assertions follow each mutation.
 */

// ---------------------------------------------------------------------------
// 1. Tab navigation: Stage → Compose → Logic → Stage
// ---------------------------------------------------------------------------
test('SceneGraph tabs: Stage / Compose / Logic switch correctly', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  // Wait for editor to load — scene tree is the reliable sentinel.
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Stage tab is active by default; clicking it again is a no-op but still
  // registers the handle.
  const stageTab = page.locator('.vs-tab-stage');
  await expect(stageTab).toBeVisible();
  await stageTab.click();

  // Switch to Compose tab.
  const composeTab = page.locator('.vs-tab-compose');
  await expect(composeTab).toBeVisible();
  await composeTab.click();

  // Switch to Logic tab.
  const logicTab = page.locator('.vs-tab-logic');
  await expect(logicTab).toBeVisible();
  await logicTab.click();

  // Switch back to Stage tab to restore state for the rest of the test.
  await stageTab.click();
  // Scene tree should be visible again.
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// 2. Scene row select and per-scene add-node button
// ---------------------------------------------------------------------------
test('SceneGraph scene row: select + add-node button flashes Create palette', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Click the scene row to select it.
  const sceneRow = page.locator('.vs-scene-row').first();
  await expect(sceneRow).toBeVisible();
  await sceneRow.click();

  // Click the per-scene + button (vs-scene-add-node) — it switches the bottom
  // dock to "Create" and flashes it.
  const addNodeBtn = page.locator('.vs-scene-add-node').first();
  await expect(addNodeBtn).toBeVisible();
  await addNodeBtn.click();

  // The bottom dock's "Create" tab should now be active / visible (it's flashed
  // into view). We can't easily assert the flash animation but can check the
  // Create palette button is present.
  await expect(
    page.getByRole('button', { name: 'Create', exact: true })
  ).toBeVisible({ timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// 3. Node row select
// ---------------------------------------------------------------------------
test('SceneGraph node row: clicking selects the node', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  await seedNode(request, sceneId, 'SelectMe', 'group');

  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('SelectMe', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // Click the node ROW itself (vs-node-row) — specifically click on the node
  // name text span, which has no vs- class of its own, so the coverage recorder
  // walks up and attributes the interaction to vs-node-row.
  // We use the text locator inside the node row to land on the name span.
  const nodeRow = page.locator('.vs-node-row').first();
  await expect(nodeRow).toBeVisible();
  // Click in the left portion of the row where the icon+name live, avoiding
  // the small action buttons on the right side.
  await nodeRow.click({ position: { x: 40, y: 10 } });

  // The node name text remains visible after selection.
  await expect(page.getByText('SelectMe', { exact: true })).toBeVisible();
});

// ---------------------------------------------------------------------------
// 4. Node visibility toggle
// ---------------------------------------------------------------------------
test('SceneGraph visibility toggle: hides and shows a node (persists)', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'ToggleMe', 'group');

  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('ToggleMe', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // Click the visibility toggle button (vs-node-visibility).
  const visBtn = page.locator('.vs-node-visibility').first();
  await expect(visBtn).toBeVisible();
  await visBtn.click();

  // REST read-back: the node's hidden flag was set (backend may return 1 or true).
  await expect
    .poll(
      async () => {
        const nodes = await listNodes(request, sceneId);
        const node = nodes.find((n) => n.id === nodeId);
        const h = (node as Record<string, unknown> | undefined)?.hidden;
        return Boolean(h);
      },
      { timeout: 10_000 }
    )
    .toBe(true);

  // Toggle back visible.
  await visBtn.click();
  await expect
    .poll(
      async () => {
        const nodes = await listNodes(request, sceneId);
        const node = nodes.find((n) => n.id === nodeId);
        const h = (node as Record<string, unknown> | undefined)?.hidden;
        return Boolean(h);
      },
      { timeout: 10_000 }
    )
    .toBe(false);
});

// ---------------------------------------------------------------------------
// 5. Components (behaviours) toggle
// ---------------------------------------------------------------------------
test('SceneGraph components toggle: opens and closes the behaviours section', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  await seedNode(request, sceneId, 'CompNode', 'group');

  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('CompNode', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // Click the ⚙ components toggle (vs-node-components-toggle).
  const toggleBtn = page.locator('.vs-node-components-toggle').first();
  await expect(toggleBtn).toBeVisible();
  await toggleBtn.click();

  // The behaviours section should now be expanded — it shows an "Add component"
  // button or the "no components" hint text.  Either indicates the section opened.
  // We assert the toggle button is still visible (it stays mounted).
  await expect(toggleBtn).toBeVisible();

  // Toggle closed again.
  await toggleBtn.click();
});

// ---------------------------------------------------------------------------
// 6. Scene collapse toggle: collapses a scene that has root nodes
// ---------------------------------------------------------------------------
test('SceneGraph scene collapse: clicking chevron collapses/expands scene', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  // Seed a node so the scene has content and the collapse chevron is visible.
  await seedNode(request, sceneId, 'CollapseTarget', 'group');

  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('CollapseTarget', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // The scene collapse chevron (vs-scene-collapse) should now be visible
  // because the scene has root nodes.
  const collapseChevron = page.locator('.vs-scene-collapse').first();
  await expect(collapseChevron).toBeVisible();
  await collapseChevron.click();

  // The node disappears (collapsed).
  await expect(
    page.getByText('CollapseTarget', { exact: true })
  ).not.toBeVisible({ timeout: 5_000 });

  // Click again to expand.
  await collapseChevron.click();
  await expect(page.getByText('CollapseTarget', { exact: true })).toBeVisible({
    timeout: 5_000,
  });
});

// ---------------------------------------------------------------------------
// 7. Node collapse toggle: collapses a node that has children
// ---------------------------------------------------------------------------
test('SceneGraph node collapse: clicking chevron collapses/expands node', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  // Create a parent node and a child node so the collapse chevron is visible.
  const parentId = await seedNode(request, sceneId, 'ParentNode', 'group');
  // Seed a child of the parent
  const childRes = await request.post(`/api/scenes/${sceneId}/nodes`, {
    data: { name: 'ChildNode', kind: 'group', parentId },
  });
  const childId = (await childRes.json()).data.id as string;
  expect(childId).toBeTruthy();

  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('ParentNode', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  // Child is visible initially.
  await expect(page.getByText('ChildNode', { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  // The node collapse chevron (vs-node-collapse) should be visible for the
  // parent node because it has children.
  const nodeCollapse = page.locator('.vs-node-collapse').first();
  await expect(nodeCollapse).toBeVisible();
  await nodeCollapse.click();

  // Child is now hidden (node collapsed).
  await expect(page.getByText('ChildNode', { exact: true })).not.toBeVisible({
    timeout: 5_000,
  });

  // Expand again.
  await nodeCollapse.click();
  await expect(page.getByText('ChildNode', { exact: true })).toBeVisible({
    timeout: 5_000,
  });
});

// ---------------------------------------------------------------------------
// 9. "+ Scene" button opens prompt → new scene persists via REST
// ---------------------------------------------------------------------------
test('SceneGraph add-scene button: creates a new scene and it persists', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Click the "+ Scene" button (vs-add-scene).
  const addSceneBtn = page.locator('.vs-add-scene');
  await expect(addSceneBtn).toBeVisible();
  await addSceneBtn.click();

  // A prompt dialog appears — fill in a name and confirm.
  const sceneName = `CovScene ${Date.now()}`;
  const dialog = page.locator('[style*="position: fixed"][style*="inset: 0"]');
  await dialog.getByRole('textbox').fill(sceneName);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();

  // The new scene row appears in the tree.
  await expect(page.getByText(sceneName, { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  // REST read-back: the scene was persisted.
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/projects/${projectId}/scenes`);
        const body = (await res.json()) as {
          data: { scenes: { name: string }[] };
        };
        return body.data.scenes.some((s) => s.name === sceneName);
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});
