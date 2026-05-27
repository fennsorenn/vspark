import type * as THREE from 'three';

export interface AnimEntry {
  action: THREE.AnimationAction;
  mixer: THREE.AnimationMixer;
  fbxAction: THREE.AnimationAction;
  fbxMixer: THREE.AnimationMixer;
  fbxScene: THREE.Group;
  duration: number;
}

export const animRegistry = new Map<string, AnimEntry>();
