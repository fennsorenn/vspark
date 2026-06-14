import type * as THREE from 'three';

// Per-avatar-instance animation state. Held on a ref inside each AvatarNode (see
// Viewport.tsx) rather than a shared map: the same avatar can be rendered by
// several AvatarNode instances at once (the scene viewport + each compose camera
// view), and they must not share or evict one another's mixers.
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
