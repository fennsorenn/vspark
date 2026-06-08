import { type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useEditorStore,
  type ComposeLayerRecord,
} from '../../store/editorStore';
import { api } from '../../api/client';
import type { ComposeAnchorH, ComposeAnchorV } from '../../api/client';
import { useTrackClipRecorder } from '../../hooks/useTrackClipRecorder';
import { NumInput, VecInput, SliderInput } from './numericInputs';
import { CSS_BLEND_MODES, readChroma } from './videoFx';
import { HelpButton } from '../../help/HelpButton';
import { Toggle } from '../Toggle';

// The old `numInput` / `NumberField` / `KfBtn` helpers were removed when the
// numeric controls were unified — see ./numericInputs.tsx.

const textInput: CSSProperties = {
  width: '100%',
  background: '#2a2a2a',
  border: '1px solid #3a3a3a',
  color: '#e0e0e0',
  borderRadius: 4,
  padding: '5px 8px',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
};

const sectionHeader: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 8,
  marginTop: 16,
};

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 6,
};

const label: CSSProperties = {
  fontSize: 12,
  color: '#bbb',
  width: 56,
  flexShrink: 0,
};

const select: CSSProperties = {
  background: '#2a2a2a',
  border: '1px solid #3a3a3a',
  color: '#e0e0e0',
  borderRadius: 4,
  padding: '3px 6px',
  fontSize: 12,
  outline: 'none',
  // Fill the control column so selects share consistent left/right edges with
  // the other fields instead of sizing to their text. In rows that hold two
  // selects (units, anchor) each one takes an equal half.
  flex: 1,
  minWidth: 0,
  boxSizing: 'border-box',
};

export function ComposeLayerProperties({
  layer,
}: {
  layer: ComposeLayerRecord;
}) {
  const { t } = useTranslation('compose');
  const assets = useEditorStore((s) => s.assets);
  const updateLayerLocal = useEditorStore((s) => s.updateComposeLayerLocal);
  const flashBottomTab = useEditorStore((s) => s.flashBottomTab);
  const nodes = useEditorStore((s) => s.nodes);
  const { canRecord, recordKeyframe, recordKeyframes } = useTrackClipRecorder();

  const cameraNode = layer.cameraNodeId
    ? nodes.find((n) => n.id === layer.cameraNodeId)
    : null;
  const scopeLabel = layer.cameraNodeId
    ? t('properties.scopeCamera', {
        name: cameraNode?.name ?? t('properties.scopeUnknown'),
      })
    : t('properties.scopeAllCameras');

  const commit = (patch: Partial<ComposeLayerRecord>) => {
    updateLayerLocal(layer.id, patch);
    api.updateComposeLayer(layer.id, patch).catch(() => {});
  };

  // Mirror the 3D media nodes' "Pick…" affordance: jump to + flash the matching
  // bottom-dock asset tab, where the asset's "Apply to <layer>" button sets the
  // source of this selected layer.
  const pickBtn = (tab: Parameters<typeof flashBottomTab>[0]) => (
    <button
      onClick={() => flashBottomTab(tab)}
      title={t('properties.pickBtnTitle')}
      style={{
        marginLeft: 8,
        background: '#2a2a2a',
        border: '1px solid #3a3a3a',
        color: '#9cf',
        borderRadius: 4,
        padding: '1px 6px',
        cursor: 'pointer',
        fontSize: 10,
      }}
    >
      {t('properties.pickBtn')}
    </button>
  );

  // The compose scene this layer belongs to defines the % reference frame.
  const composeScenes = useEditorStore((s) => s.composeScenes);
  const parentScene = composeScenes.find(
    (cs) => cs.id === layer.rootComposeSceneId
  );
  const frameW = parentScene?.width ?? 1920;
  const frameH = parentScene?.height ?? 1080;

  type UnitKey = 'xUnit' | 'yUnit' | 'widthUnit' | 'heightUnit';
  const unitOf = (key: UnitKey): 'px' | '%' =>
    layer.config[key] === '%' ? '%' : 'px';

  /** Toggle a field's unit, converting the stored value so the on-screen size
   *  stays the same (relative to the compose frame). */
  const setUnit = (
    field: 'x' | 'y' | 'width' | 'height',
    unitKey: UnitKey,
    unit: 'px' | '%'
  ) => {
    const current = unitOf(unitKey);
    if (current === unit) return;
    const basis = field === 'x' || field === 'width' ? frameW : frameH;
    const value = layer[field];
    const converted =
      unit === '%'
        ? Math.round(((value / basis) * 100 + Number.EPSILON) * 100) / 100
        : Math.round((value / 100) * basis);
    commit({
      [field]: converted,
      config: { ...layer.config, [unitKey]: unit },
    } as Partial<ComposeLayerRecord>);
  };

  // Compact unit picker rendered inside a numeric field (right edge), so units
  // live on the value row instead of a separate line. Styled as a small pill
  // with a caret so it reads as an interactive dropdown rather than static text.
  const unitSelectInline = (
    field: 'x' | 'y' | 'width' | 'height',
    unitKey: UnitKey
  ) => (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        flexShrink: 0,
      }}
    >
      <select
        value={unitOf(unitKey)}
        onChange={(e) => setUnit(field, unitKey, e.target.value as 'px' | '%')}
        title={t('properties.unitTitle')}
        style={{
          appearance: 'none',
          WebkitAppearance: 'none',
          MozAppearance: 'none',
          background: '#ffffff14',
          border: '1px solid #ffffff24',
          borderRadius: 3,
          color: '#bbb',
          fontSize: 10,
          outline: 'none',
          cursor: 'pointer',
          padding: '1px 13px 1px 5px',
          textAlignLast: 'center',
        }}
      >
        <option value="px">px</option>
        <option value="%">%</option>
      </select>
      <span
        style={{
          position: 'absolute',
          right: 4,
          top: '50%',
          transform: 'translateY(-50%)',
          pointerEvents: 'none',
          fontSize: 7,
          color: '#999',
        }}
      >
        ▾
      </span>
    </span>
  );

  // One of the four layer corners. Highlights the active anchor and sets both
  // axes at once.
  const anchorBtn = (
    h: ComposeAnchorH,
    v: ComposeAnchorV,
    icon: string,
    title: string
  ) => {
    const active = layer.anchorH === h && layer.anchorV === v;
    return (
      <button
        type="button"
        onClick={() => commit({ anchorH: h, anchorV: v })}
        title={title}
        style={{
          width: 26,
          height: 22,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: active ? '#2a4a6a' : '#2a2a2a',
          border: `1px solid ${active ? '#5a8acc' : '#3a3a3a'}`,
          color: active ? '#cfe3ff' : '#888',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 13,
          lineHeight: 1,
          padding: 0,
        }}
      >
        {icon}
      </button>
    );
  };

  const compatibleAssets = assets.filter((a) => {
    if (layer.kind === 'image') return a.kind === 'image';
    if (layer.kind === 'video') return a.mimeType.startsWith('video/');
    if (layer.kind === 'audio') return a.mimeType.startsWith('audio/');
    return false;
  });

  const locked = layer.config.locked === true;
  const locked3d = layer.config.locked3d === true;
  const toggleLock = (key: 'locked' | 'locked3d') =>
    commit({ config: { ...layer.config, [key]: !layer.config[key] } });

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 14,
        }}
      >
        <span style={{ fontSize: 18 }}>
          {layer.kind === 'image'
            ? '🖼'
            : layer.kind === 'video'
              ? '🎞'
              : layer.kind === 'camera_view'
                ? '📷'
                : layer.kind === 'group'
                  ? '📁'
                  : layer.kind === 'scene_include'
                    ? '🎬'
                    : '🌐'}
        </span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{layer.name}</div>
          <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>
            {scopeLabel}
          </div>
        </div>
      </div>

      <div style={sectionHeader}>{t('properties.sectionLock')}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 12,
            color: '#bbb',
            cursor: 'pointer',
          }}
        >
          <Toggle checked={locked} onChange={() => toggleLock('locked')} />
          {t('properties.lockLayer2d')}
        </label>
        {layer.kind === 'camera_view' && (
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 12,
              color: '#bbb',
              cursor: 'pointer',
            }}
          >
            <Toggle
              checked={locked3d}
              onChange={() => toggleLock('locked3d')}
            />
            {t('properties.lockLayer3d')}
          </label>
        )}
      </div>

      <div
        style={{
          ...sectionHeader,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {t('properties.sectionName')}
        <HelpButton
          topic="compose"
          anchor="layers"
          tip={t('help.layerProperties')}
        />
      </div>
      <input
        type="text"
        value={layer.name}
        onChange={(e) => updateLayerLocal(layer.id, { name: e.target.value })}
        onBlur={(e) =>
          api
            .updateComposeLayer(layer.id, { name: e.target.value })
            .catch(() => {})
        }
        style={textInput}
      />

      {layer.kind === 'camera_view' && (
        <>
          <div style={sectionHeader}>{t('properties.sectionCamera')}</div>
          <select
            value={layer.cameraNodeId ?? ''}
            onChange={(e) =>
              commit({
                cameraNodeId: e.target.value || null,
              } as Partial<ComposeLayerRecord>)
            }
            style={{
              ...textInput,
              background: '#1a1a1a',
              color: '#ccc',
              cursor: 'pointer',
            }}
          >
            <option value="">{t('properties.optionNone')}</option>
            {nodes
              .filter((n) => n.kind === 'camera')
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
          </select>
        </>
      )}

      {layer.kind === 'scene_include' && (
        <>
          <div style={sectionHeader}>
            {t('properties.sectionIncludedScene')}
          </div>
          <select
            value={(layer.config.includeSceneId as string | undefined) ?? ''}
            onChange={(e) =>
              commit({
                config: {
                  ...layer.config,
                  includeSceneId: e.target.value || undefined,
                },
              })
            }
            style={{
              ...textInput,
              background: '#1a1a1a',
              color: '#ccc',
              cursor: 'pointer',
            }}
          >
            <option value="">{t('properties.optionNone')}</option>
            {composeScenes
              .filter((cs) => cs.id !== layer.rootComposeSceneId)
              .map((cs) => (
                <option key={cs.id} value={cs.id}>
                  {cs.name}
                </option>
              ))}
          </select>
        </>
      )}

      <div style={sectionHeader}>{t('properties.sectionPosition')}</div>
      <VecInput
        values={[layer.x, layer.y]}
        labels={['X', 'Y']}
        step={1}
        axisSuffix={(axis) =>
          unitSelectInline(
            axis === 0 ? 'x' : 'y',
            axis === 0 ? 'xUnit' : 'yUnit'
          )
        }
        onChange={(_next, axis) => {
          // Suppress any active clip override so the typed value isn't masked.
          const paramPath = axis === 0 ? 'x' : 'y';
          useEditorStore
            .getState()
            .suppressOverride('compose_layer', layer.id, paramPath);
        }}
        onCommit={(next, axis) =>
          commit(axis === 0 ? { x: next[0] } : { y: next[1] })
        }
        canRecord={canRecord}
        onSetAxisKeyframe={(axis, value) => {
          const paramPath = axis === 0 ? 'x' : 'y';
          return recordKeyframe({
            targetKind: 'compose_layer',
            targetId: layer.id,
            paramPath,
            value,
          });
        }}
        onSetGroupKeyframe={() =>
          recordKeyframes([
            {
              targetKind: 'compose_layer',
              targetId: layer.id,
              paramPath: 'x',
              value: layer.x,
            },
            {
              targetKind: 'compose_layer',
              targetId: layer.id,
              paramPath: 'y',
              value: layer.y,
            },
          ])
        }
      />
      <div style={row}>
        <span style={label}>{t('properties.labelAnchor')}</span>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, auto)',
            gap: 3,
          }}
        >
          {anchorBtn('left', 'top', '◰', t('properties.anchorTopLeft'))}
          {anchorBtn('right', 'top', '◳', t('properties.anchorTopRight'))}
          {anchorBtn('left', 'bottom', '◱', t('properties.anchorBottomLeft'))}
          {anchorBtn('right', 'bottom', '◲', t('properties.anchorBottomRight'))}
        </div>
      </div>

      <div style={sectionHeader}>{t('properties.sectionSize')}</div>
      <VecInput
        values={[layer.width, layer.height]}
        labels={['W', 'H']}
        step={1}
        min={[0, 0]}
        axisSuffix={(axis) =>
          unitSelectInline(
            axis === 0 ? 'width' : 'height',
            axis === 0 ? 'widthUnit' : 'heightUnit'
          )
        }
        onCommit={(next, axis) =>
          commit(axis === 0 ? { width: next[0] } : { height: next[1] })
        }
      />

      <div style={sectionHeader}>{t('properties.sectionRotation')}</div>
      <NumInput
        value={layer.rotation}
        step={1}
        prefix="∠"
        suffix="°"
        onChange={() =>
          useEditorStore
            .getState()
            .suppressOverride('compose_layer', layer.id, 'rotation')
        }
        onCommit={(v) => commit({ rotation: v })}
        canRecord={canRecord}
        onSetKeyframe={(value) =>
          recordKeyframe({
            targetKind: 'compose_layer',
            targetId: layer.id,
            paramPath: 'rotation',
            value,
          })
        }
        style={{ width: 110 }}
      />

      <div style={sectionHeader}>{t('properties.sectionVisibility')}</div>
      <div style={row}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: '#bbb',
          }}
        >
          <Toggle
            checked={layer.visible}
            onChange={(v) => commit({ visible: v })}
          />
          {t('properties.labelVisible')}
        </label>
      </div>
      <div style={row}>
        <span style={label}>{t('properties.labelOpacity')}</span>
        <SliderInput
          value={
            typeof layer.config.opacity === 'number' ? layer.config.opacity : 1
          }
          min={0}
          max={1}
          step={0.01}
          precision={2}
          onChange={(o) => commit({ config: { ...layer.config, opacity: o } })}
          style={{ flex: 1 }}
        />
      </div>
      <div style={row}>
        <span style={label}>{t('properties.labelBlend')}</span>
        <select
          value={(layer.config.blendMode as string | undefined) ?? 'normal'}
          onChange={(e) =>
            commit({ config: { ...layer.config, blendMode: e.target.value } })
          }
          style={select}
        >
          {CSS_BLEND_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {(layer.kind === 'image' || layer.kind === 'video') && (
        <>
          <div
            style={{ ...sectionHeader, display: 'flex', alignItems: 'center' }}
          >
            {layer.kind === 'image'
              ? t('properties.sectionImageAsset')
              : t('properties.sectionVideoAsset')}
            {pickBtn(layer.kind === 'image' ? 'images' : 'videos')}
          </div>
          <select
            value={layer.assetId ?? ''}
            onChange={(e) => commit({ assetId: e.target.value || null })}
            style={{ ...select, width: '100%' }}
          >
            <option value="">{t('properties.optionNoneAsset')}</option>
            {compatibleAssets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <div style={{ ...row, marginTop: 6 }}>
            <span style={label}>{t('properties.labelFit')}</span>
            <select
              value={(layer.config.objectFit as string | undefined) ?? 'cover'}
              onChange={(e) =>
                commit({
                  config: { ...layer.config, objectFit: e.target.value },
                })
              }
              style={select}
            >
              <option value="cover">cover</option>
              <option value="contain">contain</option>
              <option value="fill">fill</option>
            </select>
          </div>
        </>
      )}

      {layer.kind === 'video' && (
        <>
          <div style={sectionHeader}>{t('properties.sectionPlayback')}</div>
          <div style={row}>
            <span style={label}>{t('properties.labelAutoplay')}</span>
            <Toggle
              checked={layer.config.autoplay !== false}
              onChange={(v) =>
                commit({
                  config: { ...layer.config, autoplay: v },
                })
              }
            />
          </div>
          <div style={row}>
            <span style={label}>{t('properties.labelLoop')}</span>
            <Toggle
              checked={layer.config.loop !== false}
              onChange={(v) =>
                commit({
                  config: { ...layer.config, loop: v },
                })
              }
            />
          </div>
          <div style={row}>
            <span style={label}>{t('properties.labelOnEnd')}</span>
            <select
              value={(layer.config.onEnd as string | undefined) ?? 'freeze'}
              onChange={(e) =>
                commit({
                  config: { ...layer.config, onEnd: e.target.value },
                })
              }
              style={select}
            >
              <option value="freeze">{t('properties.onEndFreeze')}</option>
              <option value="hide">{t('properties.onEndHide')}</option>
            </select>
          </div>
          <div style={row}>
            <span style={label}>{t('properties.labelMuted')}</span>
            <Toggle
              checked={layer.config.muted !== false}
              onChange={(v) =>
                commit({
                  config: { ...layer.config, muted: v },
                })
              }
            />
          </div>
          <div style={row}>
            <span style={label}>{t('properties.labelVolume')}</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={
                typeof layer.config.volume === 'number'
                  ? layer.config.volume
                  : 1
              }
              onChange={(e) =>
                commit({
                  config: {
                    ...layer.config,
                    volume: parseFloat(e.target.value),
                  },
                })
              }
              style={textInput}
            />
          </div>
          {(() => {
            const ck = readChroma(
              layer.config.chromaKey as Record<string, unknown>
            );
            const saveCk = (p: Partial<typeof ck>) =>
              commit({
                config: {
                  ...layer.config,
                  chromaKey: { ...ck, ...p },
                },
              });
            return (
              <>
                <div style={sectionHeader}>
                  {t('properties.sectionChromaKey')}
                </div>
                <div style={row}>
                  <span style={label}>{t('properties.labelEnabled')}</span>
                  <Toggle
                    checked={ck.enabled}
                    onChange={(v) => saveCk({ enabled: v })}
                  />
                </div>
                {ck.enabled && (
                  <>
                    <div style={row}>
                      <span style={label}>{t('properties.labelKeyColor')}</span>
                      <input
                        type="color"
                        value={ck.color}
                        onChange={(e) => saveCk({ color: e.target.value })}
                        style={{
                          flex: 1,
                          width: '100%',
                          minWidth: 0,
                          height: 24,
                          background: 'none',
                          border: '1px solid #3a3a3a',
                          borderRadius: 4,
                          cursor: 'pointer',
                          padding: 2,
                          boxSizing: 'border-box',
                        }}
                      />
                    </div>
                    <div style={row}>
                      <span style={label}>
                        {t('properties.labelSimilarity')}
                      </span>
                      <SliderInput
                        value={ck.similarity}
                        min={0}
                        max={1}
                        step={0.01}
                        precision={2}
                        onChange={(v) => saveCk({ similarity: v })}
                        style={{ flex: 1 }}
                      />
                    </div>
                    <div style={row}>
                      <span style={label}>
                        {t('properties.labelSmoothness')}
                      </span>
                      <SliderInput
                        value={ck.smoothness}
                        min={0}
                        max={1}
                        step={0.01}
                        precision={2}
                        onChange={(v) => saveCk({ smoothness: v })}
                        style={{ flex: 1 }}
                      />
                    </div>
                    <div style={row}>
                      <span style={label}>{t('properties.labelSpill')}</span>
                      <SliderInput
                        value={ck.spill}
                        min={0}
                        max={1}
                        step={0.01}
                        precision={2}
                        onChange={(v) => saveCk({ spill: v })}
                        style={{ flex: 1 }}
                      />
                    </div>
                  </>
                )}
              </>
            );
          })()}
        </>
      )}

      {layer.kind === 'audio' && (
        <>
          <div
            style={{ ...sectionHeader, display: 'flex', alignItems: 'center' }}
          >
            {t('properties.sectionAudioAsset')}
            {pickBtn('audio')}
          </div>
          <select
            value={layer.assetId ?? ''}
            onChange={(e) => commit({ assetId: e.target.value || null })}
            style={{ ...select, width: '100%' }}
          >
            <option value="">{t('properties.optionNoneAsset')}</option>
            {compatibleAssets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <div style={sectionHeader}>{t('properties.sectionPlayback')}</div>
          <div style={row}>
            <span style={label}>{t('properties.labelAutoplay')}</span>
            <Toggle
              checked={layer.config.autoplay === true}
              onChange={(v) =>
                commit({
                  config: { ...layer.config, autoplay: v },
                })
              }
            />
          </div>
          <div style={row}>
            <span style={label}>{t('properties.labelLoop')}</span>
            <Toggle
              checked={layer.config.loop === true}
              onChange={(v) => commit({ config: { ...layer.config, loop: v } })}
            />
          </div>
          <div style={row}>
            <span style={label}>{t('properties.labelMuted')}</span>
            <Toggle
              checked={layer.config.muted === true}
              onChange={(v) =>
                commit({ config: { ...layer.config, muted: v } })
              }
            />
          </div>
          <div style={row}>
            <span style={label}>{t('properties.labelVolume')}</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={
                typeof layer.config.volume === 'number'
                  ? layer.config.volume
                  : 1
              }
              onChange={(e) =>
                commit({
                  config: {
                    ...layer.config,
                    volume: parseFloat(e.target.value),
                  },
                })
              }
              style={textInput}
            />
          </div>
        </>
      )}

      {layer.kind === 'text' && (
        <>
          <div style={sectionHeader}>{t('properties.sectionText')}</div>
          <textarea
            value={(layer.config.content as string | undefined) ?? ''}
            onChange={(e) =>
              updateLayerLocal(layer.id, {
                config: { ...layer.config, content: e.target.value },
              })
            }
            onBlur={(e) =>
              api
                .updateComposeLayer(layer.id, {
                  config: { ...layer.config, content: e.target.value },
                })
                .catch(() => {})
            }
            placeholder={t('properties.textPlaceholder')}
            rows={3}
            style={{ ...textInput, resize: 'vertical', fontFamily: 'inherit' }}
          />
          <div style={{ ...row, marginTop: 6 }}>
            <span style={label}>{t('properties.labelFontSize')}</span>
            <NumInput
              value={(layer.config.fontSize as number | undefined) ?? 16}
              step={1}
              min={1}
              suffix="px"
              onCommit={(v) =>
                commit({ config: { ...layer.config, fontSize: v } })
              }
              style={{ flex: 1, minWidth: 0 }}
            />
          </div>
          <div style={row}>
            <span style={label}>{t('properties.labelColor')}</span>
            <input
              type="color"
              value={(layer.config.color as string | undefined) ?? '#ffffff'}
              onChange={(e) =>
                commit({ config: { ...layer.config, color: e.target.value } })
              }
              style={{
                flex: 1,
                width: '100%',
                minWidth: 0,
                height: 24,
                background: 'none',
                border: '1px solid #3a3a3a',
                borderRadius: 4,
                cursor: 'pointer',
                padding: 2,
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div style={row}>
            <span style={label}>{t('properties.labelWeight')}</span>
            <select
              value={String(layer.config.weight ?? 'normal')}
              onChange={(e) =>
                commit({ config: { ...layer.config, weight: e.target.value } })
              }
              style={select}
            >
              <option value="normal">{t('properties.weightNormal')}</option>
              <option value="bold">{t('properties.weightBold')}</option>
            </select>
          </div>
          <div style={row}>
            <span style={label}>{t('properties.labelAlign')}</span>
            <select
              value={(layer.config.align as string | undefined) ?? 'left'}
              onChange={(e) =>
                commit({ config: { ...layer.config, align: e.target.value } })
              }
              style={select}
            >
              <option value="left">{t('properties.alignLeft')}</option>
              <option value="center">{t('properties.alignCenter')}</option>
              <option value="right">{t('properties.alignRight')}</option>
            </select>
          </div>
          <div style={row}>
            <span style={label}>{t('properties.labelAllowHtml')}</span>
            <Toggle
              checked={layer.config.allowHtml === true}
              onChange={(v) =>
                commit({ config: { ...layer.config, allowHtml: v } })
              }
            />
          </div>
        </>
      )}

      {layer.kind === 'browser' && (
        <>
          <div style={sectionHeader}>{t('properties.sectionUrl')}</div>
          <input
            type="text"
            value={(layer.config.url as string | undefined) ?? ''}
            onChange={(e) =>
              updateLayerLocal(layer.id, {
                config: { ...layer.config, url: e.target.value },
              })
            }
            onBlur={(e) =>
              api
                .updateComposeLayer(layer.id, {
                  config: { ...layer.config, url: e.target.value },
                })
                .catch(() => {})
            }
            placeholder="https://…"
            style={textInput}
          />
        </>
      )}

      {layer.kind === 'feed' && (
        <>
          <div style={sectionHeader}>{t('properties.sectionTemplate')}</div>
          <textarea
            value={(layer.config.template as string | undefined) ?? ''}
            onChange={(e) =>
              updateLayerLocal(layer.id, {
                config: { ...layer.config, template: e.target.value },
              })
            }
            onBlur={(e) =>
              api
                .updateComposeLayer(layer.id, {
                  config: { ...layer.config, template: e.target.value },
                })
                .catch(() => {})
            }
            placeholder={
              '<div className="chat">\n  ${(chat || []).map((m) => html`\n    <div key=${m.id}>${m.displayName}: <${Emote} html=${m.html} /></div>\n  `)}\n</div>'
            }
            rows={8}
            spellCheck={false}
            style={{
              ...textInput,
              resize: 'vertical',
              fontFamily: 'monospace',
              fontSize: 12,
              whiteSpace: 'pre',
            }}
          />
          <div
            style={{
              fontSize: 10,
              color: '#555',
              lineHeight: 1.4,
              marginTop: 4,
            }}
          >
            {t('properties.feedHint')}
          </div>

          <div style={sectionHeader}>{t('properties.sectionStyles')}</div>
          <textarea
            value={(layer.config.css as string | undefined) ?? ''}
            onChange={(e) =>
              updateLayerLocal(layer.id, {
                config: { ...layer.config, css: e.target.value },
              })
            }
            onBlur={(e) =>
              api
                .updateComposeLayer(layer.id, {
                  config: { ...layer.config, css: e.target.value },
                })
                .catch(() => {})
            }
            placeholder={'.chat { display:flex; flex-direction:column; }'}
            rows={6}
            spellCheck={false}
            style={{
              ...textInput,
              resize: 'vertical',
              fontFamily: 'monospace',
              fontSize: 12,
              whiteSpace: 'pre',
            }}
          />
          <div
            style={{
              fontSize: 10,
              color: '#555',
              lineHeight: 1.4,
              marginTop: 4,
            }}
          >
            {t('properties.stylesHint')}
          </div>
        </>
      )}

      <div style={sectionHeader}>{t('properties.sectionStackOrder')}</div>
      <div style={row}>
        <NumInput
          value={layer.sceneOrder}
          prefix={t('properties.prefixScene')}
          step={1}
          precision={0}
          onCommit={(v) => commit({ sceneOrder: Math.round(v) })}
          style={{ flex: 1 }}
        />
        <NumInput
          value={layer.cameraOrder}
          prefix={t('properties.prefixCam')}
          step={1}
          precision={0}
          onCommit={(v) => commit({ cameraOrder: Math.round(v) })}
          style={{ flex: 1 }}
        />
      </div>
      <div
        style={{ fontSize: 10, color: '#555', lineHeight: 1.4, marginTop: -2 }}
      >
        {t('properties.stackOrderHint')}
      </div>
    </>
  );
}
