import { test as base } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

let _covSeq = 0;

/**
 * Control-coverage instrumentation — the NUMERATOR for control coverage.
 *
 * Rather than wrapping every Playwright locator action, we listen at the DOM
 * level: an init script registers capture-phase listeners that, on any
 * click/input/change, walk up from the event target to the nearest
 * `[data-testid]` and report it to Node via an exposed binding. The per-worker
 * set of interacted ids is flushed to `.coverage/interacted-<worker>.json`,
 * which the control-coverage reporter aggregates in `onEnd`.
 *
 * Specs opt in simply by importing `test` from this module instead of
 * `@playwright/test`.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const COVERAGE_DIR = join(__dirname, '..', '.coverage');

type TestFixtures = { _codeCoverage: void };
type WorkerFixtures = { interactedSet: Set<string> };

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // Worker-scoped accumulator; flushed to disk on worker teardown.
  interactedSet: [
    async ({}, use, workerInfo) => {
      const set = new Set<string>();
      await use(set);
      mkdirSync(COVERAGE_DIR, { recursive: true });
      writeFileSync(
        join(COVERAGE_DIR, `interacted-${workerInfo.workerIndex}.json`),
        JSON.stringify([...set])
      );
    },
    { scope: 'worker' },
  ],

  // Wire the recorder onto every context/page before any page script runs.
  context: async ({ context, interactedSet }, use) => {
    await context.exposeFunction('__vsparkRecordInteraction', (id: string) => {
      if (id) interactedSet.add(id);
    });
    await context.addInitScript(() => {
      const record = (e: Event) => {
        let el = e.target as HTMLElement | null;
        while (el && el.nodeType === 1) {
          const id = el.getAttribute?.('data-testid');
          if (id) {
            (
              window as unknown as {
                __vsparkRecordInteraction?: (id: string) => void;
              }
            ).__vsparkRecordInteraction?.(id);
            break;
          }
          el = el.parentElement;
        }
      };
      document.addEventListener('click', record, true);
      document.addEventListener('input', record, true);
      document.addEventListener('change', record, true);
    });
    await use(context);
  },

  // After each test, harvest istanbul code coverage (window.__coverage__) from
  // every open page into .nyc_output/ for `nyc report`. No-op unless COVERAGE
  // is set (vite only instruments then). This is the 4b code-coverage trend
  // signal — see e2e/README.md. Depends on `context`, so it tears down BEFORE
  // the context closes (pages still alive).
  _codeCoverage: [
    async ({ context }, use) => {
      await use();
      if (!process.env.COVERAGE) return;
      const dir = join(__dirname, '..', '.nyc_output');
      mkdirSync(dir, { recursive: true });
      for (const page of context.pages()) {
        try {
          const cov = await page.evaluate(
            () =>
              (window as unknown as { __coverage__?: unknown }).__coverage__
          );
          if (cov)
            writeFileSync(
              join(dir, `cov-${process.pid}-${_covSeq++}.json`),
              JSON.stringify(cov)
            );
        } catch {
          /* page navigated/closed mid-harvest — skip */
        }
      }
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
