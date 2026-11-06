import type * as THREE from 'three';

// ---------------------------------------------------------------------------
// Puppet2DRuntime — the renderer-agnostic seam for 2D mesh-deform avatars.
//
// vspark drives 2D puppets (Live2D today, Inochi2D possibly later) from the
// same per-node blendshape + head-pose feed that drives VRM avatars. Only the
// underlying runtime differs, so the `live2d` scene node, the parameter-mapping
// layer, the asset pipeline and the properties UI all talk to THIS interface
// rather than to any specific SDK.
//
// v1 ships exactly one adapter (`Live2DRuntime`, Cubism Core + framework). A
// future `InochiRuntime` adapter slots in behind the same interface with no
// change to the node / param / UI layers. See
// dev-notes/plans/live2d-integration.md.
// ---------------------------------------------------------------------------

export interface Puppet2DRuntime {
  /**
   * Load a puppet bundle. The url points at the manifest the runtime
   * understands (`*.model3.json` for Live2D, `*.inp` for Inochi). Sibling
   * assets (textures, physics, motions) resolve relative to it.
   */
  load(bundleUrl: string): Promise<void>;

  /** Parameter ids the loaded model exposes (drives the param-map editor UI). */
  listParams(): string[];

  /** Set one parameter to an absolute value for the next rendered frame. */
  setParam(id: string, value: number): void;

  /** Advance idle motion / physics by `dtSeconds`, then draw to the texture. */
  update(dtSeconds: number): void;

  /** The off-screen render target, mounted on a plane in the 3D scene. */
  renderToTexture(): THREE.Texture;

  /** Release GL resources, textures, and any injected runtime state. */
  dispose(): void;
}

/** Puppet bundle formats vspark can recognise. */
export type Puppet2DFormat = 'live2d' | 'inochi';

/**
 * Pick a runtime by bundle manifest extension. Returns null for an unrecognised
 * url so callers can surface a clear error rather than guessing.
 */
export function detectPuppetFormat(bundleUrl: string): Puppet2DFormat | null {
  const u = bundleUrl.toLowerCase();
  if (u.endsWith('.model3.json')) return 'live2d';
  if (u.endsWith('.inp') || u.endsWith('.inx')) return 'inochi';
  return null;
}
