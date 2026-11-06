import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Canvas } from '@react-three/fiber';
import { PerspectiveCamera } from '@react-three/drei';
import { SafeEnvironment } from '../components/SafeEnvironment';
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
import {
  ComposeLayerStack,
  ComposeStageSizeContext,
} from '../components/editor/ComposeLayerStack';
import {
  ComposeStage,
  composeSceneResolution,
} from '../components/editor/ComposeView';
import { useSceneFadeIn } from '../hooks/useSceneFadeIn';
import { FrameBudget, FrameBudgetContext } from '../components/frameBudget';
import { useComposeLayers, useComposeScenes } from '../mesh/compose';
import { useSceneNode, useSceneNodes, useScenes } from '../mesh/nodes';

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

/** The output page (OBS window / browser source): rendering may take more of
 *  the main thread here than in the editor — there is no editor UI to keep
 *  responsive — but never all of it, so mesh messages still get through. */
const OUTPUT_FRAME_SHARE = 0.9;

export function ViewerPage() {
  return (
    <FrameBudgetContext.Provider value={OUTPUT_FRAME_SHARE}>
      <ViewerContent />
    </FrameBudgetContext.Provider>
  );
}

function ViewerContent() {
  useWsSync();
  useTrackClipEvaluator();
  // Live behavior/effect updates ride the tab's mesh replica now (§11) —
  // the viewer needs its own peer just like the editor.
  const { projectId, nodeId, composeSceneId } = useParams<{
    projectId: string;
    nodeId?: string;
    composeSceneId?: string;
  }>();
  const { setProject, setActiveScene, selectComposeScene, assets } =
    useEditorStore();
  const nodes = useSceneNodes();
  // The camera with its live transform, so the output follows a camera drag.
  const liveCamNode = useSceneNode(nodeId);
  const scenes = useScenes();
  const composeLayers = useComposeLayers();
  const composeScenes = useComposeScenes();

  useEffect(() => {
    // OBS browser sources composite over a transparent page, so we must keep
    // the document transparent there. A normal browser has nothing behind the
    // page, so we paint it black for a solid backdrop. Detect OBS via the
    // `window.obsstudio` global it injects (more reliable than the UA, which
    // can be overridden in the browser-source settings); fall back to the UA.
    const inOBS =
      typeof (window as unknown as { obsstudio?: unknown }).obsstudio !==
        'undefined' || /\bOBS\b/.test(navigator.userAgent);
    // `?output=window` is the backend's off-screen output window, captured by
    // OBS Window Capture — it composites over the desktop, so stay transparent.
    const outputWindow =
      new URLSearchParams(window.location.search).get('output') === 'window';
    const bg = inOBS || outputWindow ? 'transparent' : '#000000';
    document.documentElement.style.background = bg;
    document.body.style.background = bg;
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
      .getAssets(projectId)
      .then((rows) => useEditorStore.getState().setAssets(rows))
      .catch(() => {});
  }, [projectId, composeSceneId, nodeId, setProject]);

  // Activate the scene this link actually targets — for a single-camera link
  // that's the camera's own scene, not blindly the first one. Compose links
  // select a compose scene instead; their 3D content is keyed per
  // camera_view, so any 3D scene works as the base — fall back to the first.
  // Scenes and nodes arrive from the replica.
  const firstSceneId = scenes[0]?.id;
  const targetSceneId = nodeId
    ? nodes.find((n) => n.id === nodeId)?.rootSceneNodeId
    : undefined;
  useEffect(() => {
    if (composeSceneId) selectComposeScene(composeSceneId);
    const sid = (nodeId && targetSceneId) || firstSceneId;
    if (sid) setActiveScene(sid);
  }, [
    composeSceneId,
    nodeId,
    targetSceneId,
    firstSceneId,
    selectComposeScene,
    setActiveScene,
  ]);

  // Fade the 3D output in once it's loaded and settled (single-camera mode);
  // compose-scene mode fades each camera_view in via CameraCanvas instead.
  const fadeIn = useSceneFadeIn();

  // ── Compose-scene mode: stream a whole compose scene (its layer stack,
  //    including camera_view 3D). The broadcast IS the compose output. ──
  if (composeSceneId) {
    const stackLayers = composeLayers.filter(
      (l) => l.rootComposeSceneId === composeSceneId
    );
    const scene = composeScenes.find((s) => s.id === composeSceneId);
    const { width: canonW, height: canonH } = composeSceneResolution(scene);
    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
          background: 'transparent',
          position: 'relative',
        }}
      >
        {/* Fixed-resolution canonical stage, letterbox-scaled to the viewer
            window so streamed output matches the editor at any window size. */}
        <ComposeStage canonW={canonW} canonH={canonH}>
          <ComposeStageSizeContext.Provider value={`${canonW}x${canonH}`}>
            <ComposeLayerStack
              layers={stackLayers}
              assets={assets}
              mode="viewer"
            />
          </ComposeStageSizeContext.Provider>
        </ComposeStage>
      </div>
    );
  }

  // ── Single-camera mode (legacy /viewer/:projectId/:nodeId) ──
  const camNode = liveCamNode;
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

  // Single-camera mode streams ONLY this camera's 3D output — no compose layers.
  // Compose layers are shown exclusively by the compose-scene viewer above.
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
      <Canvas
        gl={{ alpha: true, antialias: true, toneMapping: THREE.NoToneMapping }}
        shadows={canvasShadowsProp(shadowsEnabled, cc?.shadowQuality)}
        style={{
          background: 'transparent',
          position: 'relative',
          zIndex: 1,
          visibility: isHidden ? 'hidden' : 'visible',
          pointerEvents: 'none',
          ...fadeIn,
        }}
        onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
        frameloop="never"
      >
        <FrameBudget active={!isHidden} />
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
        <SafeEnvironment preset="city" environmentIntensity={envIntensity} />
        {nodeId && <CameraEffects forceNodeId={nodeId} sceneId={camSceneId} />}
      </Canvas>
    </div>
  );
}
