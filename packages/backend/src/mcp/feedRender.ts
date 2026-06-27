/**
 * Server-side feed-template renderer for the assistant's `render_feed_template`
 * tool. Two stages:
 *   1. compile the htm/JSX-ish template with a sample data payload into a static
 *      HTML string (the SAME `new Function` + htm compile the frontend feed
 *      renderer uses — see frontend lib/feedTemplate.tsx — but bound to a string
 *      serializer instead of React.createElement);
 *   2. rasterize that HTML + the layer CSS to a PNG with headless Chromium.
 *
 * Why a real browser: the frontend rasterizes feeds with html2canvas, which does
 * NOT support `border-image` — exactly the property the assistant most often
 * needs to eyeball. Chromium renders it faithfully. Chromium is optional at
 * runtime: if it can't launch, the tool degrades to returning the compiled HTML.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import htm from 'htm';

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'source', 'track', 'wbr',
]);

const esc = (s: unknown): string =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string
  );

interface Html { __html: string }
const isHtml = (x: unknown): x is Html =>
  !!x && typeof x === 'object' && typeof (x as Html).__html === 'string';

function serialize(c: unknown): string {
  if (c == null || c === false || c === true) return '';
  if (Array.isArray(c)) return c.map(serialize).join('');
  if (isHtml(c)) return c.__html;
  return esc(c);
}

/** htm hyperscript bound to a string serializer (mirrors the React h-binding the
 *  frontend uses, but emits HTML text). Function "components" are invoked. */
function h(
  type: string | ((props: Record<string, unknown>) => unknown),
  props: Record<string, unknown> | null,
  ...children: unknown[]
): Html {
  if (typeof type === 'function') {
    return { __html: serialize(type({ ...(props ?? {}), children })) };
  }
  let attrs = '';
  if (props)
    for (const k of Object.keys(props)) {
      // React-only props that are not DOM attributes (the default feed template
      // uses key=${m.id}); and event handlers, which have no static markup.
      if (k === 'children' || k === 'key' || k === 'ref') continue;
      const v = props[k];
      if (v == null || v === false || typeof v === 'function') continue;
      // style=${{ color: … }} — React renders a style OBJECT to inline css; do
      // the same (camelCase → kebab-case) instead of stringifying to [object …].
      if (k === 'style' && v && typeof v === 'object') {
        const css = Object.entries(v as Record<string, unknown>)
          .filter(([, val]) => val != null && val !== '')
          .map(
            ([prop, val]) =>
              `${prop.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}:${val}`
          )
          .join(';');
        if (css) attrs += ` style="${esc(css)}"`;
        continue;
      }
      const name = k === 'className' ? 'class' : k;
      attrs += v === true ? ` ${name}` : ` ${name}="${esc(v)}"`;
    }
  const inner = children.map(serialize).join('');
  return {
    __html: VOID_TAGS.has(type)
      ? `<${type}${attrs}>`
      : `<${type}${attrs}>${inner}</${type}>`,
  };
}

const html = htm.bind(h);

/** Preview stand-in for the feed `Emote` helper: injects its raw html field. */
function Emote({ html: raw }: { html?: string }): Html {
  return { __html: raw == null ? '' : String(raw) };
}

/**
 * Compile a feed template with a data payload into an HTML string. `channels`
 * fields are exposed by bare name (a `chat` field → `${chat.map(...)}`), exactly
 * like the live renderer. Throws on a template syntax/runtime error.
 */
export function renderTemplateToHtml(
  template: string,
  channels: Record<string, unknown>
): string {
  const fn = new Function(
    'html',
    'Emote',
    'channels',
    'with (channels) { return html`' + template + '`; }'
  ) as (h: unknown, e: unknown, c: Record<string, unknown>) => unknown;
  return serialize(fn(html, Emote, channels ?? {}));
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
  html: string;
  css: string;
  width: number;
  height: number;
  background: string;
  /** Loopback origin so served `/uploads/...` urls in the CSS resolve. */
  origin: string;
}

/**
 * Rasterize compiled feed HTML + CSS to a base64 PNG via headless Chromium.
 * Throws if no Chromium is available (the caller degrades gracefully).
 */
export async function rasterizeFeed(opts: RasterizeOpts): Promise<string> {
  const exe = findChromium();
  if (!exe) throw new Error('no Chromium executable found for headless rendering');
  // Resolve relative /uploads asset urls to the loopback origin so they load.
  const css = opts.css.replace(/url\(\s*\/uploads/g, `url(${opts.origin}/uploads`);
  const doc =
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0}body{width:${opts.width}px;height:${opts.height}px;` +
    `background:${opts.background};overflow:hidden;` +
    `font-family:system-ui,sans-serif;color:#222}` +
    `${css}</style></head><body>${opts.html}</body></html>`;

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
    await page.setContent(doc, { waitUntil: 'networkidle' });
    await page.waitForTimeout(150);
    const buf = await page.screenshot({ type: 'png' });
    return buf.toString('base64');
  } finally {
    await browser.close().catch(() => {});
  }
}
