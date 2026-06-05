import * as THREE from 'three';

/**
 * Shared video FX: chroma key + blend mode for both video surfaces (the 3D
 * `video` scene node, which uses a Three.js ShaderMaterial, and the 2D compose
 * `video` layer, which uses a WebGL2 canvas — see ChromaVideoCanvas). The GLSL
 * chroma function is shared so both paths key identically.
 */

export interface ChromaKeyConfig {
  enabled: boolean;
  /** Key colour to remove (hex). */
  color: string;
  /** Base similarity threshold (0..1). Larger removes more. */
  similarity: number;
  /** Edge softness (0..1). */
  smoothness: number;
  /** Spill suppression amount (0..1) — desaturates residual key colour. */
  spill: number;
}

export const CHROMA_DEFAULTS: ChromaKeyConfig = {
  enabled: false,
  color: '#00ff00',
  similarity: 0.4,
  smoothness: 0.08,
  spill: 0.1,
};

/** Blend modes for the 3D video node (mapped to Three.js blending). The compose
 *  layer uses the full CSS mix-blend-mode set directly, not this. */
export type VideoBlend3D = 'normal' | 'additive' | 'multiply' | 'screen';

export function readChroma(
  src: Record<string, unknown> | undefined | null
): ChromaKeyConfig {
  const c = (src ?? {}) as Partial<ChromaKeyConfig>;
  return {
    enabled: c.enabled === true,
    color: typeof c.color === 'string' ? c.color : CHROMA_DEFAULTS.color,
    similarity:
      typeof c.similarity === 'number' ? c.similarity : CHROMA_DEFAULTS.similarity,
    smoothness:
      typeof c.smoothness === 'number' ? c.smoothness : CHROMA_DEFAULTS.smoothness,
    spill: typeof c.spill === 'number' ? c.spill : CHROMA_DEFAULTS.spill,
  };
}

/** GLSL: chroma-key a colour by chrominance distance in YUV space, with edge
 *  softness and spill suppression. Shared verbatim by the canvas + material. */
export const CHROMA_GLSL = `
vec2 vfx_rgb2uv(vec3 c){
  return vec2(
    dot(c, vec3(-0.169, -0.331, 0.5)) + 0.5,
    dot(c, vec3(0.5, -0.419, -0.081)) + 0.5
  );
}
vec4 vfx_chroma(vec4 col, vec3 keyColor, float similarity, float smoothness, float spill){
  float d = distance(vfx_rgb2uv(col.rgb), vfx_rgb2uv(keyColor));
  float base = d - similarity;
  float mask = clamp(base / max(smoothness, 1e-4), 0.0, 1.0);
  float a = col.a * mask;
  float sp = clamp(base / max(spill, 1e-4), 0.0, 1.0);
  float luma = dot(col.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 rgb = mix(vec3(luma), col.rgb, sp);
  return vec4(rgb, a);
}
`;

const VIDEO_VERT = `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const VIDEO_FRAG = `
varying vec2 vUv;
uniform sampler2D map;
uniform float uOpacity, uFlipX, uSimilarity, uSmoothness, uSpill;
uniform int uChroma;
uniform vec3 uKeyColor;
${CHROMA_GLSL}
void main(){
  vec2 uv = vec2(uFlipX > 0.5 ? 1.0 - vUv.x : vUv.x, vUv.y);
  vec4 col = texture2D(map, uv);
  if (uChroma == 1) {
    col = vfx_chroma(col, uKeyColor, uSimilarity, uSmoothness, uSpill);
  }
  col.a *= uOpacity;
  if (col.a <= 0.001) discard;
  // The sampled video texture is sRGB-encoded; linearise so the renderer's
  // output conversion lands back at the source colour.
  col.rgb = pow(col.rgb, vec3(2.2));
  gl_FragColor = col;
}
`;

/** Build a ShaderMaterial for a 3D video plane (chroma + opacity + optional UV
 *  mirror for the backface). Call updateVideoMaterial to push config. */
export function makeVideoMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    uniforms: {
      map: { value: null },
      uOpacity: { value: 1 },
      uFlipX: { value: 0 },
      uChroma: { value: 0 },
      uKeyColor: { value: new THREE.Color('#00ff00') },
      uSimilarity: { value: CHROMA_DEFAULTS.similarity },
      uSmoothness: { value: CHROMA_DEFAULTS.smoothness },
      uSpill: { value: CHROMA_DEFAULTS.spill },
    },
    vertexShader: VIDEO_VERT,
    fragmentShader: VIDEO_FRAG,
  });
}

/** Apply a 3D blend mode to a material. */
export function applyVideoBlend(mat: THREE.Material, blend: VideoBlend3D): void {
  switch (blend) {
    case 'additive':
      mat.blending = THREE.AdditiveBlending;
      break;
    case 'multiply':
      mat.blending = THREE.MultiplyBlending;
      break;
    case 'screen':
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneMinusSrcColorFactor;
      break;
    default:
      mat.blending = THREE.NormalBlending;
  }
  mat.needsUpdate = true;
}

/** Push chroma + opacity + mirror into a video ShaderMaterial's uniforms. */
export function updateVideoMaterial(
  mat: THREE.ShaderMaterial,
  opts: { opacity: number; flipX: boolean; chroma: ChromaKeyConfig }
): void {
  const u = mat.uniforms;
  u.uOpacity.value = opts.opacity;
  u.uFlipX.value = opts.flipX ? 1 : 0;
  u.uChroma.value = opts.chroma.enabled ? 1 : 0;
  (u.uKeyColor.value as THREE.Color).set(opts.chroma.color);
  u.uSimilarity.value = opts.chroma.similarity;
  u.uSmoothness.value = opts.chroma.smoothness;
  u.uSpill.value = opts.chroma.spill;
}

/** CSS mix-blend-mode values usable on any compose layer. */
export const CSS_BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'plus-lighter',
] as const;
