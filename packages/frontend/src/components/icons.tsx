// Central icon mapping — replaces the emoji that used to stand in for type
// icons throughout the editor. All glyphs come from lucide-react (monochrome
// SVG, `currentColor`), so a button's `color` actually tints the icon.
//
// Kind → icon maps live here so every render site (scene graph, compose tree,
// properties, asset manager) draws the same glyph for a kind. Registries that
// carry their own icon component per entry (NODE_KIND_DEFS / LAYER_KIND_DEFS in
// createKinds, CAMERA_EFFECT_KINDS in the store) do not need these maps.
import {
  Antenna,
  Box,
  Camera,
  Clapperboard,
  Film,
  Folder,
  Globe,
  Image,
  Layers,
  Lightbulb,
  Link2,
  Mic,
  PersonStanding,
  Rss,
  Ruler,
  Settings2,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Type,
  Volume2,
  Wind,
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

/** Fallbacks for unknown kinds. */
export const NODE_KIND_FALLBACK: LucideIcon = Shapes;
export const BEHAVIOR_FALLBACK: LucideIcon = Settings2;
