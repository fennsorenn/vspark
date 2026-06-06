import { useState, type CSSProperties } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  useEditorStore,
  type ComposeLayerRecord,
} from '../../store/editorStore';
import { api } from '../../api/client';
import type { ComposeLayerKind } from '../../api/client';
import { ClipsSection } from './ClipsSection';
import { LogicSection } from './LogicSection';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { copyToClipboard, pasteFromClipboard } from '../../clipboard';
import { createLayer } from './createKinds';
import { DND_CREATE_LAYER } from './dnd';
import { HelpButton } from '../../help/HelpButton';

const KIND_ICONS: Record<ComposeLayerKind, string> = {
  image: '🖼',
  video: '🎞',
  audio: '🔊',
  browser: '🌐',
  group: '📁',
  compose_scene: '🎬',
  scene_include: '🎬',
  camera_view: '📷',
  text: '📝',
  feed: '📜',
};

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

// ---- Add-layer button -------------------------------------------------------

/** Routes the user to the bottom-dock Create palette (which shows layer kinds
 *  while the Compose tab is active) and flashes it as a hint, after making this
 *  compose scene the active one so the palette adds layers to it. */
function AddLayerButton({ composeSceneId }: { composeSceneId: string }) {
  const { t } = useTranslation('compose');
  const selectComposeScene = useEditorStore((s) => s.selectComposeScene);
  const flashBottomTab = useEditorStore((s) => s.flashBottomTab);
  return (
    <button
      style={addBtn}
      title={t('tree.addLayerTitle')}
      onClick={(e) => {
        e.stopPropagation();
        selectComposeScene(composeSceneId);
        flashBottomTab('create');
      }}
    >
      +
    </button>
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
  const { t } = useTranslation('compose');
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
    if (!confirm(t('tree.deleteLayerConfirm', { name: layer.name }))) return;
    useEditorStore.getState().removeComposeLayer(layer.id);
    await api.deleteComposeLayer(layer.id).catch(() => {});
  };

  const clipboardPayload = useEditorStore((s) => s.clipboardPayload);
  const setClipboard = useEditorStore((s) => s.setClipboard);
  const projectId = useEditorStore((s) => s.projectId);
  const activeSceneId = useEditorStore((s) => s.activeSceneId);

  const handleCopyLayer = async () => {
    try {
      const preset = await api.serializePreset('compose_layer', layer.id, true);
      await copyToClipboard(
        { kind: 'compose-layer', preset: preset as never },
        setClipboard
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : t('tree.errors.copyFailed'));
    }
  };

  const handlePasteLayer = async () => {
    if (!projectId || !activeSceneId) return;
    const payload = await pasteFromClipboard(clipboardPayload);
    if (!payload || payload.kind !== 'compose-layer') return;
    // Layer paste: the destination root_compose_scene_id is the same
    // compose scene that owns the row we right-clicked (the layer's
    // rootComposeSceneId); the new parent is the right-clicked layer.
    const targetSceneId =
      layer.rootComposeSceneId ??
      layer.id; /* layer is itself a compose_scene */
    try {
      await api.instantiatePreset(
        payload.preset,
        projectId,
        activeSceneId, // rootSceneNodeId required by the route but unused for layer roots
        targetSceneId,
        layer.id // parent the new layer under the right-clicked one
      );
      // Refresh the project's compose layers from the scenes bundle —
      // deserialize.ts inserts compose-layer rows via raw INSERT and
      // doesn't broadcast compose_layer_added, so the WS sync wouldn't
      // pick up the paste otherwise.
      const bundle = await api.getScenes(projectId);
      useEditorStore.setState({ composeLayers: bundle.composeLayers });
    } catch (e) {
      alert(e instanceof Error ? e.message : t('tree.errors.pasteFailed'));
    }
  };

  const handlePasteLogicAtLayer = async () => {
    const payload = await pasteFromClipboard(clipboardPayload);
    if (!payload || payload.kind !== 'graph') return;
    try {
      const created = await api.createLayerLogic(layer.id, payload.name);
      await api.updateLogic(created.id, {
        descriptor: payload.descriptor,
        enabled: true,
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : t('tree.errors.pasteGraphFailed'));
    }
  };

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };
  const buildContextMenuItems = (): ContextMenuItem[] => {
    const canPasteLayer = clipboardPayload?.kind === 'compose-layer';
    const canPasteLogic = clipboardPayload?.kind === 'graph';
    const items: ContextMenuItem[] = [
      {
        kind: 'item',
        label: t('tree.ctx.copyLayer'),
        onClick: () => void handleCopyLayer(),
      },
    ];
    if (canPasteLayer) {
      items.push({
        kind: 'item',
        label: t('tree.ctx.pasteLayerAsChild'),
        onClick: () => void handlePasteLayer(),
      });
    }
    if (canPasteLogic) {
      items.push({
        kind: 'item',
        label: t('tree.ctx.pasteLogicHere'),
        onClick: () => void handlePasteLogicAtLayer(),
      });
    }
    items.push(
      { kind: 'divider' },
      {
        kind: 'item',
        label: t('tree.ctx.delete'),
        onClick: () => void handleDelete(),
        danger: true,
      }
    );
    return items;
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
        onContextMenu={handleContextMenu}
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
          setDropPos(
            e.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
          );
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
            dropPos === 'after' ? '2px solid #4a9eff' : '2px solid transparent',
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
            title={locked3d ? t('tree.lock3dTitle_locked') : t('tree.lock3dTitle_unlocked')}
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
          title={locked ? t('tree.lockTitle_locked') : t('tree.lockTitle_unlocked')}
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
          title={layer.visible ? t('tree.hideTitle') : t('tree.showTitle')}
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
          title={t('tree.deleteLayerTitle')}
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
          <LogicSection owner={{ kind: 'layer', id: layer.id }} />
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
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={buildContextMenuItems()}
        />
      )}
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
  const { t } = useTranslation('compose');
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
    const key = l.parentId && sceneLayerIds.has(l.parentId) ? l.parentId : null;
    if (!layersByParent.has(key)) layersByParent.set(key, []);
    layersByParent.get(key)!.push(l);
  }
  const roots = (layersByParent.get(null) ?? [])
    .slice()
    .sort((a, b) => b.sceneOrder - a.sceneOrder);

  const handleDeleteScene = async () => {
    if (!confirm(t('tree.deleteSceneConfirm', { name: scene.name })))
      return;
    useEditorStore.getState().removeComposeScene(scene.id);
    await api.deleteComposeLayer(scene.id).catch(() => {});
  };

  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DND_CREATE_LAYER)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        const data = e.dataTransfer.getData(DND_CREATE_LAYER);
        if (!data) return;
        e.preventDefault();
        e.stopPropagation();
        try {
          const { kind } = JSON.parse(data) as { kind: ComposeLayerKind };
          void createLayer(scene.id, kind);
        } catch {
          /* malformed payload — ignore */
        }
      }}
    >
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
          borderLeft: isActive ? '2px solid #7a5af0' : '2px solid transparent',
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
        <AddLayerButton composeSceneId={scene.id} />
        {projectId && (
          <a
            href={`/viewer/${projectId}/compose/${scene.id}`}
            target="_blank"
            rel="noreferrer"
            title={t('tree.openBroadcastViewer')}
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
          title={t('tree.deleteSceneTitle')}
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
            {t('tree.noLayers')}
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
  const { t } = useTranslation('compose');
  const { projectId } = useParams<{ projectId: string }>();
  const composeScenes = useEditorStore((s) => s.composeScenes);
  const addComposeScene = useEditorStore((s) => s.addComposeScene);
  const selectComposeScene = useEditorStore((s) => s.selectComposeScene);

  const handleNewComposeScene = async () => {
    if (!projectId) return;
    const name = window.prompt(t('tree.promptName'), t('tree.promptDefault'));
    if (!name?.trim()) return;
    try {
      const created = await api.createComposeScene(projectId, {
        name: name.trim(),
      });
      addComposeScene(created);
      selectComposeScene(created.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : t('tree.errors.createFailed'));
    }
  };

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
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
          {t('tree.header')}
        </span>
        <HelpButton topic="scene" anchor="compose" tip={t('help.compose')} />
        <button
          style={addBtn}
          onClick={handleNewComposeScene}
          title={t('tree.newSceneTitle')}
        >
          {t('tree.newScene')}
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
            {t('tree.emptyScenes')}
            <br />
            {t('tree.emptyScenesCta')}
          </div>
        ) : (
          composeScenes.map((scene) => (
            <ComposeSceneRoot
              key={scene.id}
              scene={scene}
              projectId={projectId}
            />
          ))
        )}
      </div>
    </div>
  );
}
