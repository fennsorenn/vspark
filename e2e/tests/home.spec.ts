import { test, expect, type Page } from '@playwright/test';

/**
 * Functional exemplars for the Home page. They assert reachability,
 * maneuverability, and correct state changes — selecting controls by
 * `data-testid` (i18n-proof) and verifying outcomes via the DOM *and* a REST
 * read-back, never by appearance.
 */

/** Collect console errors + uncaught page errors for a no-error assertion. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

test('home page is reachable and renders without console errors', async ({ page }) => {
  const errors = trackErrors(page);

  await page.goto('/');

  await expect(page.getByText('vspark').first()).toBeVisible();
  await expect(page.getByTestId('new-project-button')).toBeVisible();
  expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
});

test('creating a project via the UI shows it and persists it', async ({ page, request }) => {
  const name = `E2E Project ${Date.now()}`;

  await page.goto('/');
  await page.getByTestId('new-project-button').click();
  await page.getByTestId('new-project-name').fill(name);
  await page.getByTestId('new-project-create').click();

  // DOM outcome: a card for the new project appears.
  const card = page.getByTestId('project-card').filter({ hasText: name });
  await expect(card).toBeVisible();

  // Second-level assertion: the project really hit the backend, not just the
  // local React state — catches optimistic-UI-but-silent-write-failure.
  const res = await request.get('/api/projects');
  expect(res.ok()).toBe(true);
  const body = await res.json();
  const names = (body.data as { name: string }[]).map((p) => p.name);
  expect(names).toContain(name);
});

test('opening a project navigates to its editor', async ({ page, request }) => {
  const name = `E2E Open ${Date.now()}`;
  // Seed directly via the API so this test is independent of the create flow.
  const created = await request.post('/api/projects', { data: { name } });
  expect(created.status()).toBe(201);

  await page.goto('/');
  const card = page.getByTestId('project-card').filter({ hasText: name });
  await card.getByTestId('project-open').click();

  await expect(page).toHaveURL(/\/editor\/[0-9a-f-]+$/);
});
