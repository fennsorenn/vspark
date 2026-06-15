import type { Reporter } from '@playwright/test/reporter';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
// @ts-expect-error — plain .mjs helper, no types
import { collectInventory } from '../scripts/inventory-controls.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COVERAGE_DIR = join(__dirname, '..', '.coverage');

/**
 * Control-coverage reporter — "of all operable controls (data-testid), which
 * does some test exercise?". The headline % is a trend line; the real
 * deliverable is the list of controls NO test ever touched.
 *
 * NOTE (documented caveat): interaction ≠ assertion, and this measures surface
 * not depth — it finds completely-untested controls, not under-tested ones.
 */
export default class ControlCoverageReporter implements Reporter {
  onEnd() {
    const inventory: string[] = collectInventory();
    const exercised = new Set<string>();
    if (existsSync(COVERAGE_DIR)) {
      for (const f of readdirSync(COVERAGE_DIR)) {
        if (!f.startsWith('interacted-') || !f.endsWith('.json')) continue;
        try {
          for (const id of JSON.parse(readFileSync(join(COVERAGE_DIR, f), 'utf8')))
            exercised.add(id);
        } catch {
          /* ignore a partial/corrupt fragment */
        }
      }
    }

    const covered = inventory.filter((id) => exercised.has(id));
    const untouched = inventory.filter((id) => !exercised.has(id));
    const pct = inventory.length
      ? Math.round((covered.length / inventory.length) * 1000) / 10
      : 0;

    const line = '─'.repeat(60);
    console.log(`\n${line}`);
    console.log(
      `UI control coverage: ${covered.length} / ${inventory.length} controls exercised (${pct}%)`
    );
    if (untouched.length) {
      console.log('Never interacted with:');
      for (const id of untouched) console.log(`  ${id}`);
    } else if (inventory.length) {
      console.log('All inventoried controls were exercised. 🎉');
    }
    console.log(`${line}\n`);

    // Persist a machine-readable artifact for trend tracking across runs.
    mkdirSync(COVERAGE_DIR, { recursive: true });
    writeFileSync(
      join(COVERAGE_DIR, 'control-coverage.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          total: inventory.length,
          covered: covered.length,
          percent: pct,
          untouched,
        },
        null,
        2
      )
    );
  }
}
