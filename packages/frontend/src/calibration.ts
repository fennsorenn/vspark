import * as THREE from 'three';

// ---------- Types ----------

export interface ArmCalib {
  /** Uniform scale applied to reach (distance from shoulder to wrist). >1 = extend further. */
  scale: number;
  /** Position offset added after scaling, in world space (metres). Corrects residual translation. */
  offset: [number, number, number];
}

export interface VmcCalibration {
  /**
   * Neutral-pose offsets keyed by VMC/RhyLive bone name (e.g. 'Head', 'Spine').
   * At runtime each bone's incoming quaternion is premultiplied by the stored
   * quaternion's inverse, zeroing out any systematic tilt/offset the user had
   * at calibration time.
   */
  bodyOffsets: Record<string, [number, number, number, number]>;
  left: ArmCalib;
  right: ArmCalib;
}

export const DEFAULT_ARM_CALIB: ArmCalib = { scale: 1, offset: [0, 0, 0] };

export const DEFAULT_CALIBRATION: VmcCalibration = {
  bodyOffsets: {},
  left: { ...DEFAULT_ARM_CALIB },
  right: { ...DEFAULT_ARM_CALIB },
};

// ---------- Arm correction ----------

const _rel = new THREE.Vector3();
const _off = new THREE.Vector3();

/**
 * Apply the stored arm calibration to a raw FK wrist world position.
 * Returns the corrected wrist world position in `out`.
 *
 * Correction is applied relative to the shoulder pivot so scale and offset
 * are consistent regardless of where the avatar stands in the scene.
 */
export function applyArmCalib(
  wristWorld: THREE.Vector3,
  shoulderWorld: THREE.Vector3,
  calib: ArmCalib,
  out: THREE.Vector3
): void {
  _rel.subVectors(wristWorld, shoulderWorld);
  _rel.multiplyScalar(calib.scale);
  _off.fromArray(calib.offset);
  out.addVectors(shoulderWorld, _rel).add(_off);
}

// ---------- Direction-based upper-arm IK ----------

const _targetDir = new THREE.Vector3();
const _restDir = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Given a corrected wrist world position, compute the normalized-pose quaternion
 * for the upper-arm bone so the arm points toward the target.
 *
 * Strategy: convert the desired arm direction from world space into the upper-arm
 * parent's frame (using the raw clavicle bone's world quaternion as an approximation
 * of the normalised parent frame), then express it as a rotation from the rest
 * direction (+X for left arm, -X for right arm).
 *
 * @param correctedWrist   Target wrist world position (after applyArmCalib)
 * @param upperArmBone     Raw Three.js bone for the upper arm (from getRawBoneNode)
 * @param isRight          True for the right arm (rest direction is -X)
 */
export function upperArmNormRotFromTarget(
  correctedWrist: THREE.Vector3,
  upperArmBone: THREE.Object3D,
  isRight: boolean
): THREE.Quaternion {
  // Shoulder pivot = upper arm bone's world position
  const shoulderWorld = new THREE.Vector3();
  upperArmBone.getWorldPosition(shoulderWorld);

  // Direction we want the arm to point in world space
  _targetDir.subVectors(correctedWrist, shoulderWorld).normalize();

  // Rest direction of the upper arm in normalised pose (+X left, -X right)
  _restDir.set(isRight ? -1 : 1, 0, 0);

  // Parent world quaternion (clavicle raw bone) — approximates normalised parent frame
  const parentWorldQ = new THREE.Quaternion();
  if (upperArmBone.parent) upperArmBone.parent.getWorldQuaternion(parentWorldQ);

  // Bring target direction into parent's local frame
  const parentWorldQInv = parentWorldQ.clone().invert();
  const localTargetDir = _targetDir.clone().applyQuaternion(parentWorldQInv);

  // Rotation from rest direction to local target direction
  _q.setFromUnitVectors(_restDir, localTargetDir);
  return _q.clone();
}

// ---------- Elbow angle from reach ----------

/**
 * Given arm bone lengths and a target reach distance, return the normalised
 * elbow bend angle (0 = fully extended, 1 = fully bent).
 * Uses law of cosines.  Returns null if target is unreachable.
 */
export function elbowAngleForReach(
  upperLen: number,
  lowerLen: number,
  reachDist: number
): number {
  const d = Math.max(
    Math.abs(upperLen - lowerLen) + 0.001,
    Math.min(upperLen + lowerLen - 0.001, reachDist)
  );
  const cosElbow =
    (upperLen * upperLen + lowerLen * lowerLen - d * d) /
    (2 * upperLen * lowerLen);
  // elbowAngle is the interior angle at the elbow joint
  const elbowAngle = Math.acos(Math.max(-1, Math.min(1, cosElbow)));
  // 0 = straight (pi radians interior angle), 1 = fully bent (0 radians)
  return 1 - elbowAngle / Math.PI;
}

// ---------- Calibration fitting ----------

export interface CalibSample {
  /** FK-computed wrist world position (from VRM bones after raw pose applied). */
  fkWrist: [number, number, number];
  /** Target wrist world position (e.g. from face landmark or known pose). */
  targetWrist: [number, number, number];
  /** Shoulder (upper-arm bone) world position at capture time. */
  shoulder: [number, number, number];
}

/**
 * Fit ArmCalib from a set of (fkWrist, targetWrist, shoulder) samples.
 * Solves for a scale + offset that minimises squared error across all samples
 * in the shoulder-relative frame.
 *
 * With ≥2 samples we fit scale; with ≥1 we compute a residual offset.
 * A single near+far sample pair is enough for a reasonable calibration.
 */
export function fitArmCalib(samples: CalibSample[]): ArmCalib {
  if (samples.length === 0) return { ...DEFAULT_ARM_CALIB };

  const fkRel = samples.map((s) =>
    new THREE.Vector3(...s.fkWrist).sub(new THREE.Vector3(...s.shoulder))
  );
  const tgtRel = samples.map((s) =>
    new THREE.Vector3(...s.targetWrist).sub(new THREE.Vector3(...s.shoulder))
  );

  // Fit scale: minimise sum |scale * fkRel - tgtRel|^2
  // Closed form: scale = (sum fkRel·tgtRel) / (sum fkRel·fkRel)
  let num = 0,
    den = 0;
  for (let i = 0; i < samples.length; i++) {
    num += fkRel[i].dot(tgtRel[i]);
    den += fkRel[i].dot(fkRel[i]);
  }
  const scale = den < 1e-9 ? 1 : Math.max(0.1, Math.min(3, num / den));

  // Residual offset after scaling
  const offset = new THREE.Vector3();
  for (let i = 0; i < samples.length; i++) {
    offset.add(tgtRel[i].clone().sub(fkRel[i].clone().multiplyScalar(scale)));
  }
  offset.divideScalar(samples.length);

  return {
    scale,
    offset: [offset.x, offset.y, offset.z],
  };
}
