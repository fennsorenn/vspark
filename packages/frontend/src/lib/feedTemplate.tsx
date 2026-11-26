import {
  Component,
  createElement,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
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

/** Seconds as a clock: `auto` → `M:SS` under an hour, else `H:MM:SS` (hours
 *  keep counting past 24); `hh:mm:ss` / `mm:ss` force the layout (`mm:ss`
 *  counts minutes past 59). */
export function formatCountdown(seconds: number, format = 'auto'): string {
  const total = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p2 = (n: number) => String(n).padStart(2, '0');
  if (format === 'mm:ss') return `${p2(Math.floor(total / 60))}:${p2(s)}`;
  if (format === 'hh:mm:ss') return `${p2(h)}:${p2(m)}:${p2(s)}`;
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
}

/** What a timer looks like when published: the Deadline node's `state`. */
export interface CountdownState {
  /** Epoch seconds it ends at while running. */
  endsAt?: number | null;
  /** Seconds left while paused / not started. */
  remaining?: number;
  running?: boolean;
  /** The publisher's clock (epoch seconds) when it published — corrects for
   *  a viewer whose clock differs. */
  now?: number;
}

/**
 * Host-provided component for feed templates: a clock that counts down on the
 * page, so the graph only publishes when the end time changes (start, pause,
 * time added) — never once per second. Pass the Deadline node's `state` as
 * `state`, or `to` (epoch seconds) for a plain count down to a moment.
 *
 *   <${Countdown} state=${timer} format="auto" />
 */
export function Countdown({
  state,
  to,
  format = 'auto',
  className,
}: {
  state?: CountdownState | null;
  to?: number | null;
  format?: string;
  className?: string;
}) {
  const running = to != null ? true : state?.running === true;
  const endsAt = to ?? state?.endsAt ?? null;
  const frozen = state?.remaining ?? 0;
  // The publisher's clock minus ours, taken when a new state arrives.
  const skew = useMemo(
    () =>
      typeof state?.now === 'number' ? state.now - Date.now() / 1000 : 0,
    [state?.now]
  );
  const left = () =>
    running && typeof endsAt === 'number'
      ? endsAt - (Date.now() / 1000 + skew)
      : frozen;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running || typeof endsAt !== 'number') return;
    const id = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [running, endsAt]);
  return <span className={className}>{formatCountdown(left(), format)}</span>;
}

export type FeedRender = (
  html: unknown,
  Emote: unknown,
  channels: Record<string, unknown>,
  Countdown: unknown
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
 * `chat` is referenced as `${chat.map(...)}`); the `Emote` and `Countdown`
 * helpers are also in scope. Field names must be valid JS identifiers to be referenced bare.
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
      'Countdown',
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
    return <>{render(html, Emote, channels, Countdown)}</>;
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
