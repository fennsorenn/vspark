import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene } from '../fixtures/seed';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

/**
 * Control-coverage spec: the Actions panel's chat / redemption kinds (chat
 * command, chat pattern, chat keyword, keyword combo, redemption) and the
 * Hotkey parity additions (inline shortcut recorder, per-group quick add).
 * Sibling of cov-actions.spec.ts (core + Hotkey).
 *
 * Targeted `vs-` handles:
 *   vs-action-add-kind-<kind>, vs-action-command, vs-action-aliases,
 *   vs-action-min-rank, vs-action-cooldown-seconds, vs-action-cooldown-group,
 *   vs-action-args-pattern, vs-action-counter-enabled, vs-action-counter-name,
 *   vs-action-counter-step, vs-action-counter-persistent, vs-action-reply,
 *   vs-action-account, vs-action-pattern, vs-action-keywords,
 *   vs-action-trigger, vs-action-response-type, vs-action-field,
 *   vs-action-threshold, vs-action-window, vs-action-unique,
 *   vs-action-end-message, vs-action-reward, vs-action-mark-complete,
 *   vs-action-group-add, vs-action-row-shortcut.
 *
 * Every mutation is asserted by REST read-back. The account list is served by
 * a route stub (no real Twitch / StreamElements account can be created here).
 */

type Json = Record<string, any>;

async function actionsOf(
  request: APIRequestContext,
  projectId: string
): Promise<Json[]> {
  const res = await request.get(`/api/projects/${projectId}/actions`);
  return ((await res.json()).data as Json[]) ?? [];
}

const byKind = async (
  request: APIRequestContext,
  projectId: string,
  kind: string
) => (await actionsOf(request, projectId)).filter((a) => a.kind === kind);

async function graphKinds(
  request: APIRequestContext,
  graphId: string
): Promise<string[]> {
  const res = await request.get(`/api/logic/${graphId}`);
  if (!res.ok()) return [];
  const nodes = (await res.json()).data.descriptor.nodes;
  return (Array.isArray(nodes) ? nodes : Object.values(nodes)).map(
    (n: Json) => n.kind
  );
}

async function openActionsTab(page: Page, projectId: string): Promise<void> {
  await page.route(`**/api/projects/${projectId}/overlive-accounts`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            ok: true,
            data: [
              {
                id: 'acc-bot',
                projectId,
                platform: 'twitch',
                label: 'Bot account',
                appCredentialId: null,
                credentials: {},
                broadcasterId: null,
                broadcasterLogin: null,
                status: 'disconnected',
                statusReason: null,
                statusMessage: null,
                isDefault: false,
              },
            ],
          },
        })
      : route.continue()
  );
  await page.goto(`/editor/${projectId}`);
  await expect(page.getByText('Scene', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.locator('.vs-tab-actions').click();
}

/** Add an action of `kind` from the menu; its form opens by itself. Returns
 *  the form and the action's REST read-back getter. */
async function addKind(
  page: Page,
  request: APIRequestContext,
  projectId: string,
  kind: string
) {
  await page.locator('.vs-action-add').click();
  await page.locator(`.vs-action-add-kind-${kind}`).click();
  await expect
    .poll(async () => (await byKind(request, projectId, kind)).length)
    .toBe(1);
  const form = page.locator(`.vs-action-group-${kind} .vs-action-form`);
  await expect(form).toBeVisible();
  const read = async () => (await byKind(request, projectId, kind))[0];
  return { form, read };
}

/** Fill a draft text / number field and commit it with Enter. */
async function commit(field: Locator, value: string): Promise<void> {
  await field.fill(value);
  await field.press('Enter');
}

test('Actions kinds: chat command / pattern forms (REST-verified)', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openActionsTab(page, projectId);

  // ── Chat command ───────────────────────────────────────────────────────────
  const { form, read } = await addKind(
    page,
    request,
    projectId,
    'chat_command'
  );
  const fp = (await read()).templateFingerprint;
  await commit(form.locator('.vs-action-command'), '!hug');
  await commit(form.locator('.vs-action-aliases'), 'cuddle snuggle');
  await expect
    .poll(async () => (await read()).settings.derived.commandPattern)
    .toBe('^(?:hug|cuddle|snuggle)$');
  await form.locator('.vs-action-min-rank').selectOption('sub');
  await expect.poll(async () => (await read()).settings.minRank).toBe('sub');
  await commit(form.locator('.vs-action-cooldown-seconds'), '30');
  await commit(form.locator('.vs-action-cooldown-group'), 'fun');
  await expect
    .poll(async () => (await read()).settings.cooldown)
    .toEqual({ seconds: 30, group: 'fun' });
  await commit(form.locator('.vs-action-args-pattern'), '^@?(?<target>\\w+)$');
  await expect
    .poll(async () => (await read()).settings.argsPattern)
    .toBe('^@?(?<target>\\w+)$');

  await form.locator('.vs-action-counter-enabled').click();
  await expect
    .poll(async () => (await read()).settings.counter.enabled)
    .toBe(true);
  await commit(form.locator('.vs-action-counter-name'), 'hugs');
  await commit(form.locator('.vs-action-counter-step'), '2');
  await expect
    .poll(async () => (await read()).settings.counter)
    .toMatchObject({ name: 'hugs', step: 2, persistent: true });
  await form.locator('.vs-action-counter-persistent').click();
  await expect
    .poll(async () => (await read()).settings.counter.persistent)
    .toBe(false);

  await commit(
    form.locator('.vs-action-reply'),
    '${user} hugs ${target} (${count})'
  );
  await expect
    .poll(async () => (await read()).settings.reply)
    .toBe('${user} hugs ${target} (${count})');
  await form.locator('.vs-action-account').selectOption('acc-bot');
  await expect
    .poll(async () => (await read()).settings.account)
    .toBe('acc-bot');

  // All value settings: the graph was never rebuilt.
  const cmd = await read();
  expect([cmd.templateFingerprint, cmd.modified]).toEqual([fp, false]);
  await expect(
    page.locator('.vs-action-group-chat_command .vs-action-preview')
  ).toContainText('!snuggle');

  // ── Chat pattern ───────────────────────────────────────────────────────────
  const pat = await addKind(page, request, projectId, 'chat_pattern');
  await commit(
    pat.form.locator('.vs-action-pattern'),
    '"(?<quote>.+)" - (?<who>.+)'
  );
  await expect
    .poll(async () => (await pat.read()).settings.derived.fullPattern)
    .toBe('^(?:"(?<quote>.+)" - (?<who>.+))$');
  await commit(pat.form.locator('.vs-action-reply'), '${who}: ${quote}');
  await expect
    .poll(async () => (await pat.read()).settings.reply)
    .toBe('${who}: ${quote}');
  expect(await graphKinds(request, (await pat.read()).graphId)).toContain(
    'overlive_chat_message'
  );
});

test('Actions kinds: keyword / combo / redemption forms (REST-verified)', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openActionsTab(page, projectId);

  // ── Chat keyword: response type is a shape setting ────────────────────────
  const kw = await addKind(page, request, projectId, 'chat_keyword');
  await commit(kw.form.locator('.vs-action-keywords'), 'LUL, KEKW');
  await expect
    .poll(async () => (await kw.read()).settings.keywords)
    .toBe('LUL, KEKW');
  const kwGraph = (await kw.read()).graphId as string;
  await kw.form
    .locator('.vs-action-response-type')
    .selectOption('control_media');
  await expect
    .poll(() => graphKinds(request, kwGraph))
    .toContain('media_control');
  await kw.form.locator('.vs-action-field-action').selectOption('play');
  await expect
    .poll(async () => (await kw.read()).settings.response.action)
    .toBe('play');
  await commit(kw.form.locator('.vs-action-trigger'), 'laugh');
  await expect
    .poll(async () => (await kw.read()).settings.trigger)
    .toBe('laugh');
  expect((await kw.read()).modified).toBe(false);

  // ── Keyword combo ──────────────────────────────────────────────────────────
  const combo = await addKind(page, request, projectId, 'keyword_combo');
  await commit(combo.form.locator('.vs-action-keywords'), 'PogChamp');
  await commit(combo.form.locator('.vs-action-threshold'), '6');
  await commit(combo.form.locator('.vs-action-window'), '15');
  await combo.form.locator('.vs-action-unique').click();
  await commit(combo.form.locator('.vs-action-end-message'), 'Combo: ${count}');
  await expect
    .poll(async () => {
      const s = (await combo.read()).settings;
      return [
        s.threshold,
        s.window,
        s.uniqueChatters,
        s.endMessage,
        s.derived.comboKey,
      ];
    })
    .toEqual([6, 15, false, 'Combo: ${count}', '']);
  await expect(
    page.locator('.vs-action-group-keyword_combo .vs-action-preview')
  ).toContainText('6× within 15 s');

  // ── Redemption ─────────────────────────────────────────────────────────────
  const red = await addKind(page, request, projectId, 'redemption');
  await commit(red.form.locator('.vs-action-reward'), 'Hydrate');
  await commit(red.form.locator('.vs-action-reply'), '${user}: ${message}');
  await red.form.locator('.vs-action-mark-complete').click();
  await expect
    .poll(async () => {
      const s = (await red.read()).settings;
      return [s.reward, s.reply, s.markComplete];
    })
    .toEqual(['Hydrate', '${user}: ${message}', true]);
  expect(await graphKinds(request, (await red.read()).graphId)).toContain(
    'overlive_redemption_status'
  );
});

test('Actions: Hotkey parity — inline shortcut, per-group quick add', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);
  await openActionsTab(page, projectId);
  await page.locator('.vs-action-add').click();
  await page.locator('.vs-action-add-kind-hotkey').click();
  await expect
    .poll(async () => (await byKind(request, projectId, 'hotkey')).length)
    .toBe(1);

  // Record the shortcut in the row itself, settings closed.
  await page.locator('.vs-action-settings').click(); // close the auto-opened form
  await expect(page.locator('.vs-action-form')).toHaveCount(0);
  await page.locator('.vs-action-row-shortcut').click();
  await page.keyboard.press('Control+F7');
  await expect
    .poll(
      async () =>
        (await byKind(request, projectId, 'hotkey'))[0]?.settings.shortcut
    )
    .toMatchObject({ key: 'F7', ctrl: true });

  // One-click add of another hotkey; its form opens.
  await page.locator('.vs-action-group-hotkey .vs-action-group-add').click();
  await expect
    .poll(async () => (await byKind(request, projectId, 'hotkey')).length)
    .toBe(2);
  await expect(
    page.locator('.vs-action-group-hotkey .vs-action-form')
  ).toHaveCount(1);
});
