import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Canvas } from '@react-three/fiber';
import { PerspectiveCamera, Environment } from '@react-three/drei';
import { FittedOrthoCamera } from '../components/editor/FittedOrthoCamera';
import * as THREE from 'three';
import { useEditorStore } from '../store/editorStore';
import { api } from '../api/client';
import { useWsSync } from '../hooks/useWsSync';
import { useTrackClipEvaluator } from '../hooks/useTrackClipEvaluator';
import {
  SceneNodes,
  CameraEffects,
  ShadowCatcher,
  ShadowMaterialSync,
  canvasShadowsProp,
  type ShadowQuality,
} from '../components/editor/Viewport';
import { ComposeLayerStack } from '../components/editor/ComposeLayerStack';

function getT(components: Record<string, unknown> | undefined) {
  const t = components?.transform as
    | Partial<{
        x: number;
        y: number;
        z: number;
        rx: number;
        ry: number;
        rz: number;
      }>
    | undefined;
  return {
    x: t?.x ?? 0,
    y: t?.y ?? 0,
    z: t?.z ?? 0,
    rx: t?.rx ?? 0,
    ry: t?.ry ?? 0,
    rz: t?.rz ?? 0,
  };
}

export function ViewerPage() {
  useWsSync();
  useTrackClipEvaluator();
  const { projectId, nodeId, composeSceneId } = useParams<{
    projectId: string;
    nodeId?: string;
    composeSceneId?: string;
  }>();
  const {
    setProject,
    setScenes,
    setActiveScene,
    setNodes,
    setNodeComponents,
    setCameraEffects,
    setComposeLayers,
    setComposeScenes,
    selectComposeScene,
    setTrackClips,
    nodes,
    composeLayers,
    assets,
  } = useEditorStore();

  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return () => {
      document.documentElement.style.background = '';
      document.body.style.background = '';
    };
  }, []);

  useEffect(() => {
    if (!projectId) return;

    api
      .getProjects()
      .then((projects) => {
        const project = projects.find((p) => p.id === projectId);
        if (project) setProject(project.id, project.name);
      })
      .catch(() => {});

    api
      .getScenes(projectId)
      .then(
        ({
          scenes,
          nodes: sceneNodes,
          nodeComponents,
          cameraEffects,
          composeLayers,
          trackClips,
        }) => {
          setScenes(scenes);
          setNodeComponents(nodeComponents);
          setCameraEffects(cameraEffects);
          // Split compose_scene containers from regular layers (mirrors Editor).
          setComposeScenes(
            composeLayers.filter((l) => l.kind === 'compose_scene')
          );
          setComposeLayers(
            composeLayers.filter((l) => l.kind !== 'compose_scene')
          );
          setTrackClips(trackClips);
          // Load every scene's nodes so cross-scene camera_views resolve.
          setNodes(sceneNodes);
          if (composeSceneId) selectComposeScene(composeSceneId);
          if (scenes.length > 0) setActiveScene(scenes[0].id);
        }
      )
      .catch(() => {});
    api
      .getAssets(projectId)
      .then((rows) => useEditorStore.getState().setAssets(rows))
      .catch(() => {});
  }, [
    projectId,
    composeSceneId,
    setProject,
    setScenes,
    setActiveScene,
    setNodes,
    setNodeComponents,
    setCameraEffects,
    setComposeLayers,
    setComposeScenes,
    selectComposeScene,
    setTrackClips,
  ]);

  // ── Compose-scene mode: stream a whole compose scene (its layer stack,
  //    including camera_view 3D). The broadcast IS the compose output. ──
  if (composeSceneId) {
    const stackLayers = composeLayers.filter(
      (l) => l.rootComposeSceneId === composeSceneId
    );
    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
          background: 'transparent',
          position: 'relative',
        }}
      >
        <ComposeLayerStack layers={stackLayers} assets={assets} mode="viewer" />
      </div>
    );
  }

  // ── Single-camera mode (legacy /viewer/:projectId/:nodeId) ──
  const camNode = nodes.find((n) => n.id === nodeId);
  const cc = camNode?.components?.camera as
    | {
        projection?: 'perspective' | 'orthographic';
        fov?: number;
        near?: number;
        far?: number;
        orthoSize?: number;
        backgroundImage?: string;
        shadowsEnabled?: boolean;
        shadowQuality?: ShadowQuality;
        envIntensity?: number;
      }
    | undefined;
  const projection = cc?.projection ?? 'perspective';
  const orthoSize = cc?.orthoSize ?? 2;
  const shadowsEnabled = cc?.shadowsEnabled ?? false;
  const envIntensity = cc?.envIntensity ?? 1;
  const t = getT(camNode?.components as Record<string, unknown> | undefined);
  const bgImage = cc?.backgroundImage ?? null;
  const camSceneId = camNode?.rootSceneNodeId;

  const isHidden = camNode?.hidden ?? false;

  // Scene-wide + this camera's own layers, across all compose scenes.
  const stackLayers = composeLayers.filter(
    (l) =>
      l.kind !== 'camera_view' &&
      (l.cameraNodeId == null || l.cameraNodeId === nodeId)
  );

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: 'transparent',
        position: 'relative',
      }}
    >
      {bgImage && (
        <img
          src={bgImage}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            pointerEvents: 'none',
            zIndex: 0,
          }}
          alt=""
        />
      )}
      <ComposeLayerStack layers={stackLayers} assets={assets} mode="viewer" />
      <Canvas
        gl={{ alpha: true, antialias: true, toneMapping: THREE.NoToneMapping }}
        shadows={canvasShadowsProp(shadowsEnabled, cc?.shadowQuality)}
        style={{
          background: 'transparent',
          position: 'relative',
          zIndex: 1,
          visibility: isHidden ? 'hidden' : 'visible',
          pointerEvents: 'none',
        }}
        onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
        frameloop={isHidden ? 'never' : 'always'}
      >
        {projection === 'perspective' ? (
          <PerspectiveCamera
            makeDefault
            fov={cc?.fov ?? 50}
            near={cc?.near ?? 0.1}
            far={cc?.far ?? 1000}
            position={[t.x, t.y, t.z]}
            rotation={[t.rx, t.ry, t.rz]}
          />
        ) : (
          <FittedOrthoCamera
            size={orthoSize}
            near={cc?.near ?? 0.1}
            far={cc?.far ?? 1000}
            position={[t.x, t.y, t.z]}
            rotation={[t.rx, t.ry, t.rz]}
          />
        )}
        <SceneNodes omitKinds={['camera']} viewerMode sceneId={camSceneId} />
        {shadowsEnabled && <ShadowCatcher />}
        <ShadowMaterialSync enabled={shadowsEnabled} />
        <Environment preset="city" environmentIntensity={envIntensity} />
        {nodeId && <CameraEffects forceNodeId={nodeId} sceneId={camSceneId} />}
      </Canvas>
    </div>
  );
}
