#!/usr/bin/env node
/**
 * Control enumeration — the honest denominator for control coverage.
 *
 * Walks the frontend source with the TypeScript AST and enumerates every
 * interactive control (not just the ones that happen to carry a `data-testid`),
 * so control coverage is "of ALL controls, how many does a test exercise?" — not
 * "of the instrumented subset". Each control records its `data-testid` (if any)
 * and whether it is opted out.
 *
 * A control is an intrinsic interactive element (`button`, `input`, `select`,
 * `textarea`, `a` with href) OR any JSX element carrying an
 * `on{Click,Change,Input,KeyDown,Submit,PointerDown,MouseDown,DoubleClick}`
 * handler. 3D/canvas files (react-three-fiber) are skipped — their handlers are
 * on meshes, not DOM. Opt a single control out with a `data-coverage-ignore`
 * prop; opt a whole file out with an "instrumentation-ignore-file" marker.
 *
 * Derived signals (computed in the reporter):
 *   control coverage   = exercised / active-controls   (exercised = testid interacted with)
 *   instrumentation    = controls-with-testid / active-controls
 *
 * Staleness: each file's controls hash to a signature; an edit that changes the
 * control surface (adds a control, drops/edits a testid, opts out) drifts it and
 * `check` flags it STALE until re-`bless`ed — so new controls can't slip past.
 *
 * Usage:
 *   node scripts/controls.mjs report        # control list summary + blind spots
 *   node scripts/controls.mjs check          # stale/new vs manifest (--strict to fail)
 *   node scripts/controls.mjs bless           # record current surface as reviewed
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_SRC = join(__dirname, '..', '..', 'packages', 'frontend', 'src');
const MANIFEST = join(__dirname, '..', 'controls-manifest.json');

const INTRINSIC = new Set(['button', 'input', 'select', 'textarea']);
const HANDLERS = new Set([
  'onClick',
  'onChange',
  'onInput',
  'onKeyDown',
  'onSubmit',
  'onPointerDown',
  'onMouseDown',
  'onDoubleClick',
]);

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

function attrName(attr) {
  return attr.name && attr.name.escapedText
    ? String(attr.name.escapedText)
    : attr.name?.getText?.() ?? '';
}

/** Inspect a JSX opening element → control descriptor or null. */
function inspectElement(node, tagText) {
  const attrs =
    node.attributes && node.attributes.properties ? node.attributes.properties : [];
  let hasHandler = false;
  let hasHref = false;
  let testid = null;
  let testidDynamic = false;
  let optedOut = false;

  for (const attr of attrs) {
    if (attr.kind !== ts.SyntaxKind.JsxAttribute) continue;
    const name = attrName(attr);
    if (HANDLERS.has(name)) hasHandler = true;
    else if (name === 'href') hasHref = true;
    else if (name === 'data-coverage-ignore') optedOut = true;
    else if (name === 'data-testid') {
      const init = attr.initializer;
      if (init && ts.isStringLiteral(init)) testid = init.text;
      else if (
        init &&
        ts.isJsxExpression(init) &&
        init.expression &&
        ts.isStringLiteral(init.expression)
      )
        testid = init.expression.text;
      else testidDynamic = true; // present but not a static string
    }
  }

  const intrinsic = INTRINSIC.has(tagText);
  const anchor = tagText === 'a' && (hasHref || hasHandler);
  if (!intrinsic && !anchor && !hasHandler) return null;
  return { tag: tagText, testid, testidDynamic, optedOut };
}

export function enumerateControls(srcDir = FRONTEND_SRC) {
  const files = [];
  walk(srcDir, files);
  const controls = [];
  let excludedFiles = 0;

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (
      text.includes('instrumentation-ignore-file') ||
      /@react-three\/fiber|from ['"]three['"]/.test(text)
    ) {
      excludedFiles++;
      continue;
    }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const rel = relative(srcDir, file).replace(/\\/g, '/');
    const visit = (node) => {
      if (
        node.kind === ts.SyntaxKind.JsxOpeningElement ||
        node.kind === ts.SyntaxKind.JsxSelfClosingElement
      ) {
        const tagText = node.tagName.getText(sf);
        const ctl = inspectElement(node, tagText);
        if (ctl) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          controls.push({ rel, line: line + 1, ...ctl });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  controls.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
  return { controls, excludedFiles };
}

/** Per-file signature for staleness (element-level: tag + testid + optout). */
export function fileSignatures(controls) {
  const byFile = new Map();
  for (const c of controls) {
    const sig = `${c.tag}#${c.testid ?? (c.testidDynamic ? '~' : '-')}${c.optedOut ? '!' : ''}`;
    byFile.set(c.rel, (byFile.get(c.rel) ?? '') + sig + '|');
  }
  const out = {};
  for (const [rel, s] of byFile)
    out[rel] = createHash('sha1').update(s).digest('hex').slice(0, 12);
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function summarize() {
  const { controls, excludedFiles } = enumerateControls();
  const active = controls.filter((c) => c.optedOut === false);
  const withId = active.filter((c) => c.testid || c.testidDynamic);
  return { controls, active, withId, excludedFiles };
}

function cmdReport() {
  const { controls, active, withId, excludedFiles } = summarize();
  const optedOut = controls.length - active.length;
  const instrPct = active.length
    ? Math.round((withId.length / active.length) * 1000) / 10
    : 0;
  const line = '─'.repeat(64);
  console.log(line);
  console.log(`Controls: ${controls.length} total (${optedOut} opted out → ${active.length} active)`);
  console.log(
    `Instrumentation: ${withId.length} / ${active.length} active controls have a test id (${instrPct}%)`
  );
  const blind = active.filter((c) => !c.testid && !c.testidDynamic);
  if (blind.length) {
    console.log(`Active controls with NO test id (${blind.length}):`);
    for (const c of blind) console.log(`  ${c.rel}:${c.line}  <${c.tag}>`);
  }
  console.log(`(${excludedFiles} 3D/canvas or opted-out files excluded)`);
  console.log(line);
}

function loadManifest() {
  return existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null;
}

function cmdCheck() {
  const { controls } = summarize();
  const current = fileSignatures(controls);
  const manifest = loadManifest();
  const strict = process.argv.includes('--strict');
  if (!manifest) {
    console.log('[controls] no manifest yet — run `bless` to record the current surface.');
    process.exit(0);
  }
  const stale = [];
  const fresh = [];
  for (const rel of Object.keys(current)) {
    if (!(rel in manifest)) fresh.push(rel);
    else if (manifest[rel] !== current[rel]) stale.push(rel);
  }
  const removed = Object.keys(manifest).filter((rel) => !(rel in current));

  if (!stale.length && !fresh.length && !removed.length) {
    console.log(`[controls] manifest up to date — ${Object.keys(current).length} files reviewed.`);
    return;
  }
  if (stale.length) {
    console.log('STALE — control surface changed; re-review test ids then `bless`:');
    for (const rel of stale) console.log(`  ${rel}`);
  }
  if (fresh.length) {
    console.log('NEW — file with controls not yet reviewed; add test ids then `bless`:');
    for (const rel of fresh) console.log(`  ${rel}`);
  }
  if (removed.length) {
    console.log('GONE — in manifest but no controls now (run `bless` to prune):');
    for (const rel of removed) console.log(`  ${rel}`);
  }
  if (strict) process.exit(1);
}

function cmdBless() {
  const { controls } = summarize();
  writeFileSync(MANIFEST, JSON.stringify(fileSignatures(controls), null, 2) + '\n');
  console.log(`[controls] blessed → ${relative(process.cwd(), MANIFEST)}`);
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
