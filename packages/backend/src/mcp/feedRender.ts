/**
 * Server-side feed-template renderer for the assistant's `render_feed_template`
 * tool. It produces previews with the SAME renderer the live feed layer uses:
 * the frontend `lib/feedTemplate` (`compileTemplate` + `FeedContent` + `Emote`,
 * htm bound to React) is bundled by esbuild into a headless-browser entry
 * (`feedPreviewEntry.tsx`) and rasterized with headless Chromium. There is no
 * parallel template renderer — what you preview is what the feed layer renders.
 *
 * Both esbuild (first call, cached) and Chromium are required; if either is
 * unavailable the caller degrades gracefully.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The frontend preview entry that imports the real feed renderer. Resolved
 *  relative to this module so it works under tsx (monorepo source present);
 *  absent in a stripped production bundle → rendering degrades gracefully. */
function previewEntryPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const p = join(
    here,
    '../../../frontend/src/preview/feedPreviewEntry.tsx'
  );
  return existsSync(p) ? p : null;
}

/** esbuild-bundle the preview entry (React + htm + dompurify + the real
 *  renderer) into a single IIFE string. Cached for the process. */
let bundlePromise: Promise<string> | null = null;
function buildPreviewBundle(): Promise<string> {
  if (bundlePromise) return bundlePromise;
  bundlePromise = (async () => {
    const entry = previewEntryPath();
    if (!entry) throw new Error('feed preview entry source not found');
    const esbuild = await import('esbuild');
    const res = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      minify: true,
      loader: { '.tsx': 'tsx', '.ts': 'ts' },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    return res.outputFiles[0].text;
  })().catch((e) => {
    bundlePromise = null; // allow retry on transient failure
    throw e;
  });
  return bundlePromise;
}

/** Locate the pre-installed Chromium executable (env browsers dir layout varies
 *  by platform), or null if none is present. */
function findChromium(): string | null {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(root)) return null;
  let dirs: string[];
  try {
    dirs = readdirSync(root).filter((d) => /^chromium/.test(d));
  } catch {
    return null;
  }
  const subs = [
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-win/chrome.exe',
    'chrome-headless-shell-linux64/chrome-headless-shell',
  ];
  for (const d of dirs)
    for (const s of subs) {
      const p = join(root, d, s);
      if (existsSync(p)) return p;
    }
  return null;
}

export interface RasterizeOpts {
  template: string;
  css: string;
  data: Record<string, unknown>;
  width: number;
  height: number;
  background: string;
  /** Loopback origin so served `/uploads/...` urls in the CSS resolve. */
  origin: string;
}

/**
 * Render a feed template + CSS + sample data to a base64 PNG using the real
 * feed renderer in headless Chromium. Throws if esbuild or Chromium is
 * unavailable (the caller degrades gracefully).
 */
export async function rasterizeFeed(opts: RasterizeOpts): Promise<string> {
  const exe = findChromium();
  if (!exe) throw new Error('no Chromium executable found for headless rendering');
  const bundle = await buildPreviewBundle();
  // Resolve relative /uploads asset urls to the loopback origin so they load.
  const css = opts.css.replace(/url\(\s*\/uploads/g, `url(${opts.origin}/uploads`);
  const doc =
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html,body,#root{margin:0;width:${opts.width}px;height:${opts.height}px}` +
    `body{background:${opts.background};overflow:hidden;` +
    `font-family:system-ui,sans-serif;color:#222}</style></head>` +
    `<body><div id="root"></div><script>${bundle}</script></body></html>`;

  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: 2,
    });
    await page.setContent(doc, { waitUntil: 'load' });
    await page.waitForFunction('window.__previewReady === true', undefined, {
      timeout: 5000,
    });
    await page.evaluate(
      (payload) => {
        (
          globalThis as unknown as {
            __renderFeed: (o: unknown) => void;
          }
        ).__renderFeed(payload);
      },
      { template: opts.template, css, data: opts.data }
    );
    // Let React commit and any border-image / emote <img> assets load + paint.
    await page
      .waitForLoadState('networkidle', { timeout: 3000 })
      .catch(() => {});
    await page.waitForTimeout(250);
    const buf = await page.screenshot({ type: 'png' });
    return buf.toString('base64');
  } finally {
    await browser.close().catch(() => {});
  }
}
