import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene } from '../fixtures/seed';

/**
 * Control-coverage spec: plugin UI, against the "hello" fixture plugin the
 * e2e stack loads from a dev folder (fixtures/pluginFixture.ts).
 *
 * Targeted `vs-` handles:
 *   vs-topbar-plugins, vs-plugins-tab-*, vs-plugin-details, vs-plugins-refresh,
 *   vs-plugins-registries-toggle, vs-plugins-registry-url,
 *   vs-plugins-registry-add, vs-plugins-registry-trusted,
 *   vs-plugins-registry-remove, vs-plugins-registry-reset, vs-plugins-close,
 *   vs-plugin-app-field, vs-plugin-account-connect, vs-plugin-account-setup,
 *   vs-action-schema-field, vs-action-response-type.
 *
 * Installing from a registry needs an https registry and is covered by the
 * backend tests (plugins.manager.test.ts); accounts are created only by a
 * completed OAuth flow, covered by plugins.accounts.test.ts.
 */

test('Plugins window lists the running dev plugin and edits registries', async ({ page, request }) => {
  const { projectId } = await seedProjectScene(request);
  const plugins = await (await request.get('/api/plugins')).json();
  expect(plugins.data).toEqual([expect.objectContaining({ id: 'hello', status: 'active', source: 'dev' })]);

  await page.goto(`/editor/${projectId}`);
  await page.locator('.vs-topbar-plugins').click();
  const win = page.locator('.vs-plugins-window');
  await expect(win.locator('.vs-plugin-row-hello')).toContainText('Running');
  await win.locator('.vs-plugin-row-hello .vs-plugin-details').click();
  await expect(win.locator('.vs-plugin-detail')).toContainText('1 nodes');
  await win.locator('.vs-plugins-tab-browse').click();
  await win.locator('.vs-plugins-tab-installed').click();
  await win.locator('.vs-plugins-refresh').click();

  await win.locator('.vs-plugins-registries-toggle').click();
  await expect(win.locator('.vs-plugins-registry')).toHaveCount(1);
  await win.locator('.vs-plugins-registry-url').fill('https://127.0.0.1:9/other.json');
  await win.locator('.vs-plugins-registry-add').click();
  await expect(win.locator('.vs-plugins-registry')).toHaveCount(2);
  await win.locator('.vs-plugins-registry-trusted').first().click();
  await page.locator('.vs-dialog-confirm').click();
  await expect(win.locator('.vs-plugins-registry-trusted').first()).toBeChecked();
  await win.locator('.vs-plugins-registry-remove').last().click();
  await expect(win.locator('.vs-plugins-registry')).toHaveCount(1);
  await win.locator('.vs-plugins-registry-reset').click();
  await expect(win.locator('.vs-plugins-registry').first()).toContainText('raw.githubusercontent.com');
  await win.locator('.vs-plugins-close').click();
  await expect(win).toHaveCount(0);
});

test('a plugin provider in the Accounts window; plugin Action kind and response in the editor', async ({ page, request }) => {
  const { projectId } = await seedProjectScene(request);
  await page.goto(`/editor/${projectId}`);
  await page.locator('.vs-topbar-accounts').click();
  const block = page.locator('.vs-plugin-accounts-hello-svc');
  await expect(block).toBeVisible();
  await expect(block.locator('.vs-plugin-account-connect')).toBeDisabled();
  const field = block.locator('.vs-plugin-app-field-clientId');
  await field.fill('client-e2e');
  await field.press('Enter');
  await expect(block.locator('.vs-plugin-account-connect')).toBeEnabled();
  await expect(block).toContainText('/api/plugin-auth/callback');
  await page.keyboard.press('Escape');

  // The plugin's Action kind has a generated form.
  await page.locator('.vs-tab-actions').click();
  await page.locator('.vs-action-add').click();
  await page.locator('.vs-action-add-kind-hello_wave').click();
  const form = page.locator('.vs-action-editor .vs-action-schema-form');
  const name = form.locator('.vs-action-schema-field-name');
  await name.fill('Ada');
  await name.press('Enter');
  await expect
    .poll(async () => {
      const res = await request.get(`/api/projects/${projectId}/actions`);
      return (await res.json()).data.find((a: { kind: string }) => a.kind === 'hello_wave')?.settings?.name;
    })
    .toBe('Ada');

  // Its response type is offered by a built-in kind.
  await page.locator('.vs-action-add').click();
  await page.locator('.vs-action-add-kind-named_trigger').click();
  await page.locator('.vs-action-editor .vs-action-response-type').selectOption('hello_greet');
  await expect(page.locator('.vs-action-editor .vs-action-field-name')).toBeVisible();
});
