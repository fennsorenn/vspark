// Playwright smoke-test runner template for vspark.
//
// Run with the global Playwright install on Node's module path:
//   NODE_PATH=$(npm root -g) node /tmp/smoketest/smoke.mjs
//
// Adapt the `checks` to whatever the current diff actually touched. Keep it
// small and proportional. Every meaningful state gets a screenshot so the PR
// report can both prove the feature works and surface visual regressions.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const FRONTEND = process.env.FRONTEND_URL ?? 'http://localhost:5173';
const SHOTS = process.env.SHOTS_DIR ?? '/tmp/smoketest/shots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
const consoleErrors = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

let shotN = 0;
const shot = async (label) => {
  const file = `${SHOTS}/${String(++shotN).padStart(2, '0')}-${label}.png`;
  await page.screenshot({ path: file, fullPage: false });
  return file;
};

try {
  // --- Check: Home loads ---
  await page.goto(FRONTEND, { waitUntil: 'networkidle' });
  await shot('home');
  record('Home route renders', true);

  // --- Check: open the editor and wait for the 3D canvas ---
  // The editor lives at /:projectId. Either click into an existing project from
  // Home, or create one via the API first and navigate directly. Adjust to taste.
  // await page.goto(`${FRONTEND}/${projectId}`, { waitUntil: 'networkidle' });
  // await page.waitForSelector('canvas', { timeout: 15000 });
  // await shot('editor-loaded');
  // record('Editor canvas mounts', true);

  // --- Add change-specific assertions here ---
  // e.g. open a panel, toggle a control, switch language, assert text/elements.

} catch (err) {
  record('Uncaught failure', false, err.message);
  await shot('failure');
} finally {
  if (consoleErrors.length) {
    record('No console errors', false, `${consoleErrors.length} error(s)`);
    console.log('Console errors:\n' + consoleErrors.map((e) => '  - ' + e).join('\n'));
  } else {
    record('No console errors', true);
  }
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
