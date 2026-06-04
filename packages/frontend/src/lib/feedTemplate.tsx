import { Component, createElement, type ReactNode } from 'react';
import DOMPurify from 'dompurify';
import htm from 'htm';
import { TEXT_SANITIZE_OPTS } from './textSanitize';

/**
 * Shared data-channel feed template engine. Used by both surfaces that render a
 * data channel through a user-authored JSX-ish (htm) template:
 *   - the 2D `feed` compose layer (`ComposeLayerStack.FeedLayer`)
 *   - the 3D `feed` scene node (`Viewport.FeedCanvasNode`, rasterised to a
 *     CanvasTexture)
 * See dev-notes/modules/data-channels.md.
 */

/** htm bound to React.createElement — JSX-ish templates with no build step. */
export const html = htm.bind(createElement);

/** Host-provided component for feed templates: renders a per-field HTML blob
 *  (e.g. the chat `html` field with emote <img>s) safely. Templates inject raw
 *  HTML only through this; everything else is authored as JSX-ish markup and
 *  produced as real React elements. */
export function Emote({ html: raw }: { html?: string }) {
  return (
    <span
      dangerouslySetInnerHTML={{
        __html: DOMPurify.sanitize(raw ?? '', TEXT_SANITIZE_OPTS),
      }}
    />
  );
}

export type FeedRender = (
  html: unknown,
  Emote: unknown,
  channels: Record<string, unknown>
) => ReactNode;

export interface CompiledTemplate {
  render: FeedRender | null;
  error: string | null;
}

// Compiled templates are cached by source string — `new Function` (the htm
// "compile") runs once per distinct template, then re-renders are cheap.
const _templateCache = new Map<string, CompiledTemplate>();

/**
 * Compile a feed template (JSX-ish htm body) into a render function. The body is
 * interpolated into an htm tagged-template literal and evaluated as JS via
 * `new Function` — htm has no build step. The published fields visible to this
 * consumer are exposed as BARE NAMES via `with(channels)` (so a field labeled
 * `chat` is referenced as `${chat.map(...)}`); the `Emote` helper is also in
 * scope. Field names must be valid JS identifiers to be referenced bare.
 *
 * NOTE: templates execute as code. This is acceptable under vspark's local /
 * single-user model — no worse than the `browser` compose layer, which already
 * runs arbitrary web content. Revisit before any multi-user / untrusted-import
 * story (see dev-notes/modules/data-channels.md).
 */
export function compileTemplate(src: string): CompiledTemplate {
  const hit = _templateCache.get(src);
  if (hit) return hit;
  let result: CompiledTemplate;
  try {
    // `with` is sloppy-mode only; a `new Function` body is sloppy by default, so
    // it's allowed here and gives bare-name field access without knowing the
    // field set at compile time.
    const fn = new Function(
      'html',
      'Emote',
      'channels',
      `with (channels) { return html\`${src}\`; }`
    ) as FeedRender;
    result = { render: fn, error: null };
  } catch (e) {
    result = {
      render: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  _templateCache.set(src, result);
  return result;
}

/** Renders the compiled template. The htm tagged-template builds its React
 *  element tree synchronously, so a throw here (a bare field referenced before
 *  its producer has published, or a typo) is caught and rendered as nothing —
 *  and retried on the next data update, rather than latching like an error
 *  boundary would. Real syntax errors are caught at compile time. */
export function FeedContent({
  render,
  channels,
}: {
  render: FeedRender;
  channels: Record<string, unknown>;
}) {
  try {
    return <>{render(html, Emote, channels)}</>;
  } catch {
    return null;
  }
}

/** Backstop for any throw that escapes FeedContent's synchronous try/catch
 *  (e.g. a deferred render-phase throw) so a bad template can't white-screen the
 *  host. Reset by remounting (parent keys it on the template source). */
export class FeedErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

// Default JSX-ish (htm) template + CSS for a new `feed` surface — a chat overlay
// expecting a `set_data` node that publishes a field labeled `chat`. `\${`/`\``
// are escaped so the stored string carries literal `${`/backticks for htm.
export const FEED_DEFAULT_TEMPLATE = `<div className="chat">
  \${(chat || []).map((m) => html\`
    <div className="msg" key=\${m.id}>
      <span className="name" style=\${{ color: m.color || '#fff' }}>\${m.displayName}</span>: <\${Emote} html=\${m.html} />
    </div>
  \`)}
</div>`;

export const FEED_DEFAULT_CSS = `.chat { display:flex; flex-direction:column; justify-content:flex-end; height:100%; gap:6px; padding:12px; box-sizing:border-box; overflow:hidden; font-family:system-ui,sans-serif; }
.msg { background:rgba(0,0,0,.55); border-radius:8px; padding:6px 10px; color:#fff; line-height:1.35; animation:pop .25s ease-out; }
.msg .name { font-weight:700; }
.msg img { height:1.3em; vertical-align:-.25em; }
@keyframes pop { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }`;
