import { test as base } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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

type WorkerFixtures = { interactedSet: Set<string> };

// eslint-disable-next-line @typescript-eslint/ban-types
export const test = base.extend<{}, WorkerFixtures>({
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
});

export { expect } from '@playwright/test';
