import type { Reporter } from '@playwright/test/reporter';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
// @ts-expect-error — plain .mjs helper, no types
import { enumerateControls } from '../scripts/controls.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COVERAGE_DIR = join(__dirname, '..', '.coverage');

interface Control {
  rel: string;
  line: number;
  tag: string;
  testid: string | null;
  testidDynamic: boolean;
  optedOut: boolean;
}

/**
 * Control-coverage reporter.
 *
 * Denominator is EVERY interactive control in the frontend (via the TS AST in
 * controls.mjs), not just the instrumented subset — minus controls explicitly
 * opted out with `data-coverage-ignore`. So:
 *
 *   control coverage = controls whose testid was interacted with / active controls
 *   instrumentation  = controls that have a testid / active controls
 *
 * Both are trend signals. NOTE (caveat): interaction ≠ assertion, and this is
 * surface not depth — it finds untested controls, not under-tested ones.
 */
export default class ControlCoverageReporter implements Reporter {
  onEnd() {
    const { controls } = enumerateControls() as { controls: Control[] };

    // Testids actually interacted with during the run.
    const exercisedIds = new Set<string>();
    if (existsSync(COVERAGE_DIR)) {
      for (const f of readdirSync(COVERAGE_DIR)) {
        if (!f.startsWith('interacted-') || !f.endsWith('.json')) continue;
        try {
          for (const id of JSON.parse(readFileSync(join(COVERAGE_DIR, f), 'utf8')))
            exercisedIds.add(id);
        } catch {
          /* ignore a partial/corrupt fragment */
        }
      }
    }

    const active = controls.filter((c) => !c.optedOut);
    const optedOut = controls.length - active.length;
    const withId = active.filter((c) => c.testid || c.testidDynamic);
    const exercised = active.filter((c) => c.testid && exercisedIds.has(c.testid));
    const unexercised = withId.filter(
      (c) => !(c.testid && exercisedIds.has(c.testid))
    );

    const pct = (n: number) =>
      active.length ? Math.round((n / active.length) * 1000) / 10 : 0;

    const line = '─'.repeat(64);
    console.log(`\n${line}`);
    console.log(
      `UI control coverage: ${exercised.length} / ${active.length} controls exercised (${pct(exercised.length)}%)` +
        `   [${optedOut} opted out]`
    );
    console.log(
      `Instrumentation:     ${withId.length} / ${active.length} controls have a test id (${pct(withId.length)}%)`
    );
    console.log(
      '  ↳ denominator is ALL interactive controls (TS-AST), not just instrumented ones.'
    );
    if (unexercised.length) {
      console.log(`Instrumented but not exercised (${unexercised.length}):`);
      for (const c of unexercised) console.log(`  ${c.testid}  (${c.rel}:${c.line})`);
    }
    const blind = active.length - withId.length;
    if (blind > 0)
      console.log(
        `${blind} active controls have no test id — run \`pnpm controls:report\` for the list.`
      );
    console.log(`${line}\n`);

    // Machine-readable artifact for trend tracking.
    mkdirSync(COVERAGE_DIR, { recursive: true });
    writeFileSync(
      join(COVERAGE_DIR, 'control-coverage.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          totalControls: controls.length,
          optedOut,
          activeControls: active.length,
          instrumented: withId.length,
          instrumentationPercent: pct(withId.length),
          exercised: exercised.length,
          controlCoveragePercent: pct(exercised.length),
        },
        null,
        2
      )
    );
  }
}
