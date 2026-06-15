#!/usr/bin/env node
/**
 * Instrumentation coverage + staleness — guards the *denominator* of control
 * coverage.
 *
 * Control coverage only sees controls that carry a `data-testid`, so a component
 * full of interactive UI but with NO test ids is invisible and silently inflates
 * the %. This tool measures the other side:
 *
 *   1. Instrumentation coverage (file-level): of all component files that
 *      contain interactive UI (button/input/select/textarea/anchor or an
 *      on{Click,Change,...} handler), how many carry at least one `data-testid`?
 *      Lists the interactive components with NONE — the blind spots.
 *
 *   2. Staleness manifest: a committed signature of each interactive file's
 *      surface (its tag/handler/testid counts). When an edit changes that
 *      surface (adds a button, removes a testid, …) the signature drifts and the
 *      file is flagged STALE — you must re-review its instrumentation and
 *      `bless` it, so new UI elements can't slip past un-instrumented.
 *
 * Heuristic (regex, not a full parser): counts are occurrence-based, so the
 * file-level signal is robust even though exact element↔testid pairing is not
 * attempted. 3D/canvas files (react-three-fiber) are excluded — their onClick
 * handlers live on meshes, not DOM, and can't take a data-testid. Opt a file out
 * explicitly with an "instrumentation-ignore-file" marker in a comment.
 *
 * Usage:
 *   node scripts/instrumentation.mjs report      # coverage % + blind spots
 *   node scripts/instrumentation.mjs check        # stale/new vs manifest (--strict to fail)
 *   node scripts/instrumentation.mjs bless         # write current signatures to manifest
 */
import {
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_SRC = join(__dirname, '..', '..', 'packages', 'frontend', 'src');
const MANIFEST = join(__dirname, '..', 'instrumentation-manifest.json');

const COUNTERS = {
  button: /<button[\s>/]/g,
  input: /<input[\s>/]/g,
  select: /<select[\s>]/g,
  textarea: /<textarea[\s>]/g,
  anchor: /<a\s[^>]*href/g,
  onClick: /\bonClick\s*=/g,
  onChange: /\bonChange\s*=/g,
  onInput: /\bonInput\s*=/g,
  onKeyDown: /\bonKeyDown\s*=/g,
  onSubmit: /\bonSubmit\s*=/g,
};
const TESTID_RE = /data-testid\s*=/g;

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
    } else if (/\.(tsx|jsx)$/.test(entry)) {
      out.push(full);
    }
  }
}

function count(text, re) {
  return (text.match(re) ?? []).length;
}

/** Analyse one file → its interactive signature, or null if not interactive. */
export function analyzeFile(text) {
  if (text.includes('instrumentation-ignore-file')) return { excluded: true };
  // Exclude 3D/canvas components — their handlers are on meshes, not DOM.
  if (/@react-three\/fiber|from ['"]three['"]/.test(text))
    return { excluded: true };

  const counts = {};
  let interactive = 0;
  for (const [k, re] of Object.entries(COUNTERS)) {
    counts[k] = count(text, re);
    interactive += counts[k];
  }
  if (interactive === 0) return null; // no interactive UI → not in scope
  const testids = count(text, TESTID_RE);
  // Signature drives staleness: any change to the interactive surface (incl.
  // testid count) drifts it. Editing handler internals does not.
  const sig = createHash('sha1')
    .update(JSON.stringify({ ...counts, testids }))
    .digest('hex')
    .slice(0, 12);
  return { counts, testids, instrumented: testids > 0, sig };
}

export function analyzeAll(srcDir = FRONTEND_SRC) {
  const files = [];
  walk(srcDir, files);
  const interactive = []; // { rel, testids, instrumented, sig, counts }
  let excluded = 0;
  for (const file of files) {
    const res = analyzeFile(readFileSync(file, 'utf8'));
    if (!res) continue;
    if (res.excluded) {
      excluded++;
      continue;
    }
    interactive.push({ rel: relative(srcDir, file).replace(/\\/g, '/'), ...res });
  }
  interactive.sort((a, b) => a.rel.localeCompare(b.rel));
  const instrumented = interactive.filter((f) => f.instrumented);
  return {
    interactive,
    instrumented,
    excluded,
    pct: interactive.length
      ? Math.round((instrumented.length / interactive.length) * 1000) / 10
      : 0,
  };
}

function summarizeCounts(counts) {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}:${n}`)
    .join(' ');
}

function loadManifest() {
  if (!existsSync(MANIFEST)) return null;
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function cmdReport() {
  const a = analyzeAll();
  const line = '─'.repeat(60);
  console.log(line);
  console.log(
    `Instrumentation coverage (file-level): ${a.instrumented.length} / ${a.interactive.length} interactive component files carry a data-testid (${a.pct}%)`
  );
  const blind = a.interactive.filter((f) => !f.instrumented);
  if (blind.length) {
    console.log('Interactive components with NO test ids (control-coverage blind spots):');
    for (const f of blind) console.log(`  ${f.rel}  (${summarizeCounts(f.counts)})`);
  } else {
    console.log('Every interactive component carries at least one test id. 🎉');
  }
  console.log(`(${a.excluded} 3D/canvas or opted-out files excluded)`);
  console.log(line);
}

function cmdCheck() {
  const a = analyzeAll();
  const manifest = loadManifest();
  const strict = process.argv.includes('--strict');
  if (!manifest) {
    console.log(
      '[instrumentation] no manifest yet — run `bless` to record the current surface.'
    );
    process.exit(0);
  }
  const stale = [];
  const fresh = [];
  for (const f of a.interactive) {
    if (!(f.rel in manifest)) fresh.push(f);
    else if (manifest[f.rel] !== f.sig) stale.push(f);
  }
  const removed = Object.keys(manifest).filter(
    (rel) => !a.interactive.some((f) => f.rel === rel)
  );

  if (!stale.length && !fresh.length && !removed.length) {
    console.log(
      `[instrumentation] manifest up to date — ${a.interactive.length} interactive files reviewed.`
    );
    return;
  }
  if (stale.length) {
    console.log('STALE — interactive surface changed; re-review test ids then `bless`:');
    for (const f of stale) console.log(`  ${f.rel}  (${summarizeCounts(f.counts)})`);
  }
  if (fresh.length) {
    console.log('NEW — interactive component not yet reviewed; add test ids then `bless`:');
    for (const f of fresh) console.log(`  ${f.rel}  (${summarizeCounts(f.counts)})`);
  }
  if (removed.length) {
    console.log('GONE — in manifest but no longer interactive (run `bless` to prune):');
    for (const rel of removed) console.log(`  ${rel}`);
  }
  if (strict) process.exit(1);
}

function cmdBless() {
  const a = analyzeAll();
  const manifest = {};
  for (const f of a.interactive) manifest[f.rel] = f.sig;
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `[instrumentation] blessed ${a.interactive.length} interactive files → ${relative(process.cwd(), MANIFEST)}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] ?? 'report';
  if (cmd === 'report') cmdReport();
  else if (cmd === 'check') cmdCheck();
  else if (cmd === 'bless') cmdBless();
  else {
    console.error(`unknown command "${cmd}" (expected report|check|bless)`);
    process.exit(2);
  }
}
