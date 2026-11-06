import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { MediaInputWindow } from '../components/MediaInputWindow';
import { useEditorStore } from '../store/editorStore';
import { HelpButton } from '../help/HelpButton';
import { useScenes } from '../mesh/nodes';

/**
 * Standalone page for the Media Input window — can be opened in a separate tab
 * so the main editor doesn't need to remain in focus.
 * Route: /media-input/:projectId
 */
export function MediaInputPage() {
  const { t } = useTranslation('media');
  const { projectId } = useParams<{ projectId: string }>();
  const { setProject, setActiveScene } = useEditorStore();
  const scenes = useScenes();

  // The project's nodes come from the replica; MediaInputWindow resolves its
  // behaviors against them, so the open project is all this page has to say.
  useEffect(() => {
    if (!projectId) return;
    setProject(projectId, '');
  }, [projectId, setProject]);
  const firstSceneId = scenes[0]?.id;
  useEffect(() => {
    if (firstSceneId) setActiveScene(firstSceneId);
  }, [firstSceneId, setActiveScene]);
  const ready = !!projectId;
  const error: string | null = null;

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
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {t('page.pageLabel')}
        <HelpButton
          topic="behaviors"
          anchor="devices"
          tip={t('help.devices')}
        />
      </div>
      {/* Window rendered in place (alwaysExpanded, no position dragging needed on this page) */}
      <MediaInputWindow alwaysExpanded={true} />
    </div>
  );
}
