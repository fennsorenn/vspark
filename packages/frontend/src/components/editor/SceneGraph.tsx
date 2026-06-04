import { useState, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useEditorStore } from '../../store/editorStore';
import { api } from '../../api/client';
import type { NodeRecord, NodeComponent } from '../../store/editorStore';
import { newComponentId } from '../../store/editorStore';
import { CAMERA_EFFECT_KINDS } from '../../store/editorStore';
import { ComposeTree } from './ComposeTree';
import { ClipsSection } from './ClipsSection';
import { GraphsSection } from './GraphsSection';
import { ContextMenu } from './ContextMenu';
import { copyToClipboard, pasteFromClipboard } from '../../clipboard';
import {
  NODE_KIND_DEFS,
  createSceneNode,
  nextNodeName,
  componentCompatibleWith,
  type NodeKindDef,
} from './createKinds';
import { handleSceneNodeDrop } from './dnd';

const KIND_ICONS: Record<string, string> = {
  scene: '🎬',
  scene_instance: '🔗',
  avatar: '🧍',
  model: '📦',
  light: '💡',
  camera: '📷',
  prop: '🔹',
  group: '📁',
  godray_caster: '☀️',
  particle: '✨',
  billboard: '🖼️',
};

// Node kinds the user can add. Sourced from the shared registry so the scene
// tree, compose tree, and bottom-dock Create palette stay in lockstep.
const NODE_TYPES = NODE_KIND_DEFS;

// ---------- Context menu ----------
interface CtxMenu {
  nodeId: string;
  x: number;
  y: number;
}

/** Scene-tree-specific right-click menu. Older than the generic
 *  ContextMenu in ./ContextMenu.tsx; renamed away from `ContextMenu` so
 *  the two don't collide. Worth eventually rewriting on top of the
 *  generic one once we settle the submenu-by-hover pattern there. */
function SceneNodeContextMenu({
  menu,
  nodes,
  onClose,
  onAddChild,
  onReparent,
  onUnparent,
  onDelete,
  onCopy,
  onPasteNode,
  onPasteGraph,
  canPasteNode,
  canPasteGraph,
}: {
  menu: CtxMenu;
  nodes: NodeRecord[];
  onClose: () => void;
  onAddChild: (parentId: string, type: (typeof NODE_TYPES)[number]) => void;
  onReparent: (nodeId: string, newParentId: string) => void;
  onUnparent: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onCopy: (nodeId: string) => void;
  onPasteNode: (parentNodeId: string) => void;
  onPasteGraph: (nodeId: string) => void;
  canPasteNode: boolean;
  canPasteGraph: boolean;
}) {
  const node = nodes.find((n) => n.id === menu.nodeId)!;
  const [showAddChild, setShowAddChild] = useState(false);
  const [showMoveInto, setShowMoveInto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    top: menu.y,
    left: menu.x,
    background: '#1e1e1e',
    border: '1px solid #3a3a3a',
    borderRadius: 6,
    zIndex: 9999,
    minWidth: 180,
    boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
    fontFamily: 'system-ui, sans-serif',
    overflow: 'hidden',
  };

  const itemStyle: React.CSSProperties = {
    padding: '7px 14px',
    fontSize: 13,
    color: '#e0e0e0',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    userSelect: 'none',
  };

  const dividerStyle: React.CSSProperties = {
    height: 1,
    background: '#2a2a2a',
    margin: '3px 0',
  };

  return (
    <div ref={ref} style={menuStyle}>
      {/* Add Child submenu */}
      <div
        style={itemStyle}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.background = '#2a2a2a';
          setShowAddChild(true);
          setShowMoveInto(false);
        }}
        onMouseLeave={(e) =>
          ((e.currentTarget as HTMLDivElement).style.background = 'transparent')
        }
      >
        <span>Add Child</span>
        <span style={{ color: '#666' }}>▶</span>
        {showAddChild && (
          <div
            style={{
              position: 'absolute',
              left: '100%',
              top: 0,
              background: '#1e1e1e',
              border: '1px solid #3a3a3a',
              borderRadius: 6,
              minWidth: 160,
              boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
              overflow: 'hidden',
            }}
          >
            {NODE_TYPES.map((t) => (
              <div
                key={t.label}
                style={itemStyle}
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLDivElement).style.background =
                    '#2a2a2a')
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLDivElement).style.background =
                    'transparent')
                }
                onClick={() => {
                  onAddChild(menu.nodeId, t);
                  onClose();
                }}
              >
                {KIND_ICONS[t.kind] ?? '🔹'} {t.label}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Move Into submenu */}
      <div
        style={itemStyle}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.background = '#2a2a2a';
          setShowMoveInto(true);
          setShowAddChild(false);
        }}
        onMouseLeave={(e) =>
          ((e.currentTarget as HTMLDivElement).style.background = 'transparent')
        }
      >
        <span>Move Into</span>
        <span style={{ color: '#666' }}>▶</span>
        {showMoveInto && (
          <div
            style={{
              position: 'absolute',
              left: '100%',
              top: 32,
              background: '#1e1e1e',
              border: '1px solid #3a3a3a',
              borderRadius: 6,
              minWidth: 180,
              maxHeight: 240,
              overflowY: 'auto',
              boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
            }}
          >
            {nodes
              .filter((n) => n.id !== menu.nodeId && n.id !== node.parentId)
              .map((n) => (
                <div
                  key={n.id}
                  style={itemStyle}
                  onMouseEnter={(e) =>
                    ((e.currentTarget as HTMLDivElement).style.background =
                      '#2a2a2a')
                  }
                  onMouseLeave={(e) =>
                    ((e.currentTarget as HTMLDivElement).style.background =
                      'transparent')
                  }
                  onClick={() => {
                    onReparent(menu.nodeId, n.id);
                    onClose();
                  }}
                >
                  {KIND_ICONS[n.kind] ?? '🔹'} {n.name}
                </div>
              ))}
          </div>
        )}
      </div>

      {node.parentId && (
        <div
          style={itemStyle}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLDivElement).style.background = '#2a2a2a')
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLDivElement).style.background =
              'transparent')
          }
          onClick={() => {
            onUnparent(menu.nodeId);
            onClose();
          }}
        >
          Unparent
        </div>
      )}

      <div style={dividerStyle} />

      <div
        style={itemStyle}
        onMouseEnter={(e) =>
          ((e.currentTarget as HTMLDivElement).style.background = '#2a2a2a')
        }
        onMouseLeave={(e) =>
          ((e.currentTarget as HTMLDivElement).style.background = 'transparent')
        }
        onClick={() => {
          onCopy(menu.nodeId);
          onClose();
        }}
      >
        Copy node
      </div>

      {canPasteNode && (
        <div
          style={itemStyle}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLDivElement).style.background = '#2a2a2a')
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLDivElement).style.background =
              'transparent')
          }
          onClick={() => {
            onPasteNode(menu.nodeId);
            onClose();
          }}
        >
          Paste node as child
        </div>
      )}

      {canPasteGraph && (
        <div
          style={itemStyle}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLDivElement).style.background = '#2a2a2a')
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLDivElement).style.background =
              'transparent')
          }
          onClick={() => {
            onPasteGraph(menu.nodeId);
            onClose();
          }}
        >
          Paste graph here
        </div>
      )}

      <div style={dividerStyle} />

      <div
        style={{ ...itemStyle, color: '#e05555' }}
        onMouseEnter={(e) =>
          ((e.currentTarget as HTMLDivElement).style.background = '#2a2a2a')
        }
        onMouseLeave={(e) =>
          ((e.currentTarget as HTMLDivElement).style.background = 'transparent')
        }
        onClick={() => {
          onDelete(menu.nodeId);
          onClose();
        }}
      >
        Delete
      </div>
    </div>
  );
}

// ---------- Inline components section ----------
function NodeComponentsSection({ nodeId }: { nodeId: string }) {
  /** Open context menu state. Null when no menu is currently up. */
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    comp: NodeComponent;
  } | null>(null);
  const nodeComponentsFor = useEditorStore((s) => s.nodeComponentsFor);
  const nodeKind = useEditorStore(
    (s) => s.nodes.find((n) => n.id === nodeId)?.kind ?? ''
  );
  const addNodeComponent = useEditorStore((s) => s.addNodeComponent);
  const updateNodeComponent = useEditorStore((s) => s.updateNodeComponent);
  const removeNodeComponent = useEditorStore((s) => s.removeNodeComponent);
  const selectedComponentId = useEditorStore((s) => s.selectedComponentId);
  const selectComponent = useEditorStore((s) => s.selectComponent);
  const vmcStatus = useEditorStore((s) => s.vmcStatus);
  const vmcTracking = useEditorStore((s) => s.vmcTracking);
  const componentKinds = useEditorStore((s) => s.componentKinds);
  const clipboardPayload = useEditorStore((s) => s.clipboardPayload);
  const setClipboard = useEditorStore((s) => s.setClipboard);
  const canPasteComponent = clipboardPayload?.kind === 'node-component';
  const components = nodeComponentsFor(nodeId).filter(
    (c) => !CAMERA_EFFECT_KINDS.some((k) => k.kind === c.kind)
  );

  const handleCopyComponent = async (comp: NodeComponent) => {
    await copyToClipboard(
      {
        kind: 'node-component',
        component: {
          kind: comp.kind,
          enabled: comp.enabled,
          config: comp.config,
        },
      },
      setClipboard
    );
  };

  const handlePasteComponent = async () => {
    const payload = await pasteFromClipboard(clipboardPayload);
    if (!payload || payload.kind !== 'node-component') return;
    const comp: NodeComponent = {
      id: newComponentId(),
      nodeId,
      kind: payload.component.kind,
      enabled: payload.component.enabled,
      config: { ...payload.component.config },
    };
    addNodeComponent(comp);
    try {
      await api.createNodeComponent(nodeId, comp);
    } catch {
      /* non-fatal */
    }
  };
  const [showAddMenu, setShowAddMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showAddMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setShowAddMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAddMenu]);

  const handleAdd = async (ct: (typeof componentKinds)[number]) => {
    setShowAddMenu(false);
    const comp: NodeComponent = {
      id: newComponentId(),
      nodeId,
      kind: ct.kind,
      enabled: true,
      config: { ...ct.defaultConfig },
    };
    addNodeComponent(comp);
    try {
      await api.createNodeComponent(nodeId, comp);
    } catch {
      /* non-fatal — state already updated locally */
    }
  };

  const handleToggleEnabled = async (comp: NodeComponent) => {
    const next = !comp.enabled;
    updateNodeComponent(comp.id, { enabled: next });
    try {
      await api.updateNodeComponent(comp.id, { enabled: next });
    } catch {
      /* non-fatal */
    }
  };

  const handleRemove = async (comp: NodeComponent) => {
    removeNodeComponent(comp.id);
    try {
      await api.deleteNodeComponent(comp.id);
    } catch {
      /* non-fatal */
    }
  };

  return (
    <div
      style={{
        marginLeft: 28,
        marginRight: 4,
        marginBottom: 4,
        background: '#111',
        borderRadius: 4,
        border: '1px solid #222',
        overflow: 'hidden',
      }}
    >
      {components.length === 0 && (
        <div
          style={{
            padding: '4px 10px',
            fontSize: 11,
            color: '#444',
            fontStyle: 'italic',
          }}
        >
          No components
        </div>
      )}
      {components.map((comp) => {
        const ct = componentKinds.find((c) => c.kind === comp.kind);
        const isSelected = selectedComponentId === comp.id;
        const hasStatus = comp.kind === 'vmc_receiver';
        const isConnected = hasStatus && vmcStatus[comp.id] === true;
        const isTracking = hasStatus && vmcTracking[comp.id] === true;
        return (
          <div
            key={comp.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              borderBottom: '1px solid #1a1a1a',
              fontSize: 12,
              cursor: 'pointer',
              background: isSelected ? '#1a3a5a' : 'transparent',
            }}
            onClick={() => selectComponent(isSelected ? null : comp.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, comp });
            }}
          >
            <span style={{ fontSize: 14 }}>{ct?.icon ?? '⚙️'}</span>
            <span
              style={{
                flex: 1,
                color: comp.enabled ? (isSelected ? '#fff' : '#ccc') : '#555',
              }}
            >
              {ct?.label ?? comp.kind}
            </span>
            {hasStatus && (
              <>
                <span
                  title={isConnected ? 'Client connected' : 'No client'}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: isConnected ? '#4ade80' : '#444',
                    boxShadow: isConnected ? '0 0 4px #4ade80' : 'none',
                  }}
                />
                <span
                  title={
                    isConnected
                      ? isTracking
                        ? 'Tracking active'
                        : 'Tracking lost'
                      : 'Not connected'
                  }
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: !isConnected
                      ? '#444'
                      : isTracking
                        ? '#facc15'
                        : '#555',
                    boxShadow: isTracking ? '0 0 4px #facc15' : 'none',
                  }}
                />
              </>
            )}
            <button
              title={comp.enabled ? 'Disable' : 'Enable'}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: comp.enabled ? '#4a9' : '#555',
                fontSize: 13,
                padding: '0 2px',
                lineHeight: 1,
              }}
              onClick={(e) => {
                e.stopPropagation();
                handleToggleEnabled(comp);
              }}
            >
              {comp.enabled ? '●' : '○'}
            </button>
          </div>
        );
      })}

      {/* Add / paste component buttons */}
      <div
        style={{
          position: 'relative',
          padding: '3px 6px',
          display: 'flex',
          gap: 6,
        }}
      >
        <button
          style={{
            background: 'none',
            border: '1px dashed #2a2a2a',
            borderRadius: 4,
            color: '#555',
            cursor: 'pointer',
            fontSize: 11,
            padding: '2px 8px',
            flex: 1,
            textAlign: 'left',
          }}
          onClick={() => setShowAddMenu((v) => !v)}
        >
          + Add Component
        </button>
        {canPasteComponent && (
          <button
            title="Paste component from clipboard onto this node"
            onClick={handlePasteComponent}
            style={{
              background: 'none',
              border: '1px dashed #3a5a4a',
              borderRadius: 4,
              color: '#9bc090',
              cursor: 'pointer',
              fontSize: 11,
              padding: '2px 8px',
            }}
          >
            ⧉ Paste
          </button>
        )}
        {showAddMenu && (
          <div
            ref={menuRef}
            style={{
              position: 'absolute',
              left: 6,
              bottom: '100%',
              marginBottom: 2,
              background: '#1e1e1e',
              border: '1px solid #3a3a3a',
              borderRadius: 6,
              minWidth: 200,
              zIndex: 1000,
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
              overflow: 'hidden',
            }}
          >
            {(() => {
              // Show components compatible with this node's kind first, then a
              // separated "Other" group for the rest (still addable).
              const item = (
                ct: (typeof componentKinds)[number],
                dimmed: boolean
              ) => (
                <div
                  key={ct.kind}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 12px',
                    cursor: 'pointer',
                    fontSize: 12,
                    color: '#e0e0e0',
                    opacity: dimmed ? 0.5 : 1,
                  }}
                  onMouseEnter={(e) =>
                    ((e.currentTarget as HTMLDivElement).style.background =
                      '#2a2a2a')
                  }
                  onMouseLeave={(e) =>
                    ((e.currentTarget as HTMLDivElement).style.background =
                      'transparent')
                  }
                  onClick={() => handleAdd(ct)}
                >
                  <span style={{ fontSize: 16 }}>{ct.icon}</span>
                  <div>
                    <div style={{ fontWeight: 500 }}>{ct.label}</div>
                    <div style={{ fontSize: 10, color: '#666', marginTop: 1 }}>
                      {ct.description}
                    </div>
                  </div>
                </div>
              );
              const compatible = componentKinds.filter((ct) =>
                componentCompatibleWith(ct.applicableTo, nodeKind)
              );
              const incompatible = componentKinds.filter(
                (ct) => !componentCompatibleWith(ct.applicableTo, nodeKind)
              );
              return (
                <>
                  {compatible.map((ct) => item(ct, false))}
                  {incompatible.length > 0 && (
                    <div
                      style={{
                        padding: '4px 12px',
                        fontSize: 9,
                        color: '#555',
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                        borderTop: '1px solid #2a2a2a',
                      }}
                    >
                      Other
                    </div>
                  )}
                  {incompatible.map((ct) => item(ct, true))}
                </>
              );
            })()}
          </div>
        )}
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              kind: 'item',
              label: 'Copy component',
              onClick: () => void handleCopyComponent(ctxMenu.comp),
            },
            {
              kind: 'item',
              label: ctxMenu.comp.enabled ? 'Disable' : 'Enable',
              onClick: () => handleToggleEnabled(ctxMenu.comp),
            },
            { kind: 'divider' },
            {
              kind: 'item',
              label: 'Remove component',
              onClick: () => handleRemove(ctxMenu.comp),
              danger: true,
            },
          ]}
        />
      )}
    </div>
  );
}

// ---------- Inline camera effects section ----------
function CameraEffectsSection({ nodeId }: { nodeId: string }) {
  const cameraEffectsFor = useEditorStore((s) => s.cameraEffectsFor);
  const addCameraEffect = useEditorStore((s) => s.addCameraEffect);
  const updateCameraEffect = useEditorStore((s) => s.updateCameraEffect);
  const removeCameraEffect = useEditorStore((s) => s.removeCameraEffect);
  const selectedEffect = useEditorStore((s) => s.selectedEffect);
  const selectEffect = useEditorStore((s) => s.selectEffect);
  const clearSelectedEffect = useEditorStore((s) => s.clearSelectedEffect);
  const clipboardPayload = useEditorStore((s) => s.clipboardPayload);
  const setClipboard = useEditorStore((s) => s.setClipboard);
  const canPasteEffect = clipboardPayload?.kind === 'camera-effect';
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    effect: import('../../store/editorStore').CameraEffectRecord;
  } | null>(null);

  const effects = cameraEffectsFor(nodeId);

  const handleCopyEffect = async (
    effect: import('../../store/editorStore').CameraEffectRecord
  ) => {
    await copyToClipboard(
      {
        kind: 'camera-effect',
        effect: {
          kind: effect.kind,
          enabled: effect.enabled,
          config: effect.config,
        },
      },
      setClipboard
    );
  };

  const handlePasteEffect = async () => {
    const payload = await pasteFromClipboard(clipboardPayload);
    if (!payload || payload.kind !== 'camera-effect') return;
    // Refuse silently if this kind is already present (mirrors handleAdd).
    if (effects.some((e) => e.kind === payload.effect.kind)) return;
    const effect = {
      id: newComponentId(),
      nodeId,
      kind: payload.effect.kind,
      enabled: payload.effect.enabled,
      config: { ...payload.effect.config },
    };
    addCameraEffect(effect);
    try {
      await api.createCameraEffect(nodeId, effect);
    } catch {
      /* non-fatal */
    }
  };
  const [showAddMenu, setShowAddMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showAddMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setShowAddMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAddMenu]);

  const handleAdd = async (ek: (typeof CAMERA_EFFECT_KINDS)[number]) => {
    setShowAddMenu(false);
    if (effects.some((e) => e.kind === ek.kind)) return;
    const effect = {
      id: newComponentId(),
      nodeId,
      kind: ek.kind,
      enabled: true,
      config: { ...ek.defaultConfig },
    };
    addCameraEffect(effect);
    try {
      await api.createCameraEffect(nodeId, effect);
    } catch {
      /* non-fatal */
    }
  };

  const handleToggleEnabled = async (
    effect: import('../../store/editorStore').CameraEffectRecord
  ) => {
    const next = !effect.enabled;
    updateCameraEffect(effect.id, { enabled: next });
    try {
      await api.updateCameraEffect(effect.id, { enabled: next });
    } catch {
      /* non-fatal */
    }
  };

  const handleRemove = async (
    effect: import('../../store/editorStore').CameraEffectRecord
  ) => {
    removeCameraEffect(effect.id);
    if (
      selectedEffect?.nodeId === nodeId &&
      selectedEffect.kind === effect.kind
    )
      clearSelectedEffect();
    try {
      await api.deleteCameraEffect(effect.id);
    } catch {
      /* non-fatal */
    }
  };

  return (
    <div
      style={{
        marginLeft: 28,
        marginRight: 4,
        marginBottom: 4,
        background: '#0e0e18',
        borderRadius: 4,
        border: '1px solid #1e1e2e',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '3px 8px',
          fontSize: 10,
          color: '#556',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          borderBottom: '1px solid #1a1a2a',
        }}
      >
        Effects
      </div>
      {effects.length === 0 && (
        <div
          style={{
            padding: '4px 10px',
            fontSize: 11,
            color: '#444',
            fontStyle: 'italic',
          }}
        >
          No effects
        </div>
      )}
      {effects.map((effect) => {
        const ek = CAMERA_EFFECT_KINDS.find((k) => k.kind === effect.kind);
        const isSelected =
          selectedEffect?.nodeId === nodeId &&
          selectedEffect.kind === effect.kind;
        return (
          <div
            key={effect.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              borderBottom: '1px solid #1a1a2a',
              fontSize: 12,
              cursor: 'pointer',
              background: isSelected ? '#1a3a5a' : 'transparent',
            }}
            onClick={() =>
              isSelected
                ? clearSelectedEffect()
                : selectEffect(nodeId, effect.kind)
            }
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, effect });
            }}
          >
            <span style={{ fontSize: 13 }}>{ek?.icon ?? '✦'}</span>
            <span
              style={{
                flex: 1,
                color: effect.enabled ? (isSelected ? '#fff' : '#ccc') : '#555',
              }}
            >
              {ek?.label ?? effect.kind}
            </span>
            <button
              title={effect.enabled ? 'Disable' : 'Enable'}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: effect.enabled ? '#4a9' : '#555',
                fontSize: 13,
                padding: '0 2px',
                lineHeight: 1,
              }}
              onClick={(e) => {
                e.stopPropagation();
                handleToggleEnabled(effect);
              }}
            >
              {effect.enabled ? '●' : '○'}
            </button>
          </div>
        );
      })}
      <div
        style={{
          position: 'relative',
          padding: '3px 6px',
          display: 'flex',
          gap: 6,
        }}
      >
        <button
          style={{
            background: 'none',
            border: '1px dashed #1e1e2e',
            borderRadius: 4,
            color: '#555',
            cursor: 'pointer',
            fontSize: 11,
            padding: '2px 8px',
            flex: 1,
            textAlign: 'left',
          }}
          onClick={() => setShowAddMenu((v) => !v)}
        >
          + Add Effect
        </button>
        {canPasteEffect && (
          <button
            title="Paste effect from clipboard onto this camera"
            onClick={handlePasteEffect}
            style={{
              background: 'none',
              border: '1px dashed #3a5a4a',
              borderRadius: 4,
              color: '#9bc090',
              cursor: 'pointer',
              fontSize: 11,
              padding: '2px 8px',
            }}
          >
            ⧉ Paste
          </button>
        )}
        {showAddMenu && (
          <div
            ref={menuRef}
            style={{
              position: 'absolute',
              left: 6,
              bottom: '100%',
              marginBottom: 2,
              background: '#1e1e1e',
              border: '1px solid #3a3a3a',
              borderRadius: 6,
              minWidth: 180,
              zIndex: 1000,
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
              overflow: 'hidden',
            }}
          >
            {CAMERA_EFFECT_KINDS.map((ek) => {
              const alreadyAdded = effects.some((e) => e.kind === ek.kind);
              return (
                <div
                  key={ek.kind}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 12px',
                    cursor: alreadyAdded ? 'default' : 'pointer',
                    fontSize: 12,
                    color: alreadyAdded ? '#444' : '#e0e0e0',
                  }}
                  onMouseEnter={(e) => {
                    if (!alreadyAdded)
                      (e.currentTarget as HTMLDivElement).style.background =
                        '#2a2a2a';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background =
                      'transparent';
                  }}
                  onClick={() => {
                    if (!alreadyAdded) handleAdd(ek);
                  }}
                >
                  <span style={{ fontSize: 15 }}>{ek.icon}</span>
                  <div>
                    <div style={{ fontWeight: 500 }}>{ek.label}</div>
                    <div style={{ fontSize: 10, color: '#666', marginTop: 1 }}>
                      {ek.description}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              kind: 'item',
              label: 'Copy effect',
              onClick: () => void handleCopyEffect(ctxMenu.effect),
            },
            {
              kind: 'item',
              label: ctxMenu.effect.enabled ? 'Disable' : 'Enable',
              onClick: () => handleToggleEnabled(ctxMenu.effect),
            },
            { kind: 'divider' },
            {
              kind: 'item',
              label: 'Remove effect',
              onClick: () => handleRemove(ctxMenu.effect),
              danger: true,
            },
          ]}
        />
      )}
    </div>
  );
}

const formatBoneName = (name: string) =>
  name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

// ---------- Graph list panel ----------
import type { GraphDescriptor } from '@vspark/shared/signal';
import type { GraphRecord } from '../../api/client';

function GraphListPanel() {
  const { projectId } = useParams<{ projectId: string }>();
  const { activeGraphId, setActiveGraph } = useEditorStore();
  const [componentGraphs, setComponentGraphs] = useState<GraphDescriptor[]>([]);
  const [projectGraphs, setProjectGraphs] = useState<GraphRecord[]>([]);
  const [componentGraphsOpen, setComponentGraphsOpen] = useState(false);
  const clipboardPayload = useEditorStore((s) => s.clipboardPayload);
  const setClipboard = useEditorStore((s) => s.setClipboard);
  const canPasteGraph = clipboardPayload?.kind === 'graph';
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    graph: GraphRecord;
  } | null>(null);

  const refresh = () => {
    api
      .getSignalGraphs()
      .then(setComponentGraphs)
      .catch(() => {});
    if (projectId)
      api
        .getProjectGraphs(projectId)
        .then(setProjectGraphs)
        .catch(() => {});
  };

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 3000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const rowStyle = (active: boolean): React.CSSProperties => ({
    padding: '7px 12px',
    fontSize: 12,
    color: active ? '#fff' : '#bbb',
    background: active ? '#1e3a5f' : 'transparent',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    userSelect: 'none',
    borderLeft: active ? '2px solid #4a90d9' : '2px solid transparent',
  });

  const handleCreate = async () => {
    if (!projectId) return;
    const name = window.prompt('New graph name:', 'Untitled Graph');
    if (!name?.trim()) return;
    try {
      const created = await api.createProjectGraph(projectId, name.trim());
      setProjectGraphs((prev) => [...prev, created]);
      setActiveGraph(created.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to create graph');
    }
  };

  const handleRename = async (g: GraphRecord) => {
    const name = window.prompt('Rename graph:', g.name);
    if (!name?.trim() || name.trim() === g.name) return;
    try {
      const updated = await api.updateGraph(g.id, { name: name.trim() });
      setProjectGraphs((prev) =>
        prev.map((x) => (x.id === g.id ? updated : x))
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to rename graph');
    }
  };

  const handleToggleEnabled = async (g: GraphRecord) => {
    try {
      const updated = await api.updateGraph(g.id, {
        enabled: !g.enabled,
      });
      setProjectGraphs((prev) =>
        prev.map((x) => (x.id === g.id ? updated : x))
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to toggle graph');
    }
  };

  const handleDelete = async (g: GraphRecord) => {
    if (!window.confirm(`Delete graph "${g.name}"?`)) return;
    try {
      await api.deleteGraph(g.id);
      setProjectGraphs((prev) => prev.filter((x) => x.id !== g.id));
      if (activeGraphId === g.id) setActiveGraph(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete graph');
    }
  };

  const handleCopy = async (g: GraphRecord) => {
    await copyToClipboard(
      {
        kind: 'graph',
        name: g.name,
        descriptor: g.descriptor,
        sourceOwnerKind: 'project',
      },
      setClipboard
    );
  };

  const handlePaste = async () => {
    if (!projectId) return;
    const payload = await pasteFromClipboard(clipboardPayload);
    if (!payload || payload.kind !== 'graph') return;
    try {
      const created = await api.createProjectGraph(projectId, payload.name);
      const updated = await api.updateGraph(created.id, {
        descriptor: payload.descriptor,
        enabled: true,
      });
      setProjectGraphs((prev) => [...prev, updated]);
      setActiveGraph(updated.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to paste graph');
    }
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
      {/* Standalone (project) graphs */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 10px 4px',
          fontSize: 10,
          fontWeight: 700,
          color: '#666',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        <span>Project Graphs</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {canPasteGraph && (
            <button
              title="Paste graph from clipboard as a project graph"
              onClick={handlePaste}
              style={{
                background: 'none',
                border: '1px dashed #3a5a4a',
                color: '#9bc090',
                borderRadius: 4,
                padding: '1px 6px',
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              ⧉
            </button>
          )}
          <button
            title="New graph"
            onClick={handleCreate}
            style={{
              background: '#2563eb',
              border: 'none',
              color: '#fff',
              borderRadius: 4,
              padding: '2px 7px',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 500,
            }}
          >
            +
          </button>
        </div>
      </div>
      {projectGraphs.length === 0 ? (
        <div
          style={{
            color: '#444',
            fontSize: 11,
            padding: '4px 12px 8px',
            fontStyle: 'italic',
          }}
        >
          No project graphs yet.
        </div>
      ) : (
        projectGraphs.map((g) => {
          const active = g.id === activeGraphId;
          return (
            <div
              key={g.id}
              style={rowStyle(active)}
              onClick={() => setActiveGraph(active ? null : g.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu({ x: e.clientX, y: e.clientY, graph: g });
              }}
            >
              <span style={{ opacity: g.enabled ? 0.9 : 0.35 }}>⬡</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {g.name}
                </div>
                <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>
                  {g.descriptor.nodes.length} nodes{' '}
                  {g.enabled ? '' : '· disabled'}
                </div>
              </div>
              <button
                title={g.enabled ? 'Disable' : 'Enable'}
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleEnabled(g);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: g.enabled ? '#4a9' : '#555',
                  fontSize: 13,
                  padding: '0 2px',
                  lineHeight: 1,
                }}
              >
                {g.enabled ? '●' : '○'}
              </button>
            </div>
          );
        })
      )}

      {/* Component-owned graphs (read-only) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 10px 4px',
          fontSize: 10,
          fontWeight: 700,
          color: '#666',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setComponentGraphsOpen((v) => !v)}
      >
        <span style={{ color: '#555' }}>{componentGraphsOpen ? '▼' : '▶'}</span>
        <span>Component Graphs</span>
        <span style={{ color: '#444', fontWeight: 400 }}>
          ({componentGraphs.length})
        </span>
      </div>
      {componentGraphsOpen &&
        (componentGraphs.length === 0 ? (
          <div
            style={{
              color: '#444',
              fontSize: 11,
              padding: '4px 12px',
              fontStyle: 'italic',
            }}
          >
            No active component graphs.
          </div>
        ) : (
          componentGraphs.map((g) => (
            <div
              key={g.id}
              style={rowStyle(g.id === activeGraphId)}
              onClick={() =>
                setActiveGraph(g.id === activeGraphId ? null : g.id)
              }
            >
              <span style={{ opacity: 0.6 }}>⬡</span>
              <div>
                <div style={{ fontWeight: 500 }}>{g.label}</div>
                <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>
                  {g.nodes.length} nodes · read-only
                </div>
              </div>
            </div>
          ))
        ))}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              kind: 'item',
              label: 'Copy graph',
              onClick: () => void handleCopy(ctxMenu.graph),
            },
            {
              kind: 'item',
              label: 'Rename…',
              onClick: () => handleRename(ctxMenu.graph),
            },
            {
              kind: 'item',
              label: ctxMenu.graph.enabled ? 'Disable' : 'Enable',
              onClick: () => handleToggleEnabled(ctxMenu.graph),
            },
            { kind: 'divider' },
            {
              kind: 'item',
              label: 'Delete',
              onClick: () => handleDelete(ctxMenu.graph),
              danger: true,
            },
          ]}
        />
      )}
    </div>
  );
}

// ---------- Main SceneGraph ----------
export function SceneGraph() {
  const { projectId } = useParams<{ projectId: string }>();
  const {
    activeSceneId,
    scenes,
    nodes: allNodes,
    selectedNodeId,
    selectNode,
    deleteNode: storeDeleteNode,
    updateNode: storeUpdateNode,
    nodeComponents,
    vrmBonesByNode,
    setHoveredBone,
    boneListExpanded,
    setBoneListExpanded,
    previewEffectsCamera,
    setPreviewEffectsCamera,
    toggleNodeHidden,
    sceneSelected,
    setSceneSelected,
  } = useEditorStore();

  const dockTab = useEditorStore((s) => s.leftTab);
  const setDockTab = useEditorStore((s) => s.setLeftTab);
  const setActiveScene = useEditorStore((s) => s.setActiveScene);
  const setScenes = useEditorStore((s) => s.setScenes);
  const flashBottomTab = useEditorStore((s) => s.flashBottomTab);
  const requestFocusName = useEditorStore((s) => s.requestFocusName);
  const clipboardPayload = useEditorStore((s) => s.clipboardPayload);
  const setClipboard = useEditorStore((s) => s.setClipboard);
  const canPasteSceneNodeClipboard = clipboardPayload?.kind === 'scene-node';
  const canPasteGraphClipboard = clipboardPayload?.kind === 'graph';
  // Collapsed scene roots (scene id set).
  const [collapsedScenes, setCollapsedScenes] = useState<Set<string>>(
    new Set()
  );
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());
  const [collapsedBones, setCollapsedBones] = useState<Set<string>>(new Set()); // key: `${nodeId}:${boneName}`
  const [expandedComponents, setExpandedComponents] = useState<Set<string>>(
    new Set()
  );
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [dragOverBone, setDragOverBone] = useState<{
    nodeId: string;
    bone: string;
  } | null>(null);
  const [dragOverNodeId, setDragOverNodeId] = useState<string | null>(null);

  const toggleBones = (id: string) =>
    setBoneListExpanded(id, !(boneListExpanded[id] ?? false));

  // Hide spawn-manager tmp clones (`__spawn:UUID` ids) from the scene tree —
  // they live only for the duration of a tmp clip and would churn the tree.
  // The renderer still picks them up from the store; this filter is UI-only.
  const nodes = allNodes.filter((n) => !n.id.startsWith('__spawn:'));

  const sceneNodes = nodes.filter((n) => n.rootSceneNodeId === activeSceneId);

  const toggleCollapse = (id: string) =>
    setCollapsedNodes((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const toggleBoneCollapse = (key: string) =>
    setCollapsedBones((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  const toggleComponents = (id: string) =>
    setExpandedComponents((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const toggleSceneCollapse = (id: string) =>
    setCollapsedScenes((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const handleNewScene = async () => {
    if (!projectId) return;
    const name = window.prompt('Scene name:', 'New Scene');
    if (!name?.trim()) return;
    try {
      const scene = await api.createScene(projectId, name.trim());
      // Reload the full project so the auto-populated nodes (camera, lights,
      // compose scene) land in the store alongside the new scene row.
      const data = await api.getScenes(projectId);
      setScenes(data.scenes);
      useEditorStore.getState().setNodes(data.nodes);
      setActiveScene(scene.id);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to create scene');
    }
  };

  const handleDeleteScene = async (scene: (typeof scenes)[number]) => {
    if (
      !window.confirm(
        `Delete scene "${scene.name}" and all its nodes? This cannot be undone.`
      )
    )
      return;
    try {
      await api.deleteScene(scene.id);
      useEditorStore.getState().removeScene(scene.id);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to delete scene');
    }
  };

  const handleAdd = async (
    type: NodeKindDef,
    parentId: string | null = null,
    sceneId: string | null = activeSceneId
  ) => {
    if (!sceneId) return;
    // Create with a deduplicated default name, then select + focus the name
    // field so the user can rename inline instead of being prompted up front.
    const name = nextNodeName(type, sceneId);
    try {
      const node = await createSceneNode(sceneId, type, parentId, name);
      if (parentId)
        setCollapsedNodes((s) => {
          const n = new Set(s);
          n.delete(parentId);
          return n;
        });
      selectNode(node.id);
      setSceneSelected(false);
      requestFocusName();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to create node');
    }
  };

  const handleDelete = async (nodeId: string) => {
    const node = sceneNodes.find((n) => n.id === nodeId);
    if (!node || !window.confirm(`Delete "${node.name}"?`)) return;
    try {
      await api.deleteNode(nodeId);
      storeDeleteNode(nodeId);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to delete node');
    }
  };

  // ── copy / paste (scene node, bone, scoped graph) ──────────────────────
  //
  // Copy serialises the whole subtree as a preset payload — same code path
  // as the existing Save-Preset feature, so any cross-project portability
  // (asset rematching, internal id substitution, attached graph + clip
  // round-trip) carries through. Paste calls instantiatePreset with the
  // right parentId / boneAttachment combo, then refreshes the local scene
  // node list. Errors surface via alert() so silent failures don't get
  // swallowed.
  const handleCopyNode = async (nodeId: string) => {
    try {
      const preset = await api.serializePreset('scene_node', nodeId, true);
      await copyToClipboard(
        { kind: 'scene-node', preset: preset as never },
        setClipboard
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to copy node (serialize)');
    }
  };

  const refreshSceneNodes = async () => {
    if (!activeSceneId) return;
    try {
      const fetched = await api.getNodes(activeSceneId);
      // Replace the active scene's nodes in the store.
      const store = useEditorStore.getState();
      const others = store.nodes.filter(
        (n) => n.rootSceneNodeId !== activeSceneId
      );
      useEditorStore.setState({ nodes: [...others, ...fetched] });
    } catch {
      /* non-fatal */
    }
  };

  const handlePasteNodeAsChild = async (
    parentNodeId: string | null,
    bone: string | null = null
  ) => {
    if (!activeSceneId || !projectId) return;
    const payload = await pasteFromClipboard(clipboardPayload);
    if (!payload || payload.kind !== 'scene-node') return;
    try {
      await api.instantiatePreset(
        payload.preset,
        projectId,
        activeSceneId,
        null,
        parentNodeId,
        bone
      );
      await refreshSceneNodes();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to paste node');
    }
  };

  const handlePasteGraphAtNode = async (nodeId: string) => {
    const payload = await pasteFromClipboard(clipboardPayload);
    if (!payload || payload.kind !== 'graph') return;
    try {
      const created = await api.createNodeGraph(nodeId, payload.name);
      await api.updateGraph(created.id, {
        descriptor: payload.descriptor,
        enabled: true,
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to paste graph');
    }
  };

  const handleReparent = async (
    nodeId: string,
    newParentId: string | null,
    newBoneAttachment?: string | null
  ) => {
    try {
      const patch: Parameters<typeof api.updateNode>[1] = {
        parentId: newParentId,
      };
      if (newBoneAttachment !== undefined)
        patch.boneAttachment = newBoneAttachment;
      await api.updateNode(nodeId, patch);
      storeUpdateNode(nodeId, {
        parentId: newParentId,
        ...(newBoneAttachment !== undefined
          ? { boneAttachment: newBoneAttachment }
          : {}),
      });
      if (newParentId)
        setCollapsedNodes((s) => {
          const n = new Set(s);
          n.delete(newParentId);
          return n;
        });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to move node');
    }
  };

  // Drag handlers
  const handleDragStart = (e: React.DragEvent, nodeId: string) => {
    e.stopPropagation();
    setDragNodeId(nodeId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDropOnBone = async (
    e: React.DragEvent,
    parentNodeId: string,
    boneName: string
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverBone(null);
    if (!dragNodeId || dragNodeId === parentNodeId) return;
    await handleReparent(dragNodeId, parentNodeId, boneName);
    setDragNodeId(null);
  };

  const handleDropOnNode = async (e: React.DragEvent, targetNodeId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverNodeId(null);
    // Drag-create from the bottom dock: add the new node/asset as a child.
    if (await handleSceneNodeDrop(e, activeSceneId, targetNodeId)) {
      setCollapsedNodes((s) => {
        const n = new Set(s);
        n.delete(targetNodeId);
        return n;
      });
      return;
    }
    if (!dragNodeId || dragNodeId === targetNodeId) return;
    await handleReparent(dragNodeId, targetNodeId, null);
    setDragNodeId(null);
  };

  const handleDropOnRoot = async (e: React.DragEvent) => {
    e.preventDefault();
    // Drag-create from the bottom dock: add at scene root.
    if (await handleSceneNodeDrop(e, activeSceneId, null)) return;
    if (!dragNodeId) return;
    await handleReparent(dragNodeId, null, null);
    setDragNodeId(null);
  };

  const renderNode = (node: NodeRecord, depth = 0) => {
    const isSelected = selectedNodeId === node.id;
    const isHidden = node.hidden ?? false;
    const allChildren = nodes.filter((n) => n.parentId === node.id);
    const bones =
      node.kind === 'avatar' || node.kind === 'model'
        ? (vrmBonesByNode[node.id] ?? null)
        : null;
    const showBones = boneListExpanded[node.id] ?? false;

    // Split children: bone-attached vs unattached
    const attachedChildren = allChildren.filter((c) => c.boneAttachment);
    const freeChildren = allChildren.filter((c) => !c.boneAttachment);

    const hasVisibleChildren =
      freeChildren.length > 0 ||
      (bones && attachedChildren.length > 0) ||
      (bones && showBones && bones.length > 0);
    const isCollapsed = collapsedNodes.has(node.id);
    const showComponents = expandedComponents.has(node.id);
    const compCount = nodeComponents.filter(
      (c) =>
        c.nodeId === node.id &&
        !CAMERA_EFFECT_KINDS.some((k) => k.kind === c.kind)
    ).length;
    const icon = KIND_ICONS[node.kind] ?? '🔹';
    const isDragOver = dragOverNodeId === node.id;

    return (
      <div key={node.id}>
        {/* Node row */}
        <div
          draggable
          onDragStart={(e) => handleDragStart(e, node.id)}
          onDragEnd={() => {
            setDragNodeId(null);
            setDragOverNodeId(null);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOverNodeId(node.id);
            setDragOverBone(null);
          }}
          onDragLeave={() => setDragOverNodeId(null)}
          onDrop={(e) => handleDropOnNode(e, node.id)}
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: `4px 8px 4px ${8 + depth * 16}px`,
            cursor: 'pointer',
            background: isSelected
              ? '#1a3a6a'
              : isDragOver
                ? '#1a2a1a'
                : 'transparent',
            borderRadius: 4,
            margin: '1px 4px',
            fontSize: 13,
            color: '#e0e0e0',
            userSelect: 'none',
            gap: 2,
            outline: isDragOver ? '1px solid #4a8' : 'none',
          }}
          onClick={() => {
            if (node.rootSceneNodeId !== activeSceneId)
              setActiveScene(node.rootSceneNodeId);
            selectNode(isSelected ? null : node.id);
            setSceneSelected(false);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu({ nodeId: node.id, x: e.clientX, y: e.clientY });
          }}
        >
          {/* Collapse chevron (or spacer) */}
          <span
            style={{
              width: 16,
              flexShrink: 0,
              color: '#555',
              fontSize: 10,
              textAlign: 'center',
              visibility: hasVisibleChildren ? 'visible' : 'hidden',
            }}
            onClick={(e) => {
              e.stopPropagation();
              toggleCollapse(node.id);
            }}
          >
            {isCollapsed ? '▶' : '▼'}
          </span>

          <span style={{ fontSize: 14, flexShrink: 0 }}>{icon}</span>
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginLeft: 4,
            }}
          >
            {node.name}
          </span>

          {/* Bones toggle — avatar/model only, shown once VRM is loaded */}
          {bones && (
            <button
              title={showBones ? 'Collapse empty bones' : 'Expand all bones'}
              style={{
                background: 'none',
                border: 'none',
                color: showBones ? '#8af' : '#444',
                cursor: 'pointer',
                fontSize: 11,
                padding: '0 3px',
                flexShrink: 0,
                lineHeight: 1,
              }}
              onClick={(e) => {
                e.stopPropagation();
                toggleBones(node.id);
              }}
            >
              🦴
            </button>
          )}

          {/* Components toggle */}
          <button
            title={showComponents ? 'Hide components' : 'Show components'}
            style={{
              background: 'none',
              border: 'none',
              color: showComponents ? '#4a8' : compCount > 0 ? '#666' : '#333',
              cursor: 'pointer',
              fontSize: 11,
              padding: '0 3px',
              flexShrink: 0,
              lineHeight: 1,
            }}
            onClick={(e) => {
              e.stopPropagation();
              toggleComponents(node.id);
            }}
          >
            ⚙
            {compCount > 0 ? (
              <sup style={{ fontSize: 8 }}>{compCount}</sup>
            ) : null}
          </button>

          {/* Camera-only controls */}
          {node.kind === 'camera' && (
            <>
              <button
                title={
                  previewEffectsCamera === node.id
                    ? 'Disable effect preview'
                    : 'Preview effects in viewport'
                }
                style={{
                  background: 'none',
                  border: 'none',
                  color: previewEffectsCamera === node.id ? '#7ab' : '#444',
                  cursor: 'pointer',
                  fontSize: 11,
                  padding: '0 2px',
                  flexShrink: 0,
                  lineHeight: 1,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setPreviewEffectsCamera(node.id);
                }}
              >
                ✦
              </button>
              {projectId && (
                <a
                  href={`/viewer/${projectId}/${node.id}`}
                  target="_blank"
                  rel="noreferrer"
                  title="Open viewer"
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
            </>
          )}

          {/* Visibility toggle */}
          <button
            title={isHidden ? 'Show' : 'Hide'}
            style={{
              background: 'none',
              border: 'none',
              color: isHidden ? '#444' : '#666',
              cursor: 'pointer',
              padding: '0 2px',
              fontSize: 12,
              lineHeight: 1,
              flexShrink: 0,
            }}
            onClick={(e) => {
              e.stopPropagation();
              toggleNodeHidden(node.id);
              api.updateNode(node.id, { hidden: !isHidden }).catch(() => {});
            }}
          >
            {isHidden ? '🙈' : '👁'}
          </button>

          {/* Delete button */}
          <button
            style={{
              background: 'none',
              border: 'none',
              color: '#555',
              cursor: 'pointer',
              padding: '0 2px',
              fontSize: 14,
              lineHeight: 1,
              flexShrink: 0,
            }}
            onClick={(e) => {
              e.stopPropagation();
              handleDelete(node.id);
            }}
            title="Delete node"
          >
            ×
          </button>
        </div>

        {/* Inline components section */}
        {showComponents && (
          <div style={{ paddingLeft: 8 + depth * 16 }}>
            <NodeComponentsSection nodeId={node.id} />
            {node.kind === 'camera' && (
              <CameraEffectsSection nodeId={node.id} />
            )}
            <ClipsSection owner={{ kind: 'node', id: node.id }} />
            <GraphsSection owner={{ kind: 'node', id: node.id }} />
          </div>
        )}

        {/* Children + bone rows (not collapsed) */}
        {!isCollapsed && (
          <>
            {/* Bone rows for skeletal nodes */}
            {bones &&
              (() => {
                const bonesWithChildren = bones.filter((b) =>
                  attachedChildren.some((c) => c.boneAttachment === b)
                );
                const emptyBones = bones.filter(
                  (b) => !attachedChildren.some((c) => c.boneAttachment === b)
                );
                const visibleBones = [
                  ...bonesWithChildren,
                  ...(showBones ? emptyBones : []),
                ];

                return visibleBones.map((boneName) => {
                  const boneKey = `${node.id}:${boneName}`;
                  const boneChildren = attachedChildren.filter(
                    (c) => c.boneAttachment === boneName
                  );
                  const hasBoneChildren = boneChildren.length > 0;
                  const isBoneCollapsed = collapsedBones.has(boneKey);
                  const isDragOverThis =
                    dragOverBone?.nodeId === node.id &&
                    dragOverBone.bone === boneName;

                  return (
                    <div key={boneKey}>
                      {/* Bone row */}
                      <div
                        onContextMenu={(e) => {
                          if (!canPasteSceneNodeClipboard) return;
                          e.preventDefault();
                          // Single-action prompt — full menu is overkill
                          // when "paste here" is the only meaningful action
                          // a bone can host.
                          const yes = window.confirm(
                            `Paste node onto bone "${formatBoneName(boneName)}"?`
                          );
                          if (yes) {
                            void handlePasteNodeAsChild(node.id, boneName);
                          }
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDragOverBone({ nodeId: node.id, bone: boneName });
                          setDragOverNodeId(null);
                        }}
                        onDragLeave={() => setDragOverBone(null)}
                        onDrop={(e) => handleDropOnBone(e, node.id, boneName)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          padding: `3px 8px 3px ${8 + (depth + 1) * 16}px`,
                          fontSize: 11,
                          color: isDragOverThis ? '#8af' : '#556',
                          userSelect: 'none',
                          gap: 4,
                          background: isDragOverThis
                            ? '#1a2a3a'
                            : 'transparent',
                          borderRadius: 3,
                          margin: '1px 4px',
                          outline: isDragOverThis ? '1px dashed #4a8' : 'none',
                        }}
                        onMouseEnter={() => setHoveredBone(boneName)}
                        onMouseLeave={() => setHoveredBone(null)}
                      >
                        <span
                          style={{
                            width: 14,
                            flexShrink: 0,
                            color: '#444',
                            fontSize: 9,
                            textAlign: 'center',
                            visibility: hasBoneChildren ? 'visible' : 'hidden',
                            cursor: 'pointer',
                          }}
                          onClick={() => toggleBoneCollapse(boneKey)}
                        >
                          {isBoneCollapsed ? '▶' : '▼'}
                        </span>
                        <span style={{ fontSize: 12, flexShrink: 0 }}>🦴</span>
                        <span
                          style={{
                            flex: 1,
                            fontFamily: 'monospace',
                            fontSize: 10,
                          }}
                        >
                          {formatBoneName(boneName)}
                        </span>
                      </div>

                      {/* Bone's attached children */}
                      {!isBoneCollapsed &&
                        boneChildren.map((child) =>
                          renderNode(child, depth + 2)
                        )}
                    </div>
                  );
                });
              })()}

            {/* Free children (no bone attachment) */}
            {freeChildren.map((child) => renderNode(child, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const renderSceneRoot = (scene: (typeof scenes)[number]) => {
    const isActive = scene.id === activeSceneId;
    const isSelected = isActive && sceneSelected;
    const isCollapsed = collapsedScenes.has(scene.id);
    const rootNodes = nodes.filter(
      (n) => n.rootSceneNodeId === scene.id && !n.parentId && n.kind !== 'scene'
    );

    return (
      <div key={scene.id}>
        {/* Scene row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '5px 8px',
            cursor: 'pointer',
            background: isSelected
              ? '#2a1a4a'
              : isActive
                ? '#1c1c28'
                : 'transparent',
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
          onClick={() => {
            setActiveScene(scene.id);
            setSceneSelected(true);
            selectNode(null);
          }}
        >
          <span
            style={{
              width: 16,
              flexShrink: 0,
              color: '#555',
              fontSize: 10,
              textAlign: 'center',
              visibility: rootNodes.length > 0 ? 'visible' : 'hidden',
            }}
            onClick={(e) => {
              e.stopPropagation();
              toggleSceneCollapse(scene.id);
            }}
          >
            {isCollapsed ? '▶' : '▼'}
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
          {/* Per-scene add-node button — routes to the bottom-dock Create
              palette and flashes it as a hint, rather than opening its own
              menu. The palette adds to whichever scene is active. */}
          <button
            title="Add node — opens the Create palette"
            style={{
              background: '#2563eb',
              border: 'none',
              color: '#fff',
              borderRadius: 4,
              padding: '2px 7px',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 500,
            }}
            onClick={(e) => {
              e.stopPropagation();
              setActiveScene(scene.id);
              setSceneSelected(true);
              selectNode(null);
              setDockTab('scene');
              flashBottomTab('create');
            }}
          >
            +
          </button>
          {/* Delete scene */}
          <button
            title="Delete scene"
            style={{
              background: 'none',
              border: 'none',
              color: '#555',
              cursor: 'pointer',
              padding: '0 2px',
              fontSize: 14,
              lineHeight: 1,
              flexShrink: 0,
            }}
            onClick={(e) => {
              e.stopPropagation();
              handleDeleteScene(scene);
            }}
          >
            ×
          </button>
        </div>

        {/* Scene-level clips + graphs (owned by the scene node itself) */}
        {isSelected && (
          <>
            <ClipsSection owner={{ kind: 'node', id: scene.id }} />
            <GraphsSection owner={{ kind: 'node', id: scene.id }} />
          </>
        )}

        {/* Scene's root nodes */}
        {!isCollapsed &&
          (rootNodes.length === 0 ? (
            <div
              style={{
                color: '#444',
                fontSize: 11,
                padding: '4px 0 4px 30px',
                fontStyle: 'italic',
              }}
            >
              Empty scene
            </div>
          ) : (
            rootNodes.map((n) => renderNode(n, 1))
          ))}
      </div>
    );
  };

  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '7px 0',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    color: active ? '#e0e0e0' : '#555',
    background: 'none',
    border: 'none',
    borderBottom: active ? '2px solid #4a90d9' : '2px solid transparent',
    cursor: 'pointer',
  });

  return (
    <div
      style={{
        width: 240,
        flexShrink: 0,
        background: '#141414',
        borderRight: '1px solid #2a2a2a',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'system-ui, sans-serif',
        overflow: 'hidden',
      }}
    >
      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid #2a2a2a',
          flexShrink: 0,
        }}
      >
        <button
          style={tabStyle(dockTab === 'scene')}
          onClick={() => setDockTab('scene')}
        >
          Scene
        </button>
        <button
          style={tabStyle(dockTab === 'compose')}
          onClick={() => setDockTab('compose')}
          title="Compose"
        >
          Compose
        </button>
        <button
          style={tabStyle(dockTab === 'graphs')}
          onClick={() => setDockTab('graphs')}
        >
          Graphs
        </button>
      </div>

      {dockTab === 'graphs' && <GraphListPanel />}
      {dockTab === 'compose' && <ComposeTree />}

      {dockTab === 'scene' && (
        <>
          {/* Scenes header */}
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
              Scenes
            </span>
            <button
              style={{
                background: '#2563eb',
                border: 'none',
                color: '#fff',
                borderRadius: 4,
                padding: '2px 8px',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 500,
              }}
              onClick={handleNewScene}
              title="New scene"
            >
              + Scene
            </button>
          </div>

          {/* Scene roots */}
          <div
            style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDropOnRoot}
          >
            {scenes.length === 0 ? (
              <div
                style={{
                  color: '#555',
                  fontSize: 12,
                  padding: '12px',
                  textAlign: 'center',
                }}
              >
                No scenes yet. Click + Scene
              </div>
            ) : (
              scenes.map((scene) => renderSceneRoot(scene))
            )}
          </div>

          {/* Context menu */}
          {ctxMenu && (
            <SceneNodeContextMenu
              menu={ctxMenu}
              nodes={nodes}
              onClose={() => setCtxMenu(null)}
              onAddChild={(parentId, type) => handleAdd(type, parentId)}
              onReparent={(id, newParentId) => handleReparent(id, newParentId)}
              onUnparent={(id) => handleReparent(id, null, null)}
              onDelete={handleDelete}
              onCopy={(id) => void handleCopyNode(id)}
              onPasteNode={(parentId) =>
                void handlePasteNodeAsChild(parentId, null)
              }
              onPasteGraph={(id) => void handlePasteGraphAtNode(id)}
              canPasteNode={canPasteSceneNodeClipboard}
              canPasteGraph={canPasteGraphClipboard}
            />
          )}
        </>
      )}
    </div>
  );
}
