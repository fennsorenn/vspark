import { Effect, EffectAttribute, BlendFunction } from 'postprocessing'
import { Uniform, Color, Texture } from 'three'

// Blend mode indices must match BLEND_MODES order below.
export const EDGE_BLEND_MODES = [
  'NORMAL', 'MULTIPLY', 'SCREEN', 'OVERLAY',
  'DARKEN', 'LIGHTEN', 'ADD', 'DIFFERENCE',
  'EXCLUSION', 'SOFT_LIGHT', 'HARD_LIGHT',
  'COLOR_BURN', 'COLOR_DODGE', 'SUBTRACT',
] as const
export type EdgeBlendMode = typeof EDGE_BLEND_MODES[number]

const fragmentShader = /* glsl */`
uniform vec3    edgeColor;
uniform float   threshold;
uniform float   thickness;
uniform float   edgeAlpha;
uniform float   normalStrength;
uniform int     blendMode;
uniform sampler2D normalBuffer;

vec3 blendEdge(const in vec3 base, const in vec3 edge, const in int mode) {
  if (mode == 0)  return edge;
  if (mode == 1)  return base * edge;
  if (mode == 2)  return base + edge - base * edge;
  if (mode == 3)  return mix(2.0*base*edge, 1.0-2.0*(1.0-base)*(1.0-edge), step(0.5, base));
  if (mode == 4)  return min(base, edge);
  if (mode == 5)  return max(base, edge);
  if (mode == 6)  return min(base + edge, vec3(1.0));
  if (mode == 7)  return abs(base - edge);
  if (mode == 8)  return base + edge - 2.0 * base * edge;
  if (mode == 9)  return base + (2.0*edge - 1.0) * (base - base*base);
  if (mode == 10) return mix(2.0*base*edge, 1.0-2.0*(1.0-base)*(1.0-edge), step(0.5, edge));
  if (mode == 11) return 1.0 - min((1.0-base)/max(edge, 0.001), vec3(1.0));
  if (mode == 12) return min(base / max(1.0-edge, 0.001), vec3(1.0));
  if (mode == 13) return max(base - edge, vec3(0.0));
  return edge;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 texel = vec2(thickness) / resolution;

  // Depth Sobel
  float d0 = readDepth(uv);
  float d1 = readDepth(uv + vec2( texel.x, 0.0));
  float d2 = readDepth(uv + vec2(-texel.x, 0.0));
  float d3 = readDepth(uv + vec2(0.0,  texel.y));
  float d4 = readDepth(uv + vec2(0.0, -texel.y));
  float depthEdge = sqrt((d1-d2)*(d1-d2) + (d3-d4)*(d3-d4));

  // Normal Sobel — each channel independently, then take magnitude
  vec3 n1 = texture2D(normalBuffer, uv + vec2( texel.x, 0.0)).rgb * 2.0 - 1.0;
  vec3 n2 = texture2D(normalBuffer, uv + vec2(-texel.x, 0.0)).rgb * 2.0 - 1.0;
  vec3 n3 = texture2D(normalBuffer, uv + vec2(0.0,  texel.y)).rgb * 2.0 - 1.0;
  vec3 n4 = texture2D(normalBuffer, uv + vec2(0.0, -texel.y)).rgb * 2.0 - 1.0;
  vec3 ndx = n1 - n2;
  vec3 ndy = n3 - n4;
  float normalEdge = sqrt(dot(ndx, ndx) + dot(ndy, ndy));

  float edge = max(depthEdge, normalEdge * normalStrength);

  // Suppress edges on skybox
  edge *= (1.0 - step(0.9999, d0));

  float mask = step(threshold, edge) * edgeAlpha;
  vec3 blended = blendEdge(inputColor.rgb, edgeColor, blendMode);
  outputColor = vec4(mix(inputColor.rgb, blended, mask), inputColor.a);
}
`

export class DepthEdgeEffect extends Effect {
  constructor() {
    super('DepthEdgeEffect', fragmentShader, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, Uniform>([
        ['edgeColor',      new Uniform(new Color('#000000'))],
        ['threshold',      new Uniform(0.001)],
        ['thickness',      new Uniform(1.0)],
        ['edgeAlpha',      new Uniform(1.0)],
        ['normalStrength', new Uniform(1.0)],
        ['blendMode',      new Uniform(0)],
        ['normalBuffer',   new Uniform(null)],
      ]),
    })
  }

  setColor(hex: string) { (this.uniforms.get('edgeColor')!.value as Color).set(hex) }
  setThreshold(v: number) { this.uniforms.get('threshold')!.value = v }
  setThickness(v: number) { this.uniforms.get('thickness')!.value = v }
  setAlpha(v: number) { this.uniforms.get('edgeAlpha')!.value = v }
  setNormalStrength(v: number) { this.uniforms.get('normalStrength')!.value = v }
  setNormalBuffer(t: Texture | null) { this.uniforms.get('normalBuffer')!.value = t }
  setBlendMode(name: EdgeBlendMode) {
    this.uniforms.get('blendMode')!.value = EDGE_BLEND_MODES.indexOf(name)
  }
}
