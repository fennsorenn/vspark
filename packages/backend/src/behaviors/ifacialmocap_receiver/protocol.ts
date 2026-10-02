/**
 * iFacialMocap wire protocol.
 *
 * Unlike VMC (binary OSC over UDP, passive listen) iFacialMocap is a plain-text
 * UDP protocol that has to be *asked* for data: the receiver sends a fixed
 * handshake string to the iOS device, and the device then streams ~60 fps to
 * the same port until it stops hearing from us. See
 * https://www.ifacialmocap.com/for-developer/.
 *
 * Payload (one datagram per frame), `|`-separated:
 *
 *   v2:  browDown_L&0|browDown_R&12|…|=head#1.2,3.4,5.6,0.0,0.1,0.2|rightEye#…|leftEye#…|
 *   v1:  browDown_L-0|browDown_R-12|…|=head#…|rightEye#…|leftEye#…|
 *
 * - Blendshape names are ARKit names with `_L` / `_R` side suffixes, weights are
 *   0..100 integers.
 * - `=head#` carries six comma-separated values: euler X,Y,Z in **degrees**
 *   followed by position X,Y,Z (cm, relative to the camera — unused here; the
 *   avatar's root is driven by the scene, not by the phone).
 * - `rightEye#` / `leftEye#` carry euler X,Y,Z in degrees.
 *
 * This module is pure — no sockets, no graph. Everything here is unit-tested.
 */

import { ARKIT_SHAPES } from '@vspark/shared/arkit';

/** Default UDP port. iFacialMocap always streams to 49983 on the receiving machine. */
export const IFM_DEFAULT_PORT = 49983;

/**
 * The magic string the device expects before it starts streaming. Re-sending it
 * is harmless and is how a receiver re-attaches after the app is restarted.
 * `sendDataVersion=v2` opts into the `&`-separated payload; devices that predate
 * it ignore the suffix and answer with the `-`-separated v1 form, which
 * `parseIFacialMocapPacket` also accepts.
 */
export const IFM_HANDSHAKE =
  'iFacialMocap_sahuasouryya9218sauhuiayeta91555dy3719|sendDataVersion=v2';

/** Unity HumanBodyBones names this source can produce (subset of RHYLIVE_BONES). */
export const IFM_BONES = ['Head', 'RightEye', 'LeftEye'] as const;

/** Per-axis sign flips applied to every incoming euler triple. */
export interface IFacialMocapAxisFlips {
  /** Invert rotation around X (nod / pitch). */
  invertPitch?: boolean;
  /** Invert rotation around Y (turn / yaw). */
  invertYaw?: boolean;
  /** Invert rotation around Z (tilt / roll). */
  invertRoll?: boolean;
}

export interface IFacialMocapFrame {
  /** Canonical ARKit shape name → 0..1 weight. Unknown names are dropped. */
  arkit: Record<string, number>;
  /** Unity HumanBodyBones name → `[x, y, z, w]` in Unity's left-handed frame. */
  bones: Record<string, [number, number, number, number]>;
  /**
   * Fixed-length numeric fingerprint of the frame (head + eye euler degrees
   * followed by the 52 ARKit weights in canonical order). Frame-to-frame deltas
   * over this vector drive tracking detection, mirroring how the VMC receiver
   * diffs the `/Body` float array. Built from the *raw* device values, before
   * axis flips, so toggling a flip mid-session isn't read as a motion spike.
   */
  signature: number[];
}

const ARKIT_SHAPE_SET: ReadonlySet<string> = new Set(ARKIT_SHAPES);

/**
 * `browDown_L` → `browDownLeft`. iFacialMocap uses side suffixes where ARKit
 * spells the side out; everything else is already the canonical ARKit name.
 */
export function normalizeShapeName(name: string): string {
  if (name.endsWith('_L')) return `${name.slice(0, -2)}Left`;
  if (name.endsWith('_R')) return `${name.slice(0, -2)}Right`;
  return name;
}

/**
 * Euler degrees → quaternion using Unity's `Quaternion.Euler` composition
 * (`q = qY * qX * qZ`), so the result lands in the same left-handed convention
 * the RhyLive/VMC bone mapper already converts from. That is what lets the
 * iFacialMocap pipeline reuse `rhylive_bone_mapper` verbatim.
 */
export function unityEulerToQuaternion(
  xDeg: number,
  yDeg: number,
  zDeg: number
): [number, number, number, number] {
  const half = Math.PI / 360; // deg → rad, halved for the quaternion terms
  const hx = xDeg * half;
  const hy = yDeg * half;
  const hz = zDeg * half;
  const sx = Math.sin(hx);
  const cx = Math.cos(hx);
  const sy = Math.sin(hy);
  const cy = Math.cos(hy);
  const sz = Math.sin(hz);
  const cz = Math.cos(hz);
  return [
    cy * sx * cz + sy * cx * sz,
    sy * cx * cz - cy * sx * sz,
    cy * cx * sz - sy * sx * cz,
    cy * cx * cz + sy * sx * sz,
  ];
}

/** Parse `x,y,z[,px,py,pz]` into a euler triple, or null when malformed. */
function readEuler(body: string): [number, number, number] | null {
  const parts = body.split(',');
  if (parts.length < 3) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const z = Number(parts[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
    return null;
  return [x, y, z];
}

/** Split a blendshape component into `[name, weight01]`, or null when malformed. */
function readShape(part: string): [string, number] | null {
  // v2 uses `name&value`; v1 uses `name-value`. Weights are non-negative
  // integers, so the first separator is unambiguous in both forms.
  const sep = part.includes('&') ? part.indexOf('&') : part.indexOf('-');
  if (sep <= 0) return null;
  const name = normalizeShapeName(part.slice(0, sep));
  if (!ARKIT_SHAPE_SET.has(name)) return null;
  const value = Number(part.slice(sep + 1));
  if (!Number.isFinite(value)) return null;
  return [name, value / 100];
}

/**
 * Parse one iFacialMocap datagram. Returns null when the payload carries
 * neither a recognised blendshape nor a head/eye transform — i.e. it is not an
 * iFacialMocap frame at all — so the caller can ignore stray traffic on the port.
 */
export function parseIFacialMocapPacket(
  text: string,
  flips: IFacialMocapAxisFlips = {}
): IFacialMocapFrame | null {
  const arkit: Record<string, number> = {};
  const eulers: Record<string, [number, number, number]> = {};

  for (const raw of text.split('|')) {
    const part = raw.trim();
    if (!part) continue;
    if (part.startsWith('=head#')) {
      const e = readEuler(part.slice('=head#'.length));
      if (e) eulers.Head = e;
    } else if (part.startsWith('rightEye#')) {
      const e = readEuler(part.slice('rightEye#'.length));
      if (e) eulers.RightEye = e;
    } else if (part.startsWith('leftEye#')) {
      const e = readEuler(part.slice('leftEye#'.length));
      if (e) eulers.LeftEye = e;
    } else {
      const shape = readShape(part);
      if (shape) arkit[shape[0]] = shape[1];
    }
  }

  if (Object.keys(arkit).length === 0 && Object.keys(eulers).length === 0)
    return null;

  const sx = flips.invertPitch ? -1 : 1;
  const sy = flips.invertYaw ? -1 : 1;
  const sz = flips.invertRoll ? -1 : 1;

  const bones: Record<string, [number, number, number, number]> = {};
  const signature: number[] = [];
  for (const bone of IFM_BONES) {
    const e = eulers[bone];
    if (e)
      bones[bone] = unityEulerToQuaternion(e[0] * sx, e[1] * sy, e[2] * sz);
    signature.push(e?.[0] ?? 0, e?.[1] ?? 0, e?.[2] ?? 0);
  }
  for (const shape of ARKIT_SHAPES) signature.push(arkit[shape] ?? 0);

  return { arkit, bones, signature };
}
