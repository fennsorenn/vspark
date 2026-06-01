import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useEditorStore } from '../../store/editorStore';
import { api } from '../../api/client';
import { getNodeGroup, listRegisteredNodeGroups } from './Viewport';
import { sendNodeTransformPreview } from '../../hooks/useWsSync';

const PREVIEW_INTERVAL_MS = 33; // ~30 Hz cap on outgoing transform previews

/** Marker so we can identify objects whose raycast we've zeroed. */
const COMPOSE_RAYCAST_DISABLED = '__composeRaycastDisabled';
const noopRaycast = (): void => {
  /* picking goes through the wrapper's custom raycast */
};

const WHEEL_IMPULSE_FRACTION = 0.6; // wheel-tick impulse, in units/sec, as a fraction of camera distance
const WHEEL_DAMPING_PER_SEC = 0.005; // velocity multiplier per second (i.e. retains 0.5% after 1s → fast decay)
const WHEEL_VELOCITY_EPS = 1e-4; // m/s; below this, stop integrating and persist
const MIN_CAM_DISTANCE = 0.05; // never push the object closer than this

// Reusable scratch — raycaster + NDC vector, shared across handlers in this module.
const wheelRay = new THREE.Raycaster();
const ndc = new THREE.Vector2();

/** Per-camera_view interaction registry. Each mounted ComposeSceneInteractions
 *  (one per camera_view layer's CameraCanvas) registers its handlers under its
 *  composeLayerId, so the capture overlay can dispatch to whichever camera_view
 *  is under the cursor. A `default` key (empty string) is used when no
 *  composeLayerId is supplied (e.g. a lone canvas), preserving single-canvas
 *  behaviour. */
type ScenePicker = (clientX: number, clientY: number) => string | null;
type SceneDragStarter = (
  nodeId: string,
  clientX: number,
  clientY: number,
  pointerId: number
) => boolean;
type SceneWheel = (deltaY: number, clientX: number, clientY: number) => void;

const scenePickers = new Map<string, ScenePicker>();
const sceneDragStarters = new Map<string, SceneDragStarter>();
const sceneWheels = new Map<string, SceneWheel>();

/** Pick a 3D node under the cursor by trying each registered camera_view's
 *  picker. Each picker already returns null when the cursor is outside its own
 *  canvas rect, so the first non-null hit wins. Returns the nodeId or null. */
export function composeScenePick(
  clientX: number,
  clientY: number
): string | null {
  for (const pick of scenePickers.values()) {
    const id = pick(clientX, clientY);
    if (id) return id;
  }
  return null;
}

/** Start a 3D drag on `nodeId`. `composeLayerId` selects which camera_view's
 *  canvas/camera the drag is relative to; when omitted, tries all. */
export function composeSceneStartDrag(
  nodeId: string,
  clientX: number,
  clientY: number,
  pointerId: number,
  composeLayerId?: string
): boolean {
  if (composeLayerId != null) {
    return (
      sceneDragStarters.get(composeLayerId)?.(
        nodeId,
        clientX,
        clientY,
        pointerId
      ) ?? false
    );
  }
  for (const start of sceneDragStarters.values()) {
    if (start(nodeId, clientX, clientY, pointerId)) return true;
  }
  return false;
}

/** Apply a wheel impulse. `composeLayerId` selects the camera_view under the
 *  cursor; when omitted, dispatches to all (only the one owning the selected
 *  node will act). */
export function composeSceneApplyWheel(
  deltaY: number,
  clientX: number,
  clientY: number,
  composeLayerId?: string
): void {
  if (composeLayerId != null) {
    sceneWheels.get(composeLayerId)?.(deltaY, clientX, clientY);
    return;
  }
  for (const wheel of sceneWheels.values()) wheel(deltaY, clientX, clientY);
}

/** Inside-canvas component that turns mesh clicks into scene-node selection
 *  and drags the selected node along the viewport-aligned plane through its
 *  current position. Lives in ComposeView so this behaviour is scoped to the
 *  Compose tab; the regular Viewport keeps its own selection model. */
/** Build a flat transform payload from the group's current position/rotation/scale,
 *  preserving scale fields from the stored components if present (drag/wheel only
 *  change position, so reading from the live group is safe — but we never overwrite
 *  scale unintentionally). */
function transformPayload(
  group: THREE.Group,
  node: { components: Record<string, unknown> } | undefined
): Record<string, number> {
  const p = group.position,
    r = group.rotation;
  const existing = (node?.components as Record<string, unknown> | undefined)
    ?.transform as Record<string, unknown> | undefined;
  return {
    x: p.x,
    y: p.y,
    z: p.z,
    rx: r.x,
    ry: r.y,
    rz: r.z,
    sx: (existing?.sx as number | undefined) ?? group.scale.x,
    sy: (existing?.sy as number | undefined) ?? group.scale.y,
    sz: (existing?.sz as number | undefined) ?? group.scale.z,
  };
}

export function ComposeSceneInteractions({
  children,
  composeLayerId,
}: {
  children: React.ReactNode;
  /** Identifies which camera_view this interaction scope belongs to; keys this
   *  scope's handlers in the per-layer interaction registry. */
  composeLayerId?: string;
}) {
  const { camera, gl } = useThree();
  // Per-gesture throttle: only emit when at least PREVIEW_INTERVAL_MS has passed
  // since the last emission for this nodeId.
  const lastPreviewAtRef = useRef<{ nodeId: string; t: number } | null>(null);
  const emitPreview = (nodeId: string, group: THREE.Group) => {
    const now = performance.now();
    const last = lastPreviewAtRef.current;
    if (last && last.nodeId === nodeId && now - last.t < PREVIEW_INTERVAL_MS)
      return;
    lastPreviewAtRef.current = { nodeId, t: now };
    const node = useEditorStore.getState().nodes.find((n) => n.id === nodeId);
    sendNodeTransformPreview(nodeId, transformPayload(group, node));
  };

  // Mirror the live group transform back into the store so React's declarative
  // `position={[t.x, t.y, t.z]}` on the node renderer stays in sync with what
  // we've imperatively written to group.position. Without this, any unrelated
  // store update during a drag triggers a re-render that resets `position` to
  // the stale pre-drag value. Throttled to ~30 Hz to avoid re-render storms.
  const lastStoreSyncAtRef = useRef<{ nodeId: string; t: number } | null>(null);
  const syncToStore = (nodeId: string, group: THREE.Group) => {
    const now = performance.now();
    const last = lastStoreSyncAtRef.current;
    if (last && last.nodeId === nodeId && now - last.t < PREVIEW_INTERVAL_MS)
      return;
    lastStoreSyncAtRef.current = { nodeId, t: now };
    const store = useEditorStore.getState();
    const node = store.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const components = {
      ...node.components,
      transform: { type: 'transform', ...transformPayload(group, node) },
    };
    store.updateNode(nodeId, { components });
  };
  const dragRef = useRef<{
    nodeId: string;
    group: THREE.Group;
    plane: THREE.Plane;
    startWorld: THREE.Vector3;
    startLocal: THREE.Vector3;
    grabOffset: THREE.Vector3;
  } | null>(null);

  /** Begin a drag-move gesture on the given node. Captures pointer, hooks the
   *  pointermove/pointerup listeners that move the group along its viewport plane. */
  const beginDrag = (
    nodeId: string,
    group: THREE.Group,
    ray: THREE.Ray,
    pointerId: number
  ) => {
    const objWorld = new THREE.Vector3();
    group.getWorldPosition(objWorld);
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      camDir,
      objWorld
    );
    const hit = new THREE.Vector3();
    if (!ray.intersectPlane(plane, hit)) return;
    const grabOffset = objWorld.clone().sub(hit);

    dragRef.current = {
      nodeId,
      group,
      plane,
      startWorld: objWorld.clone(),
      startLocal: group.position.clone(),
      grabOffset,
    };
    const canvas = gl.domElement;
    canvas.setPointerCapture(pointerId);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
  };

  const onMove = (ev: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const rect = gl.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    wheelRay.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    if (!wheelRay.ray.intersectPlane(d.plane, hit)) return;
    const targetWorld = hit.add(d.grabOffset);

    // Translate from world delta to local delta. If the group has a parent
    // (most scene nodes do — root group is the R3F scene root or a parent group),
    // convert world point to parent-local space.
    const parent = d.group.parent;
    const localTarget = parent
      ? parent.worldToLocal(targetWorld.clone())
      : targetWorld;
    d.group.position.copy(localTarget);
    emitPreview(d.nodeId, d.group);
    syncToStore(d.nodeId, d.group);
  };

  const onUp = (ev: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const canvas = gl.domElement;
    if (canvas.hasPointerCapture(ev.pointerId))
      canvas.releasePointerCapture(ev.pointerId);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    dragRef.current = null;

    // Persist the new transform.
    const store = useEditorStore.getState();
    const node = store.nodes.find((n) => n.id === d.nodeId);
    if (!node) return;
    const p = d.group.position;
    const r = d.group.rotation;
    const s = d.group.scale;
    const existing = (node.components as Record<string, unknown>)?.transform as
      | Record<string, unknown>
      | undefined;
    const components = {
      ...node.components,
      transform: {
        type: 'transform',
        x: p.x,
        y: p.y,
        z: p.z,
        rx: r.x,
        ry: r.y,
        rz: r.z,
        sx: (existing?.sx as number | undefined) ?? s.x,
        sy: (existing?.sy as number | undefined) ?? s.y,
        sz: (existing?.sz as number | undefined) ?? s.z,
      },
    };
    store.updateNode(d.nodeId, { components });
    api.updateNode(d.nodeId, { components }).catch(() => {});
  };

  // Wheel: instead of moving the object directly, each tick imparts an impulse
  // (velocity along the cursor ray) and a useFrame loop integrates the position
  // with exponential damping. When velocity decays past WHEEL_VELOCITY_EPS we
  // commit one final PUT. Stays client-only during the glide.
  const wheelStateRef = useRef<{
    nodeId: string;
    velocity: THREE.Vector3; // world-space units / sec
  } | null>(null);

  // The wheel handler is now invoked from the capture overlay (which owns all
  // input events). It applies an impulse to the selected node's velocity; the
  // useFrame loop below integrates and persists.
  useEffect(() => {
    const key = composeLayerId ?? '';
    sceneWheels.set(key, (deltaY: number, clientX: number, clientY: number) => {
      const store = useEditorStore.getState();
      const nodeId = store.selectedNodeId;
      if (!nodeId) return;
      const group = getNodeGroup(nodeId);
      if (!group) return;

      const rect = gl.domElement.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      wheelRay.setFromCamera(ndc, camera);
      const axis = wheelRay.ray.direction.clone().normalize();

      const camPos = new THREE.Vector3();
      camera.getWorldPosition(camPos);
      const pivotWorld = group.getWorldPosition(new THREE.Vector3());
      const distance = Math.max(
        MIN_CAM_DISTANCE,
        pivotWorld.distanceTo(camPos)
      );
      const impulse = axis.multiplyScalar(
        distance * WHEEL_IMPULSE_FRACTION * -Math.sign(deltaY)
      );

      const cur = wheelStateRef.current;
      if (cur && cur.nodeId === nodeId) cur.velocity.add(impulse);
      else wheelStateRef.current = { nodeId, velocity: impulse };
    });
    return () => {
      sceneWheels.delete(key);
    };
  });

  // Integrate the wheel velocity each frame. Persists the transform once the
  // glide settles (or when the selection changes / the node unmounts).
  const scratchPos = useRef(new THREE.Vector3()).current;
  useFrame((_state, dt) => {
    const w = wheelStateRef.current;
    if (!w) return;
    const group = getNodeGroup(w.nodeId);
    const stillSelected = useEditorStore.getState().selectedNodeId === w.nodeId;
    if (!group || !stillSelected) {
      // Lost target — drop velocity without persisting (the last write was already optimistic).
      wheelStateRef.current = null;
      return;
    }

    // Integrate position with the current velocity, applied to the group pivot.
    if (w.velocity.lengthSq() > 0) {
      const move = w.velocity.clone().multiplyScalar(dt);
      group.getWorldPosition(scratchPos);
      scratchPos.add(move);
      // Clamp: never push closer than MIN_CAM_DISTANCE along the camera→pivot axis.
      const camPos = new THREE.Vector3();
      camera.getWorldPosition(camPos);
      if (scratchPos.distanceTo(camPos) < MIN_CAM_DISTANCE) {
        const safe = scratchPos
          .sub(camPos)
          .normalize()
          .multiplyScalar(MIN_CAM_DISTANCE)
          .add(camPos);
        scratchPos.copy(safe);
        w.velocity.set(0, 0, 0);
      }
      const parent = group.parent;
      const localTarget = parent
        ? parent.worldToLocal(scratchPos.clone())
        : scratchPos.clone();
      group.position.copy(localTarget);
      emitPreview(w.nodeId, group);
      syncToStore(w.nodeId, group);
    }

    // Exponential damping: v *= damping^dt
    w.velocity.multiplyScalar(Math.pow(WHEEL_DAMPING_PER_SEC, dt));

    if (w.velocity.length() < WHEEL_VELOCITY_EPS) {
      // Settled — commit one PUT and drop the momentum state.
      const s = useEditorStore.getState();
      const node = s.nodes.find((n) => n.id === w.nodeId);
      wheelStateRef.current = null;
      if (!node) return;
      const p = group.position,
        r = group.rotation;
      const existing = (node.components as Record<string, unknown>)
        ?.transform as Record<string, unknown> | undefined;
      const components = {
        ...node.components,
        transform: {
          type: 'transform',
          x: p.x,
          y: p.y,
          z: p.z,
          rx: r.x,
          ry: r.y,
          rz: r.z,
          sx: (existing?.sx as number | undefined) ?? group.scale.x,
          sy: (existing?.sy as number | undefined) ?? group.scale.y,
          sz: (existing?.sz as number | undefined) ?? group.scale.z,
        },
      };
      s.updateNode(w.nodeId, { components });
      api.updateNode(w.nodeId, { components }).catch(() => {});
    }
  });

  // Custom raycast: AABB-only against registered node groups. Skips R3F's
  // default per-triangle raycast of every mesh under the wrapper, which was
  // killing frame rate while moving the cursor over a VRM.
  const wrapperRef = useRef<THREE.Group>(null);
  const aabb = useMemo(() => new THREE.Box3(), []);
  const tmpBox = useMemo(() => new THREE.Box3(), []);

  /** One-time per SkinnedMesh: bin each vertex into the bone with the highest
   *  skin weight, then compute that bone's local-space AABB over its bin.
   *  Cached on userData so the vertex scan only happens once per mesh. */
  type BoneBoxes = { boneIndices: number[]; localBoxes: THREE.Box3[] };
  const buildBoneBoxes = (mesh: THREE.SkinnedMesh): BoneBoxes | null => {
    const geom = mesh.geometry;
    const posAttr = geom?.attributes?.position as
      | THREE.BufferAttribute
      | undefined;
    const skinIdxAttr = geom?.attributes?.skinIndex as
      | THREE.BufferAttribute
      | undefined;
    const skinWtAttr = geom?.attributes?.skinWeight as
      | THREE.BufferAttribute
      | undefined;
    if (!posAttr || !skinIdxAttr || !skinWtAttr) return null;
    const skeleton = mesh.skeleton;
    if (!skeleton) return null;

    const localByBone = new Map<number, THREE.Box3>();
    const vBind = new THREE.Vector3();
    const vBoneLocal = new THREE.Vector3();
    const invBindBuf = new THREE.Matrix4();

    for (let i = 0; i < posAttr.count; i++) {
      // Pick the dominant bone for this vertex (highest weight).
      let bestBone = -1,
        bestWt = -Infinity;
      for (let k = 0; k < 4; k++) {
        const wt = skinWtAttr.getComponent(i, k);
        if (wt > bestWt) {
          bestWt = wt;
          bestBone = skinIdxAttr.getComponent(i, k);
        }
      }
      if (bestBone < 0 || bestWt <= 0) continue;
      vBind.fromBufferAttribute(posAttr, i);
      // Transform the bind-pose vertex into the bone's local space via its
      // inverse bind matrix. The bone box thus expresses "where this vertex
      // sits relative to the bone" — applying the live bone matrix later puts
      // it back in world space at the bone's current pose.
      invBindBuf.copy(skeleton.boneInverses[bestBone]);
      vBoneLocal.copy(vBind).applyMatrix4(invBindBuf);
      let box = localByBone.get(bestBone);
      if (!box) {
        box = new THREE.Box3();
        localByBone.set(bestBone, box);
      }
      box.expandByPoint(vBoneLocal);
    }

    const boneIndices: number[] = [];
    const localBoxes: THREE.Box3[] = [];
    for (const [boneIdx, box] of localByBone) {
      if (box.isEmpty()) continue;
      boneIndices.push(boneIdx);
      localBoxes.push(box);
    }
    return { boneIndices, localBoxes };
  };

  /** Compute the world-space AABB envelope of a node by unioning the
   *  transformed-to-world AABBs of each per-bone box (skinned meshes) and each
   *  static mesh's local AABB. Used only as a cheap prefilter; precise picking
   *  iterates each underlying OBB via {@link pickPreciseHit}. */
  const computeMeshAabb = (root: THREE.Object3D, out: THREE.Box3): boolean => {
    out.makeEmpty();
    root.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      const isSkinned =
        (mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true;
      const geom = mesh.geometry;
      const posAttr = geom?.attributes?.position as
        | THREE.BufferAttribute
        | undefined;
      if (!posAttr) return;

      const ud = mesh.userData as {
        __composeLocalAabb?: THREE.Box3;
        __composeBoneBoxes?: BoneBoxes | null;
      };

      if (isSkinned) {
        // Skinned: build per-bone bin boxes once, then transform with live bone matrices each call.
        if (ud.__composeBoneBoxes === undefined) {
          ud.__composeBoneBoxes = buildBoneBoxes(mesh as THREE.SkinnedMesh);
        }
        const bb = ud.__composeBoneBoxes;
        const sm = mesh as THREE.SkinnedMesh;
        if (bb && sm.skeleton) {
          for (let i = 0; i < bb.boneIndices.length; i++) {
            const bone = sm.skeleton.bones[bb.boneIndices[i]];
            if (!bone) continue;
            tmpBox.copy(bb.localBoxes[i]).applyMatrix4(bone.matrixWorld);
            out.union(tmpBox);
          }
          return;
        }
        // Fallback to bind-pose AABB if skinning data was missing.
      }

      // Static mesh (or skinned fallback): cache local AABB, transform by matrixWorld.
      if (!mesh.isMesh && !isSkinned) return;
      let local = ud.__composeLocalAabb;
      if (!local) {
        local = new THREE.Box3();
        const v = new THREE.Vector3();
        for (let i = 0; i < posAttr.count; i++) {
          v.fromBufferAttribute(posAttr, i);
          local.expandByPoint(v);
        }
        ud.__composeLocalAabb = local;
      }
      tmpBox.copy(local).applyMatrix4(mesh.matrixWorld);
      out.union(tmpBox);
    });
    return !out.isEmpty();
  };

  /** Ray-vs-OBB by transforming the ray into the box's local frame and doing
   *  ray-vs-AABB there. `invWorld` is the inverse of the world matrix that maps
   *  local-space → world-space. Returns the world-space hit distance, or -1. */
  const tmpRay = useMemo(() => new THREE.Ray(), []);
  const tmpInvWorld = useMemo(() => new THREE.Matrix4(), []);
  const tmpHit = useMemo(() => new THREE.Vector3(), []);
  const rayVsObb = (
    worldRay: THREE.Ray,
    worldMatrix: THREE.Matrix4,
    localBox: THREE.Box3
  ): number => {
    tmpInvWorld.copy(worldMatrix).invert();
    tmpRay.copy(worldRay).applyMatrix4(tmpInvWorld);
    // applyMatrix4 doesn't renormalise direction, but for ray-vs-AABB the
    // intersection-distance scales by the inverse of the direction's new length.
    const dirScale = tmpRay.direction.length();
    if (dirScale === 0) return -1;
    tmpRay.direction.divideScalar(dirScale);
    if (!tmpRay.intersectBox(localBox, tmpHit)) return -1;
    // localDist along the normalised local ray → worldDist = localDist / dirScale.
    const localDist = tmpHit.distanceTo(tmpRay.origin);
    return localDist / dirScale;
  };

  /** Walk a node's meshes and find the closest precise-pick hit on any per-bone
   *  OBB (skinned) or static-mesh OBB. Returns world-space distance or -1. */
  const pickPreciseHit = (
    root: THREE.Object3D,
    worldRay: THREE.Ray
  ): number => {
    let best = -1;
    root.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      const isSkinned =
        (mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true;
      const ud = mesh.userData as {
        __composeLocalAabb?: THREE.Box3;
        __composeBoneBoxes?: BoneBoxes | null;
      };

      if (isSkinned) {
        const bb = ud.__composeBoneBoxes;
        const sm = mesh as THREE.SkinnedMesh;
        if (bb && sm.skeleton) {
          for (let i = 0; i < bb.boneIndices.length; i++) {
            const bone = sm.skeleton.bones[bb.boneIndices[i]];
            if (!bone) continue;
            // Each bone box is local to its bone; world matrix is bone.matrixWorld.
            const d = rayVsObb(worldRay, bone.matrixWorld, bb.localBoxes[i]);
            if (d > 0 && (best < 0 || d < best)) best = d;
          }
          return;
        }
      }

      if (!mesh.isMesh && !isSkinned) return;
      const local = ud.__composeLocalAabb;
      if (!local) return;
      const d = rayVsObb(worldRay, mesh.matrixWorld, local);
      if (d > 0 && (best < 0 || d < best)) best = d;
    });
    return best;
  };

  /** Core picker shared between R3F's pointer events and the layer-cycle
   *  helper. Returns the closest node intersection (or null) and writes a flat
   *  list of hits ordered nearest-first into `out` if provided. */
  const pickNodes = (
    ray: THREE.Ray,
    out?: THREE.Intersection[]
  ): { nodeId: string; group: THREE.Group; distance: number } | null => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return null;
    const hits: {
      nodeId: string;
      group: THREE.Group;
      distance: number;
      point: THREE.Vector3;
    }[] = [];
    for (const [nodeId, group] of listRegisteredNodeGroups()) {
      // Only consider groups inside our wrapper subtree (skip the Scene-tab's
      // copy of the registered groups, which lives in another Canvas).
      let inside = false;
      let p: THREE.Object3D | null = group;
      while (p) {
        if (p === wrapper) {
          inside = true;
          break;
        }
        p = p.parent;
      }
      if (!inside) continue;

      // Prefilter: ray-vs-union AABB.
      group.updateMatrixWorld(true);
      if (!computeMeshAabb(group, aabb)) continue;
      if (aabb.containsPoint(ray.origin)) continue;
      if (!ray.intersectBox(aabb, new THREE.Vector3())) continue;

      // Precise: ray-vs-per-bone-OBB / static-mesh-OBB.
      const distance = pickPreciseHit(group, ray);
      if (distance < 0) continue;
      const point = ray.origin
        .clone()
        .add(ray.direction.clone().multiplyScalar(distance));
      hits.push({ nodeId, group, distance, point });
    }
    hits.sort((a, b) => a.distance - b.distance);
    if (out) {
      for (const h of hits) {
        out.push({
          distance: h.distance,
          point: h.point,
          object: h.group,
        } as unknown as THREE.Intersection);
      }
    }
    return hits[0] ?? null;
  };

  const customRaycast = (
    raycaster: THREE.Raycaster,
    intersects: THREE.Intersection[]
  ) => {
    const debug = (window as unknown as { __composeRaycastDebug?: boolean })
      .__composeRaycastDebug;
    if (debug) {
      // eslint-disable-next-line no-console
      console.group('[compose raycast]');
      console.log(
        'ray.origin',
        raycaster.ray.origin.toArray(),
        'ray.direction',
        raycaster.ray.direction.toArray()
      );
    }
    pickNodes(raycaster.ray, intersects);
    if (debug) {
      console.log(
        'result',
        intersects.length,
        'closest',
        intersects[0]?.object?.name
      );
      console.groupEnd();
    }
  };

  // Register this camera_view's screen-space picker + drag starter under its
  // composeLayerId so the capture overlay can dispatch to whichever camera_view
  // is under the cursor.
  useEffect(() => {
    const key = composeLayerId ?? '';
    scenePickers.set(key, (clientX: number, clientY: number) => {
      const canvas = gl.domElement;
      const rect = canvas.getBoundingClientRect();
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      )
        return null;
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      wheelRay.setFromCamera(ndc, camera);
      return pickNodes(wheelRay.ray)?.nodeId ?? null;
    });
    sceneDragStarters.set(key, (nodeId, clientX, clientY, pointerId) => {
      const group = getNodeGroup(nodeId);
      if (!group) return false;
      const canvas = gl.domElement;
      const rect = canvas.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      wheelRay.setFromCamera(ndc, camera);
      beginDrag(nodeId, group, wheelRay.ray.clone(), pointerId);
      return true;
    });
    return () => {
      scenePickers.delete(key);
      sceneDragStarters.delete(key);
    };
  });

  // Each frame: disable raycast on every descendant so R3F only sees the
  // wrapper's custom raycast above. The original raycast is stashed on
  // userData so customRaycast can temporarily restore it for a precise
  // second-pass test on whichever subtree passed the AABB prefilter.
  useFrame(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    wrapper.traverse((o) => {
      const ud = o.userData as Record<string, unknown>;
      if (ud[COMPOSE_RAYCAST_DISABLED]) return;
      o.raycast = noopRaycast;
      ud[COMPOSE_RAYCAST_DISABLED] = true;
    });
    wrapper.raycast = customRaycast;
  });

  return (
    <group ref={wrapperRef}>
      {children}
      <BoneBoxDebug wrapperRef={wrapperRef} />
    </group>
  );
}

// ── Debug overlay: render per-bone bounding boxes ────────────────────────────
// Enable in the browser console with `window.__composeBoneBoxDebug = true`.
// Draws every cached per-bone AABB for SkinnedMesh descendants of the Compose
// wrapper, transformed by the bone's live matrix. Cheap to leave installed;
// returns null and skips traversal when the flag is off.

const BONE_BOX_COLOR = 0xffaa00;
const NODE_BOX_COLOR = 0x00ff88;

/** Unit-cube wireframe geometry (12 edges centred on the origin, side length 1).
 *  Scale + translate via a custom matrix to render any rotated box. */
function makeUnitCubeEdges(): THREE.BufferGeometry {
  const h = 0.5;
  const verts = [
    // bottom
    -h,
    -h,
    -h,
    h,
    -h,
    -h,
    h,
    -h,
    -h,
    h,
    -h,
    h,
    h,
    -h,
    h,
    -h,
    -h,
    h,
    -h,
    -h,
    h,
    -h,
    -h,
    -h,
    // top
    -h,
    h,
    -h,
    h,
    h,
    -h,
    h,
    h,
    -h,
    h,
    h,
    h,
    h,
    h,
    h,
    -h,
    h,
    h,
    -h,
    h,
    h,
    -h,
    h,
    -h,
    // verticals
    -h,
    -h,
    -h,
    -h,
    h,
    -h,
    h,
    -h,
    -h,
    h,
    h,
    -h,
    h,
    -h,
    h,
    h,
    h,
    h,
    -h,
    -h,
    h,
    -h,
    h,
    h,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(verts), 3)
  );
  return g;
}

/** A LineSegments cube whose world transform is set manually each frame to
 *  match a box in some parent space (e.g. bone-local). Renders as a true OBB
 *  in world space rather than an AABB. */
function makeObbHelper(color: number): THREE.LineSegments {
  const ls = new THREE.LineSegments(
    makeUnitCubeEdges(),
    new THREE.LineBasicMaterial({ color })
  );
  ls.matrixAutoUpdate = false;
  return ls;
}

function BoneBoxDebug({
  wrapperRef,
}: {
  wrapperRef: React.RefObject<THREE.Group>;
}) {
  const groupRef = useRef<THREE.Group>(null);
  // Pool reused per frame so we don't churn geometries. Bone helpers are OBBs
  // (parented in world space but matrix-driven from bone × box). Node helpers
  // are still axis-aligned boxes (the union envelope used by the prefilter).
  const pool = useRef<{
    boneHelpers: THREE.LineSegments[];
    nodeHelpers: THREE.Box3Helper[];
  }>({ boneHelpers: [], nodeHelpers: [] });
  const nodeBox = useMemo(() => new THREE.Box3(), []);
  const tmpBox = useMemo(() => new THREE.Box3(), []); // scratch for union AABB
  const tmpMat = useMemo(() => new THREE.Matrix4(), []);
  const tmpScale = useMemo(() => new THREE.Matrix4(), []);
  const tmpTrans = useMemo(() => new THREE.Matrix4(), []);
  const tmpCentre = useMemo(() => new THREE.Vector3(), []);
  const tmpSize = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const debugOn = (window as unknown as { __composeBoneBoxDebug?: boolean })
      .__composeBoneBoxDebug;
    const root = groupRef.current;
    const wrapper = wrapperRef.current;
    if (!root) return;
    if (!debugOn || !wrapper) {
      // Hide all helpers when the flag is off.
      for (const h of pool.current.boneHelpers) h.visible = false;
      for (const h of pool.current.nodeHelpers) h.visible = false;
      return;
    }

    let boneCursor = 0;
    let nodeCursor = 0;
    const ensureBoneHelper = (): THREE.LineSegments => {
      let h = pool.current.boneHelpers[boneCursor];
      if (!h) {
        h = makeObbHelper(BONE_BOX_COLOR);
        pool.current.boneHelpers.push(h);
        root.add(h);
      }
      boneCursor++;
      h.visible = true;
      return h;
    };
    const ensureNodeHelper = (): THREE.Box3Helper => {
      let h = pool.current.nodeHelpers[nodeCursor];
      if (!h) {
        h = new THREE.Box3Helper(new THREE.Box3(), NODE_BOX_COLOR);
        pool.current.nodeHelpers.push(h);
        root.add(h);
      }
      nodeCursor++;
      h.visible = true;
      return h;
    };

    /** Position/rotate/scale a bone-OBB helper so its unit cube becomes the
     *  given local box, transformed by `parentMatrix`. */
    const placeObbHelper = (
      helper: THREE.LineSegments,
      localBox: THREE.Box3,
      parentMatrix: THREE.Matrix4
    ) => {
      localBox.getCenter(tmpCentre);
      localBox.getSize(tmpSize);
      tmpScale.makeScale(tmpSize.x, tmpSize.y, tmpSize.z);
      tmpTrans.makeTranslation(tmpCentre.x, tmpCentre.y, tmpCentre.z);
      // matrixWorld = parentMatrix · translate(centre) · scale(size)
      tmpMat.copy(parentMatrix).multiply(tmpTrans).multiply(tmpScale);
      helper.matrix.copy(tmpMat);
      helper.matrixWorld.copy(tmpMat);
    };

    // Walk every registered node group inside our wrapper subtree, mirroring the
    // raycast's selection logic so the debug view matches what picking sees.
    for (const [, group] of listRegisteredNodeGroups()) {
      let inside = false;
      let p: THREE.Object3D | null = group;
      while (p) {
        if (p === wrapper) {
          inside = true;
          break;
        }
        p = p.parent;
      }
      if (!inside) continue;
      group.updateMatrixWorld(true);

      nodeBox.makeEmpty();
      group.traverseVisible((o) => {
        const mesh = o as THREE.Mesh;
        const isSkinned =
          (mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh ===
          true;
        const ud = mesh.userData as {
          __composeLocalAabb?: THREE.Box3;
          __composeBoneBoxes?: {
            boneIndices: number[];
            localBoxes: THREE.Box3[];
          } | null;
        };

        if (isSkinned) {
          const bb = ud.__composeBoneBoxes;
          const sm = mesh as THREE.SkinnedMesh;
          if (bb && sm.skeleton) {
            for (let i = 0; i < bb.boneIndices.length; i++) {
              const bone = sm.skeleton.bones[bb.boneIndices[i]];
              if (!bone) continue;
              const h = ensureBoneHelper();
              placeObbHelper(h, bb.localBoxes[i], bone.matrixWorld);
              // For the union AABB, still compute the world-space envelope.
              tmpBox.copy(bb.localBoxes[i]).applyMatrix4(bone.matrixWorld);
              nodeBox.union(tmpBox);
            }
            return;
          }
        }

        // Static mesh fallback: draw the OBB (mesh-local box × matrixWorld).
        const local = ud.__composeLocalAabb;
        if (!local) return;
        const h = ensureBoneHelper();
        placeObbHelper(h, local, mesh.matrixWorld);
        tmpBox.copy(local).applyMatrix4(mesh.matrixWorld);
        nodeBox.union(tmpBox);
      });

      if (!nodeBox.isEmpty()) {
        const h = ensureNodeHelper();
        h.box.copy(nodeBox);
        h.updateMatrixWorld(true);
      }
    }

    // Hide leftover helpers from previous frames if the node count shrank.
    for (let i = boneCursor; i < pool.current.boneHelpers.length; i++)
      pool.current.boneHelpers[i].visible = false;
    for (let i = nodeCursor; i < pool.current.nodeHelpers.length; i++)
      pool.current.nodeHelpers[i].visible = false;
  });

  return <group ref={groupRef} />;
}
