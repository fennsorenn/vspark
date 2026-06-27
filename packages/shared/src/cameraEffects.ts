/**
 * Camera post-processing effect catalog — the single source of truth shared by
 * the frontend (effect picker / PropertiesPanel), the backend MCP tool
 * (list_camera_effect_kinds), and any other consumer. Each entry's
 * `defaultConfig` is the canonical config shape for that effect kind; the
 * camera-effects route stores `config` as an opaque blob, so this catalog is
 * how a caller discovers the valid config keys.
 */

export interface CameraEffectKind {
  kind: string;
  label: string;
  icon: string;
  description: string;
  defaultConfig: Record<string, unknown>;
}

export const CAMERA_EFFECT_KINDS: CameraEffectKind[] = [
  // --- Color & Tone ---
  {
    kind: 'fx_tone_mapping',
    label: 'Tone Mapping',
    icon: '🎚',
    description: 'Controls how HDR values are mapped to the display',
    defaultConfig: { mode: 6 }, // 6 = ACES_FILMIC
  },
  {
    kind: 'fx_brightness_contrast',
    label: 'Brightness / Contrast',
    icon: '☀',
    description: 'Adjusts overall image brightness and contrast',
    defaultConfig: { brightness: 0, contrast: 0 },
  },
  {
    kind: 'fx_hue_saturation',
    label: 'Hue / Saturation',
    icon: '🎨',
    description: 'Shifts hue and scales color saturation',
    defaultConfig: { hue: 0, saturation: 0 },
  },
  {
    kind: 'fx_sepia',
    label: 'Sepia',
    icon: '🟫',
    description: 'Warm brownish cinematic tint',
    defaultConfig: { intensity: 1.0 },
  },
  // --- Depth & Atmosphere ---
  {
    kind: 'fx_bloom',
    label: 'Bloom',
    icon: '✨',
    description: 'Glowing highlights bleed from bright areas',
    defaultConfig: {
      intensity: 1.0,
      luminanceThreshold: 0.9,
      luminanceSmoothing: 0.025,
      mipmapBlur: true,
    },
  },
  {
    kind: 'fx_depth_of_field',
    label: 'Depth of Field',
    icon: '📷',
    description: 'Bokeh blur outside the focal plane',
    defaultConfig: {
      worldFocusDistance: 3,
      worldFocusRange: 2,
      bokehScale: 2,
      autofocus: false,
      afMode: 'point', // 'point' | 'percentile'
      afPointX: 0.5,
      afPointY: 0.5,
      afPercentile: 15,
      afSpeed: 4, // convergence speed (higher = faster)
      afDelay: 0.2, // seconds before AF starts moving
      afOvershoot: 0.15, // fraction of delta to overshoot by
    },
  },
  {
    kind: 'fx_chromatic_aberration',
    label: 'Chromatic Aberration',
    icon: '🌈',
    description: 'RGB channel fringing along edges, like a real lens',
    defaultConfig: { offsetX: 0.002, offsetY: 0.002 },
  },
  {
    kind: 'fx_ssao',
    label: 'Ambient Occlusion',
    icon: '🌑',
    description: 'Screen-space contact shadows in crevices',
    defaultConfig: {
      intensity: 1.5,
      radius: 0.2,
      bias: 0.025,
      rings: 4,
      samples: 30,
    },
  },
  // --- Stylization ---
  {
    kind: 'fx_outline',
    label: 'Edge Outline',
    icon: '🖊',
    description: 'Depth-buffer edge detection outlines',
    defaultConfig: {
      color: '#000000',
      threshold: 0.001,
      thickness: 1.0,
      alpha: 1.0,
      normalStrength: 1.0,
      blendMode: 'NORMAL',
    },
  },
  {
    kind: 'fx_vignette',
    label: 'Vignette',
    icon: '🔲',
    description: 'Darkened edges around the frame',
    defaultConfig: { offset: 0.5, darkness: 0.5 },
  },
  {
    kind: 'fx_noise',
    label: 'Noise',
    icon: '📺',
    description: 'Film grain overlay',
    defaultConfig: { opacity: 0.2 },
  },
  {
    kind: 'fx_scanline',
    label: 'Scanline',
    icon: '📟',
    description: 'CRT horizontal scanline overlay',
    defaultConfig: { density: 1.25, opacity: 0.1 },
  },
  {
    kind: 'fx_pixelation',
    label: 'Pixelation',
    icon: '🟦',
    description: 'Retro pixel art look',
    defaultConfig: { granularity: 8 },
  },
  {
    kind: 'fx_ascii',
    label: 'ASCII',
    icon: '🔤',
    description: 'Renders the scene as ASCII characters',
    defaultConfig: {
      characters: ' .:-+*=%@#',
      fontSize: 54,
      cellSize: 16,
      color: '#ffffff',
      invert: false,
    },
  },
  {
    kind: 'fx_dot_screen',
    label: 'Dot Screen',
    icon: '🔵',
    description: 'Halftone dot pattern overlay',
    defaultConfig: { angle: 1.57, scale: 1.0 },
  },
  {
    kind: 'fx_glitch',
    label: 'Glitch',
    icon: '⚡',
    description: 'Digital glitch distortion',
    defaultConfig: {
      delay: [1.5, 3.5],
      duration: [0.06, 0.3],
      strength: [0.3, 1.0],
      columns: 0.05,
      ratio: 0.85,
    },
  },
  {
    kind: 'fx_smaa',
    label: 'SMAA',
    icon: '🔍',
    description: 'Subpixel morphological antialiasing',
    defaultConfig: {},
  },
  {
    kind: 'fx_tilt_shift',
    label: 'Tilt Shift',
    icon: '📸',
    description: 'Miniature / tilt-shift blur effect',
    defaultConfig: { offset: 0.0, rotation: 0.0, focusArea: 0.4, feather: 0.3 },
  },
  {
    kind: 'fx_water',
    label: 'Water',
    icon: '🌊',
    description: 'Watery ripple distortion',
    defaultConfig: { factor: 1.0 },
  },
];
