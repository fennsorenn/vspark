import { Canvas } from '@react-three/fiber';
import { PerspectiveCamera } from '@react-three/drei';
import { SafeEnvironment } from '../SafeEnvironment';
import * as THREE from 'three';
import type { StageObject } from '../../store/editorStore';
import {
  SceneNodes,
  CameraEffects,
  ShadowCatcher,
  ShadowMaterialSync,
  canvasShadowsProp,
  type ShadowQuality,
} from './Viewport';
import { ComposeSceneInteractions } from './ComposeSceneInteractions';
import { FittedOrthoCamera } from './FittedOrthoCamera';

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

/**
 * Renders one camera's 3D scene into a self-contained R3F canvas. Used by
 * camera_view compose layers (one canvas per layer) and, for now, by the
 * compose/viewer 3D output. The canvas is pointer-events:none so the compose
 * event-capture overlay owns input; in-layer 3D interaction is wired through
 * ComposeSceneInteractions, keyed by composeLayerId.
 *
 * NOTE: this is the per-camera-Canvas implementation. A future change will swap
 * the rendering behind this boundary to a single shared WebGLRenderer
 * (createPortal + priority useFrame + drawImage blit) without changing callers.
 */
export function CameraCanvas({
  cameraNode,
  sceneId,
  composeLayerId,
  active = true,
}: {
  cameraNode: StageObject;
  sceneId: string;
  /** Identifies this camera_view for interaction routing. */
  composeLayerId?: string;
  /** When false, the canvas pauses its render loop (hidden / off-screen). */
  active?: boolean;
}) {
  const cc = cameraNode.components?.camera as
    | {
        projection?: 'perspective' | 'orthographic';
        fov?: number;
        near?: number;
        far?: number;
        orthoSize?: number;
        shadowsEnabled?: boolean;
        shadowQuality?: ShadowQuality;
        envIntensity?: number;
      }
    | undefined;
  const projection = cc?.projection ?? 'perspective';
  const orthoSize = cc?.orthoSize ?? 2;
  const shadowsEnabled = cc?.shadowsEnabled ?? false;
  const envIntensity = cc?.envIntensity ?? 1;
  const t = getT(cameraNode.components as Record<string, unknown> | undefined);

  return (
    <Canvas
      frameloop={active ? 'always' : 'never'}
      gl={{ alpha: true, antialias: true, toneMapping: THREE.NoToneMapping }}
      shadows={canvasShadowsProp(shadowsEnabled, cc?.shadowQuality)}
      style={{ width: '100%', height: '100%', background: 'transparent' }}
      onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
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
      <ComposeSceneInteractions composeLayerId={composeLayerId}>
        <SceneNodes omitKinds={['camera']} viewerMode sceneId={sceneId} />
      </ComposeSceneInteractions>
      {shadowsEnabled && <ShadowCatcher />}
      <ShadowMaterialSync enabled={shadowsEnabled} />
      <SafeEnvironment preset="city" environmentIntensity={envIntensity} />
      <CameraEffects forceNodeId={cameraNode.id} sceneId={sceneId} />
    </Canvas>
  );
}
