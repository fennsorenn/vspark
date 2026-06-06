import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { MediaInputWindow } from '../components/MediaInputWindow';
import { useEditorStore } from '../store/editorStore';

/**
 * Standalone page for the Media Input window — can be opened in a separate tab
 * so the main editor doesn't need to remain in focus.
 * Route: /media-input/:projectId
 */
export function MediaInputPage() {
  const { t } = useTranslation('media');
  const { projectId } = useParams<{ projectId: string }>();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setNodes, setActiveScene, setBehaviors } = useEditorStore();

  // Fetch the project/scene/nodes so MediaInputWindow can resolve component IDs
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    async function load() {
      try {
        const { scenes, nodes, behaviors } = await api.getScenes(
          projectId!
        );
        if (cancelled) return;
        const firstScene = scenes[0];
        if (firstScene) setActiveScene(firstScene.id);
        setNodes(nodes);
        setBehaviors(behaviors);
        setReady(true);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [projectId, setNodes, setActiveScene, setBehaviors]);

  const style: React.CSSProperties = {
    background: '#111',
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingTop: 32,
    fontFamily: 'system-ui, sans-serif',
    color: '#ccc',
  };

  if (error)
    return (
      <div style={style}>
        <div style={{ color: '#f87171', padding: 24 }}>
          {t('page.loadError', { message: error })}
        </div>
      </div>
    );

  if (!ready)
    return (
      <div style={style}>
        <div style={{ padding: 24, color: '#666' }}>{t('page.loading')}</div>
      </div>
    );

  return (
    <div style={style}>
      <div
        style={{
          fontSize: 13,
          color: '#444',
          position: 'fixed',
          top: 8,
          left: 12,
        }}
      >
        {t('page.pageLabel')}
      </div>
      {/* Window rendered in place (alwaysExpanded, no position dragging needed on this page) */}
      <MediaInputWindow alwaysExpanded={true} />
    </div>
  );
}
