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

test('cov-composites: stream widgets — timer buttons, stages, goal by hand, list toggles', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
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

  /** Place a widget from the palette; resolves to its marker's parts. */
  async function placeWidget(label: string, type: string) {
    await page.locator('.vs-tab-create').click();
    await page
      .locator('.vs-palette-composite')
      .filter({ hasText: label })
      .click();
    let root: Doc | undefined;
    await expect
      .poll(async () => {
        root = (await layersOf(request, composeSceneId)).find(
          (l) => marker(l, 'config')?.type === type
        );
        return !!root;
      })
      .toBe(true);
    await expect(page.locator('.vs-composite-settings')).toBeVisible();
    return marker(root, 'config')!.parts;
  }

  // Countdown: a length, then Start / Pause / Resume / Reset.
  const cd = await placeWidget('Countdown', 'countdown');
  const length = page.locator('.vs-composite-setting-duration');
  await length.fill('0:10:00');
  await length.press('Enter');
  await expect
    .poll(
      async () =>
        ((await graphNode(request, cd.timer, 'dl'))?.defaultConfig as Doc)
          ?.duration
    )
    .toBe(600);
  const settings = page.locator('.vs-composite-settings');
  await page.locator('.vs-composite-timer-start').click();
  await expect(settings).toContainText('running');
  await page.locator('.vs-composite-timer-pause').click();
  await expect(settings).toContainText('paused');
  await page.locator('.vs-composite-timer-resume').click();
  await expect(settings).toContainText('running');
  await page.locator('.vs-composite-timer-reset').click();
  await expect(settings).toContainText('not started');

  // Subathon: add a soft-limit stage, change it, remove it.
  const sub = await placeWidget('Subathon Timer', 'subathon');
  const steps = async () =>
    (((await graphNode(request, sub.flow, 'st'))?.defaultConfig as Doc)
      ?.steps ?? []) as { at: number; value: number }[];
  await page.locator('.vs-composite-stage-add').click();
  await expect.poll(async () => (await steps()).length).toBe(1);
  const factor = page.locator('.vs-composite-stage-factor').first();
  await factor.fill('0.25');
  await factor.press('Enter');
  await expect.poll(async () => (await steps())[0]?.value).toBe(0.25);
  const at = page.locator('.vs-composite-stage-at').first();
  await at.fill('24:00:00');
  await at.press('Enter');
  await expect.poll(async () => (await steps())[0]?.at).toBe(86400);
  await page.locator('.vs-composite-stage-remove').first().click();
  await expect.poll(async () => (await steps()).length).toBe(0);

  // Goal: set its count by hand; the bar shows it.
  await placeWidget('Goal', 'goal');
  const current = page.locator('.vs-composite-setting-current');
  await current.fill('7');
  await current.press('Enter');
  await expect(page.getByText('7 / 50').first()).toBeVisible();

  // Recent events: turning a kind off unwires it.
  const recent = await placeWidget('Recent Events', 'recent_events');
  await page.locator('.vs-composite-setting-showFollow').click();
  await expect
    .poll(async () => {
      const g = (await (await request.get(`/api/logic/${recent.flow}`)).json())
        .data as Doc;
      const edges = (g.descriptor as Doc).edges;
      const list = Array.isArray(edges)
        ? (edges as Doc[])
        : Object.values(edges as Record<string, Doc>);
      return list.some(
        (e) =>
          e.fromNodeId === 'sFollow' &&
          e.fromPort === 'event' &&
          e.toNodeId === 'pFollow'
      );
    })
    .toBe(false);
});
