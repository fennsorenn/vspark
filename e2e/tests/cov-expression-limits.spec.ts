import { test, expect } from '../fixtures/controlCoverage';
import type { APIRequestContext } from '@playwright/test';
import { seedProjectScene, seedNode } from '../fixtures/seed';

/**
 * Control-coverage spec: the Expression Limits (`blendshape_limiter`) behavior
 * panel in PropertiesPanel.tsx.
 *
 * The behavior is seeded via REST (the add-menu flow is already covered by
 * editor-behaviors-effects.spec.ts), then selected in the scene graph so the
 * panel renders. Every edit persists through PUT /api/behaviors/:id, so each
 * assertion is a REST read-back poll rather than a DOM check — same rule as the
 * PATCH-controlled checkboxes elsewhere: drive with .click(), assert via REST.
 *
 * Controls targeted:
 *   vs-bslimits-enabled        — master switch (persists limits.enabled)
 *   vs-bslimits-clamp-label    — clamp rule label text input (persists)
 *   vs-bslimits-clamp-max      — clamp rule max NumInput (persists)
 *   vs-bslimits-clamp-enabled  — per-rule enable checkbox (persists)
 *   vs-bslimits-group-remove   — drops an exclusive group (persists)
 *   vs-bslimits-add-clamp      — appends a clamp rule (persists)
 *   vs-bslimits-name-add       — adds a name pattern chip (persists)
 *   vs-bslimits-name-remove    — removes a name pattern chip (persists)
 *   vs-bslimits-reset          — restores the shipped defaults (persists)
 *   vs-bslimits-json           — raw JSON textarea
 *   vs-bslimits-json-apply     — applies the edited JSON (persists)
 *   vs-bslimits-json-revert    — discards the JSON draft (local state only)
 *
 * Not targeted here: the group mode select / strength / member label / member
 * remove / add-group / add-member and the clamp min + threshold + ramp inputs —
 * they are the same write path as the controls above (patch → PUT), and the
 * group-remove + add-clamp cases already cover list mutation in both directions.
 */

type Limits = {
  enabled?: boolean;
  groups?: { id: string; members: { id: string; patterns: string[] }[] }[];
  clamps?: {
    id: string;
    label?: string;
    enabled?: boolean;
    when?: string[];
    targets: string[];
    max?: number;
  }[];
};

/** REST read-back of the behavior's stored rule set. The list route returns raw
 *  `behaviors` rows, so `config` arrives as a JSON string. */
async function readLimits(
  request: APIRequestContext,
  nodeId: string
): Promise<Limits> {
  const res = await request.get(`/api/scene-nodes/${nodeId}/behaviors`);
  const body = (await res.json()) as {
    data: { kind: string; config: string | { limits?: Limits } }[];
  };
  const beh = body.data.find((b) => b.kind === 'blendshape_limiter');
  if (!beh) return {};
  const cfg = (
    typeof beh.config === 'string' ? JSON.parse(beh.config) : beh.config
  ) as { limits?: Limits };
  return cfg.limits ?? {};
}

/** Seed a project + avatar + Expression Limits behavior, open its panel. */
async function openPanel(
  page: import('@playwright/test').Page,
  request: APIRequestContext
) {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'LimitedAvatar', 'avatar');
  const created = await request.post(
    `/api/scene-nodes/${nodeId}/behaviors`,
    { data: { kind: 'blendshape_limiter' } }
  );
  expect(created.ok()).toBe(true);

  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('LimitedAvatar', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // ⚙ toggle reveals the node's inline behavior list; click the row to select.
  await page.locator('button[title="Show components"]').first().click();
  const row = page.getByText('Expression Limits', { exact: true }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();

  // The panel is up once the master switch renders.
  await expect(page.locator('.vs-bslimits-enabled')).toBeVisible({
    timeout: 10_000,
  });
  return { nodeId };
}

// ---------------------------------------------------------------------------
// The shipped defaults land on a freshly added behavior
// ---------------------------------------------------------------------------
test('expression limits: a new behavior arrives with the shipped defaults', async ({
  page,
  request,
}) => {
  const { nodeId } = await openPanel(page, request);

  const limits = await readLimits(request, nodeId);
  expect(limits.enabled).toBe(true);
  expect(limits.groups).toHaveLength(1);
  expect(limits.clamps).toHaveLength(2);

  // Rendered from the stored document, not from a client-side default.
  await expect(page.locator('.vs-bslimits-clamp-label').first()).toHaveValue(
    'Joy limits eye close'
  );
});

// ---------------------------------------------------------------------------
// Master switch + per-rule controls
// ---------------------------------------------------------------------------
test('expression limits: master switch and clamp-rule edits persist', async ({
  page,
  request,
}) => {
  const { nodeId } = await openPanel(page, request);

  // Master switch off.
  await page.locator('.vs-bslimits-enabled').click();
  await expect
    .poll(async () => (await readLimits(request, nodeId)).enabled, {
      timeout: 10_000,
    })
    .toBe(false);

  // Per-rule enable off (second rule — "Joy limits mouth open").
  await page.locator('.vs-bslimits-clamp-enabled').nth(1).click();
  await expect
    .poll(async () => (await readLimits(request, nodeId)).clamps?.[1].enabled, {
      timeout: 10_000,
    })
    .toBe(false);

  // Rename the first rule.
  const label = page.locator('.vs-bslimits-clamp-label').first();
  await label.fill('Eye cap');
  await expect
    .poll(async () => (await readLimits(request, nodeId)).clamps?.[0].label, {
      timeout: 10_000,
    })
    .toBe('Eye cap');

  // Tighten the first rule's ceiling. NumInput commits on blur.
  const max = page.locator('.vs-bslimits-clamp-max input').first();
  await max.fill('0.25');
  await max.blur();
  await expect
    .poll(async () => (await readLimits(request, nodeId)).clamps?.[0].max, {
      timeout: 10_000,
    })
    .toBeCloseTo(0.25, 5);
});

// ---------------------------------------------------------------------------
// List mutation — add, remove, reset
// ---------------------------------------------------------------------------
test('expression limits: rules can be added, removed and reset', async ({
  page,
  request,
}) => {
  const { nodeId } = await openPanel(page, request);

  // Drop the emotions group.
  await page.locator('.vs-bslimits-group-remove').first().click();
  await expect
    .poll(async () => (await readLimits(request, nodeId)).groups?.length, {
      timeout: 10_000,
    })
    .toBe(0);

  // Append a clamp rule.
  await page.locator('.vs-bslimits-add-clamp').click();
  await expect
    .poll(async () => (await readLimits(request, nodeId)).clamps?.length, {
      timeout: 10_000,
    })
    // The new rule persists with empty targets — pruning happens on read (so a
    // rule with nothing to clamp is a runtime no-op), never on write, which
    // would delete the row the user just added before they can fill it in.
    .toBe(3);

  // Reset puts the shipped rule set back.
  await page.locator('.vs-bslimits-reset').click();
  await expect
    .poll(
      async () => {
        const l = await readLimits(request, nodeId);
        return `${l.groups?.length}/${l.clamps?.length}`;
      },
      { timeout: 10_000 }
    )
    .toBe('1/2');
});

// ---------------------------------------------------------------------------
// Name-pattern chips
// ---------------------------------------------------------------------------
test('expression limits: name patterns can be added and removed', async ({
  page,
  request,
}) => {
  const { nodeId } = await openPanel(page, request);

  // The first name field belongs to the first member of the emotions group.
  const add = page.locator('.vs-bslimits-name-add').first();
  await add.fill('Fcl_ALL_Grin');
  await add.press('Enter');
  await expect
    .poll(
      async () =>
        (await readLimits(request, nodeId)).groups?.[0].members[0].patterns,
      { timeout: 10_000 }
    )
    .toContain('Fcl_ALL_Grin');

  // Remove the first chip of that member.
  const before = (await readLimits(request, nodeId)).groups?.[0].members[0]
    .patterns[0] as string;
  await page.locator('.vs-bslimits-name-remove').first().click();
  await expect
    .poll(
      async () =>
        (await readLimits(request, nodeId)).groups?.[0].members[0].patterns,
      { timeout: 10_000 }
    )
    .not.toContain(before);
});

// ---------------------------------------------------------------------------
// Raw JSON escape hatch
// ---------------------------------------------------------------------------
test('expression limits: the raw JSON editor applies and discards', async ({
  page,
  request,
}) => {
  const { nodeId } = await openPanel(page, request);

  // The Raw JSON section ships collapsed.
  await page.getByText('Raw JSON', { exact: true }).click();
  const textarea = page.locator('.vs-bslimits-json');
  await expect(textarea).toBeVisible({ timeout: 5_000 });

  // A draft that is discarded must not reach the server.
  await textarea.fill('{}');
  await page.locator('.vs-bslimits-json-revert').click();
  await expect(textarea).toHaveValue(/"clamps"/);
  expect((await readLimits(request, nodeId)).clamps).toHaveLength(2);

  // An applied document replaces the rule set wholesale.
  await textarea.fill(
    JSON.stringify({
      enabled: true,
      groups: [],
      clamps: [{ id: 'only', targets: ['aa'], max: 0.2 }],
    })
  );
  await page.locator('.vs-bslimits-json-apply').click();
  await expect
    .poll(
      async () => {
        const l = await readLimits(request, nodeId);
        return `${l.groups?.length}:${l.clamps?.map((c) => c.id).join(',')}`;
      },
      { timeout: 10_000 }
    )
    .toBe('0:only');
});
