#!/usr/bin/env node
/**
 * Coverage trend / drop detector (Phase 4b).
 *
 * Reads the line % from nyc's `coverage/coverage-summary.json` and compares it
 * to a committed baseline (`coverage-baseline.json`). A high % is a weak
 * positive; a sharp DROP is a strong negative (orphaned/unreachable code, or new
 * functionality shipped without a UI path). So this WARNS on a drop beyond a
 * threshold rather than hard-failing — the signal is the delta, not the absolute.
 *
 * Usage:
 *   node scripts/coverage-trend.mjs                 # report + warn on drop
 *   node scripts/coverage-trend.mjs --update        # write current as baseline
 *
 * Env:
 *   COVERAGE_DROP_THRESHOLD   max tolerated absolute drop in % (default 1.5)
 *   COVERAGE_FAIL_ON_DROP     '1' to exit non-zero on a drop (default: warn only)
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SUMMARY = join(ROOT, 'coverage', 'coverage-summary.json');
const BASELINE = join(ROOT, 'coverage-baseline.json');
const THRESHOLD = Number(process.env.COVERAGE_DROP_THRESHOLD ?? 1.5);

if (!existsSync(SUMMARY)) {
  console.error(
    `[coverage-trend] ${SUMMARY} not found — run \`pnpm coverage:report\` first.`
  );
  process.exit(1);
}

const current = JSON.parse(readFileSync(SUMMARY, 'utf8')).total.lines.pct;

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify({ lines: current }, null, 2) + '\n');
  console.log(`[coverage-trend] baseline updated → ${current}% lines`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.log(
    `[coverage-trend] no baseline yet (current ${current}% lines). ` +
      `Run with --update to set one.`
  );
  process.exit(0);
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8')).lines;
const delta = Math.round((current - base) * 10) / 10;
console.log(
  `[coverage-trend] lines: ${current}% (baseline ${base}%, delta ${delta >= 0 ? '+' : ''}${delta}%)`
);

if (base - current > THRESHOLD) {
  const msg = `[coverage-trend] ⚠️  coverage dropped ${base - current}% (> ${THRESHOLD}% threshold) — investigate orphaned/unreachable/untested code.`;
  console.warn(msg);
  if (process.env.COVERAGE_FAIL_ON_DROP === '1') process.exit(1);
}
