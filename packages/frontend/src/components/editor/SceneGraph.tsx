import { useState, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../store/editorStore';
import { api } from '../../api/client';
import type { StageObject, Behavior } from '../../store/editorStore';
import { newBehaviorId } from '../../store/editorStore';
import { CAMERA_EFFECT_KINDS } from '../../store/editorStore';
import { ComposeTree } from './ComposeTree';
import { ClipsSection } from './ClipsSection';
import { LogicSection } from './LogicSection';
import { ContextMenu } from './ContextMenu';
import { HelpButton } from '../../help/HelpButton';
import { useConnectionsStore } from '../../store/connectionsStore';
import { isWritableRemoteNode as isWritableRemote } from '../../sync/remoteEdit';
import {
  getObjectGrantees,
  shareObject,
  unshareObject,
} from '../../api/client';
import { useConfirm, usePrompt } from '../DialogProvider';
import { copyToClipboard, pasteFromClipboard } from '../../clipboard';
import {
  NODE_KIND_DEFS,
  createSceneNode,
  nextNodeName,
  behaviorCompatibleWith,
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
  video: '🎞️',
  audio: '🔊',
  feed: '📜',
  remote_object: '🔗',
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
  onPasteLogic,
  canPasteNode,
  canPasteLogic,
}: {
  menu: CtxMenu;
  nodes: StageObject[];
  onClose: () => void;
  onAddChild: (parentId: string, type: (typeof NODE_TYPES)[number]) => void;
  onReparent: (nodeId: string, newParentId: string) => void;
  onUnparent: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onCopy: (nodeId: string) => void;
  onPasteNode: (parentNodeId: string) => void;
  onPasteLogic: (nodeId: string) => void;
  canPasteNode: boolean;
  canPasteLogic: boolean;
}) {
  const { t } = useTranslation('sceneGraph');
  const node = nodes.find((n) => n.id === menu.nodeId)!;
  const [showAddChild, setShowAddChild] = useState(false);
  const [showMoveInto, setShowMoveInto] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [grantees, setGrantees] = useState<string[]>([]);
  /** When set, sharing also grants edit (update/create/delete) rights. */
  const [shareWithEdit, setShareWithEdit] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Sharing targets: peers with a live mesh connection. Hidden entirely when
  // multiplayer is off or nobody is connected.
  const mpEnabled = useConnectionsStore((s) => s.enabled);
  const connectedIds = useConnectionsStore((s) => s.connectedIds);
  const nameById = useConnectionsStore((s) => s.nameById);
  const canShare = mpEnabled && !node.remote && node.kind !== 'remote_object';

  // Load the object's current grantees when the Share submenu opens.
  useEffect(() => {
    if (!showShare) return;
    let alive = true;
    void getObjectGrantees(menu.nodeId)
      .then((g) => alive && setGrantees(g))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [showShare, menu.nodeId]);

  const toggleShare = async (granteePeerId: string) => {
    const has = grantees.includes(granteePeerId);
    try {
      const { grantees: next } = has
        ? await unshareObject(menu.nodeId, granteePeerId)
        : await shareObject(menu.nodeId, granteePeerId, 'object', shareWithEdit);
      setGrantees(next);
    } catch {
      /* ignore */
    }
  };

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
        <span>{t('context.addChild')}</span>
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
            {NODE_TYPES.map((def) => (
              <div
                key={def.i18nKey}
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
                  onAddChild(menu.nodeId, def);
                  onClose();
                }}
              >
                {KIND_ICONS[def.kind] ?? '🔹'}{' '}
                {t(`kinds:node.${def.i18nKey}`, { defaultValue: def.label })}
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
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {t('context.moveInto')}
          <HelpButton
            topic="scene"
            anchor="hierarchy"
            tip={t('help.hierarchy')}
            size={11}
          />
        </span>
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

      {/* Share with (multiplayer) submenu */}
      {canShare && (
        <div
          style={itemStyle}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLDivElement).style.background = '#2a2a2a';
            setShowShare(true);
            setShowAddChild(false);
            setShowMoveInto(false);
          }}
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLDivElement).style.background =
              'transparent')
          }
        >
          <span>{t('context.shareWith')}</span>
          <span style={{ color: '#666' }}>▶</span>
          {showShare && (
            <div
              style={{
                position: 'absolute',
                left: '100%',
                top: 0,
                background: '#1e1e1e',
                border: '1px solid #3a3a3a',
                borderRadius: 6,
                minWidth: 180,
                maxHeight: 280,
                overflowY: 'auto',
                boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
              }}
            >
              {connectedIds.length === 0 && (
                <div style={{ ...itemStyle, color: '#888', cursor: 'default' }}>
                  {t('context.shareNobody')}
                </div>
              )}
              {connectedIds.length > 0 && (
                <div
                  style={{
                    ...itemStyle,
                    borderBottom: '1px solid #3a3a3a',
                    color: shareWithEdit ? '#4ade80' : '#aaa',
                  }}
                  onClick={() => setShareWithEdit((v) => !v)}
                  title={t('context.shareCanEditHint')}
                >
                  <span>{t('context.shareCanEdit')}</span>
                  <span>{shareWithEdit ? '☑' : '☐'}</span>
                </div>
              )}
              {connectedIds.length > 0 && (
                <div
                  style={itemStyle}
                  onMouseEnter={(e) =>
                    ((e.currentTarget as HTMLDivElement).style.background =
                      '#2a2a2a')
                  }
                  onMouseLeave={(e) =>
                    ((e.currentTarget as HTMLDivElement).style.background =
                      'transparent')
                  }
                  onClick={() => void toggleShare('*')}
                >
                  <span>{t('context.shareEveryone')}</span>
                  <span style={{ color: '#4ade80' }}>
                    {grantees.includes('*') ? '✓' : ''}
                  </span>
                </div>
              )}
              {connectedIds.map((peerId) => (
                <div
                  key={peerId}
                  style={itemStyle}
                  onMouseEnter={(e) =>
                    ((e.currentTarget as HTMLDivElement).style.background =
                      '#2a2a2a')
                  }
                  onMouseLeave={(e) =>
                    ((e.currentTarget as HTMLDivElement).style.background =
                      'transparent')
                  }
                  onClick={() => void toggleShare(peerId)}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {nameById[peerId] || peerId.slice(0, 12)}
                  </span>
                  <span style={{ color: '#4ade80' }}>
                    {grantees.includes(peerId) ? '✓' : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
          {t('context.unparent')}
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
        {t('context.copyNode')}
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
          {t('context.pasteNodeAsChild')}
        </div>
      )}

      {canPasteLogic && (
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
            onPasteLogic(menu.nodeId);
            onClose();
          }}
        >
          {t('context.pasteLogicHere')}
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
        {t('context.delete')}
      </div>
    </div>
  );
}

// ---------- Inline components section ----------
function BehaviorsSection({ nodeId }: { nodeId: string }) {
  const { t } = useTranslation('sceneGraph');
  /** Open context menu state. Null when no menu is currently up. */
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    comp: Behavior;
  } | null>(null);
  const behaviorsFor = useEditorStore((s) => s.behaviorsFor);
  const nodeKind = useEditorStore(
    (s) => s.nodes.find((n) => n.id === nodeId)?.kind ?? ''
  );
  const addBehavior = useEditorStore((s) => s.addBehavior);
  const updateBehavior = useEditorStore((s) => s.updateBehavior);
  const removeBehavior = useEditorStore((s) => s.removeBehavior);
  const selectedBehaviorId = useEditorStore((s) => s.selectedBehaviorId);
  const selectBehavior = useEditorStore((s) => s.selectBehavior);
  const vmcStatus = useEditorStore((s) => s.vmcStatus);
  const vmcTracking = useEditorStore((s) => s.vmcTracking);
  const behaviorKinds = useEditorStore((s) => s.behaviorKinds);
  const clipboardPayload = useEditorStore((s) => s.clipboardPayload);
  const setClipboard = useEditorStore((s) => s.setClipboard);
  const canPasteBehavior = clipboardPayload?.kind === 'node-component';
  const components = behaviorsFor(nodeId).filter(
    (c) => !CAMERA_EFFECT_KINDS.some((k) => k.kind === c.kind)
  );

  const handleCopyBehavior = async (comp: Behavior) => {
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

  const handlePasteBehavior = async () => {
    const payload = await pasteFromClipboard(clipboardPayload);
    if (!payload || payload.kind !== 'node-component') return;
    const comp: Behavior = {
      id: newBehaviorId(),
      nodeId,
      kind: payload.component.kind,
      enabled: payload.component.enabled,
      config: { ...payload.component.config },
    };
    addBehavior(comp);
    try {
      await api.createBehavior(nodeId, comp);
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

  const handleAdd = async (ct: (typeof behaviorKinds)[number]) => {
    setShowAddMenu(false);
    const comp: Behavior = {
      id: newBehaviorId(),
      nodeId,
      kind: ct.kind,
      enabled: true,
      config: { ...ct.defaultConfig },
    };
    addBehavior(comp);
    try {
      await api.createBehavior(nodeId, comp);
    } catch {
      /* non-fatal — state already updated locally */
    }
  };

  const handleToggleEnabled = async (comp: Behavior) => {
    const next = !comp.enabled;
    updateBehavior(comp.id, { enabled: next });
    try {
      await api.updateBehavior(comp.id, { enabled: next });
    } catch {
      /* non-fatal */
    }
  };

  const handleRemove = async (comp: Behavior) => {
    removeBehavior(comp.id);
    try {
      await api.deleteBehavior(comp.id);
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
          {t('behaviors.empty')}
        </div>
      )}
      {components.map((comp) => {
        const ct = behaviorKinds.find((c) => c.kind === comp.kind);
        const isSelected = selectedBehaviorId === comp.id;
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
            onClick={() => selectBehavior(isSelected ? null : comp.id)}
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
                  title={
                    isConnected ? t('vmc.clientConnected') : t('vmc.noClient')
                  }
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
                        ? t('vmc.trackingActive')
                        : t('vmc.trackingLost')
                      : t('vmc.notConnected')
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
              title={
                comp.enabled ? t('behaviors.disable') : t('behaviors.enable')
              }
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
          {t('behaviors.addButton')}
        </button>
        {canPasteBehavior && (
          <button
            title={t('behaviors.pasteTitle')}
            onClick={handlePasteBehavior}
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
            {t('behaviors.pasteButton')}
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
                ct: (typeof behaviorKinds)[number],
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
              const compatible = behaviorKinds.filter((ct) =>
                behaviorCompatibleWith(ct.applicableTo, nodeKind)
              );
              const incompatible = behaviorKinds.filter(
                (ct) => !behaviorCompatibleWith(ct.applicableTo, nodeKind)
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
                      {t('behaviors.other')}
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
              label: t('behaviors.ctxCopy'),
              onClick: () => void handleCopyBehavior(ctxMenu.comp),
            },
            {
              kind: 'item',
              label: ctxMenu.comp.enabled
                ? t('behaviors.disable')
                : t('behaviors.enable'),
              onClick: () => handleToggleEnabled(ctxMenu.comp),
            },
            { kind: 'divider' },
            {
              kind: 'item',
              label: t('behaviors.ctxRemove'),
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
  const { t } = useTranslation('sceneGraph');
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
      id: newBehaviorId(),
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
      id: newBehaviorId(),
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
        {t('effects.header')}
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
          {t('effects.empty')}
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
              {ek
                ? t(`kinds:effect.${ek.kind}.label`, { defaultValue: ek.label })
                : effect.kind}
            </span>
            <button
              title={
                effect.enabled ? t('effects.disable') : t('effects.enable')
              }
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
          {t('effects.addButton')}
        </button>
        {canPasteEffect && (
          <button
            title={t('effects.pasteTitle')}
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
            {t('effects.pasteButton')}
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
                    <div style={{ fontWeight: 500 }}>
                      {t(`kinds:effect.${ek.kind}.label`, {
                        defaultValue: ek.label,
                      })}
                    </div>
                    <div style={{ fontSize: 10, color: '#666', marginTop: 1 }}>
                      {t(`kinds:effect.${ek.kind}.description`, {
                        defaultValue: ek.description,
                      })}
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
              label: t('effects.ctxCopy'),
              onClick: () => void handleCopyEffect(ctxMenu.effect),
            },
            {
              kind: 'item',
              label: ctxMenu.effect.enabled
                ? t('effects.disable')
                : t('effects.enable'),
              onClick: () => handleToggleEnabled(ctxMenu.effect),
            },
            { kind: 'divider' },
            {
              kind: 'item',
              label: t('effects.ctxRemove'),
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
import type { LogicRecord, ScopedLogicRecord } from '../../api/client';

function LogicListPanel() {
  const { t } = useTranslation('sceneGraph');
  const { projectId } = useParams<{ projectId: string }>();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { activeLogicId, setActiveLogic } = useEditorStore();
  const [behaviorLogic, setBehaviorLogic] = useState<GraphDescriptor[]>([]);
  const [projectLogic, setProjectLogic] = useState<LogicRecord[]>([]);
  const [scopedLogic, setScopedLogic] = useState<ScopedLogicRecord[]>([]);
  const [scopedLogicOpen, setScopedLogicOpen] = useState(true);
  const [behaviorLogicOpen, setBehaviorLogicOpen] = useState(false);
  const clipboardPayload = useEditorStore((s) => s.clipboardPayload);
  const setClipboard = useEditorStore((s) => s.setClipboard);
  const canPasteLogic = clipboardPayload?.kind === 'graph';
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    graph: LogicRecord;
  } | null>(null);

  const refresh = () => {
    api
      .getSignalGraphs()
      .then(setBehaviorLogic)
      .catch(() => {});
    if (projectId) {
      api
        .getProjectLogic(projectId)
        .then(setProjectLogic)
        .catch(() => {});
      api
        .getProjectScopedLogic(projectId)
        .then(setScopedLogic)
        .catch(() => {});
    }
  };

  const handleToggleScopedEnabled = async (g: ScopedLogicRecord) => {
    try {
      const updated = await api.updateLogic(g.id, { enabled: !g.enabled });
      setScopedLogic((prev) =>
        prev.map((x) =>
          x.id === g.id ? { ...x, enabled: updated.enabled } : x
        )
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : t('logic.failToggle'));
    }
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
    const name = await prompt({
      title: t('logic.promptName'),
      defaultValue: t('logic.promptDefault'),
      confirmLabel: t('common:actions.create'),
    });
    if (!name?.trim()) return;
    try {
      const created = await api.createProjectLogic(projectId, name.trim());
      setProjectLogic((prev) => [...prev, created]);
      setActiveLogic(created.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : t('logic.failCreate'));
    }
  };

  const handleRename = async (g: LogicRecord) => {
    const name = await prompt({
      title: t('logic.promptRename'),
      defaultValue: g.name,
      confirmLabel: t('common:actions.rename'),
    });
    if (!name?.trim() || name.trim() === g.name) return;
    try {
      const updated = await api.updateLogic(g.id, { name: name.trim() });
      setProjectLogic((prev) => prev.map((x) => (x.id === g.id ? updated : x)));
    } catch (e) {
      alert(e instanceof Error ? e.message : t('logic.failRename'));
    }
  };

  const handleToggleEnabled = async (g: LogicRecord) => {
    try {
      const updated = await api.updateLogic(g.id, {
        enabled: !g.enabled,
      });
      setProjectLogic((prev) => prev.map((x) => (x.id === g.id ? updated : x)));
    } catch (e) {
      alert(e instanceof Error ? e.message : t('logic.failToggle'));
    }
  };

  const handleDelete = async (g: LogicRecord) => {
    if (
      !(await confirm({
        message: t('logic.confirmDelete', { name: g.name }),
        confirmLabel: t('common:actions.delete'),
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteLogic(g.id);
      setProjectLogic((prev) => prev.filter((x) => x.id !== g.id));
      if (activeLogicId === g.id) setActiveLogic(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : t('logic.failDelete'));
    }
  };

  const handleCopy = async (g: LogicRecord) => {
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
      const created = await api.createProjectLogic(projectId, payload.name);
      const updated = await api.updateLogic(created.id, {
        descriptor: payload.descriptor,
        enabled: true,
      });
      setProjectLogic((prev) => [...prev, updated]);
      setActiveLogic(updated.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : t('logic.failPaste'));
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
        <span>{t('logic.globalLogic')}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {canPasteLogic && (
            <button
              title={t('logic.pasteTitle')}
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
            title={t('logic.newTitle')}
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
      {projectLogic.length === 0 ? (
        <div
          style={{
            color: '#444',
            fontSize: 11,
            padding: '4px 12px 8px',
            fontStyle: 'italic',
          }}
        >
          {t('logic.noProjectGraphs')}
        </div>
      ) : (
        projectLogic.map((g) => {
          const active = g.id === activeLogicId;
          return (
            <div
              key={g.id}
              style={rowStyle(active)}
              onClick={() => setActiveLogic(active ? null : g.id)}
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
                  {t('logic.nodes', { count: g.descriptor.nodes.length })}{' '}
                  {g.enabled ? '' : t('logic.disabled')}
                </div>
              </div>
              <button
                title={g.enabled ? t('logic.disable') : t('logic.enable')}
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

      {/* Scoped graphs (scene-node / compose-layer owned). Listed here too —
          in addition to the inline lists in the scene/compose trees — so the
          Graphs tab can show the active scoped graph as selected and let the
          user switch between scoped graphs without leaving this tab. */}
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
        onClick={() => setScopedLogicOpen((v) => !v)}
      >
        <span style={{ color: '#555' }}>{scopedLogicOpen ? '▼' : '▶'}</span>
        <span>{t('logic.scopedLogic')}</span>
        <span style={{ color: '#444', fontWeight: 400 }}>
          ({scopedLogic.length})
        </span>
      </div>
      {scopedLogicOpen &&
        (scopedLogic.length === 0 ? (
          <div
            style={{
              color: '#444',
              fontSize: 11,
              padding: '4px 12px',
              fontStyle: 'italic',
            }}
          >
            {t('logic.noScopedGraphs')}
          </div>
        ) : (
          scopedLogic.map((g) => {
            const active = g.id === activeLogicId;
            return (
              <div
                key={g.id}
                style={rowStyle(active)}
                onClick={() => setActiveLogic(active ? null : g.id)}
              >
                <span style={{ opacity: g.enabled ? 0.9 : 0.35 }}>⊕</span>
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
                  <div
                    style={{
                      fontSize: 10,
                      color: '#555',
                      marginTop: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {g.ownerName} ·{' '}
                    {g.ownerKind === 'compose_layer'
                      ? t('logic.layer')
                      : t('logic.node')}
                    {g.enabled ? '' : ' ' + t('logic.disabled')}
                  </div>
                </div>
                <button
                  title={g.enabled ? t('logic.disable') : t('logic.enable')}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleScopedEnabled(g);
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
        ))}

      {/* Behavior-owned graphs (read-only) */}
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
        onClick={() => setBehaviorLogicOpen((v) => !v)}
      >
        <span style={{ color: '#555' }}>{behaviorLogicOpen ? '▼' : '▶'}</span>
        <span>{t('logic.behaviorLogic')}</span>
        <span style={{ color: '#444', fontWeight: 400 }}>
          ({behaviorLogic.length})
        </span>
      </div>
      {behaviorLogicOpen &&
        (behaviorLogic.length === 0 ? (
          <div
            style={{
              color: '#444',
              fontSize: 11,
              padding: '4px 12px',
              fontStyle: 'italic',
            }}
          >
            {t('logic.noBehaviorGraphs')}
          </div>
        ) : (
          behaviorLogic.map((g) => (
            <div
              key={g.id}
              style={rowStyle(g.id === activeLogicId)}
              onClick={() =>
                setActiveLogic(g.id === activeLogicId ? null : g.id)
              }
            >
              <span style={{ opacity: 0.6 }}>⬡</span>
              <div>
                <div style={{ fontWeight: 500 }}>{g.label}</div>
                <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>
                  {t('logic.nodes', { count: g.nodes.length })} ·{' '}
                  {t('logic.readOnly')}
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
              label: t('logic.ctxCopy'),
              onClick: () => void handleCopy(ctxMenu.graph),
            },
            {
              kind: 'item',
              label: t('logic.ctxRename'),
              onClick: () => handleRename(ctxMenu.graph),
            },
            {
              kind: 'item',
              label: ctxMenu.graph.enabled
                ? t('logic.disable')
                : t('logic.enable'),
              onClick: () => handleToggleEnabled(ctxMenu.graph),
            },
            { kind: 'divider' },
            {
              kind: 'item',
              label: t('logic.ctxDelete'),
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
  const { t } = useTranslation('sceneGraph');
  const { projectId } = useParams<{ projectId: string }>();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const {
    activeSceneId,
    scenes,
    nodes: allNodes,
    selectedNodeId,
    selectNode,
    deleteNode: storeDeleteNode,
    updateNode: storeUpdateNode,
    behaviors,
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
  const canPasteLogicClipboard = clipboardPayload?.kind === 'graph';
  // Collapsed scene roots (scene id set).
  const [collapsedScenes, setCollapsedScenes] = useState<Set<string>>(
    new Set()
  );
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());
  const [collapsedBones, setCollapsedBones] = useState<Set<string>>(new Set()); // key: `${nodeId}:${boneName}`
  const [expandedBehaviors, setExpandedBehaviors] = useState<Set<string>>(
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

  const toggleBehaviors = (id: string) =>
    setExpandedBehaviors((s) => {
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
    const name = await prompt({
      title: t('scenes.promptName'),
      defaultValue: t('scenes.promptDefault'),
      confirmLabel: t('common:actions.create'),
    });
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
      alert(e instanceof Error ? e.message : t('scenes.failCreate'));
    }
  };

  const handleDeleteScene = async (scene: (typeof scenes)[number]) => {
    if (
      !(await confirm({
        message: t('scenes.confirmDelete', { name: scene.name }),
        confirmLabel: t('common:actions.delete'),
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteScene(scene.id);
      useEditorStore.getState().removeScene(scene.id);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('scenes.failDelete'));
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
      alert(e instanceof Error ? e.message : t('nodes.failCreate'));
    }
  };

  const handleDelete = async (nodeId: string) => {
    const node = sceneNodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (
      !(await confirm({
        message: t('nodes.confirmDelete', { name: node.name }),
        confirmLabel: t('common:actions.delete'),
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteNode(nodeId);
      storeDeleteNode(nodeId);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('nodes.failDelete'));
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
      alert(e instanceof Error ? e.message : t('nodes.failCopy'));
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
      alert(e instanceof Error ? e.message : t('nodes.failPaste'));
    }
  };

  const handlePasteLogicAtNode = async (nodeId: string) => {
    const payload = await pasteFromClipboard(clipboardPayload);
    if (!payload || payload.kind !== 'graph') return;
    try {
      const created = await api.createNodeLogic(nodeId, payload.name);
      await api.updateLogic(created.id, {
        descriptor: payload.descriptor,
        enabled: true,
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : t('logic.failPaste'));
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
      alert(e instanceof Error ? e.message : t('nodes.failMove'));
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

  const renderNode = (node: StageObject, depth = 0) => {
    const isSelected = selectedNodeId === node.id;
    const isHidden = node.hidden ?? false;
    // Projected (remote) inner nodes are hidden from the tree — only the opaque
    // remote_object container they live under is shown + editable. Exception
    // (Phase 6): a projected subtree the local user has *edit* rights on is shown
    // + selectable, so its nodes can be edited (commits route to the owner).
    const allChildren = nodes.filter(
      (n) => n.parentId === node.id && (!n.remote || isWritableRemote(n))
    );
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
    const showBehaviors = expandedBehaviors.has(node.id);
    const compCount = behaviors.filter(
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

          <span
            style={{
              fontSize: 16,
              flexShrink: 0,
              marginRight: 6,
              alignSelf: 'center',
            }}
          >
            {icon}
          </span>
          {/* Two-row body: name on top, action controls beneath. Keeping the
              actions on their own row stops them from crowding or being
              clipped by long node names. */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                overflow: 'hidden',
              }}
            >
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {node.name}
              </span>
              {/* Opaque container for a peer's shared object: editable
                  placement, but its contents live on the owner's server
                  (read-only internals). */}
              {node.kind === 'remote_object' && (
                <span
                  title={t('remote.tip')}
                  style={{ fontSize: 11, flexShrink: 0, opacity: 0.7 }}
                >
                  📡
                </span>
              )}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {/* Bones toggle — avatar/model only, shown once VRM is loaded */}
              {bones && (
                <button
                  title={showBones ? t('bones.collapse') : t('bones.expand')}
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
                title={
                  showBehaviors ? t('components.hide') : t('components.show')
                }
                style={{
                  background: 'none',
                  border: 'none',
                  color: showBehaviors
                    ? '#4a8'
                    : compCount > 0
                      ? '#666'
                      : '#333',
                  cursor: 'pointer',
                  fontSize: 11,
                  padding: '0 3px',
                  flexShrink: 0,
                  lineHeight: 1,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleBehaviors(node.id);
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
                        ? t('camera.previewDisable')
                        : t('camera.previewEnable')
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
                      title={t('camera.openViewer')}
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
                title={isHidden ? t('visibility.show') : t('visibility.hide')}
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
                  api
                    .updateNode(node.id, { hidden: !isHidden })
                    .catch(() => {});
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
                title={t('nodes.deleteTitle')}
              >
                🗑
              </button>
            </div>
          </div>
        </div>

        {/* Inline components section */}
        {showBehaviors && (
          <div style={{ paddingLeft: 8 + depth * 16 }}>
            <BehaviorsSection nodeId={node.id} />
            {node.kind === 'camera' && (
              <CameraEffectsSection nodeId={node.id} />
            )}
            <ClipsSection owner={{ kind: 'node', id: node.id }} />
            <LogicSection owner={{ kind: 'node', id: node.id }} />
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
                          void confirm({
                            message: t('bones.pasteConfirm', {
                              bone: formatBoneName(boneName),
                            }),
                          }).then((yes) => {
                            if (yes)
                              void handlePasteNodeAsChild(node.id, boneName);
                          });
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
      (n) =>
        n.rootSceneNodeId === scene.id &&
        !n.parentId &&
        n.kind !== 'scene' &&
        !n.remote
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
            title={t('nodes.addNodeTitle')}
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
            title={t('nodes.deleteScene')}
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
            <LogicSection owner={{ kind: 'node', id: scene.id }} />
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
              {t('scenes.emptyScene')}
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
          {t('tabs.stage')}
        </button>
        <button
          style={tabStyle(dockTab === 'compose')}
          onClick={() => setDockTab('compose')}
          title={t('tabs.compose')}
        >
          {t('tabs.compose')}
        </button>
        <button
          style={tabStyle(dockTab === 'graphs')}
          onClick={() => setDockTab('graphs')}
        >
          {t('tabs.logic')}
        </button>
      </div>

      {dockTab === 'graphs' && <LogicListPanel />}
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
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              {t('scenes.header')}
              <HelpButton
                topic="scene"
                anchor="nodes"
                tip={t('help.sceneNodes')}
                size={12}
              />
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
              title={t('scenes.newButton_title')}
            >
              {t('scenes.newButton')}
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
                {t('scenes.empty')}
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
              onPasteLogic={(id) => void handlePasteLogicAtNode(id)}
              canPasteNode={canPasteSceneNodeClipboard}
              canPasteLogic={canPasteLogicClipboard}
            />
          )}
        </>
      )}
    </div>
  );
}
