import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import {
  MediaInputWindow,
  type MediaAgentConfig,
} from '../components/MediaInputWindow';
import { useEditorStore } from '../store/editorStore';
import { HelpButton } from '../help/HelpButton';

/**
 * Standalone page for the Media Input window — can be opened in a separate tab
 * so the main editor doesn't need to remain in focus.
 * Route: /media-input/:projectId
 */
export function MediaInputPage() {
  const { t } = useTranslation('media');
  const { projectId } = useParams<{ projectId: string }>();
  const [search] = useSearchParams();

  /**
   * Agent mode. The server's browser-agent capture provider launches this page with
   * ?agent=1 plus the behaviour ids (and optional device ids) it wants captured, e.g.
   *   /media-input/<projectId>?agent=1&tracking=<behaviorId>&trackingDevice=<deviceId>
   * The window then auto-starts those captures and uplinks over the normal WebSocket, so
   * server-side capture reuses this page verbatim instead of duplicating the pipeline.
   */
  const agent = useMemo<MediaAgentConfig | null>(() => {
    if (search.get('agent') !== '1') return null;
    const cfg: MediaAgentConfig = {};
    const tracking = search.get('tracking');
    if (tracking)
      cfg.tracking = {
        behaviorId: tracking,
        deviceId: search.get('trackingDevice') ?? undefined,
      };
    const lipsync = search.get('lipsync');
    if (lipsync)
      cfg.lipsync = {
        behaviorId: lipsync,
        deviceId: search.get('lipsyncDevice') ?? undefined,
      };
    return cfg;
  }, [search]);
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
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {t('page.pageLabel')}
        <HelpButton topic="behaviors" anchor="devices" tip={t('help.devices')} />
      </div>
      {/* Window rendered in place (alwaysExpanded, no position dragging needed on this page) */}
      <MediaInputWindow alwaysExpanded={true} agent={agent} />
    </div>
  );
}
