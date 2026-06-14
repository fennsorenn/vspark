/**
 * World-transform composition for spawned scene-node clones.
 *
 * A spawn clone is rendered at the scene root (`parentId: null`) so it stays
 * visible even when its source template is hidden. But scene-node transforms
 * are applied per-node LOCALLY via React-Three-Fiber group nesting (a child's
 * world placement comes from its ancestors' groups), so a clone of a CHILD
 * node, hoisted to root with only its local transform, lands in the wrong
 * place — it loses every ancestor's translate/rotate/scale.
 *
 * This bakes the source node's full ancestor-composed WORLD transform into the
 * clone, so it renders exactly where the source sits while staying detached
 * from the (possibly hidden) template. The matrix math mirrors three.js
 * exactly (Euler order 'XYZ', Matrix4 compose/decompose) so the baked TRS
 * decomposes to the same placement the frontend's group nesting would produce.
 *
 * Translation + rotation + uniform scale compose exactly; non-uniform scale
 * combined with ancestor rotation can introduce shear a single TRS can't
 * represent (a rare, pathological case) — still strictly better than dropping
 * all ancestor transform. Bone-attached ancestors aren't scene_nodes and
 * aren't captured (the source's BoneFollower handles that case live).
 */
import { getDb } from '../db/index.js';

export interface TRS {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  sx: number;
  sy: number;
  sz: number;
}

/** Column-major 4x4 (three.js Matrix4 element order). */
type Mat4 = number[];

const ZERO_TRS = (): TRS => ({
  x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
});

/** Read a node's local TRS from its `components.transform` (frontend defaults:
 *  position/rotation 0, scale 1). */
function localTRS(componentsJson: string): TRS {
  let t: Record<string, unknown> = {};
  try {
    const c = JSON.parse(componentsJson || '{}') as Record<string, unknown>;
    if (c.transform && typeof c.transform === 'object')
      t = c.transform as Record<string, unknown>;
  } catch {
    /* malformed — identity */
  }
  const n = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : d;
  return {
    x: n(t.x, 0), y: n(t.y, 0), z: n(t.z, 0),
    rx: n(t.rx, 0), ry: n(t.ry, 0), rz: n(t.rz, 0),
    sx: n(t.sx, 1), sy: n(t.sy, 1), sz: n(t.sz, 1),
  };
}

/** Euler (radians, order 'XYZ') → quaternion [x,y,z,w]. (three.js Quaternion.setFromEuler) */
function eulerXYZToQuat(x: number, y: number, z: number): [number, number, number, number] {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/** TRS → Mat4 (three.js Matrix4.compose). */
function trsToMat4(t: TRS): Mat4 {
  const [qx, qy, qz, qw] = eulerXYZToQuat(t.rx, t.ry, t.rz);
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  const { sx, sy, sz } = t;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t.x, t.y, t.z, 1,
  ];
}

/** a * b (three.js Matrix4.multiplyMatrices), column-major. */
function multiply(a: Mat4, b: Mat4): Mat4 {
  const a11 = a[0], a12 = a[4], a13 = a[8], a14 = a[12];
  const a21 = a[1], a22 = a[5], a23 = a[9], a24 = a[13];
  const a31 = a[2], a32 = a[6], a33 = a[10], a34 = a[14];
  const a41 = a[3], a42 = a[7], a43 = a[11], a44 = a[15];
  const b11 = b[0], b12 = b[4], b13 = b[8], b14 = b[12];
  const b21 = b[1], b22 = b[5], b23 = b[9], b24 = b[13];
  const b31 = b[2], b32 = b[6], b33 = b[10], b34 = b[14];
  const b41 = b[3], b42 = b[7], b43 = b[11], b44 = b[15];
  return [
    a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41,
    a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41,
    a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41,
    a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41,
    a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42,
    a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42,
    a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42,
    a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42,
    a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43,
    a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43,
    a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43,
    a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43,
    a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44,
    a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44,
    a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44,
    a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44,
  ];
}

/** Mat4 → TRS (three.js Matrix4.decompose + Euler.setFromRotationMatrix 'XYZ'). */
function decompose(m: Mat4): TRS {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  // Negative determinant of the linear part → a reflection; three.js folds the
  // sign onto x scale.
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[4] * (m[1] * m[10] - m[2] * m[9]) +
    m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sx = -sx;

  const isx = sx === 0 ? 0 : 1 / sx;
  const isy = sy === 0 ? 0 : 1 / sy;
  const isz = sz === 0 ? 0 : 1 / sz;
  // Rotation matrix elements (three.js indexing: m11=te[0], m12=te[4], …).
  const m11 = m[0] * isx, m21 = m[1] * isx, m31 = m[2] * isx;
  const m12 = m[4] * isy, m22 = m[5] * isy, m32 = m[6] * isy;
  const m13 = m[8] * isz, m23 = m[9] * isz, m33 = m[10] * isz;

  const clamp = (v: number): number => Math.max(-1, Math.min(1, v));
  const ry = Math.asin(clamp(m13));
  let rx: number, rz: number;
  if (Math.abs(m13) < 0.9999999) {
    rx = Math.atan2(-m23, m33);
    rz = Math.atan2(-m12, m11);
  } else {
    rx = Math.atan2(m32, m22);
    rz = 0;
  }
  return { x: m[12], y: m[13], z: m[14], rx, ry, rz, sx, sy, sz };
}

/** Compose a node's world transform from its ancestor chain ordered
 *  [node, parent, …, root]. Exported for verification. */
export function composeWorld(chainNodeToRoot: TRS[]): TRS {
  // world = M_root · … · M_parent · M_node
  let world = trsToMat4(chainNodeToRoot[chainNodeToRoot.length - 1] ?? ZERO_TRS());
  for (let i = chainNodeToRoot.length - 2; i >= 0; i--)
    world = multiply(world, trsToMat4(chainNodeToRoot[i]));
  return decompose(world);
}

/** The world transform of `nodeId`, composed from its scene-node ancestor
 *  chain (walks `parent_id` to the root). */
export function nodeWorldTransform(nodeId: string): TRS {
  const db = getDb();
  const chain: TRS[] = [];
  let cur: string | null = nodeId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    // Re-prepare each step: the db wrapper finalizes a statement after one use.
    const row = db
      .prepare('SELECT parent_id, components FROM scene_nodes WHERE id = ?')
      .get(cur) as { parent_id: string | null; components: string } | undefined;
    if (!row) break;
    chain.push(localTRS(row.components));
    cur = row.parent_id;
  }
  if (chain.length === 0) return ZERO_TRS();
  return composeWorld(chain);
}
