import * as THREE from 'three';

/** Pure world-axis rotation helpers for the compose 3D gizmo (Ctrl-drag rotate,
 *  Ctrl-scroll roll). Kept standalone so they're unit-testable without the
 *  Viewport/R3F import chain. */

const _qDelta = new THREE.Quaternion();
const _qWorld = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _pivotPos = new THREE.Vector3();
const _centerBox = new THREE.Box3();
const _tmpBox = new THREE.Box3();

/** World-space geometric centre (bounding-box centre) of an object's *visible*
 *  renderable meshes, falling back to its origin when it has no geometry. This is
 *  the pivot rotation spins around — the *centre*, not the transform origin,
 *  which can sit off to one side of the geometry.
 *
 *  Uses the rest/bind-pose bounds (a stable centre that doesn't shift as the
 *  avatar animates) and — unlike `Box3.setFromObject` — skips invisible objects,
 *  so editor-only helpers (e.g. the hidden bone-visualisation cylinder at the
 *  avatar's origin) don't drag the centre off the visible body. */
export function objectWorldCenter(
  obj: THREE.Object3D,
  out: THREE.Vector3
): THREE.Vector3 {
  obj.updateWorldMatrix(true, true);
  _centerBox.makeEmpty();
  obj.traverseVisible((o) => {
    const mesh = o as THREE.Mesh;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!mesh.isMesh || !geom) return;
    if (!geom.boundingBox) geom.computeBoundingBox();
    if (!geom.boundingBox) return;
    _tmpBox.copy(geom.boundingBox).applyMatrix4(mesh.matrixWorld);
    _centerBox.union(_tmpBox);
  });
  return _centerBox.isEmpty()
    ? obj.getWorldPosition(out)
    : _centerBox.getCenter(out);
}

/** Rotate `obj` around a world-space `axis` by `angle` (radians) about the world
 *  point `pivot` (or the object's own origin when `pivot` is omitted). With a
 *  pivot it updates position too, so the object spins about that point. Writes
 *  back a local transform that yields the intended world result regardless of any
 *  parent transform. */
export function rotateAroundWorldAxis(
  obj: THREE.Object3D,
  axis: THREE.Vector3,
  angle: number,
  pivot?: THREE.Vector3
): void {
  if (angle === 0) return;
  // Refresh matrixWorld from local first so chained rotations (yaw then pitch in
  // one move, or several moves per frame) read the accumulated transform rather
  // than a stale one from the last render.
  obj.updateWorldMatrix(true, false);
  _qDelta.setFromAxisAngle(axis, angle);
  obj.getWorldQuaternion(_qWorld).premultiply(_qDelta);
  if (obj.parent) obj.parent.getWorldQuaternion(_qParent).invert();
  else _qParent.identity();
  obj.quaternion.copy(_qParent.multiply(_qWorld));
  if (pivot) {
    obj.getWorldPosition(_pivotPos).sub(pivot).applyQuaternion(_qDelta).add(pivot);
    obj.position.copy(
      obj.parent ? obj.parent.worldToLocal(_pivotPos) : _pivotPos
    );
  }
}
