import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene } from '../fixtures/seed';

/**
 * Editor-flow E2E (Phase 8): i18n language switching + help system.
 *
 * Flow 1 — i18n language switch
 *   Seed a project+scene, open the editor, assert the "Stage" tab label is
 *   visible in English, switch the language selector to German, and assert the
 *   same tab now reads "Bühne" (the German translation of "Stage").
 *   Resets back to English before the test ends.
 *
 * Flow 2 — help system
 *   Click the `?` HelpButton in the TopBar (topic="overview") and assert that
 *   the floating HelpWindow appears (identified by its "Help & Documentation"
 *   header title); then close it with the × button and assert it disappears.
 */

test('i18n: switching language updates UI labels', async ({ page, request }) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  // Wait for the editor to finish loading — the "Stage" tab is always rendered.
  const stageTab = page.getByRole('button', { name: 'Stage', exact: true });
  await expect(stageTab).toBeVisible({ timeout: 30_000 });

  // Sanity: the English label is present before switching.
  await expect(stageTab).toBeVisible();

  // Find the language selector by its stable title attribute.
  const langSelect = page.locator('select[title="Language / Sprache"]');
  await expect(langSelect).toBeVisible();

  // Switch to German.
  await langSelect.selectOption('de');

  // The "Stage" tab should now read "Bühne" in German.
  const stageTabDe = page.getByRole('button', { name: 'Bühne', exact: true });
  await expect(stageTabDe).toBeVisible({ timeout: 10_000 });

  // The English label should no longer be present.
  await expect(stageTab).not.toBeVisible();

  // Reset to English so we don't pollute localStorage for other specs.
  await langSelect.selectOption('en');
  await expect(page.getByRole('button', { name: 'Stage', exact: true })).toBeVisible({
    timeout: 10_000,
  });
});

test('help system: opening and closing the help window', async ({ page, request }) => {
  const { projectId } = await seedProjectScene(request);

  await page.goto(`/editor/${projectId}`);

  // Wait for the editor to be ready.
  const stageTab = page.getByRole('button', { name: 'Stage', exact: true });
  await expect(stageTab).toBeVisible({ timeout: 30_000 });

  // The TopBar renders a HelpButton whose aria-label is set to the tip prop
  // (topbar.help.tip = "Open help & documentation" in English).
  const helpButton = page.getByRole('button', { name: 'Open help & documentation', exact: true });
  await expect(helpButton).toBeVisible();
  await helpButton.click();

  // The HelpWindow header shows the translated window.title: "Help & Documentation".
  const helpWindowTitle = page.getByText('Help & Documentation', { exact: true });
  await expect(helpWindowTitle).toBeVisible({ timeout: 10_000 });

  // Close the window with the × button. The HeaderButton renders its title as
  // "Close" (help.window.close) and its text content as "×". Target by title.
  const closeButton = page.locator('button[title="Close"]');
  await expect(closeButton).toBeVisible();
  await closeButton.click();

  // The help window should be gone.
  await expect(helpWindowTitle).not.toBeVisible();
});
