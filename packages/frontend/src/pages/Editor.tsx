import { useEffect, useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  api,
  serializePreset,
  instantiatePreset as instantiatePresetApi,
} from '../api/client';
import { useEditorStore } from '../store/editorStore';
import { useWsSync } from '../hooks/useWsSync';
import { useTrackClipEvaluator } from '../hooks/useTrackClipEvaluator';
import { TopBar } from '../components/editor/TopBar';
import { SceneGraph } from '../components/editor/SceneGraph';
import { Viewport } from '../components/editor/Viewport';
import { PropertiesPanel } from '../components/editor/PropertiesPanel';
import { AssetManager } from '../components/editor/AssetManager';
import { SignalGraphCanvas } from '../components/editor/signal/SignalGraphCanvas';
import { NodePalette } from '../components/editor/signal/NodePalette';
import { ComposeView } from '../components/editor/ComposeView';
import {
  handleSceneNodeDrop,
  hasCreatePayload,
} from '../components/editor/dnd';
import type { NodeKindMeta } from '@vspark/shared/signal';

export function Editor() {
  useWsSync();
  useTrackClipEvaluator();
  const { projectId } = useParams<{ projectId: string }>();
  const {
    setProject,
    setScenes,
    setActiveScene,
    setNodes,
    setAssets,
    setNodeComponents,
    setComponentKinds,
    setCameraEffects,
    setComposeLayers,
    setComposeScenes,
    selectComposeScene,
    setTrackClips,
    setOverliveAccounts,
    setPresets,
    activeGraphId,
    leftTab,
    activeGraphWritable,
  } = useEditorStore();
  const [kindMeta, setKindMeta] = useState<NodeKindMeta[]>([]);

  useEffect(() => {
    api
      .getSignalNodeKinds()
      .then(setKindMeta)
      .catch(() => {});
    api
      .getComponentKinds()
      .then(setComponentKinds)
      .catch(() => {});
  }, [setComponentKinds]);

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
          nodeComponents,
          cameraEffects,
          composeLayers,
          trackClips,
        }) => {
          setScenes(scenes);
          setNodeComponents(nodeComponents);
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
    setNodeComponents,
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
        {/* Viewport always mounts (keeps 3D scene alive) but is hidden when another mode is active */}
        <div
          style={{ flex: 1, position: 'relative', overflow: 'hidden' }}
          onDragOver={(e) => {
            // Accept drag-create drops from the bottom dock while the 3D
            // viewport is the visible mode.
            if (activeGraphId || leftTab === 'compose') return;
            if (hasCreatePayload(e)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDrop={(e) => {
            if (activeGraphId || leftTab === 'compose') return;
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
              visibility:
                activeGraphId || leftTab === 'compose' ? 'hidden' : 'visible',
            }}
          >
            <Viewport />
          </div>
          {activeGraphId && (
            <div style={{ position: 'absolute', inset: 0 }}>
              <SignalGraphCanvas graphId={activeGraphId} kindMeta={kindMeta} />
            </div>
          )}
          {!activeGraphId && leftTab === 'compose' && <ComposeView />}
        </div>
        <PropertiesPanel />
      </div>
      {activeGraphId ? (
        <NodePalette kindMeta={kindMeta} graphReadonly={!activeGraphWritable} />
      ) : (
        <AssetManager />
      )}
    </div>
  );
}
