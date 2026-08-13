import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene, seedNode } from '../fixtures/seed';

/**
 * Two-tab E2E: node transform previews over the mesh `preview` channel.
 *
 * This is the first spec that drives two tabs at once, because the property
 * under test is not visible from one. A preview is defined by what it does to
 * OTHER peers and by what it deliberately does not do to the database:
 *
 *   - an in-flight gesture reaches every watching tab, and
 *   - it never persists — it is not model state, so it writes no row and logs
 *     no undo entry — until the gesture settles and commits.
 *
 * A single-tab test cannot tell a working preview from one dropped on the floor
 * (the sender's own store is updated either way), which is exactly how this path
 * shipped untested: before this spec, nothing anywhere exercised
 * `node_transform_preview` or its mesh replacement beyond `vi.fn()` mocks.
 *
 * Both tabs sit in one browser context — same user, two windows — which is the
 * real scenario this transport exists for.
 */

/** The persisted transform for a node, straight from the backend. */
async function persistedTransform(
  request: APIRequestContext,
  sceneId: string,
  nodeId: string
): Promise<Record<string, number>> {
  const res = await request.get(`/api/scenes/${sceneId}/nodes`);
  const json = (await res.json()) as { data: Record<string, unknown>[] };
  const row = json.data.find((n) => n.id === nodeId);
  const comps =
    typeof row?.components === 'string'
      ? (JSON.parse(row.components) as Record<string, unknown>)
      : ((row?.components ?? {}) as Record<string, unknown>);
  return (comps.transform ?? {}) as Record<string, number>;
}

/** Open the editor and select `name` so the Properties panel is showing it. */
async function openAndSelect(
  page: Page,
  projectId: string,
  name: string
): Promise<void> {
  await page.goto(`/editor/${projectId}`);
  const row = page.getByText(name, { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.locator('.vs-node-name')).toHaveValue(name);
}

/** The X-position box of the Properties panel's position VecInput. */
const xBox = (page: Page) =>
  page.locator('.vs-transform-position input').nth(0);

/** Poll a tab's displayed X until it reaches `want` (previews arrive tweened,
 *  over ~80ms of rAF, so this converges rather than landing in one step). */
async function expectDisplayedX(page: Page, want: number): Promise<void> {
  await expect
    .poll(async () => Number(await xBox(page).inputValue()), {
      timeout: 10_000,
    })
    .toBeCloseTo(want, 2);
}

test('preview: an in-flight drag reaches the other tab without persisting', async ({
  browser,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'PreviewNode', 'group');

  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();

  await openAndSelect(tabA, projectId, 'PreviewNode');
  await openAndSelect(tabB, projectId, 'PreviewNode');

  // Gesture in flight: `fill` fires the input's onChange (→ previewNodeTransform)
  // but NOT its onBlur, so nothing has committed yet.
  await xBox(tabA).fill('7.5');

  // The other tab tracks the gesture...
  await expectDisplayedX(tabB, 7.5);

  // ...and the database does not. This is the half a one-tab test cannot see:
  // a preview that silently fell through to a committed write would look
  // identical in tabB and only differ here.
  expect((await persistedTransform(request, sceneId, nodeId)).x ?? 0).toBe(0);

  // Settle the gesture: blur commits.
  await xBox(tabA).blur();

  await expect
    .poll(async () => (await persistedTransform(request, sceneId, nodeId)).x, {
      timeout: 10_000,
    })
    .toBeCloseTo(7.5, 2);

  // And the committed value is what both tabs are left showing.
  await expectDisplayedX(tabB, 7.5);

  await context.close();
});

test('preview: a rotation gesture reaches the other tab', async ({
  browser,
  request,
}) => {
  // Rotation travels a different path on the receiver: it is the only field
  // tweened as a quaternion rather than per-scalar, and `hasNodeTween` has to
  // look in that second map or the committed value snaps instead of gliding.
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'RotateNode', 'group');

  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();

  await openAndSelect(tabA, projectId, 'RotateNode');
  await openAndSelect(tabB, projectId, 'RotateNode');

  // The rotation VecInput shows degrees; the stored component is radians.
  const rotA = tabA.locator('.vs-transform-rotation input').nth(1); // Y axis
  const rotB = tabB.locator('.vs-transform-rotation input').nth(1);
  await rotA.fill('90');

  await expect
    .poll(async () => Number(await rotB.inputValue()), { timeout: 10_000 })
    .toBeCloseTo(90, 0);

  expect((await persistedTransform(request, sceneId, nodeId)).ry ?? 0).toBe(0);

  await rotA.blur();
  await expect
    .poll(async () => (await persistedTransform(request, sceneId, nodeId)).ry, {
      timeout: 10_000,
    })
    .toBeCloseTo(Math.PI / 2, 2);

  await context.close();
});

test('preview: a gesture does not put an entry on the undo stack', async ({
  browser,
  request,
}) => {
  // Previews are not model state, so a drag must cost exactly ONE undo step
  // (the commit), not one per frame. Undoing once returns the node to where it
  // started rather than to some midpoint of the drag.
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'UndoNode', 'group');

  const context = await browser.newContext();
  const tabA = await context.newPage();
  await openAndSelect(tabA, projectId, 'UndoNode');

  await xBox(tabA).fill('1');
  await xBox(tabA).fill('2');
  await xBox(tabA).fill('3.5');
  await xBox(tabA).blur();

  await expect
    .poll(async () => (await persistedTransform(request, sceneId, nodeId)).x, {
      timeout: 10_000,
    })
    .toBeCloseTo(3.5, 2);

  await tabA.keyboard.press('Control+z');

  await expect
    .poll(
      async () => (await persistedTransform(request, sceneId, nodeId)).x ?? 0,
      { timeout: 10_000 }
    )
    .toBe(0);

  await context.close();
});
