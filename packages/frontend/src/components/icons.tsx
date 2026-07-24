// Central icon mapping — replaces the emoji that used to stand in for type
// icons throughout the editor. All glyphs come from lucide-react (monochrome
// SVG, `currentColor`), so a button's `color` actually tints the icon.
//
// Kind → icon maps live here so every render site (scene graph, compose tree,
// properties, asset manager) draws the same glyph for a kind. Registries that
// carry their own icon component per entry (NODE_KIND_DEFS / LAYER_KIND_DEFS in
// createKinds) do not need these maps. CAMERA_EFFECT_KINDS lives in
// @vspark/shared (React-free — the backend MCP tool serves it to the assistant),
// so its `icon` field is an emoji string; CAMERA_EFFECT_ICON below maps each
// effect kind to the lucide glyph the editor renders instead.
import {
  Antenna,
  Aperture,
  Blend,
  Box,
  Camera,
  Clapperboard,
  Coffee,
  Contrast,
  Film,
  Focus,
  Folder,
  Frame,
  Globe,
  Grid2x2,
  Grip,
  Image,
  Layers,
  Lightbulb,
  Link2,
  Mic,
  Moon,
  Palette,
  PenTool,
  PersonStanding,
  Rainbow,
  Rss,
  Ruler,
  ScanLine,
  Settings2,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Tv,
  Type,
  Volume2,
  Waves,
  Wind,
  Zap,
  type LucideIcon,
} from 'lucide-react';

export type { LucideIcon };

/** Scene-node kinds (SceneGraph tree, properties). */
export const NODE_KIND_ICON: Record<string, LucideIcon> = {
  scene: Clapperboard,
  scene_instance: Link2,
  avatar: PersonStanding,
  model: Box,
  light: Lightbulb,
  camera: Camera,
  prop: Shapes,
  group: Folder,
  godray_caster: Sun,
  particle: Sparkles,
  billboard: Image,
  video: Film,
  audio: Volume2,
  feed: Rss,
  remote_object: Antenna,
};

/** Compose-layer kinds (compose tree, layer properties, placeholders). */
export const LAYER_KIND_ICON: Record<string, LucideIcon> = {
  image: Image,
  video: Film,
  audio: Volume2,
  browser: Globe,
  group: Folder,
  compose_scene: Clapperboard,
  scene_include: Layers,
  camera_view: Camera,
  text: Type,
  feed: Rss,
};

/** Behavior kinds (backend-provided; keyed here so the emoji its metadata still
 *  carries is never rendered). */
export const BEHAVIOR_ICON: Record<string, LucideIcon> = {
  vmc_receiver: Antenna,
  mediapipe_tracker: Camera,
  lipsync: Mic,
  lipsync_processor: Mic,
  breathing: Wind,
  manual_calibration: Ruler,
  api_controller: SlidersHorizontal,
};

/** Camera post-processing effect kinds (effect picker, PropertiesPanel,
 *  SceneGraph, AssetManager). Keyed by the `kind` of a CAMERA_EFFECT_KINDS
 *  entry — the catalog itself lives in @vspark/shared and only carries an emoji
 *  string, so the editor looks the lucide glyph up here. */
export const CAMERA_EFFECT_ICON: Record<string, LucideIcon> = {
  fx_tone_mapping: SlidersHorizontal,
  fx_brightness_contrast: Contrast,
  fx_hue_saturation: Palette,
  fx_sepia: Coffee,
  fx_bloom: Sparkles,
  fx_depth_of_field: Aperture,
  fx_chromatic_aberration: Rainbow,
  fx_ssao: Moon,
  fx_outline: PenTool,
  fx_vignette: Frame,
  fx_noise: Tv,
  fx_scanline: ScanLine,
  fx_pixelation: Grid2x2,
  fx_ascii: Type,
  fx_dot_screen: Grip,
  fx_glitch: Zap,
  fx_smaa: Blend,
  fx_tilt_shift: Focus,
  fx_water: Waves,
};

/** Fallbacks for unknown kinds. */
export const NODE_KIND_FALLBACK: LucideIcon = Shapes;
export const BEHAVIOR_FALLBACK: LucideIcon = Settings2;
export const CAMERA_EFFECT_FALLBACK: LucideIcon = Sparkles;
