import { useEditorStore, type NodeRecord } from '../../store/editorStore';
import { api } from '../../api/client';
import type { AssetFile, ComposeLayerKind } from '../../api/client';
import { PARTICLE_DEFAULTS } from '../../particleUtils';

// ---------------------------------------------------------------------------
// Shared registry of the node + compose-layer kinds the user can create, plus
// the creation helpers behind them. Used by the scene tree (SceneGraph), the
// compose tree (ComposeTree), and the bottom-dock "Create" palette
// (AssetManager) so all three add things the exact same way.
// ---------------------------------------------------------------------------

export interface NodeKindDef {
  label: string;
  kind: string;
  /** Only meaningful for `kind === 'light'`. */
  lightType?: string;
  icon: string;
}

export const NODE_KIND_DEFS: NodeKindDef[] = [
  { label: 'Group', kind: 'group', icon: '📁' },
  { label: 'Avatar', kind: 'avatar', icon: '🧍' },
  { label: 'Model', kind: 'model', icon: '📦' },
  { label: 'Prop', kind: 'prop', icon: '🔹' },
  { label: 'Point Light', kind: 'light', lightType: 'point', icon: '💡' },
  {
    label: 'Directional Light',
    kind: 'light',
    lightType: 'directional',
    icon: '🔦',
  },
  { label: 'Camera', kind: 'camera', icon: '📷' },
  { label: 'Godray Caster', kind: 'godray_caster', icon: '☀️' },
  { label: 'Particle', kind: 'particle', icon: '✨' },
  { label: 'Billboard', kind: 'billboard', icon: '🖼️' },
  { label: 'Text (SDF / troika)', kind: 'text_troika', icon: '🔤' },
  { label: 'Text (canvas, HTML-capable)', kind: 'text_canvas', icon: '🔡' },
];

const DEFAULT_COMPONENTS = {
  transform: {
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
  },
};

/** Return `base`, or `base 2` / `base 3` / … if `base` (or a lower number) is
 *  already present in `taken`. Used to give freshly created entities a unique
 *  default name without prompting. */
export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

/** Default-name dedupe for a node in a given scene. */
export function nextNodeName(def: NodeKindDef, sceneId: string): string {
  const taken = new Set(
    useEditorStore
      .getState()
      .nodes.filter((n) => n.rootSceneNodeId === sceneId)
      .map((n) => n.name)
  );
  return uniqueName(def.label, taken);
}

/** Build the default component bag for a node kind and create it via the API,
 *  inserting it into the store. Throws on failure; callers handle selection. */
export async function createSceneNode(
  sceneId: string,
  def: NodeKindDef,
  parentId: string | null,
  name: string
): Promise<NodeRecord> {
  const components: Record<string, unknown> = { ...DEFAULT_COMPONENTS };
  if (def.kind === 'light') {
    components.light = {
      type: 'light',
      lightType: def.lightType ?? 'point',
      color: '#ffffff',
      intensity: 1,
    };
  } else if (def.kind === 'camera') {
    components.camera = { type: 'camera', fov: 50, near: 0.1, far: 1000 };
  } else if (def.kind === 'particle') {
    components.particle = { ...PARTICLE_DEFAULTS };
  } else if (def.kind === 'billboard') {
    components.billboard = {
      type: 'billboard',
      facing: 'screen',
      backface: 'none',
      width: 1,
      height: 1,
      alpha: 1,
      textureUrl: null,
    };
  } else if (def.kind === 'text_troika') {
    components.text = {
      type: 'text',
      content: 'Text',
      fontSize: 0.2,
      color: '#ffffff',
      anchorX: 'center',
      anchorY: 'middle',
      maxWidth: 0,
      billboard: true,
      // Match the BillboardNode facing controls so the user gets one
      // consistent set of options for "what direction is this thing looking".
      facing: 'screen' as 'screen' | 'world',
    };
  } else if (def.kind === 'text_canvas') {
    components.text = {
      type: 'text',
      content: 'Text',
      fontSize: 48,
      color: '#ffffff',
      padding: 16,
      width: 2,
      height: 0.5,
      allowHtml: false,
      billboard: true,
      facing: 'screen' as 'screen' | 'world',
    };
  }

  const node = await api.createNode(sceneId, {
    parentId,
    name,
    kind: def.kind,
    filePath: null,
    components,
  });
  // The WS broadcast may also deliver this node; dedupe by id.
  if (useEditorStore.getState().nodes.every((n) => n.id !== node.id)) {
    useEditorStore.getState().addNode(node);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Creating nodes from asset files (shared by the asset cards + drag-and-drop)
// ---------------------------------------------------------------------------

/** Add a model/avatar asset to a scene as an avatar (VRM) or model node. */
export async function createNodeFromModelAsset(
  asset: AssetFile,
  sceneId: string,
  parentId: string | null = null
): Promise<NodeRecord> {
  const ext = asset.name.split('.').pop()?.toLowerCase();
  const kind = ext === 'vrm' ? 'avatar' : 'model';
  const node = await api.createNode(sceneId, {
    parentId,
    name: asset.name,
    kind,
    filePath: asset.url,
    components: { ...DEFAULT_COMPONENTS },
  });
  if (useEditorStore.getState().nodes.every((n) => n.id !== node.id)) {
    useEditorStore.getState().addNode(node);
  }
  return node;
}

/** Add an image asset to a scene as a billboard node textured with it. */
export async function createBillboardFromImageAsset(
  asset: AssetFile,
  sceneId: string,
  parentId: string | null = null
): Promise<NodeRecord> {
  const node = await api.createNode(sceneId, {
    parentId,
    name: asset.name,
    kind: 'billboard',
    filePath: asset.url,
    components: {
      ...DEFAULT_COMPONENTS,
      billboard: {
        facing: 'screen',
        backface: 'none',
        width: 1,
        height: 1,
        alpha: 1,
        textureUrl: asset.url,
      },
    },
  });
  if (useEditorStore.getState().nodes.every((n) => n.id !== node.id)) {
    useEditorStore.getState().addNode(node);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Compose layers
// ---------------------------------------------------------------------------

export interface LayerKindDef {
  kind: ComposeLayerKind;
  label: string;
  icon: string;
}

// Layer kinds the user can add inside a compose scene.
export const LAYER_KIND_DEFS: LayerKindDef[] = [
  { kind: 'camera_view', label: 'Camera View', icon: '📷' },
  { kind: 'scene_include', label: 'Include Scene', icon: '🎬' },
  { kind: 'image', label: 'Image', icon: '🖼' },
  { kind: 'video', label: 'Video', icon: '🎞' },
  { kind: 'browser', label: 'Browser', icon: '🌐' },
  { kind: 'text', label: 'Text', icon: '📝' },
  { kind: 'group', label: 'Group', icon: '📁' },
];

/** Create a compose layer of the given kind inside a compose scene, with sane
 *  defaults, then select it. Surfaces blocking preconditions (no camera / no
 *  other scene to include) via alert and bails. */
export async function createLayer(
  composeSceneId: string,
  kind: ComposeLayerKind
): Promise<void> {
  const baseName =
    kind === 'camera_view'
      ? 'Camera View'
      : kind === 'scene_include'
        ? 'Included Scene'
        : kind[0].toUpperCase() + kind.slice(1) + ' Layer';

  // Camera views default to the first available camera; reassign in properties.
  let cameraNodeId: string | null = null;
  if (kind === 'camera_view') {
    const cameras = useEditorStore
      .getState()
      .nodes.filter((n) => n.kind === 'camera');
    if (cameras.length === 0) {
      alert('No cameras exist yet. Add a camera node to a scene first.');
      return;
    }
    cameraNodeId = cameras[0].id;
  }

  const config: Record<string, unknown> =
    kind === 'browser' ? { url: 'https://example.com' } : {};

  // Scene includes default to the first OTHER compose scene; reassign in
  // properties. They mount that scene's whole layer stack.
  if (kind === 'scene_include') {
    const others = useEditorStore
      .getState()
      .composeScenes.filter((s) => s.id !== composeSceneId);
    if (others.length === 0) {
      alert('No other compose scene to include. Create another one first.');
      return;
    }
    config.includeSceneId = others[0].id;
  }

  // Camera views and scene includes default to filling the whole compose frame
  // (100% × 100%).
  const fills = kind === 'camera_view' || kind === 'scene_include';
  const sizeDefaults = fills
    ? { width: 100, height: 100 }
    : ({} as { width?: number; height?: number });
  if (fills) {
    config.widthUnit = '%';
    config.heightUnit = '%';
  }

  const taken = new Set(
    useEditorStore
      .getState()
      .composeLayers.filter((l) => l.rootComposeSceneId === composeSceneId)
      .map((l) => l.name)
  );
  const name = uniqueName(baseName, taken);

  try {
    const created = await api.createComposeSceneLayer(composeSceneId, {
      name,
      kind,
      cameraNodeId,
      config,
      ...sizeDefaults,
    });
    // Optimistic insert; the WS broadcast dedupes by id.
    useEditorStore.getState().addComposeLayer(created);
    useEditorStore.getState().selectComposeLayer(created.id);
  } catch (e) {
    alert(e instanceof Error ? e.message : 'Failed to add layer');
  }
}
