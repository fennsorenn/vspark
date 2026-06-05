// Built-in presets shipped with the app. Authored as plain objects (the
// backend bundle has no JSON-module support) in the same `vspark.preset.v2`
// shape the serializer emits, so they flow through the normal instantiate path.
// They are read-only: served via GET /api/presets/builtin[/:id], never stored
// in or deletable from the DB.
//
// Definitions are split by theme under `builtin_presets/`:
//   - helpers.ts   — shared builders (scene node / compose layer / graph / clip)
//   - particles.ts — Rain / Snow / Fire / Magic Sparkles / Sparkler
//   - chat.ts      — chat overlay (2D layer + 3D node) + scrolling 3D chat
//   - alerts.ts    — Donation / Tip / Sub / Raid event overlays
// Add more by extending the relevant file (or appending below).
import {
  identity,
  sceneNode,
  sceneNodePreset,
  transform,
  type BuiltinPreset,
} from './builtin_presets/helpers.js';
import { PARTICLE_PRESETS } from './builtin_presets/particles.js';
import { CHAT_PRESETS } from './builtin_presets/chat.js';
import { ALERT_PRESETS } from './builtin_presets/alerts.js';

export type { BuiltinPreset } from './builtin_presets/helpers.js';

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  sceneNodePreset(
    'builtin:three-point-lighting',
    'Three-Point Lighting',
    'Key / fill / rim light rig grouped under one node.',
    [
      sceneNode('n1', null, 'Lighting Rig', 'group', { transform: identity }),
      sceneNode('n2', 'n1', 'Key Light', 'light', {
        transform: transform(2, 3, 2),
        light: {
          type: 'light',
          lightType: 'directional',
          color: '#ffffff',
          intensity: 1.2,
        },
      }),
      sceneNode('n3', 'n1', 'Fill Light', 'light', {
        transform: transform(-2.5, 1.5, 2),
        light: {
          type: 'light',
          lightType: 'point',
          color: '#cfe0ff',
          intensity: 0.6,
        },
      }),
      sceneNode('n4', 'n1', 'Rim Light', 'light', {
        transform: transform(0, 2.5, -3),
        light: {
          type: 'light',
          lightType: 'point',
          color: '#ffe6c0',
          intensity: 0.9,
        },
      }),
    ]
  ),
  sceneNodePreset(
    'builtin:organizer-group',
    'Organizer Group',
    'An empty group scaffold with Avatars / Props / Effects subgroups.',
    [
      sceneNode('n1', null, 'Scene Root', 'group', { transform: identity }),
      sceneNode('n2', 'n1', 'Avatars', 'group', { transform: identity }),
      sceneNode('n3', 'n1', 'Props', 'group', { transform: identity }),
      sceneNode('n4', 'n1', 'Effects', 'group', { transform: identity }),
    ]
  ),
  ...PARTICLE_PRESETS,
  ...CHAT_PRESETS,
  ...ALERT_PRESETS,
];

export function getBuiltinPreset(id: string): BuiltinPreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id);
}
