import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene, seedNode } from '../fixtures/seed';

/**
 * Editor-flow E2E: mesh-native undo/redo of Properties-panel edits.
 *
 * Undo/redo is authored by the tab peer that commits the write, so it only
 * works once a UI write path flows through `collection.set` rather than REST
 * (see packages/frontend/src/mesh/peer.ts §undo). These specs are what prove
 * that: the TopBar buttons stay disabled until an edit is committed, and an
 * undo has to move the *persisted* value back, not just the on-screen one.
 *
 * They also pin commit granularity, which is the part a unit test can't see:
 * one edit must be one undo step. Typing a nine-character name has to undo in
 * a single click, not nine — the panel commits on blur, never per keystroke.
 *
 * Assertions read back through REST so a passing test means the value reached
 * SQLite, not just the store.
 */

/** The persisted row for one node (REST read-back). */
async function getNodeRow(
  request: APIRequestContext,
  sceneId: string,
  nodeId: string
): Promise<Record<string, unknown> | undefined> {
  const res = await request.get(`/api/scenes/${sceneId}/nodes`);
  const json = (await res.json()) as {
    ok: boolean;
    data: Record<string, unknown>[];
  };
  return json.data.find((n) => n.id === nodeId);
}

/** Poll the persisted `name` until it matches (writes land asynchronously). */
async function expectPersistedName(
  request: APIRequestContext,
  sceneId: string,
  nodeId: string,
  expected: string
): Promise<void> {
  await expect
    .poll(async () => (await getNodeRow(request, sceneId, nodeId))?.name, {
      timeout: 15_000,
    })
    .toBe(expected);
}

/** Poll the persisted transform's X (components is a JSON string in the row). */
async function expectPersistedX(
  request: APIRequestContext,
  sceneId: string,
  nodeId: string,
  expected: number
): Promise<void> {
  await expect
    .poll(
      async () => {
        const row = await getNodeRow(request, sceneId, nodeId);
        if (!row) return undefined;
        const comps =
          typeof row.components === 'string'
            ? (JSON.parse(row.components) as Record<string, unknown>)
            : (row.components as Record<string, unknown>);
        return (comps?.transform as Record<string, unknown> | undefined)?.x;
      },
      { timeout: 15_000 }
    )
    .toBe(expected);
}

/** Seed a node, open the editor, select it, and wait for the panel to bind.
 *
 *  `transformX` seeds an explicit transform component. Worth doing whenever a
 *  test undoes a transform edit: a fresh node has no transform at all (the
 *  panel defaults the display to zeros), so undo would restore *absent* rather
 *  than a number, and the assertion would be about nothing. */
async function openNode(
  page: import('@playwright/test').Page,
  request: APIRequestContext,
  name: string,
  transformX?: number
): Promise<{ sceneId: string; nodeId: string }> {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, name, 'group');

  if (transformX !== undefined)
    await request.put(`/api/scene-nodes/${nodeId}`, {
      data: { components: { transform: { type: 'transform', x: transformX } } },
    });

  await page.goto(`/editor/${projectId}`);
  const row = page.getByText(name, { exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.locator('.vs-node-name')).toHaveValue(name);

  return { sceneId, nodeId };
}

test('undo stays disabled until a write is committed, then reverts it', async ({
  page,
  request,
}) => {
  const { sceneId, nodeId } = await openNode(page, request, 'UndoNode');

  const undo = page.locator('.vs-topbar-undo');
  const nameInput = page.locator('.vs-node-name');

  // Nothing authored by this tab yet — the peer's undo stack is empty.
  await expect(undo).toBeDisabled();

  // Typing alone must not commit: the panel previews locally and commits on
  // blur, so the undo stack is still empty mid-edit.
  await nameInput.fill('Renamed');
  await expect(undo).toBeDisabled();

  await nameInput.blur();
  await expectPersistedName(request, sceneId, nodeId, 'Renamed');
  await expect(undo).toBeEnabled();

  // Undo has to move the persisted value back, not just the input.
  await undo.click();
  await expectPersistedName(request, sceneId, nodeId, 'UndoNode');
  await expect(nameInput).toHaveValue('UndoNode');
});

test('a multi-keystroke rename is a single undo step', async ({
  page,
  request,
}) => {
  const { sceneId, nodeId } = await openNode(page, request, 'GranularNode');

  const nameInput = page.locator('.vs-node-name');
  const undo = page.locator('.vs-topbar-undo');

  // Type character by character — the failure mode this guards against is one
  // undo entry per keystroke, which would make undo useless in practice.
  await nameInput.click();
  await nameInput.fill('');
  await nameInput.pressSequentially('Stagehand', { delay: 20 });
  await nameInput.blur();

  await expectPersistedName(request, sceneId, nodeId, 'Stagehand');

  // ONE undo returns the whole rename.
  await undo.click();
  await expectPersistedName(request, sceneId, nodeId, 'GranularNode');

  // ...and that was the only entry, so undo is exhausted.
  await expect(undo).toBeDisabled();
});

test('redo reapplies an undone rename', async ({ page, request }) => {
  const { sceneId, nodeId } = await openNode(page, request, 'RedoNode');

  const nameInput = page.locator('.vs-node-name');
  const undo = page.locator('.vs-topbar-undo');
  const redo = page.locator('.vs-topbar-redo');

  await expect(redo).toBeDisabled();

  await nameInput.fill('Reapplied');
  await nameInput.blur();
  await expectPersistedName(request, sceneId, nodeId, 'Reapplied');

  await undo.click();
  await expectPersistedName(request, sceneId, nodeId, 'RedoNode');
  await expect(redo).toBeEnabled();

  await redo.click();
  await expectPersistedName(request, sceneId, nodeId, 'Reapplied');
});

test('a transform drag commits once and undoes back to the prior value', async ({
  page,
  request,
}) => {
  const { sceneId, nodeId } = await openNode(page, request, 'TransformUndo', 1);

  const xInput = page.locator('.vs-transform-position input').nth(0);
  await expect(xInput).toHaveValue('1');

  await xInput.fill('2.5');
  await xInput.blur();
  await expectPersistedX(request, sceneId, nodeId, 2.5);

  await page.locator('.vs-topbar-undo').click();
  await expectPersistedX(request, sceneId, nodeId, 1);
});

test('undo unwinds edits to different fields one at a time', async ({
  page,
  request,
}) => {
  const { sceneId, nodeId } = await openNode(page, request, 'TwoFieldNode', 1);

  const nameInput = page.locator('.vs-node-name');
  const xInput = page.locator('.vs-transform-position input').nth(0);
  const undo = page.locator('.vs-topbar-undo');

  await nameInput.fill('FirstEdit');
  await nameInput.blur();
  await expectPersistedName(request, sceneId, nodeId, 'FirstEdit');

  await xInput.fill('4');
  await xInput.blur();
  await expectPersistedX(request, sceneId, nodeId, 4);

  // Each field is stamped at its own path, so unwinding the transform must
  // leave the rename standing.
  await undo.click();
  await expectPersistedX(request, sceneId, nodeId, 1);
  await expectPersistedName(request, sceneId, nodeId, 'FirstEdit');

  await undo.click();
  await expectPersistedName(request, sceneId, nodeId, 'TwoFieldNode');
});

/**
 * Drive the scene tree's HTML5 drag-and-drop.
 *
 * Playwright's dragTo() moves the mouse, which doesn't drive HTML5 DnD in
 * Chromium, so the events are dispatched directly. Two details matter:
 *
 *  - dragstart and drop must land in SEPARATE ticks. The tree carries the
 *    dragged id in React state, so a drop dispatched in the same tick still
 *    sees `dragNodeId` as null and bails out silently.
 *  - no dragover. It sets the drop zone from the pointer's Y offset, and a
 *    synthetic event's clientY of 0 reads as the row's top edge — zone
 *    'before', which makes the node a SIBLING of the target rather than
 *    nesting it. Leaving the zone unset resolves to 'inside'.
 */
async function dragNodeOnto(
  page: import('@playwright/test').Page,
  sourceName: string,
  targetName: string
): Promise<void> {
  const dispatch = (name: string, type: string) =>
    page.evaluate(
      ([label, evType]) => {
        const row = Array.from(document.querySelectorAll('*'))
          .filter(
            (e) => e.textContent?.trim() === label && e.children.length === 0
          )[0]
          ?.closest('[draggable="true"]');
        if (!row) throw new Error(`draggable row not found for ${label}`);
        const w = window as unknown as { __dndTransfer?: DataTransfer };
        if (evType === 'dragstart') w.__dndTransfer = new DataTransfer();
        row.dispatchEvent(
          new DragEvent(evType, {
            bubbles: true,
            cancelable: true,
            dataTransfer: w.__dndTransfer,
          })
        );
      },
      [name, type]
    );

  await dispatch(sourceName, 'dragstart');
  // Let React commit setDragNodeId before the drop handler reads it.
  await page.waitForTimeout(100);
  await dispatch(targetName, 'drop');
}

test('a drag-reparent is one undo step and reverts the parent', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const parentId = await seedNode(request, sceneId, 'DropTarget', 'group');
  const childId = await seedNode(request, sceneId, 'Dragged', 'group');

  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('Dragged', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const parentOf = async () =>
    (await getNodeRow(request, sceneId, childId))?.parent_id ??
    (await getNodeRow(request, sceneId, childId))?.parentId;

  expect(await parentOf()).toBeFalsy();

  await dragNodeOnto(page, 'Dragged', 'DropTarget');
  await expect.poll(parentOf, { timeout: 15_000 }).toBe(parentId);

  // Containment is a plain field write, so the drag is undoable like any edit.
  await page.locator('.vs-topbar-undo').click();
  await expect.poll(parentOf, { timeout: 15_000 }).toBeFalsy();
});

// --- structural edits -------------------------------------------------------

/** Names of every non-scene node persisted in a scene. */
async function persistedNames(
  request: APIRequestContext,
  sceneId: string
): Promise<string[]> {
  const res = await request.get(`/api/scenes/${sceneId}/nodes`);
  const json = (await res.json()) as { data: { name: string }[] };
  return json.data.map((n) => n.name).sort();
}

test('a created node undoes away and redoes back', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  await page.goto(`/editor/${projectId}`);

  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  // Create via the palette — the node is authored by this tab, not the server,
  // which is what puts it on this tab's undo stack.
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Group', exact: true }).click();

  await expect.poll(() => persistedNames(request, sceneId)).toHaveLength(1);
  const [created] = await persistedNames(request, sceneId);

  const undo = page.locator('.vs-topbar-undo');
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect.poll(() => persistedNames(request, sceneId)).toEqual([]);

  await page.locator('.vs-topbar-redo').click();
  await expect.poll(() => persistedNames(request, sceneId)).toEqual([created]);
});

test('deleting a subtree restores every descendant on undo', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const rootId = await seedNode(request, sceneId, 'Root', 'group');
  const midId = await seedNode(request, sceneId, 'Mid', 'group');
  const leafId = await seedNode(request, sceneId, 'Leaf', 'group');
  // Root → Mid → Leaf.
  await request.put(`/api/scene-nodes/${midId}`, {
    data: { parentId: rootId },
  });
  await request.put(`/api/scene-nodes/${leafId}`, {
    data: { parentId: midId },
  });

  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('Root', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // Delete Root, choosing "with children" in the branch dialog.
  await page.getByText('Root', { exact: true }).click({ button: 'right' });
  await page
    .getByText(/delete/i)
    .first()
    .click();
  const withChildren = page.getByRole('button', { name: /with .*children/i });
  await withChildren.click();

  await expect.poll(() => persistedNames(request, sceneId)).toEqual([]);

  // The whole subtree comes back in ONE undo. If descendants were left to the
  // server's FK cascade they'd be gone from SQLite and unrecoverable here.
  await page.locator('.vs-topbar-undo').click();
  await expect
    .poll(() => persistedNames(request, sceneId), { timeout: 15_000 })
    .toEqual(['Leaf', 'Mid', 'Root']);
});
