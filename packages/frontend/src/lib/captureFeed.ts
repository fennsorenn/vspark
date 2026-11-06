/**
 * Capture a feed template to a PNG using the SAME renderer the live feed layer
 * uses (compileTemplate + FeedContent from feedTemplate), rasterized in this
 * browser via html-to-image's SVG <foreignObject> path — the browser's own CSS
 * engine, so border-image / full CSS render faithfully (unlike html2canvas).
 *
 * Used by the assistant's render_feed_template tool: the backend asks the
 * connected editor to render a hypothetical template + sample data offscreen and
 * sends the PNG back, so no headless browser is needed server-side.
 */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { toPng } from 'html-to-image';
import { compileTemplate, FeedContent, FeedErrorBoundary } from './feedTemplate';
import { inlineCssAssetUrls } from './cssInline';

export interface CaptureFeedOpts {
  template: string;
  css?: string;
  data?: Record<string, unknown>;
  width: number;
  height: number;
  background?: string;
}

/** Render the feed offscreen and return a `data:image/png;base64,…` url. */
export async function captureFeedImage(opts: CaptureFeedOpts): Promise<string> {
  const { template, css = '', data = {}, width, height, background } = opts;
  const scopeId = 'feed-capture';

  // Must sit IN the viewport for html-to-image to capture it (it clips by
  // bounding rect — an off-screen `left:-99999px` host rasterizes blank), so we
  // hide it behind the app with z-index:-1 instead. It's removed right after.
  const host = document.createElement('div');
  Object.assign(host.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    zIndex: '-1',
    width: `${width}px`,
    height: `${height}px`,
    overflow: 'hidden',
    boxSizing: 'border-box',
    background: background ?? 'transparent',
    fontFamily: 'system-ui, sans-serif',
  });
  host.setAttribute('data-feed-scope', scopeId);
  document.body.appendChild(host);
  const root = createRoot(host);

  try {
    const compiled = compileTemplate(template);
    // Inline url() assets (e.g. a border-image) — the foreignObject can't fetch
    // them and html-to-image doesn't inline border-image-source.
    const inlinedCss = css ? await inlineCssAssetUrls(css) : '';
    const scopedCss = inlinedCss
      ? `@scope ([data-feed-scope="${scopeId}"]) {\n${inlinedCss}\n}`
      : '';
    flushSync(() => {
      root.render(
        createElement(
          'div',
          { style: { width: '100%', height: '100%' } },
          scopedCss ? createElement('style', null, scopedCss) : null,
          compiled.render
            ? createElement(FeedErrorBoundary, {
                key: template,
                children: createElement(FeedContent, {
                  render: compiled.render,
                  channels: data,
                }),
              })
            : createElement(
                'div',
                { style: { color: '#f55', font: '12px monospace', padding: 8 } },
                `template error: ${compiled.error ?? 'unknown'}`
              )
        )
      );
    });

    // Wait for emote <img>s to load so they're captured (border-image url()s are
    // inlined by html-to-image itself).
    const imgs = Array.from(host.querySelectorAll('img'));
    for (const img of imgs) img.crossOrigin = 'anonymous';
    await Promise.all(
      imgs.map((img) =>
        img.complete && img.naturalWidth > 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            })
      )
    );

    return await toPng(host, {
      width,
      height,
      pixelRatio: 2,
      backgroundColor: background,
      cacheBust: true,
    });
  } finally {
    queueMicrotask(() => root.unmount());
    host.remove();
  }
}
