import type * as THREE from 'three';

export interface AnimEntry {
  action: THREE.AnimationAction;
  mixer: THREE.AnimationMixer;
  fbxAction: THREE.AnimationAction;
  fbxMixer: THREE.AnimationMixer;
  fbxScene: THREE.Group;
  duration: number;
  /** Clock anchor (ms, this client's clock) for scheduled playback, or null
   *  for a free-running idle clip. When set, the useFrame loop drives
   *  `action.time` from `(now − startEpoch)·speed` instead of `mixer.update(delta)`. */
  startEpoch: number | null;
  speed: number;
  loop: boolean;
  /** True for a scheduled (clock-driven) clip; false for free-running idle. */
  clockAnchored: boolean;
}

export const animRegistry = new Map<string, AnimEntry>();
