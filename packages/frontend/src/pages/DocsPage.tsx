import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { DocViewer } from '../help/DocViewer';
import { listDocTopics } from '../help/docs';
import { LanguageSwitcher } from '../components/LanguageSwitcher';

/**
 * Standalone, full-page documentation route — the target of the help window's
 * "pop out" button. Topic comes from the `:topic` param, the section from the
 * URL hash (`/docs/avatar#animation`).
 */
export function DocsPage() {
  const { t, i18n } = useTranslation('help');
  const navigate = useNavigate();
  const params = useParams<{ topic?: string }>();
  const lng = i18n.language;

  const fallbackTopic = listDocTopics(lng)[0]?.topic ?? null;
  const topic = params.topic ?? fallbackTopic;
  const [anchor, setAnchor] = useState<string | null>(
    () => window.location.hash.replace(/^#/, '') || null
  );

  // Keep the document title in sync for a nicer popped-out tab.
  useEffect(() => {
    document.title = `${t('window.title')} — vspark`;
  }, [t]);

  const onNavigate = useCallback(
    (tgt: string, tgtAnchor?: string | null) => {
      setAnchor(tgtAnchor ?? null);
      const hash = tgtAnchor ? `#${tgtAnchor}` : '';
      navigate(`/docs/${tgt}${hash}`);
    },
    [navigate]
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: '#0f0f0f',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div
        style={{
          height: 46,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 18px',
          borderBottom: '1px solid #2a2a2a',
          background: '#1a1a1a',
          color: '#ccc',
        }}
      >
        <strong style={{ color: '#e8e8e8' }}>{t('window.title')}</strong>
        <span style={{ color: '#444' }}>|</span>
        <button
          onClick={() => navigate('/')}
          style={{
            background: 'none',
            border: 'none',
            color: '#7ea2e0',
            cursor: 'pointer',
            fontSize: 13,
            padding: 0,
          }}
        >
          {t('page.backToApp')}
        </button>
        <div style={{ flex: 1 }} />
        <LanguageSwitcher />
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DocViewer topic={topic} anchor={anchor} onNavigate={onNavigate} variant="page" />
      </div>
    </div>
  );
}
