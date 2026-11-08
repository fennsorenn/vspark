import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene, listNodes } from '../fixtures/seed';
import type { APIRequestContext } from '@playwright/test';

/**
 * Composites (dev-notes/plans/composites.md): place one from the Create
 * palette, change its settings — each writes straight into its parts — and
 * dissolve it, asserted by REST read-back.
 *
 *   1. Compose: place an Alert, set its Message (caption + template), switch
 *      its Trigger to a named trigger (graph head node), set the Gap (clock
 *      rate), then Dissolve (marker gone).
 *   2. Scene: place a 3D Chat Overlay and dissolve it from the tree's
 *      right-click menu.
 */

type Doc = Record<string, unknown>;

async function layersOf(request: APIRequestContext, composeSceneId: string) {
  const res = await request.get(`/api/compose-scenes/${composeSceneId}/layers`);
  return ((await res.json()).data ?? []) as Doc[];
}

/** The composite marker on a root; the node list route returns raw rows,
 *  whose bags are JSON strings. */
function marker(
  d: Doc | undefined,
  bag: 'config' | 'properties'
): { type: string; parts: Record<string, string> } | null {
  const raw = d?.[bag];
  const obj = (typeof raw === 'string' ? JSON.parse(raw) : raw) as
    | Doc
    | undefined;
  return (obj?.composite ?? null) as {
    type: string;
    parts: Record<string, string>;
  } | null;
}

async function graphNode(
  request: APIRequestContext,
  logicId: string,
  nodeId: string
): Promise<Doc | undefined> {
  const g = (await (await request.get(`/api/logic/${logicId}`)).json())
    .data as Doc;
  const nodes = (g.descriptor as Doc).nodes;
  const list = Array.isArray(nodes)
    ? (nodes as Doc[])
    : Object.values(nodes as Record<string, Doc>);
  return list.find((n) => n.id === nodeId);
}

test('cov-composites: place, configure and dissolve an alert', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  const composeSceneId = (
    await (
      await request.post(`/api/projects/${projectId}/compose-scenes`, {
        data: { name: 'Overlay' },
      })
    ).json()
  ).data.id as string;

  await page.goto(`/editor/${projectId}`);
  const composeTab = page.getByRole('button', { name: 'Compose', exact: true });
  await expect(composeTab).toBeVisible({ timeout: 30_000 });
  await composeTab.click();
  await page.locator('.vs-compose-scene-row').first().click();
  await page.locator('.vs-tab-create').click();

  // The alert tile sits with the layer kinds, tagged as a composite.
  const tile = page.locator('.vs-palette-composite').first();
  await expect(tile).toContainText('Alert');
  await tile.click();

  let root: Doc | undefined;
  await expect
    .poll(async () => {
      root = (await layersOf(request, composeSceneId)).find(
        (l) => marker(l, 'config')?.type === 'alert'
      );
      return !!root;
    })
    .toBe(true);
  const parts = marker(root, 'config')!.parts;

  // Placing selects it: its settings are shown.
  await expect(page.locator('.vs-composite-settings')).toBeVisible();

  // Message → the caption and the Message template.
  const message = page.locator('.vs-composite-setting-message');
  await message.fill('${displayName} is here!');
  await message.press('Enter');
  await expect
    .poll(async () => {
      const cap = (await layersOf(request, composeSceneId)).find(
        (l) => l.id === parts.caption
      );
      return (cap?.config as Doc | undefined)?.content;
    })
    .toBe('${displayName} is here!');
  await expect
    .poll(
      async () =>
        ((await graphNode(request, parts.queue, 'fmt'))?.defaultConfig as Doc)
          ?.template
    )
    .toBe('${displayName} is here!');

  // Trigger → a named trigger: the head node is replaced.
  await page
    .locator('select.vs-composite-setting-trigger')
    .selectOption('named');
  await expect
    .poll(async () => (await graphNode(request, parts.queue, 'ev'))?.kind)
    .toBe('on_trigger');
  await expect(page.locator('.vs-composite-setting-triggerName')).toHaveValue(
    'alert'
  );

  // Gap → the queue clock's rate.
  const gap = page.locator('.vs-composite-setting-gap');
  await gap.fill('2');
  await gap.press('Enter');
  await expect
    .poll(
      async () =>
        ((await graphNode(request, parts.queue, 'clock'))?.defaultConfig as Doc)
          ?.hz
    )
    .toBe(0.5);

  // A part can't be deleted on its own (REST), only with the composite.
  expect(
    (await request.delete(`/api/compose-layers/${parts.caption}`)).status()
  ).toBe(409);

  // Dissolve → a plain group; the parts stay.
  await page.locator('.vs-composite-dissolve').click();
  await expect
    .poll(async () =>
      marker(
        (await layersOf(request, composeSceneId)).find(
          (l) => l.id === root!.id
        ),
        'config'
      )
    )
    .toBeNull();
  await expect(page.locator('.vs-composite-settings')).toHaveCount(0);
  expect(
    (await layersOf(request, composeSceneId)).some(
      (l) => l.id === parts.caption
    )
  ).toBe(true);
});

test('cov-composites: place a 3D chat overlay and dissolve it from the tree', async ({
  page,
  request,
}) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.locator('.vs-scene-row').first().click();
  await page.locator('.vs-tab-create').click();

  const tile = page
    .locator('.vs-palette-composite')
    .filter({ hasText: 'Chat Overlay (3D)' });
  await tile.click();

  let rootId = '';
  await expect
    .poll(async () => {
      const nodes = (await listNodes(request, sceneId)) as Doc[];
      const root = nodes.find(
        (n) => marker(n, 'properties')?.type === 'chat_overlay_3d'
      );
      rootId = (root?.id as string) ?? '';
      return rootId !== '';
    })
    .toBe(true);
  await expect(page.locator('.vs-composite-setting-maxMessages')).toHaveValue(
    '24'
  );

  await page
    .locator('.vs-node-row')
    .filter({ hasText: 'Chat Overlay 3D' })
    .click({ button: 'right' });
  await page.locator('.vs-node-ctx-dissolve').click();
  await expect
    .poll(async () => {
      const nodes = (await listNodes(request, sceneId)) as Doc[];
      return marker(
        nodes.find((n) => n.id === rootId),
        'properties'
      );
    })
    .toBeNull();
});
