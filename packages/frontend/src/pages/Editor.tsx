import { useEffect, useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  api,
  serializePreset,
  instantiatePreset as instantiatePresetApi,
} from '../api/client';
import { useEditorStore } from '../store/editorStore';
import { useWsSync } from '../hooks/useWsSync';
import { useTrackClipEvaluator } from '../hooks/useTrackClipEvaluator';
import { useSharedSubscriptions } from '../hooks/useSharedSubscriptions';
import { useClientMesh } from '../hooks/useClientMesh';
import { initMeshPeer } from '../mesh/peer';
import { TopBar } from '../components/editor/TopBar';
import { SceneGraph } from '../components/editor/SceneGraph';
import { Viewport } from '../components/editor/Viewport';
import { PropertiesPanel } from '../components/editor/PropertiesPanel';
import { AssetManager } from '../components/editor/AssetManager';
import { SignalGraphCanvas } from '../components/editor/signal/SignalGraphCanvas';
import { NodePalette } from '../components/editor/signal/NodePalette';
import { ComposeView } from '../components/editor/ComposeView';
import { HelpWindow } from '../help/HelpWindow';
import {
  handleSceneNodeDrop,
  hasCreatePayload,
} from '../components/editor/dnd';
import type { NodeKindMeta } from '@vspark/shared/signal';

export function Editor() {
  useWsSync();
  useTrackClipEvaluator();
  useSharedSubscriptions();
  useClientMesh();
  // Mesh store (parallel-run): mirror the document collections into this tab.
  // No UI reads from it yet — features migrate onto @vspark/mesh-react one by
  // one (dev-notes/plans/mesh-sync-refactor.md §8).
  useEffect(() => void initMeshPeer().catch(console.warn), []);
  const { t } = useTranslation('editor');
  const { projectId } = useParams<{ projectId: string }>();
  const {
    setProject,
    setScenes,
    setActiveScene,
    setNodes,
    setAssets,
    setBehaviors,
    setBehaviorKinds,
    setCameraEffects,
    setComposeLayers,
    setComposeScenes,
    selectComposeScene,
    setTrackClips,
    setOverliveAccounts,
    setPresets,
    activeLogicId,
    leftTab,
    activeLogicWritable,
  } = useEditorStore();
  const [kindMeta, setKindMeta] = useState<NodeKindMeta[]>([]);

  useEffect(() => {
    api
      .getSignalNodeKinds()
      .then(setKindMeta)
      .catch(() => {});
    api
      .getBehaviorKinds()
      .then(setBehaviorKinds)
      .catch(() => {});
  }, [setBehaviorKinds]);

  // Load presets when project changes
  useEffect(() => {
    if (!projectId) return;
    api
      .getPresets(projectId)
      .then(setPresets)
      .catch(() => {});
  }, [projectId, setPresets]);

  // Ctrl+C / Ctrl+V for preset copy/paste
  const handleKeyDown = useCallback(async (e: KeyboardEvent) => {
    if (
      (e.target as HTMLElement)?.tagName === 'INPUT' ||
      (e.target as HTMLElement)?.tagName === 'TEXTAREA'
    )
      return;
    const state = useEditorStore.getState();
    if (!state.projectId || !state.activeSceneId) return;
    if (!e.ctrlKey && !e.metaKey) return;

    if (e.key === 'c') {
      const rootKind = state.selectedComposeLayerId
        ? 'compose_layer'
        : 'scene_node';
      const rootId = state.selectedComposeLayerId ?? state.selectedNodeId;
      if (!rootId) return;
      e.preventDefault();
      try {
        const payload = await serializePreset(rootKind, rootId, false);
        await navigator.clipboard.writeText(JSON.stringify(payload));
      } catch {
        /* ignore */
      }
    }

    if (e.key === 'v') {
      e.preventDefault();
      try {
        const text = await navigator.clipboard.readText();
        const payload = JSON.parse(text);
        if (
          payload.format !== 'vspark.preset.v1' &&
          payload.format !== 'vspark.preset.v2'
        )
          return;
        await instantiatePresetApi(
          payload,
          state.projectId!,
          state.activeSceneId!,
          state.selectedNodeId
        );
        const data = await api.getScenes(state.projectId!);
        useEditorStore.getState().setNodes(data.nodes);
        useEditorStore.getState().setComposeLayers(data.composeLayers);
        useEditorStore.getState().setTrackClips(data.trackClips);
      } catch {
        /* not a preset on clipboard */
      }
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    if (!projectId) return;

    api.getProjects().then((projects) => {
      const project = projects.find((p) => p.id === projectId);
      if (project) setProject(project.id, project.name);
    });

    api
      .getScenes(projectId)
      .then(
        ({
          scenes,
          nodes,
          behaviors,
          cameraEffects,
          composeLayers,
          trackClips,
        }) => {
          setScenes(scenes);
          setBehaviors(behaviors);
          setCameraEffects(cameraEffects);
          // Separate compose_scene layers from regular layers
          const composeSceneItems = composeLayers.filter(
            (l) => l.kind === 'compose_scene'
          );
          const regularLayers = composeLayers.filter(
            (l) => l.kind !== 'compose_scene'
          );
          setComposeScenes(composeSceneItems);
          setComposeLayers(regularLayers);
          if (composeSceneItems.length > 0) {
            selectComposeScene(composeSceneItems[0].id);
          }
          setTrackClips(trackClips);
          // Load every scene's nodes so the dock can render all scenes as
          // collapsible roots; the viewport still renders only the active scene.
          setNodes(nodes);
          if (scenes.length > 0) {
            setActiveScene(scenes[0].id);
          }
        }
      );

    api
      .getAssets(projectId)
      .then(setAssets)
      .catch(() => {});
    api
      .getOverliveAccounts(projectId)
      .then(setOverliveAccounts)
      .catch(() => {});
  }, [
    projectId,
    setProject,
    setScenes,
    setActiveScene,
    setNodes,
    setAssets,
    setBehaviors,
    setCameraEffects,
    setComposeLayers,
    setTrackClips,
    setOverliveAccounts,
  ]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: '#0f0f0f',
      }}
    >
      <TopBar />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <SceneGraph />
        {/* The main view is bound to the active left-dock tab: Scene → 3D
            viewport, Graphs → signal graph canvas, Compose → compose view.
            The Viewport always stays mounted (keeps the 3D scene + WebGL
            context alive) and is merely hidden when another tab is active. */}
        <div
          style={{ flex: 1, position: 'relative', overflow: 'hidden' }}
          onDragOver={(e) => {
            // Accept drag-create drops from the bottom dock only while the 3D
            // viewport is the visible tab.
            if (leftTab !== 'scene') return;
            if (hasCreatePayload(e)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDrop={(e) => {
            if (leftTab !== 'scene') return;
            void handleSceneNodeDrop(
              e,
              useEditorStore.getState().activeSceneId,
              null
            );
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              visibility: leftTab === 'scene' ? 'visible' : 'hidden',
            }}
          >
            <Viewport />
          </div>
          {leftTab === 'graphs' &&
            (activeLogicId ? (
              <div style={{ position: 'absolute', inset: 0 }}>
                <SignalGraphCanvas
                  graphId={activeLogicId}
                  kindMeta={kindMeta}
                />
              </div>
            ) : (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#555',
                  fontSize: 13,
                  background: '#0a0a0a',
                }}
              >
                {t('logic.emptyCanvas')}
              </div>
            ))}
          {leftTab === 'compose' && <ComposeView />}
        </div>
        <PropertiesPanel />
      </div>
      {leftTab === 'graphs' ? (
        <NodePalette kindMeta={kindMeta} graphReadonly={!activeLogicWritable} />
      ) : (
        <AssetManager />
      )}
      <HelpWindow />
    </div>
  );
}
