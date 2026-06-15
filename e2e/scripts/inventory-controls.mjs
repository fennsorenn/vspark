#!/usr/bin/env node
/**
 * UI control inventory — the DENOMINATOR for control coverage.
 *
 * Statically scans the frontend source for every `data-testid` literal. That
 * set is the universe of controls a test *could* drive; the control-coverage
 * reporter diffs it against the set actually interacted with during the e2e run
 * to surface controls no test ever touches.
 *
 * Caveat (documented in the testing plan): controls without a `data-testid` are
 * invisible to this denominator — completeness depends on testid discipline.
 *
 * Usage:
 *   node scripts/inventory-controls.mjs           # prints JSON array
 *   import { collectInventory } from './inventory-controls.mjs'
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_SRC = join(__dirname, '..', '..', 'packages', 'frontend', 'src');

// Matches data-testid="x", data-testid='x', data-testid={'x'}, data-testid={`x`}.
// Template literals with ${...} interpolation are skipped (not a stable key).
const TESTID_RE =
  /data-testid\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*(?:'([^']+)'|"([^"]+)"|`([^`${]+)`)\s*\})/g;

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
    } else if (/\.(tsx?|jsx?)$/.test(entry)) {
      out.push(full);
    }
  }
}

export function collectInventory(srcDir = FRONTEND_SRC) {
  const files = [];
  walk(srcDir, files);
  const ids = new Set();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(TESTID_RE)) {
      const id = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
      if (id) ids.add(id);
    }
  }
  return [...ids].sort();
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(collectInventory(), null, 2));
}
