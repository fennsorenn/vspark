import { type CSSProperties } from 'react';
import {
  useEditorStore,
  type ComposeLayerRecord,
} from '../../store/editorStore';
import { api } from '../../api/client';
import type { ComposeAnchorH, ComposeAnchorV } from '../../api/client';
import { useTrackClipRecorder } from '../../hooks/useTrackClipRecorder';
import { NumInput, VecInput, SliderInput } from './numericInputs';

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
};

export function ComposeLayerProperties({
  layer,
}: {
  layer: ComposeLayerRecord;
}) {
  const assets = useEditorStore((s) => s.assets);
  const updateLayerLocal = useEditorStore((s) => s.updateComposeLayerLocal);
  const nodes = useEditorStore((s) => s.nodes);
  const { canRecord, recordKeyframe, recordKeyframes } = useTrackClipRecorder();

  const cameraNode = layer.cameraNodeId
    ? nodes.find((n) => n.id === layer.cameraNodeId)
    : null;
  const scopeLabel = layer.cameraNodeId
    ? `Camera · ${cameraNode?.name ?? 'unknown'}`
    : 'Scene-wide (all cameras)';

  const commit = (patch: Partial<ComposeLayerRecord>) => {
    updateLayerLocal(layer.id, patch);
    api.updateComposeLayer(layer.id, patch).catch(() => {});
  };

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

  const unitSelect = (
    field: 'x' | 'y' | 'width' | 'height',
    unitKey: UnitKey
  ) => (
    <select
      value={unitOf(unitKey)}
      onChange={(e) => setUnit(field, unitKey, e.target.value as 'px' | '%')}
      style={{ ...select, width: 48 }}
      title="Unit"
    >
      <option value="px">px</option>
      <option value="%">%</option>
    </select>
  );

  const compatibleAssets = assets.filter((a) => {
    if (layer.kind === 'image') return a.kind === 'image';
    if (layer.kind === 'video') return a.mimeType.startsWith('video/');
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

      <div style={sectionHeader}>Lock</div>
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
          <input
            type="checkbox"
            checked={locked}
            onChange={() => toggleLock('locked')}
          />
          Lock layer (2D)
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
            <input
              type="checkbox"
              checked={locked3d}
              onChange={() => toggleLock('locked3d')}
            />
            Lock 3D interaction
          </label>
        )}
      </div>

      <div style={sectionHeader}>Name</div>
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
          <div style={sectionHeader}>Camera</div>
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
            <option value="">None</option>
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
          <div style={sectionHeader}>Included scene</div>
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
            <option value="">None</option>
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

      <div style={sectionHeader}>Position</div>
      <VecInput
        values={[layer.x, layer.y]}
        labels={['X', 'Y']}
        step={1}
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
      <div style={{ ...row, marginTop: 6 }}>
        <span style={label}>Units</span>
        {unitSelect('x', 'xUnit')}
        {unitSelect('y', 'yUnit')}
      </div>
      <div style={row}>
        <span style={label}>Anchor</span>
        <select
          value={layer.anchorH}
          onChange={(e) =>
            commit({ anchorH: e.target.value as ComposeAnchorH })
          }
          style={select}
        >
          <option value="left">Left</option>
          <option value="right">Right</option>
        </select>
        <select
          value={layer.anchorV}
          onChange={(e) =>
            commit({ anchorV: e.target.value as ComposeAnchorV })
          }
          style={select}
        >
          <option value="top">Top</option>
          <option value="bottom">Bottom</option>
        </select>
      </div>

      <div style={sectionHeader}>Size</div>
      <VecInput
        values={[layer.width, layer.height]}
        labels={['W', 'H']}
        step={1}
        min={[0, 0]}
        onCommit={(next, axis) =>
          commit(axis === 0 ? { width: next[0] } : { height: next[1] })
        }
      />
      <div style={{ ...row, marginTop: 6 }}>
        <span style={label}>Units</span>
        {unitSelect('width', 'widthUnit')}
        {unitSelect('height', 'heightUnit')}
      </div>

      <div style={sectionHeader}>Rotation</div>
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

      <div style={sectionHeader}>Visibility</div>
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
          <input
            type="checkbox"
            checked={layer.visible}
            onChange={(e) => commit({ visible: e.target.checked })}
          />
          Visible
        </label>
      </div>
      <div style={row}>
        <span style={label}>Opacity</span>
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

      {(layer.kind === 'image' || layer.kind === 'video') && (
        <>
          <div style={sectionHeader}>
            {layer.kind === 'image' ? 'Image asset' : 'Video asset'}
          </div>
          <select
            value={layer.assetId ?? ''}
            onChange={(e) => commit({ assetId: e.target.value || null })}
            style={{ ...select, width: '100%' }}
          >
            <option value="">— none —</option>
            {compatibleAssets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <div style={{ ...row, marginTop: 6 }}>
            <span style={label}>Fit</span>
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
          <div style={sectionHeader}>Playback</div>
          <div style={row}>
            <span style={label}>Autoplay</span>
            <input
              type="checkbox"
              checked={layer.config.autoplay !== false}
              onChange={(e) =>
                commit({
                  config: { ...layer.config, autoplay: e.target.checked },
                })
              }
            />
          </div>
          <div style={row}>
            <span style={label}>Loop</span>
            <input
              type="checkbox"
              checked={layer.config.loop !== false}
              onChange={(e) =>
                commit({
                  config: { ...layer.config, loop: e.target.checked },
                })
              }
            />
          </div>
          <div style={row}>
            <span style={label}>On end</span>
            <select
              value={(layer.config.onEnd as string | undefined) ?? 'freeze'}
              onChange={(e) =>
                commit({
                  config: { ...layer.config, onEnd: e.target.value },
                })
              }
              style={select}
            >
              <option value="freeze">Freeze on last frame</option>
              <option value="hide">Hide</option>
            </select>
          </div>
          <div style={row}>
            <span style={label}>Muted</span>
            <input
              type="checkbox"
              checked={layer.config.muted !== false}
              onChange={(e) =>
                commit({
                  config: { ...layer.config, muted: e.target.checked },
                })
              }
            />
          </div>
          <div style={row}>
            <span style={label}>Volume</span>
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

      {layer.kind === 'browser' && (
        <>
          <div style={sectionHeader}>URL</div>
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
          <div style={sectionHeader}>Template</div>
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
            JSX-ish (htm) markup. Each field a <code>set_data</code> node
            publishes is in scope by its bare name (a field labeled{' '}
            <code>chat</code> → <code>{'${chat.map(...)}'}</code>); guard with{' '}
            <code>{'${(chat ?? []).map(...)}'}</code> until data arrives. Use{' '}
            <code>{'<${Emote} html=${m.html} />'}</code> for emote HTML, and{' '}
            <code>className</code>, not <code>class</code>. A{' '}
            <code>set_data</code> with no scope is global; one scoped to this
            layer is private to it.
          </div>

          <div style={sectionHeader}>Styles (CSS)</div>
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
            Static styles, scoped to this layer. Dynamic styles can go inline in
            the template (<code>{'style=${{ color: m.color }}'}</code>).
          </div>
        </>
      )}

      <div style={sectionHeader}>Stack order</div>
      <div style={row}>
        <NumInput
          value={layer.sceneOrder}
          prefix="Scene"
          step={1}
          precision={0}
          onCommit={(v) => commit({ sceneOrder: Math.round(v) })}
          style={{ flex: 1 }}
        />
        <NumInput
          value={layer.cameraOrder}
          prefix="Cam"
          step={1}
          precision={0}
          onCommit={(v) => commit({ cameraOrder: Math.round(v) })}
          style={{ flex: 1 }}
        />
      </div>
      <div
        style={{ fontSize: 10, color: '#555', lineHeight: 1.4, marginTop: -2 }}
      >
        scene_order &lt; 0 = in front of 3D · 0 = at 3D · &gt; 0 = behind 3D
      </div>
    </>
  );
}
