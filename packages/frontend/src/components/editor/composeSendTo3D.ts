import * as THREE from 'three';
import {
  useEditorStore,
  type ComposeLayerRecord,
  type StageObject,
} from '../../store/editorStore';
import { layerFrame } from './composeHitTest';
import { commitPromoteLayerToNode } from '../../mesh/layerWrites';
import { DEFAULT_COMPOSE_WIDTH, DEFAULT_COMPOSE_HEIGHT } from './ComposeView';

/** Placement for a node sent from a 2D compose layer into a camera's 3D scene:
 *  a world position + the billboard/video quad size (world units) chosen so the
 *  node projects to the same rect the 2D layer occupies in the camera's view. */
export interface SendTo3DPlacement {
  position: [number, number, number];
  width: number;
  height: number;
}

/**
 * Compute where to place a screen-facing billboard/video in `cameraNode`'s scene
 * so it lands, in that camera's view, on top of the `source` compose layer.
 *
 * The camera-view layer maps the camera's frustum onto a rect of the compose
 * stage; we take the source layer's centre + size relative to that rect and
 * unproject them through the camera (ortho or perspective) at the depth of the
 * plane through the world origin. Assumes axis-aligned layers and that the
 * camera is positioned by its own transform (as CameraCanvas renders it).
 */
export function computeSendTo3DPlacement(
  cameraNode: StageObject,
  camView: ComposeLayerRecord,
  source: ComposeLayerRecord,
  byId: Map<string, ComposeLayerRecord>,
  canonW: number,
  canonH: number
): SendTo3DPlacement {
  const viewport = { width: canonW, height: canonH };
  const cf = layerFrame(viewport, camView, byId);
  const sf = layerFrame(viewport, source, byId);

  // Source centre as NDC within the camera-view rect (screen-down → world −Y).
  const nx = cf.hx > 0 ? (sf.cx - cf.cx) / cf.hx : 0;
  const ny = cf.hy > 0 ? -(sf.cy - cf.cy) / cf.hy : 0;
  const aspect = cf.hy > 0 ? cf.hx / cf.hy : 1;

  // Camera world basis from its transform (no parent composition, matching
  // CameraCanvas). Camera looks down its local −Z.
  const t = (cameraNode.components?.transform ?? {}) as Record<string, number>;
  const P = new THREE.Vector3(t.x ?? 0, t.y ?? 0, t.z ?? 0);
  const euler = new THREE.Euler(t.rx ?? 0, t.ry ?? 0, t.rz ?? 0, 'XYZ');
  const basis = new THREE.Matrix4().makeRotationFromEuler(euler);
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const back = new THREE.Vector3();
  basis.extractBasis(right, up, back);
  const forward = back.clone().negate();

  const cc = (cameraNode.components?.camera ?? {}) as Record<string, unknown>;
  const projection = (cc.projection as string) ?? 'perspective';
  const near = (cc.near as number) ?? 0.1;
  const far = (cc.far as number) ?? 1000;

  // Depth along forward to the plane through the world origin, clamped into the
  // frustum (so content authored near origin sits co-planar with the new node).
  let depth = -P.dot(forward);
  if (!(depth > 0)) depth = Math.min(5, far * 0.5);
  depth = Math.min(Math.max(depth, near * 2), far * 0.9);

  // Half of the camera's visible extent (world units) at that depth.
  let halfWw: number;
  let halfHw: number;
  if (projection === 'orthographic') {
    // FittedOrthoCamera: size is the half-extent of the SHORTER axis.
    const size = (cc.orthoSize as number) ?? 2;
    halfWw = aspect >= 1 ? size * aspect : size;
    halfHw = aspect >= 1 ? size : size / aspect;
  } else {
    const fov = (((cc.fov as number) ?? 50) * Math.PI) / 180; // vertical fov
    halfHw = depth * Math.tan(fov / 2);
    halfWw = halfHw * aspect;
  }

  const pos = P.clone()
    .add(forward.clone().multiplyScalar(depth))
    .add(right.clone().multiplyScalar(nx * halfWw))
    .add(up.clone().multiplyScalar(ny * halfHw));

  const width = 2 * (cf.hx > 0 ? sf.hx / cf.hx : 0) * halfWw;
  const height = 2 * (cf.hy > 0 ? sf.hy / cf.hy : 0) * halfHw;

  return {
    position: [pos.x, pos.y, pos.z],
    width: Math.max(0.01, width),
    height: Math.max(0.01, height),
  };
}

/** The camera-view layer in the same compose scene that a source layer overlaps
 *  most (by intersection area), or null if it overlaps none. */
export function findOverlappingCameraView(
  source: ComposeLayerRecord,
  layers: ComposeLayerRecord[],
  canonW: number,
  canonH: number
): ComposeLayerRecord | null {
  const byId = new Map(layers.map((l) => [l.id, l] as const));
  const viewport = { width: canonW, height: canonH };
  const sf = layerFrame(viewport, source, byId);
  let best: { layer: ComposeLayerRecord; area: number } | null = null;
  for (const l of layers) {
    if (
      l.kind !== 'camera_view' ||
      !l.cameraNodeId ||
      l.rootComposeSceneId !== source.rootComposeSceneId
    )
      continue;
    const cf = layerFrame(viewport, l, byId);
    const ox =
      Math.min(sf.cx + sf.hx, cf.cx + cf.hx) -
      Math.max(sf.cx - sf.hx, cf.cx - cf.hx);
    const oy =
      Math.min(sf.cy + sf.hy, cf.cy + cf.hy) -
      Math.max(sf.cy - sf.hy, cf.cy - cf.hy);
    if (ox > 0 && oy > 0) {
      const area = ox * oy;
      if (!best || area > best.area) best = { layer: l, area };
    }
  }
  return best?.layer ?? null;
}

/** Resolve the compose scene's canonical resolution for a layer. */
function sceneResolution(source: ComposeLayerRecord): {
  w: number;
  h: number;
} {
  const scene = useEditorStore
    .getState()
    .composeScenes.find((s) => s.id === source.rootComposeSceneId);
  return {
    w: scene?.width && scene.width > 0 ? scene.width : DEFAULT_COMPOSE_WIDTH,
    h:
      scene?.height && scene.height > 0 ? scene.height : DEFAULT_COMPOSE_HEIGHT,
  };
}

/** Whether "Send to 3D" applies to this layer (an image/video that overlaps a
 *  camera-view layer wired to a camera in the current scene set). */
export function canSendTo3D(source: ComposeLayerRecord): boolean {
  if (source.kind !== 'image' && source.kind !== 'video') return false;
  const store = useEditorStore.getState();
  const { w, h } = sceneResolution(source);
  const cv = findOverlappingCameraView(source, store.composeLayers, w, h);
  return !!(cv && store.nodes.some((n) => n.id === cv.cameraNodeId));
}

/** Create a screen-facing billboard (image) or video node in the overlapped
 *  camera's scene, matched to the 2D layer's position/size in that camera's
 *  view. Switches to that scene and selects the new node. No-op if the layer
 *  doesn't overlap a usable camera-view. */
export async function sendComposeLayerTo3D(
  source: ComposeLayerRecord
): Promise<void> {
  const store = useEditorStore.getState();
  const { w, h } = sceneResolution(source);
  const camView = findOverlappingCameraView(source, store.composeLayers, w, h);
  if (!camView?.cameraNodeId) return;
  const cameraNode = store.nodes.find((n) => n.id === camView.cameraNodeId);
  if (!cameraNode) return;
  const sceneId = cameraNode.rootSceneNodeId;

  const byId = new Map(store.composeLayers.map((l) => [l.id, l] as const));
  const place = computeSendTo3DPlacement(
    cameraNode,
    camView,
    source,
    byId,
    w,
    h
  );
  const transform = {
    type: 'transform',
    x: place.position[0],
    y: place.position[1],
    z: place.position[2],
    rx: 0,
    ry: 0,
    rz: 0,
    sx: 1,
    sy: 1,
    sz: 1,
  };

  // Build the node doc here rather than creating it: the create and the
  // layer removal have to be issued together so "send to 3D" is one undo step.
  const draft = (spec: Partial<StageObject>): StageObject => ({
    id: crypto.randomUUID(),
    rootSceneNodeId: sceneId,
    projectId: store.projectId ?? '',
    parentId: null,
    boneAttachment: null,
    name: source.name,
    kind: 'billboard',
    filePath: null,
    components: {},
    properties: {},
    hidden: false,
    ...spec,
  });

  try {
    let node: StageObject;
    if (source.kind === 'video') {
      node = draft({
        parentId: null,
        name: source.name,
        kind: 'video',
        filePath: null,
        components: {
          transform,
          video: {
            type: 'video',
            assetId: source.assetId ?? null,
            sourceUrl: null,
            facing: 'screen',
            backface: 'none',
            width: place.width,
            height: place.height,
            alpha: 1,
            autoplay: true,
            loop: true,
            onEnd: 'freeze',
            muted: true,
            volume: 1,
          },
        },
      });
    } else {
      const asset = source.assetId
        ? store.assets.find((a) => a.id === source.assetId)
        : null;
      node = draft({
        kind: 'billboard',
        filePath: asset?.url ?? null,
        components: {
          transform,
          billboard: {
            type: 'billboard',
            facing: 'screen',
            backface: 'none',
            width: place.width,
            height: place.height,
            alpha: 1,
            textureUrl: asset?.url ?? null,
          },
        },
      });
    }
    // The 2D layer has been promoted into 3D — remove it, and stay in the
    // compose view (the new node lives in the camera's scene and shows through
    // the camera_view).
    if (store.selectedComposeLayerId === source.id)
      store.selectComposeLayer(null);
    await commitPromoteLayerToNode(node, source.id);
  } catch (err) {
    alert(err instanceof Error ? err.message : 'Failed to send layer to 3D');
  }
}
