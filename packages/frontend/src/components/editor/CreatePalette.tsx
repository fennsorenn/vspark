import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../store/editorStore';
import {
  NODE_KIND_DEFS,
  LAYER_KIND_DEFS,
  createSceneNode,
  createLayer,
  nextNodeName,
  type NodeKindDef,
  type LayerKindDef,
} from './createKinds';
import { DND_CREATE_NODE, DND_CREATE_LAYER } from './dnd';
import { HelpButton } from '../../help/HelpButton';

const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
  gap: 8,
};

const tile: React.CSSProperties = {
  background: '#1e1e1e',
  border: '1px solid #2a2a2a',
  borderRadius: 6,
  padding: '12px 10px',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  cursor: 'pointer',
  color: '#e0e0e0',
  fontSize: 13,
  textAlign: 'left',
};

const hintStyle: React.CSSProperties = {
  color: '#555',
  fontSize: 12,
  textAlign: 'center',
  paddingTop: 12,
};

function Tile({
  icon,
  label,
  onClick,
  onDragStart,
  tileTitle,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  tileTitle: string;
}) {
  return (
    <button
      style={tile}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onClick={onClick}
      title={tileTitle}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#2563eb')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = '#2a2a2a')}
    >
      <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }}>{icon}</span>
      <span style={{ fontWeight: 500 }}>{label}</span>
    </button>
  );
}

/** Bottom-dock "Create" tab. Shows node kinds while the left dock is on the
 *  Scene tree, or compose-layer kinds while it's on the Compose tree. Clicking
 *  a tile creates the entity with a deduplicated default name and selects it.
 *  Replaces the old per-scene "+" dropdowns. */
export function CreatePalette() {
  const { t } = useTranslation('sceneGraph');
  const leftTab = useEditorStore((s) => s.leftTab);
  const activeSceneId = useEditorStore((s) => s.activeSceneId);
  const activeComposeSceneId = useEditorStore((s) => s.activeComposeSceneId);
  const scenes = useEditorStore((s) => s.scenes);
  const composeScenes = useEditorStore((s) => s.composeScenes);
  const selectNode = useEditorStore((s) => s.selectNode);
  const setSceneSelected = useEditorStore((s) => s.setSceneSelected);
  const requestFocusName = useEditorStore((s) => s.requestFocusName);

  const composeMode = leftTab === 'compose';

  const handleAddNode = async (def: NodeKindDef) => {
    if (!activeSceneId) return;
    const name = nextNodeName(def, activeSceneId);
    try {
      const node = await createSceneNode(activeSceneId, def, null, name);
      selectNode(node.id);
      setSceneSelected(false);
      requestFocusName();
    } catch (e) {
      alert(e instanceof Error ? e.message : t('palette.failCreate'));
    }
  };

  const handleAddLayer = (def: LayerKindDef) => {
    if (!activeComposeSceneId) return;
    void createLayer(activeComposeSceneId, def.kind);
  };

  if (composeMode) {
    const target = composeScenes.find((s) => s.id === activeComposeSceneId);
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {!activeComposeSceneId ? (
          <div style={hintStyle}>
            {t('palette.noComposeScene')}
          </div>
        ) : (
          <>
            <div style={{ color: '#777', fontSize: 11, marginBottom: 8 }}>
              {t('palette.addLayerTo')}{' '}
              <span style={{ color: '#aaa' }}>{target?.name ?? t('palette.scene')}</span>
            </div>
            <div style={grid}>
              {LAYER_KIND_DEFS.map((def) => (
                <Tile
                  key={def.kind}
                  icon={def.icon}
                  label={t(`kinds:layer.${def.kind}`, { defaultValue: def.label })}
                  tileTitle={t('palette.tileTitle')}
                  onClick={() => handleAddLayer(def)}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData(
                      DND_CREATE_LAYER,
                      JSON.stringify({ kind: def.kind })
                    );
                  }}
                />
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  const target = scenes.find((s) => s.id === activeSceneId);
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
      {!activeSceneId ? (
        <div style={hintStyle}>
          {t('palette.noScene')}
        </div>
      ) : (
        <>
          <div style={{ color: '#777', fontSize: 11, marginBottom: 8 }}>
            {t('palette.addTo')}{' '}
            <span style={{ color: '#aaa' }}>{target?.name ?? t('palette.scene')}</span>
          </div>
          <div style={grid}>
            {NODE_KIND_DEFS.map((def) => {
              const helpProps =
                def.kind === 'avatar'
                  ? { helpTopic: 'avatar', helpAnchor: 'loading', helpTip: t('help.avatar') }
                  : def.kind === 'camera'
                    ? { helpTopic: 'scene', helpAnchor: 'cameras', helpTip: t('help.camera') }
                    : def.kind === 'light'
                      ? { helpTopic: 'scene', helpAnchor: 'lights', helpTip: t('help.lights') }
                      : null;
              return (
                <div key={def.i18nKey} style={{ position: 'relative' }}>
                  <Tile
                    icon={def.icon}
                    label={t(`kinds:node.${def.i18nKey}`, { defaultValue: def.label })}
                    tileTitle={t('palette.tileTitle')}
                    onClick={() => handleAddNode(def)}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'copy';
                      e.dataTransfer.setData(DND_CREATE_NODE, JSON.stringify(def));
                    }}
                  />
                  {helpProps && (
                    <HelpButton
                      topic={helpProps.helpTopic}
                      anchor={helpProps.helpAnchor}
                      tip={helpProps.helpTip}
                      size={13}
                      style={{ position: 'absolute', top: 6, right: 6 }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
