import { useState, type CSSProperties } from 'react';
import { useParams } from 'react-router-dom';
import {
  useEditorStore,
  type ComposeLayerRecord,
} from '../../store/editorStore';
import { api } from '../../api/client';
import type { ComposeLayerKind } from '../../api/client';
import { ClipsSection } from './ClipsSection';
import { GraphsSection } from './GraphsSection';

const KIND_ICONS: Record<ComposeLayerKind, string> = {
  image: '🖼',
  video: '🎞',
  browser: '🌐',
  group: '📁',
  compose_scene: '🎬',
  scene_include: '🎬',
  camera_view: '📷',
  text: '📝',
};

// Layer kinds the user can add inside a compose scene.
const ADDABLE_KINDS: ComposeLayerKind[] = [
  'camera_view',
  'scene_include',
  'image',
  'video',
  'browser',
  'text',
  'group',
];

const addBtn: CSSProperties = {
  background: '#2563eb',
  border: 'none',
  color: '#fff',
  borderRadius: 4,
  padding: '2px 7px',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 500,
};

function rowStyle(selected: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    margin: '1px 4px',
    fontSize: 12,
    color: selected ? '#fff' : '#ddd',
    background: selected ? '#1a3a6a' : 'transparent',
    borderRadius: 3,
    cursor: 'pointer',
    userSelect: 'none',
  };
}

// ---- Add-layer menu ---------------------------------------------------------

async function createLayer(composeSceneId: string, kind: ComposeLayerKind) {
  const name =
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

function AddLayerMenu({ composeSceneId }: { composeSceneId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button
        style={addBtn}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Add layer"
      >
        + ▾
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            background: '#1e1e1e',
            border: '1px solid #3a3a3a',
            borderRadius: 4,
            minWidth: 150,
            zIndex: 50,
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          }}
        >
          {ADDABLE_KINDS.map((k) => (
            <button
              key={k}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                createLayer(composeSceneId, k);
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 10px',
                background: 'transparent',
                border: 'none',
                color: '#ddd',
                cursor: 'pointer',
                fontSize: 12,
              }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLElement).style.background = '#2a2a2a')
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLElement).style.background =
                  'transparent')
              }
            >
              <span style={{ marginRight: 6 }}>{KIND_ICONS[k]}</span>
              {k === 'camera_view'
                ? 'camera view'
                : k === 'scene_include'
                  ? 'include scene'
                  : k}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Reorder `draggedId` to sit just before `targetId` among their shared
 *  siblings, then reassign sequential sceneOrder values (front-of-list = highest
 *  sceneOrder, since the layer stack paints higher sceneOrder further back and
 *  the tree lists front-first). Persists via the bulk reorder endpoint. */
function reorderSibling(
  siblings: ComposeLayerRecord[],
  draggedId: string,
  targetId: string,
  placeAfter: boolean
) {
  if (draggedId === targetId) return;
  // siblings are passed already in display order (front → back).
  const order = siblings.map((l) => l.id).filter((id) => id !== draggedId);
  let idx = order.indexOf(targetId);
  if (idx < 0) return;
  if (placeAfter) idx += 1;
  order.splice(idx, 0, draggedId);

  // Assign descending sceneOrder so the top of the list paints in front.
  const n = order.length;
  const updates = order.map((id, i) => ({
    id,
    sceneOrder: n - i,
    cameraOrder: 0,
  }));
  const store = useEditorStore.getState();
  for (const u of updates) {
    store.updateComposeLayerLocal(u.id, { sceneOrder: u.sceneOrder });
  }
  api.reorderComposeLayers(updates).catch(() => {});
}

// ---- Layer row (recursive for parentId nesting) -----------------------------

function LayerRow({
  layer,
  layersByParent,
  depth,
}: {
  layer: ComposeLayerRecord;
  layersByParent: Map<string | null, ComposeLayerRecord[]>;
  depth: number;
}) {
  const nodes = useEditorStore((s) => s.nodes);
  const selectedComposeLayerId = useEditorStore(
    (s) => s.selectedComposeLayerId
  );
  const selectComposeLayer = useEditorStore((s) => s.selectComposeLayer);
  const selectNode = useEditorStore((s) => s.selectNode);
  const updateComposeLayerLocal = useEditorStore(
    (s) => s.updateComposeLayerLocal
  );
  const [dropPos, setDropPos] = useState<'before' | 'after' | null>(null);

  // Siblings in display order (front-first), used for drag-reorder.
  const siblings = (layersByParent.get(layer.parentId ?? null) ?? [])
    .slice()
    .sort((a, b) => b.sceneOrder - a.sceneOrder);

  const selected = selectedComposeLayerId === layer.id;
  const children = layersByParent.get(layer.id) ?? [];
  const composeScenes = useEditorStore((s) => s.composeScenes);
  const cam =
    layer.kind === 'camera_view' && layer.cameraNodeId
      ? nodes.find((n) => n.id === layer.cameraNodeId)
      : null;
  const includedScene =
    layer.kind === 'scene_include' &&
    typeof layer.config.includeSceneId === 'string'
      ? composeScenes.find((s) => s.id === layer.config.includeSceneId)
      : null;
  const label =
    layer.kind === 'camera_view'
      ? `${layer.name}${cam ? ` · ${cam.name}` : ''}`
      : layer.kind === 'scene_include'
        ? `${layer.name}${includedScene ? ` · ${includedScene.name}` : ''}`
        : layer.name;

  const handleDelete = async () => {
    if (!confirm(`Delete layer "${layer.name}"?`)) return;
    useEditorStore.getState().removeComposeLayer(layer.id);
    await api.deleteComposeLayer(layer.id).catch(() => {});
  };

  const handleToggleVisible = async () => {
    const next = !layer.visible;
    updateComposeLayerLocal(layer.id, { visible: next });
    await api.updateComposeLayer(layer.id, { visible: next }).catch(() => {});
  };

  const locked = layer.config.locked === true;
  const locked3d = layer.config.locked3d === true;

  const toggleLock = async (key: 'locked' | 'locked3d') => {
    const nextConfig = { ...layer.config, [key]: !layer.config[key] };
    updateComposeLayerLocal(layer.id, { config: nextConfig });
    await api
      .updateComposeLayer(layer.id, { config: nextConfig })
      .catch(() => {});
  };

  return (
    <div>
      <div
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/compose-layer', layer.id);
        }}
        onDragOver={(e) => {
          const draggedId = e.dataTransfer.types.includes('text/compose-layer');
          if (!draggedId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setDropPos(e.clientY - rect.top < rect.height / 2 ? 'before' : 'after');
        }}
        onDragLeave={() => setDropPos(null)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const draggedId = e.dataTransfer.getData('text/compose-layer');
          const pos = dropPos;
          setDropPos(null);
          if (!draggedId || !pos) return;
          // Only reorder among the dragged layer's own siblings.
          if (!siblings.some((s) => s.id === draggedId)) return;
          reorderSibling(siblings, draggedId, layer.id, pos === 'after');
        }}
        style={{
          ...rowStyle(selected),
          paddingLeft: 8 + depth * 14,
          borderTop:
            dropPos === 'before'
              ? '2px solid #4a9eff'
              : '2px solid transparent',
          borderBottom:
            dropPos === 'after'
              ? '2px solid #4a9eff'
              : '2px solid transparent',
        }}
        onClick={() => {
          selectComposeLayer(layer.id);
          selectNode(null);
        }}
      >
        <span style={{ width: 14 }}>{KIND_ICONS[layer.kind]}</span>
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            opacity: layer.visible ? 1 : 0.5,
          }}
        >
          {label}
        </span>
        {layer.kind === 'camera_view' && (
          <button
            title={locked3d ? 'Unlock 3D interaction' : 'Lock 3D interaction'}
            style={{
              background: 'none',
              border: 'none',
              color: locked3d ? '#e0a838' : '#555',
              cursor: 'pointer',
              fontSize: 11,
              padding: '0 2px',
            }}
            onClick={(e) => {
              e.stopPropagation();
              toggleLock('locked3d');
            }}
          >
            {locked3d ? '🔒3D' : '🔓3D'}
          </button>
        )}
        <button
          title={locked ? 'Unlock layer' : 'Lock layer (2D)'}
          style={{
            background: 'none',
            border: 'none',
            color: locked ? '#e0a838' : '#555',
            cursor: 'pointer',
            fontSize: 12,
            padding: '0 2px',
          }}
          onClick={(e) => {
            e.stopPropagation();
            toggleLock('locked');
          }}
        >
          {locked ? '🔒' : '🔓'}
        </button>
        <button
          title={layer.visible ? 'Hide' : 'Show'}
          style={{
            background: 'none',
            border: 'none',
            color: layer.visible ? '#888' : '#555',
            cursor: 'pointer',
            fontSize: 12,
            padding: '0 2px',
          }}
          onClick={(e) => {
            e.stopPropagation();
            handleToggleVisible();
          }}
        >
          {layer.visible ? '👁' : '🙈'}
        </button>
        <button
          title="Delete layer"
          style={{
            background: 'none',
            border: 'none',
            color: '#555',
            cursor: 'pointer',
            fontSize: 13,
            padding: '0 2px',
          }}
          onClick={(e) => {
            e.stopPropagation();
            handleDelete();
          }}
        >
          ×
        </button>
      </div>
      {selected && (
        <>
          <ClipsSection owner={{ kind: 'layer', id: layer.id }} />
          <GraphsSection owner={{ kind: 'layer', id: layer.id }} />
        </>
      )}
      {children
        .slice()
        .sort((a, b) => b.sceneOrder - a.sceneOrder)
        .map((child) => (
          <LayerRow
            key={child.id}
            layer={child}
            layersByParent={layersByParent}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}

// ---- Compose-scene root -----------------------------------------------------

function ComposeSceneRoot({
  scene,
  projectId,
}: {
  scene: ComposeLayerRecord;
  projectId?: string;
}) {
  const activeComposeSceneId = useEditorStore((s) => s.activeComposeSceneId);
  const selectComposeScene = useEditorStore((s) => s.selectComposeScene);
  const composeLayers = useEditorStore((s) => s.composeLayers);
  const [collapsed, setCollapsed] = useState(false);

  const isActive = scene.id === activeComposeSceneId;
  const sceneLayers = composeLayers.filter(
    (l) => l.rootComposeSceneId === scene.id
  );
  const sceneLayerIds = new Set(sceneLayers.map((l) => l.id));
  const layersByParent = new Map<string | null, ComposeLayerRecord[]>();
  for (const l of sceneLayers) {
    // Treat a layer as a root if it has no parent OR its parent isn't part of
    // this scene (dangling/cross-scene parent), so it can never be orphaned out
    // of the tree and rendered invisibly.
    const key =
      l.parentId && sceneLayerIds.has(l.parentId) ? l.parentId : null;
    if (!layersByParent.has(key)) layersByParent.set(key, []);
    layersByParent.get(key)!.push(l);
  }
  const roots = (layersByParent.get(null) ?? [])
    .slice()
    .sort((a, b) => b.sceneOrder - a.sceneOrder);

  const handleDeleteScene = async () => {
    if (
      !confirm(`Delete compose scene "${scene.name}" and all its layers?`)
    )
      return;
    useEditorStore.getState().removeComposeScene(scene.id);
    await api.deleteComposeLayer(scene.id).catch(() => {});
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '5px 8px',
          cursor: 'pointer',
          background: isActive ? '#1c1c28' : 'transparent',
          borderRadius: 4,
          margin: '1px 4px',
          fontSize: 13,
          color: isActive ? '#e0e0e0' : '#999',
          userSelect: 'none',
          gap: 2,
          borderLeft: isActive
            ? '2px solid #7a5af0'
            : '2px solid transparent',
        }}
        onClick={() => selectComposeScene(scene.id)}
      >
        <span
          style={{
            width: 16,
            flexShrink: 0,
            color: '#555',
            fontSize: 10,
            textAlign: 'center',
            visibility: roots.length > 0 ? 'visible' : 'hidden',
          }}
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((v) => !v);
          }}
        >
          {collapsed ? '▶' : '▼'}
        </span>
        <span style={{ fontSize: 14, flexShrink: 0 }}>🎬</span>
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: 600,
            marginLeft: 4,
          }}
        >
          {scene.name}
        </span>
        <AddLayerMenu composeSceneId={scene.id} />
        {projectId && (
          <a
            href={`/viewer/${projectId}/compose/${scene.id}`}
            target="_blank"
            rel="noreferrer"
            title="Open broadcast viewer"
            style={{
              color: '#555',
              fontSize: 12,
              padding: '0 2px',
              flexShrink: 0,
              lineHeight: 1,
              textDecoration: 'none',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            ↗
          </a>
        )}
        <button
          title="Delete compose scene"
          style={{
            background: 'none',
            border: 'none',
            color: '#555',
            cursor: 'pointer',
            fontSize: 13,
            padding: '0 2px',
            flexShrink: 0,
          }}
          onClick={(e) => {
            e.stopPropagation();
            handleDeleteScene();
          }}
        >
          ×
        </button>
      </div>
      {!collapsed &&
        (roots.length === 0 ? (
          <div
            style={{
              color: '#444',
              fontSize: 11,
              padding: '4px 0 4px 30px',
              fontStyle: 'italic',
            }}
          >
            No layers
          </div>
        ) : (
          roots.map((l) => (
            <LayerRow
              key={l.id}
              layer={l}
              layersByParent={layersByParent}
              depth={1}
            />
          ))
        ))}
    </div>
  );
}

// ---- Main -------------------------------------------------------------------

export function ComposeTree() {
  const { projectId } = useParams<{ projectId: string }>();
  const composeScenes = useEditorStore((s) => s.composeScenes);
  const addComposeScene = useEditorStore((s) => s.addComposeScene);
  const selectComposeScene = useEditorStore((s) => s.selectComposeScene);

  const handleNewComposeScene = async () => {
    if (!projectId) return;
    const name = window.prompt('Compose scene name:', 'Output');
    if (!name?.trim()) return;
    try {
      const created = await api.createComposeScene(projectId, {
        name: name.trim(),
      });
      addComposeScene(created);
      selectComposeScene(created.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to create compose scene');
    }
  };

  return (
    <div
      style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 10px',
          borderBottom: '1px solid #1e1e1e',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: '#666',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          Compose Scenes
        </span>
        <button style={addBtn} onClick={handleNewComposeScene} title="New compose scene">
          + Scene
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {composeScenes.length === 0 ? (
          <div
            style={{
              color: '#555',
              fontSize: 12,
              padding: 16,
              textAlign: 'center',
              lineHeight: 1.5,
            }}
          >
            No compose scenes yet.
            <br />
            Click + Scene to create one.
          </div>
        ) : (
          composeScenes.map((scene) => (
            <ComposeSceneRoot key={scene.id} scene={scene} projectId={projectId} />
          ))
        )}
      </div>
    </div>
  );
}
