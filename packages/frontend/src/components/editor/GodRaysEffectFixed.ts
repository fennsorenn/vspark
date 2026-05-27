import { GodRaysEffect } from 'postprocessing';
import type { WebGLRenderer, WebGLRenderTarget } from 'three';

// GodRaysEffect.update() calls renderPassLight.render() which triggers renderer.render().
// Three.js clears the render target before rendering (autoClear=true), wiping the scene
// depth that copyPass just wrote into renderTargetLight. This prevents occluders from
// blocking the god rays. We override update() to disable autoClear around that call.
export class GodRaysEffectFixed extends GodRaysEffect {
  override update(
    renderer: WebGLRenderer,
    inputBuffer: WebGLRenderTarget,
    deltaTime?: number
  ) {
    const prev = renderer.autoClear;
    renderer.autoClear = false;
    super.update(renderer, inputBuffer, deltaTime);
    renderer.autoClear = prev;
  }
}
