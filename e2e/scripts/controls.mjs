#!/usr/bin/env node
/**
 * Control enumeration — the honest denominator for control coverage.
 *
 * Walks the frontend source with the TypeScript AST and enumerates every
 * interactive control (not just the ones that happen to carry a targeting
 * handle), so control coverage is "of ALL controls, how many does a test
 * exercise?" — not "of the instrumented subset". Each control records its
 * targeting handle (if any) and whether it is opted out.
 *
 * A control is an intrinsic interactive element (`button`, `input`, `select`,
 * `textarea`, `a` with href), any JSX element carrying an
 * `on{Click,Change,Input,KeyDown,Submit,PointerDown,MouseDown,DoubleClick}`
 * handler, OR a usage of a registered reusable interactive component (the
 * `COMPONENTS` set below — e.g. the numeric-input primitives, whose custom
 * callback prop names prop-name detection would otherwise miss). 3D/canvas files
 * (react-three-fiber) are skipped — their handlers are on meshes, not DOM.
 *
 * ── Targeting handle (`vs-` class) ──────────────────────────────────────────
 * A control's handle is its `vs-`-prefixed CSS class — the stable targeting
 * layer that addons, userscripts, custom themes AND tests all key on (a real,
 * multi-consumer artifact, NOT test-only scaffolding). Styling classes never
 * carry the `vs-` prefix; the prefix is what lets this enumerator tell the
 * targeting layer apart from styling noise. Handles are extracted as literal
 * `vs-…` tokens from a control's `className` attribute (string, expression, or
 * template — any literal `vs-` token in the initializer counts).
 *
 * ── Opt-out (kept OUT of src/) ──────────────────────────────────────────────
 * Coverage opt-out is pure test metadata, so it lives in `e2e/coverage-ignore.json`,
 * not in the markup. It excludes by frontend-src file (glob/prefix) or by handle
 * (or `relpath:line`). See that file's `_comment`.
 *
 * Derived signals (computed in the reporter):
 *   control coverage   = exercised / active-controls   (exercised = handle interacted with)
 *   instrumentation    = controls-with-a-handle / active-controls
 *
 * Staleness: each file's controls hash to a signature; an edit that changes the
 * control surface (adds a control, drops/edits a handle) drifts it and `check`
 * flags it STALE until re-`bless`ed — so new controls can't slip past.
 *
 * Usage:
 *   node scripts/controls.mjs report        # control list summary + blind spots
 *   node scripts/controls.mjs check          # stale/new vs manifest (--strict to fail)
 *   node scripts/controls.mjs bless           # record current surface as reviewed
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
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_SRC = join(__dirname, '..', '..', 'packages', 'frontend', 'src');
const MANIFEST = join(__dirname, '..', 'controls-manifest.json');
const IGNORE_FILE = join(__dirname, '..', 'coverage-ignore.json');

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

// Reusable interactive components: every USAGE counts as a control, regardless
// of which callback props it passes. Prop-name detection alone misses these —
// their handlers are custom-named (`onCommit`, `onSetKeyframe`, `onValueChange`),
// not DOM-standard — so a usage wiring only `onCommit` would slip through. Each
// must forward a per-call-site `vs-` handle (a `className` prop spread onto its
// root) so distinct usages are attributed independently; the component's own
// internal controls are opted out in `coverage-ignore.json` (implementation, not
// a distinct interface surface). Extend this set as more primitives are added.
const COMPONENTS = new Set(['NumInput', 'VecInput', 'SliderInput']);

/** Any literal `vs-…` token anywhere in a string. */
const VS_TOKEN = /vs-[A-Za-z0-9_-]+/g;

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
    : (attr.name?.getText?.() ?? '');
}

/** Extract literal `vs-` targeting handles from a className initializer node. */
function handlesFromClassName(init, sf) {
  if (!init) return [];
  // String literal, expression-wrapped string, template, clsx(...) — in every
  // case any literal `vs-` token in the source text is a stable handle.
  const text = init.getText(sf);
  const found = text.match(VS_TOKEN);
  return found ? [...new Set(found)] : [];
}

/** Inspect a JSX opening element → control descriptor or null. */
function inspectElement(node, tagText, sf) {
  const attrs =
    node.attributes && node.attributes.properties
      ? node.attributes.properties
      : [];
  let hasHandler = false;
  let hasHref = false;
  let handles = [];

  for (const attr of attrs) {
    if (attr.kind !== ts.SyntaxKind.JsxAttribute) continue;
    const name = attrName(attr);
    if (HANDLERS.has(name)) hasHandler = true;
    else if (name === 'href') hasHref = true;
    else if (name === 'className')
      handles = handlesFromClassName(attr.initializer, sf);
  }

  const intrinsic = INTRINSIC.has(tagText);
  const anchor = tagText === 'a' && (hasHref || hasHandler);
  const component = COMPONENTS.has(tagText);
  if (!intrinsic && !anchor && !hasHandler && !component) return null;
  return { tag: tagText, handle: handles[0] ?? null, handles };
}

export function enumerateControls(srcDir = FRONTEND_SRC) {
  const ignore = loadIgnore();
  const files = [];
  walk(srcDir, files);
  const controls = [];
  let excludedFiles = 0;

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    // Auto-skip 3D/canvas files — their handlers live on meshes, not the DOM
    // (this is a structural fact, not a test-metadata opt-out).
    if (/@react-three\/fiber|from ['"]three['"]/.test(text)) {
      excludedFiles++;
      continue;
    }
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const rel = relative(srcDir, file).replace(/\\/g, '/');
    if (ignore.fileMatches(rel)) {
      excludedFiles++;
      continue;
    }
    const visit = (node) => {
      if (
        node.kind === ts.SyntaxKind.JsxOpeningElement ||
        node.kind === ts.SyntaxKind.JsxSelfClosingElement
      ) {
        const tagText = node.tagName.getText(sf);
        const ctl = inspectElement(node, tagText, sf);
        if (ctl) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          const optedOut = ignore.controlMatches(ctl.handle, rel, line + 1);
          controls.push({ rel, line: line + 1, ...ctl, optedOut });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  controls.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
  return { controls, excludedFiles };
}

/** Per-file signature for staleness (element-level: tag + handle + optout). */
export function fileSignatures(controls) {
  const byFile = new Map();
  for (const c of controls) {
    const sig = `${c.tag}#${c.handle ?? '-'}${c.optedOut ? '!' : ''}`;
    byFile.set(c.rel, (byFile.get(c.rel) ?? '') + sig + '|');
  }
  const out = {};
  for (const [rel, s] of byFile)
    out[rel] = createHash('sha1').update(s).digest('hex').slice(0, 12);
  return out;
}

// ── Opt-out config (test-only metadata, kept out of src/) ─────────────────────
function loadIgnore() {
  let cfg = { files: [], controls: [] };
  if (existsSync(IGNORE_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(IGNORE_FILE, 'utf8'));
      cfg = { files: parsed.files ?? [], controls: parsed.controls ?? [] };
    } catch {
      /* malformed — treat as empty */
    }
  }
  const fileMatchers = cfg.files.map(globToRegExp);
  const controlSet = new Set(cfg.controls);
  return {
    fileMatches: (rel) => fileMatchers.some((re) => re.test(rel)),
    controlMatches: (handle, rel, line) =>
      (handle != null && controlSet.has(handle)) ||
      controlSet.has(`${rel}:${line}`),
  };
}

/** Minimal glob → RegExp: supports `*` (any non-slash) and `**` (any), else exact. */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pat = escaped
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*');
  return new RegExp(`^${pat}$`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function summarize() {
  const { controls, excludedFiles } = enumerateControls();
  const active = controls.filter((c) => c.optedOut === false);
  const withHandle = active.filter((c) => c.handle);
  return { controls, active, withHandle, excludedFiles };
}

function cmdReport() {
  const { controls, active, withHandle, excludedFiles } = summarize();
  const optedOut = controls.length - active.length;
  const instrPct = active.length
    ? Math.round((withHandle.length / active.length) * 1000) / 10
    : 0;
  const line = '─'.repeat(64);
  console.log(line);
  console.log(
    `Controls: ${controls.length} total (${optedOut} opted out → ${active.length} active)`
  );
  console.log(
    `Instrumentation: ${withHandle.length} / ${active.length} active controls have a vs- handle (${instrPct}%)`
  );
  const blind = active.filter((c) => !c.handle);
  if (blind.length) {
    console.log(`Active controls with NO vs- handle (${blind.length}):`);
    for (const c of blind) console.log(`  ${c.rel}:${c.line}  <${c.tag}>`);
  }
  console.log(`(${excludedFiles} 3D/canvas or opted-out files excluded)`);
  console.log(line);
}

function loadManifest() {
  return existsSync(MANIFEST)
    ? JSON.parse(readFileSync(MANIFEST, 'utf8'))
    : null;
}

function cmdCheck() {
  const { controls } = summarize();
  const current = fileSignatures(controls);
  const manifest = loadManifest();
  const strict = process.argv.includes('--strict');
  if (!manifest) {
    console.log(
      '[controls] no manifest yet — run `bless` to record the current surface.'
    );
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
    console.log(
      `[controls] manifest up to date — ${Object.keys(current).length} files reviewed.`
    );
    return;
  }
  if (stale.length) {
    console.log(
      'STALE — control surface changed; re-review handles then `bless`:'
    );
    for (const rel of stale) console.log(`  ${rel}`);
  }
  if (fresh.length) {
    console.log(
      'NEW — file with controls not yet reviewed; add handles then `bless`:'
    );
    for (const rel of fresh) console.log(`  ${rel}`);
  }
  if (removed.length) {
    console.log(
      'GONE — in manifest but no controls now (run `bless` to prune):'
    );
    for (const rel of removed) console.log(`  ${rel}`);
  }
  if (strict) process.exit(1);
}

function cmdBless() {
  const { controls } = summarize();
  writeFileSync(
    MANIFEST,
    JSON.stringify(fileSignatures(controls), null, 2) + '\n'
  );
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
