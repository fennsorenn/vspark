/**
 * Headless feed-preview entry. This is bundled (esbuild) and loaded in a
 * headless browser by the backend `render_feed_template` tool so a preview is
 * produced by the SAME renderer the live feed layer uses — `compileTemplate` +
 * `FeedContent` from lib/feedTemplate, with the exact `@scope` CSS wrapping the
 * `FeedLayer` applies (see ComposeLayerStack.FeedLayer). No parallel renderer.
 *
 * The bundle exposes `window.__renderFeed({template, css, data})`; the backend
 * calls it with a sample data payload, waits for paint, and screenshots.
 */
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import {
  compileTemplate,
  FeedContent,
  FeedErrorBoundary,
} from '../lib/feedTemplate';

interface PreviewOpts {
  template: string;
  css?: string;
  data?: Record<string, unknown>;
}

const SCOPE_ID = 'feed-preview';

function Preview({ template, css, data }: PreviewOpts) {
  const compiled = compileTemplate(template);
  const scopedCss = css
    ? `@scope ([data-feed-scope="${SCOPE_ID}"]) {\n${css}\n}`
    : '';
  return createElement(
    'div',
    {
      'data-feed-scope': SCOPE_ID,
      style: { width: '100%', height: '100%', boxSizing: 'border-box' },
    },
    scopedCss ? createElement('style', null, scopedCss) : null,
    compiled.render
      ? createElement(FeedErrorBoundary, {
          key: template,
          children: createElement(FeedContent, {
            render: compiled.render,
            channels: data ?? {},
          }),
        })
      : createElement(
          'div',
          { style: { color: '#f55', font: '13px monospace', padding: 8 } },
          `template error: ${compiled.error ?? 'unknown'}`
        )
  );
}

const root = createRoot(document.getElementById('root')!);

declare global {
  interface Window {
    __renderFeed: (opts: PreviewOpts) => void;
    __previewReady: boolean;
  }
}

window.__renderFeed = (opts: PreviewOpts) => {
  root.render(createElement(Preview, opts));
};
window.__previewReady = true;
