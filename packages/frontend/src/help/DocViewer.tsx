import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import { rehypeHeadingIds } from './rehypeHeadingIds';
import { getDocMarkdown, listDocTopics } from './docs';

interface Props {
  topic: string | null;
  anchor?: string | null;
  /** Called when the user picks another page or an in-doc link is followed. */
  onNavigate: (topic: string, anchor?: string | null) => void;
  /** `page` renders a wider, full-height layout for the popped-out route. */
  variant?: 'window' | 'page';
}

/**
 * Shared markdown documentation renderer used by both the floating help window
 * and the popped-out `/docs` page. Renders a topic nav on the left and the
 * selected page on the right, deep-scrolling to `anchor` when provided.
 */
export function DocViewer({ topic, anchor, onNavigate, variant = 'window' }: Props) {
  const { t, i18n } = useTranslation('help');
  const lng = i18n.language;
  const contentRef = useRef<HTMLDivElement>(null);

  const topics = useMemo(() => listDocTopics(lng), [lng]);
  const markdown = useMemo(
    () => (topic ? getDocMarkdown(topic, lng) : null),
    [topic, lng]
  );

  // Scroll to the requested anchor (or to the top) once the page is rendered.
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    if (anchor) {
      // Defer one frame so react-markdown has committed the heading ids.
      const id = requestAnimationFrame(() => {
        const el = container.querySelector(`#${CSS.escape(anchor)}`);
        if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        else container.scrollTo({ top: 0 });
      });
      return () => cancelAnimationFrame(id);
    }
    container.scrollTo({ top: 0 });
  }, [topic, anchor, markdown]);

  const handleLinkClick = (href: string | undefined, e: React.MouseEvent) => {
    if (!href) return;
    // Internal cross-page link: `topic:scene` or `topic:scene#animation`.
    if (href.startsWith('topic:')) {
      e.preventDefault();
      const [tgtTopic, tgtAnchor] = href.slice('topic:'.length).split('#');
      onNavigate(tgtTopic, tgtAnchor || null);
      return;
    }
    // Same-page anchor.
    if (href.startsWith('#')) {
      e.preventDefault();
      if (topic) onNavigate(topic, href.slice(1));
      return;
    }
    // External links open in a new tab.
    if (/^https?:/.test(href)) {
      e.preventDefault();
      window.open(href, '_blank', 'noopener');
    }
  };

  const isPage = variant === 'page';

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, color: '#d4d4d4' }}>
      <DocStyles />
      {/* Topic nav */}
      <nav
        style={{
          width: isPage ? 240 : 168,
          flexShrink: 0,
          borderRight: '1px solid #2a2a2a',
          overflowY: 'auto',
          padding: '10px 8px',
          background: '#141414',
        }}
      >
        <div
          style={{
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: '#666',
            padding: '0 8px 6px',
          }}
        >
          {t('nav.topics')}
        </div>
        {topics.map((tp) => {
          const active = tp.topic === topic;
          return (
            <button
              key={tp.topic}
              onClick={() => onNavigate(tp.topic, null)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                background: active ? '#23314a' : 'none',
                border: 'none',
                borderRadius: 5,
                color: active ? '#cfe0ff' : '#bbb',
                cursor: 'pointer',
                fontSize: isPage ? 14 : 13,
                padding: '6px 8px',
                marginBottom: 1,
              }}
            >
              {tp.title}
            </button>
          );
        })}
      </nav>

      {/* Content */}
      <div
        ref={contentRef}
        className="vspark-doc"
        style={{
          flex: 1,
          minWidth: 0,
          overflowY: 'auto',
          padding: isPage ? '28px 40px' : '16px 22px',
          fontSize: isPage ? 15 : 13.5,
          lineHeight: 1.6,
          maxWidth: isPage ? 820 : undefined,
        }}
      >
        {markdown ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHeadingIds, rehypeSlug]}
            // Preserve our custom `topic:` and in-page `#` link schemes;
            // react-markdown's default urlTransform strips unknown protocols
            // (which would blank out the href).
            urlTransform={(url) => url}
            components={{
              // Don't spread the remaining props — they include react-markdown's
              // `node`, which would leak onto the DOM element as node="[object Object]".
              a: ({ href, children }) => (
                <a href={href} onClick={(e) => handleLinkClick(href, e)}>
                  {children}
                </a>
              ),
            }}
          >
            {markdown}
          </ReactMarkdown>
        ) : (
          <div style={{ color: '#666', fontSize: 13, paddingTop: 20 }}>
            {topic ? t('error.missing', { topic }) : t('error.noTopic')}
          </div>
        )}
      </div>
    </div>
  );
}

/** Scoped dark-theme styling for the rendered markdown. */
function DocStyles() {
  return (
    <style>{`
      .vspark-doc h1, .vspark-doc h2, .vspark-doc h3, .vspark-doc h4 {
        color: #f0f0f0; font-weight: 600; line-height: 1.3;
        margin: 1.4em 0 0.5em; scroll-margin-top: 12px;
      }
      .vspark-doc h1 { font-size: 1.7em; margin-top: 0; }
      .vspark-doc h2 { font-size: 1.32em; border-bottom: 1px solid #262626; padding-bottom: 4px; }
      .vspark-doc h3 { font-size: 1.12em; }
      .vspark-doc p { margin: 0.6em 0; }
      .vspark-doc a { color: #6ea8fe; text-decoration: none; cursor: pointer; }
      .vspark-doc a:hover { text-decoration: underline; }
      .vspark-doc ul, .vspark-doc ol { margin: 0.5em 0; padding-left: 1.4em; }
      .vspark-doc li { margin: 0.25em 0; }
      .vspark-doc code {
        background: #1d1d1d; border: 1px solid #2c2c2c; border-radius: 4px;
        padding: 1px 5px; font-size: 0.88em; font-family: ui-monospace, monospace;
      }
      .vspark-doc pre {
        background: #111; border: 1px solid #262626; border-radius: 6px;
        padding: 12px 14px; overflow-x: auto;
      }
      .vspark-doc pre code { background: none; border: none; padding: 0; }
      .vspark-doc blockquote {
        margin: 0.8em 0; padding: 2px 14px; border-left: 3px solid #3a4a6a;
        color: #aab; background: #15171b; border-radius: 0 6px 6px 0;
      }
      .vspark-doc table { border-collapse: collapse; margin: 0.8em 0; }
      .vspark-doc th, .vspark-doc td { border: 1px solid #2c2c2c; padding: 5px 10px; }
      .vspark-doc th { background: #1a1a1a; }
      .vspark-doc hr { border: none; border-top: 1px solid #262626; margin: 1.4em 0; }
      .vspark-doc img {
        max-width: 100%; display: block; margin: 12px 0;
        background: #0d1117; border: 1px solid #20242c;
        border-radius: 6px; padding: 8px;
      }
      .vspark-doc p > em:only-child {
        display: block; color: #97a3b6; font-size: 0.9em; margin-top: -4px;
      }
    `}</style>
  );
}
