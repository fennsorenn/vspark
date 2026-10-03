import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene } from '../fixtures/seed';
import type { APIRequestContext } from '@playwright/test';

/**
 * Editor-flow E2E (Phase 8): Overlive accounts modal.
 *
 * Flow 1 — modal render & reachability
 *   Seed a project, open the editor, click the Accounts TopBar button, and
 *   assert the OverliveAccountsModal renders with its title ("Stream Accounts"),
 *   both section headings ("TWITCH APPS", "ACCOUNTS"), and the empty-state text
 *   for each section.  Close the modal via the × button and assert it disappears.
 *
 * Flow 2 — Register App sub-dialog (local UI only, no external call)
 *   From within the open modal click "+ Register App" and assert the
 *   RegisterAppDialog renders (title "Register Twitch App") and shows the four
 *   form fields (Label, Client ID, Client Secret, Redirect URI).
 *   Cancel the sub-dialog and assert it disappears while the parent modal
 *   remains visible.
 *
 * Flow 3 — Add StreamElements sub-dialog (local UI only, no external call)
 *   Click "+ StreamElements" and assert the RegisterSeAccountDialog renders
 *   (title "Add StreamElements Account") with its JWT and Channel ID inputs.
 *   Cancel and assert the parent modal is still open.
 *
 * Flow 4 — Twitch app credential save via REST read-back
 *   Open "+ Register App", fill in all four fields with dummy values, click Save,
 *   and verify via GET /api/projects/:projectId/overlive-app-credentials that the
 *   row was persisted.  No real Twitch/OAuth call is needed — app credentials are
 *   stored locally only.
 *
 * SKIPPED / MOCKED:
 *   - "+ Twitch" OAuth flow (startTwitchOAuthFor → window.open): would open a
 *     real browser popup to dev.twitch.tv — skipped entirely because no mock
 *     OAuth provider is available in this harness.
 *   - StreamElements JWT save (handleSave → POST /api/projects/:projectId/overlive-accounts):
 *     Although technically local, the API does call getOverliveManager().refreshProject()
 *     which may fail without real credentials.  We assert the dialog form renders but
 *     do not submit it to avoid manager errors in the test DB.  Covered by REST-level
 *     unit tests instead.
 */

// ---------------------------------------------------------------------------
// Helper: open the Accounts modal (assumes the editor is already loaded)
// ---------------------------------------------------------------------------
async function openAccountsModal(page: import('@playwright/test').Page) {
  // Its handle, not its label: the button's purple dot used to be a 🟣 in the
  // text (which this matched on) and is now an SVG icon, so the accessible name
  // is plain "Accounts".
  const btn = page.locator('.vs-topbar-accounts');
  await expect(btn).toBeVisible();
  await btn.click();

  // The modal title is the i18n key accounts.title = "Stream Accounts".
  // The <h2> also contains a HelpButton child so its full text is
  // "Stream Accounts ?". Match with exact: false (prefix match) and scope to
  // h2 so we don't accidentally match a section heading.
  const title = page.locator('h2').filter({ hasText: 'Stream Accounts' });
  await expect(title).toBeVisible({ timeout: 10_000 });
  return title;
}

// ---------------------------------------------------------------------------
// 1. Modal render & reachability
// ---------------------------------------------------------------------------
test('overlive: modal opens, shows empty-state sections, and closes', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  // Wait for editor to be ready — Stage tab is always present
  await expect(
    page.getByRole('button', { name: 'Stage', exact: true })
  ).toBeVisible({ timeout: 30_000 });

  await openAccountsModal(page);

  // Section headings are rendered as uppercase via CSS but the DOM text is
  // the raw i18n value: "Twitch Apps" and "Accounts"
  await expect(page.getByText('Twitch Apps', { exact: true })).toBeVisible();
  await expect(page.getByText('Accounts', { exact: true }).first()).toBeVisible();

  // Empty-state for Twitch Apps section
  await expect(
    page.getByText('No Twitch apps registered.', { exact: false })
  ).toBeVisible();

  // Empty-state for Accounts section (no app present → emptyNoApp shown after emptyGeneral)
  await expect(
    page.getByText('No accounts connected yet.', { exact: false })
  ).toBeVisible();

  // Footer note
  await expect(
    page.getByText('Credentials are stored locally in your project database.', {
      exact: true,
    })
  ).toBeVisible();

  // Close via × button (title="Close")
  const closeBtn = page.locator('button[title="Close"]');
  await expect(closeBtn).toBeVisible();
  await closeBtn.click();

  // The modal title disappears
  await expect(
    page.locator('h2').filter({ hasText: 'Stream Accounts' })
  ).not.toBeVisible({ timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// 2. Register App sub-dialog (local UI, no external call)
// ---------------------------------------------------------------------------
test('overlive: Register App sub-dialog renders and can be cancelled', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  await expect(
    page.getByRole('button', { name: 'Stage', exact: true })
  ).toBeVisible({ timeout: 30_000 });

  await openAccountsModal(page);

  // Click "+ Register App" button
  const registerBtn = page.getByRole('button', {
    name: '+ Register App',
    exact: true,
  });
  await expect(registerBtn).toBeVisible();
  await registerBtn.click();

  // Sub-dialog title
  const subTitle = page.getByRole('heading', {
    name: 'Register Twitch App',
    exact: true,
  });
  await expect(subTitle).toBeVisible({ timeout: 5_000 });

  // Four form fields visible as <label> elements in the form grid.
  // "Client ID" and "Client Secret" also appear in the instructions list as
  // <strong> elements, so scope to <label> to avoid strict-mode ambiguity.
  await expect(page.locator('label').filter({ hasText: /^Label$/ })).toBeVisible();
  await expect(page.locator('label').filter({ hasText: /^Client ID$/ })).toBeVisible();
  await expect(page.locator('label').filter({ hasText: /^Client Secret$/ })).toBeVisible();
  await expect(page.locator('label').filter({ hasText: /^Redirect URI$/ })).toBeVisible();

  // Cancel the sub-dialog
  const cancelBtn = page.getByRole('button', { name: 'Cancel', exact: true }).first();
  await expect(cancelBtn).toBeVisible();
  await cancelBtn.click();

  // Sub-dialog disappears but parent modal is still open
  await expect(subTitle).not.toBeVisible({ timeout: 5_000 });
  await expect(
    page.locator('h2').filter({ hasText: 'Stream Accounts' })
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// 3. Add StreamElements sub-dialog (local UI, no external call)
// ---------------------------------------------------------------------------
test('overlive: StreamElements sub-dialog renders and can be cancelled', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  await expect(
    page.getByRole('button', { name: 'Stage', exact: true })
  ).toBeVisible({ timeout: 30_000 });

  await openAccountsModal(page);

  // Click "+ StreamElements"
  const seBtn = page.getByRole('button', {
    name: '+ StreamElements',
    exact: true,
  });
  await expect(seBtn).toBeVisible();
  await seBtn.click();

  // Sub-dialog title
  const seTitle = page.getByRole('heading', {
    name: 'Add StreamElements Account',
    exact: true,
  });
  await expect(seTitle).toBeVisible({ timeout: 5_000 });

  // JWT and Channel ID inputs must be present
  await expect(page.getByText('JWT', { exact: true })).toBeVisible();
  await expect(page.getByText('Channel ID', { exact: true })).toBeVisible();

  // Cancel
  const cancelBtn = page.getByRole('button', { name: 'Cancel', exact: true }).first();
  await expect(cancelBtn).toBeVisible();
  await cancelBtn.click();

  // Sub-dialog gone, parent still visible
  await expect(seTitle).not.toBeVisible({ timeout: 5_000 });
  await expect(
    page.locator('h2').filter({ hasText: 'Stream Accounts' })
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// 4. Twitch app credential save — drive via UI, verify via REST
// ---------------------------------------------------------------------------
test('overlive: saving a Twitch app credential persists to backend', async ({
  page,
  request,
}) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  await expect(
    page.getByRole('button', { name: 'Stage', exact: true })
  ).toBeVisible({ timeout: 30_000 });

  await openAccountsModal(page);

  // Open Register App sub-dialog
  await page.getByRole('button', { name: '+ Register App', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Register Twitch App', exact: true })
  ).toBeVisible({ timeout: 5_000 });

  // Fill in the form fields. The form has a grid of <label>/<input> pairs.
  // We clear the pre-filled Label and Client ID inputs, and fill all four.
  const labelInput = page.getByPlaceholder('My Twitch App');
  await labelInput.fill('E2E Test App');

  const clientIdInput = page.getByPlaceholder('abc123…');
  await clientIdInput.fill('fake-client-id-e2e');

  // Client Secret is a password input (placeholder = "••••••••")
  const clientSecretInput = page.getByPlaceholder('••••••••');
  await clientSecretInput.fill('fake-client-secret-e2e');

  // Redirect URI is pre-filled. Verify it contains something useful.
  // (We leave it as-is since it defaults to origin + callback path.)

  // Click Save
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // The sub-dialog should close on success
  await expect(
    page.getByRole('heading', { name: 'Register Twitch App', exact: true })
  ).not.toBeVisible({ timeout: 10_000 });

  // The new app row should appear in the parent modal
  await expect(page.getByText('E2E Test App', { exact: true })).toBeVisible({
    timeout: 5_000,
  });

  // REST read-back: credential was persisted
  await expect
    .poll(
      async () => {
        const res = await (request as APIRequestContext).get(
          `/api/projects/${projectId}/overlive-app-credentials`
        );
        const body = (await res.json()) as {
          data: { label: string; clientId: string }[];
        };
        return body.data.some(
          (r) => r.label === 'E2E Test App' && r.clientId === 'fake-client-id-e2e'
        );
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});
