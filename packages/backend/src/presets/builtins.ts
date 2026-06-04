// Built-in presets shipped with the app. Authored as plain objects (the
// backend bundle has no JSON-module support) in the same `vspark.preset.v2`
// shape the serializer emits, so they flow through the normal instantiate path.
// They are read-only: served via GET /api/presets/builtin[/:id], never stored
// in or deletable from the DB.

export interface BuiltinPreset {
  id: string;
  name: string;
  description: string;
  rootKind: 'scene_node' | 'compose_layer';
  payload: Record<string, unknown>;
}

const identity = {
  type: 'transform',
  x: 0,
  y: 0,
  z: 0,
  rx: 0,
  ry: 0,
  rz: 0,
  sx: 1,
  sy: 1,
  sz: 1,
};

function transform(x: number, y: number, z: number) {
  return { ...identity, x, y, z };
}

function sceneNode(
  presetId: string,
  parentPresetId: string | null,
  name: string,
  kind: string,
  componentsBag: Record<string, unknown>
) {
  return {
    presetId,
    parentPresetId,
    name,
    kind,
    filePresetAssetId: null,
    boneAttachment: null,
    hidden: false,
    properties: {},
    componentsBag,
    components: [],
    cameraEffects: [],
  };
}

function sceneNodePreset(
  id: string,
  name: string,
  description: string,
  sceneNodes: unknown[]
): BuiltinPreset {
  return {
    id,
    name,
    description,
    rootKind: 'scene_node',
    payload: {
      format: 'vspark.preset.v2',
      rootKind: 'scene_node',
      assets: [],
      sceneNodes,
    },
  };
}

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
];

export function getBuiltinPreset(id: string): BuiltinPreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id);
}
