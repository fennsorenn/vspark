/**
 * Inline `url(...)` asset references in a CSS string as base64 data URLs.
 *
 * Needed for offscreen rasterization (captureFeed / the 3D feed node): they
 * render through an SVG <foreignObject>, which is loaded in an isolated context
 * that cannot fetch external resources — and html-to-image inlines
 * background-image/<img> but NOT `border-image-source`. So any url() the feed
 * CSS references (notably a border-image) must be inlined up front or it won't
 * appear. Results are cached by url (the same asset is reused every re-render).
 */
const cache = new Map<string, string>();
const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

async function toDataUrl(url: string): Promise<string | null> {
  if (cache.has(url)) return cache.get(url)!;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(new Error('read failed'));
      r.readAsDataURL(blob);
    });
    cache.set(url, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

/** Replace every non-data `url(...)` in the CSS with an inlined data URL. URLs
 *  that can't be fetched are left untouched. */
export async function inlineCssAssetUrls(css: string): Promise<string> {
  if (!css.includes('url(')) return css;
  const urls = new Set<string>();
  for (const m of css.matchAll(URL_RE)) {
    const u = m[2];
    if (u && !u.startsWith('data:')) urls.add(u);
  }
  if (!urls.size) return css;
  const resolved = new Map<string, string>();
  await Promise.all(
    [...urls].map(async (u) => {
      const d = await toDataUrl(u);
      if (d) resolved.set(u, d);
    })
  );
  return css.replace(URL_RE, (whole, _q, u: string) =>
    resolved.has(u) ? `url(${resolved.get(u)})` : whole
  );
}
