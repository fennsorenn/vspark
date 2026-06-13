import type * as THREE from 'three';

export interface AnimEntry {
  action: THREE.AnimationAction;
  mixer: THREE.AnimationMixer;
  /** Trimmed VRM clip duration — the loop-wrap period for the VRM action. */
  vrmDuration: number;
  fbxAction: THREE.AnimationAction;
  fbxMixer: THREE.AnimationMixer;
  fbxScene: THREE.Group;
  /** Source FBX clip duration — used by the FBX display action + UI scrubber. */
  duration: number;
}

export const animRegistry = new Map<string, AnimEntry>();
