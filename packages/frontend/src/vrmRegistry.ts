import type { VRM } from '@pixiv/three-vrm';

/** nodeId → the currently loaded VRM for that avatar node. */
export const vrmRegistry = new Map<string, VRM>();
