import { useState, useEffect, useRef } from 'react';
import { PARTICLE_DEFAULTS } from '../../particleUtils';
import { getBuiltinParticleTextures } from '../../particleTextures';
import { ARKIT_TO_FCL, ARKIT_TO_VRM, ARKIT_SHAPES } from '@vspark/shared/arkit';
import { useParams } from 'react-router-dom';
import { useEditorStore } from '../../store/editorStore';
import { api, fireSignalEvent, updateScene } from '../../api/client';
import type { NodeRecord, NodeComponent } from '../../store/editorStore';
import { CAMERA_EFFECT_KINDS } from '../../store/editorStore';
import { ComposeLayerProperties } from './ComposeLayerProperties';
import type { AssetFile } from '../../api/client';
import { animRegistry } from '../../animRegistry';
import { MicCapture, type VowelTemplates } from '../../media/MicCapture';
import { useTrackClipRecorder } from '../../hooks/useTrackClipRecorder';

/** Small "Pick…" button that routes the user to a bottom-dock asset tab and
 *  flashes it as a hint. The asset tab's existing "Apply to <node>" buttons do
 *  the actual assignment (flash-only picker). */
function PickButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Pick from the asset library in the bottom dock"
      style={{
        background: '#1a3a5a',
        border: 'none',
        color: '#7ab',
        borderRadius: 4,
        padding: '2px 8px',
        cursor: 'pointer',
        fontSize: 11,
        marginLeft: 8,
      }}
    >
      Pick…
    </button>
  );
}
import { NumInput, VecInput, SliderInput } from './numericInputs';
import { vrmRegistry } from '../../vrmRegistry';
import {
  getMaterialSlots,
  type MaterialOverride,
  type MaterialOverrides,
  type ShaderKind,
  type AlphaMode,
} from './materialOverrides';

interface Transform {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  sx: number;
  sy: number;
  sz: number;
  /** Uniform descendant-mesh opacity. Persisted on components.transform; the
   *  viewport's per-frame material walk reads it and adjusts material.opacity. */
  opacity: number;
  /** Whether descendant meshes cast shadows (when the camera has shadows on). */
  castShadow: boolean;
  /** Whether descendant meshes receive shadows. */
  receiveShadow: boolean;
}

interface LightProps {
  lightType: string;
  color: string;
  intensity: number;
  /** Whether this light casts shadows. Inert unless the camera enables shadows. */
  castShadow?: boolean;
  /** Shadow-map resolution (px, square). Default 1024. */
  shadowMapSize?: number;
  /** Depth bias to combat shadow acne. Default -0.0005. */
  shadowBias?: number;
  /** Normal-offset bias to combat peter-panning. Default 0.02. */
  shadowNormalBias?: number;
  /** Directional-light ortho shadow-camera half-extent (world units). Default 10. */
  shadowCameraSize?: number;
  /** Shadow-camera far plane (world units). Default 50. */
  shadowCameraFar?: number;
}

export type CameraProjection = 'perspective' | 'orthographic';
export type ShadowQuality = 'low' | 'medium' | 'high';
interface CameraProps {
  projection: CameraProjection;
  fov: number;
  near: number;
  far: number;
  /** Half-height of the orthographic view frustum (world units). */
  orthoSize: number;
  /** Enable shadow-map rendering for this camera's view. Default false. */
  shadowsEnabled: boolean;
  /** Shadow-map filter quality. low=hard, medium=PCF, high=PCF-soft. */
  shadowQuality: ShadowQuality;
  /**
   * Multiplier for the environment-map (HDRI) lighting contribution in the
   * output/viewer canvases. Lower values darken surfaces facing away from
   * scene lights, increasing directional contrast. Default 1.
   */
  envIntensity: number;
}

const RAD = Math.PI / 180;

function getTransform(node: NodeRecord): Transform {
  const t = node.components?.transform as Partial<Transform> | undefined;
  return {
    x: t?.x ?? 0,
    y: t?.y ?? 0,
    z: t?.z ?? 0,
    rx: t?.rx ?? 0,
    ry: t?.ry ?? 0,
    rz: t?.rz ?? 0,
    sx: t?.sx ?? 1,
    sy: t?.sy ?? 1,
    sz: t?.sz ?? 1,
    opacity: t?.opacity ?? 1,
    castShadow: t?.castShadow ?? true,
    receiveShadow: t?.receiveShadow ?? true,
  };
}

function getLightProps(node: NodeRecord): LightProps {
  const l = node.components?.light as Partial<LightProps> | undefined;
  return {
    lightType: l?.lightType ?? 'point',
    color: l?.color ?? '#ffffff',
    intensity: l?.intensity ?? 1,
    castShadow: l?.castShadow ?? false,
    shadowMapSize: l?.shadowMapSize ?? 1024,
    shadowBias: l?.shadowBias ?? -0.0005,
    shadowNormalBias: l?.shadowNormalBias ?? 0.02,
    shadowCameraSize: l?.shadowCameraSize ?? 10,
    shadowCameraFar: l?.shadowCameraFar ?? 50,
  };
}

function getCameraProps(node: NodeRecord): CameraProps {
  const c = node.components?.camera as Partial<CameraProps> | undefined;
  return {
    projection: c?.projection ?? 'perspective',
    fov: c?.fov ?? 50,
    near: c?.near ?? 0.1,
    far: c?.far ?? 1000,
    orthoSize: c?.orthoSize ?? 2,
    shadowsEnabled: c?.shadowsEnabled ?? false,
    shadowQuality: c?.shadowQuality ?? 'medium',
    envIntensity: c?.envIntensity ?? 1,
  };
}

const numInput: React.CSSProperties = {
  width: 60,
  background: '#2a2a2a',
  border: '1px solid #3a3a3a',
  color: '#e0e0e0',
  borderRadius: 4,
  padding: '3px 6px',
  fontSize: 12,
  outline: 'none',
  textAlign: 'right',
};

const textInput: React.CSSProperties = {
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

const sectionHeader: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 8,
  marginTop: 16,
};

// The old `KfBtn`, local `NumInput`, and Vec3 row helpers (`row3`, `label`,
// `cellWithBtn`, `groupHeaderRow`, `kfGroupBtnStyle`) were removed when the
// numeric controls were unified — see ./numericInputs.tsx.

// ---------- Collapsible section ----------

/** A section header that toggles its children open/closed. Reuses the flat
 *  `sectionHeader` look with a disclosure caret. Collapse state is ephemeral
 *  (not persisted). */
function CollapsibleSection({
  title,
  count,
  defaultCollapsed = true,
  children,
}: {
  title: string;
  count?: number;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!defaultCollapsed);
  return (
    <>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          ...sectionHeader,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span
          style={{
            fontSize: 9,
            color: '#666',
            display: 'inline-block',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms',
          }}
        >
          ▶
        </span>
        <span>
          {title}
          {count != null ? ` (${count})` : ''}
        </span>
      </div>
      {open && children}
    </>
  );
}

// ---------- Material editor (MToon ⇄ PBR) ----------

const matLabel: React.CSSProperties = {
  fontSize: 11,
  color: '#888',
  width: 96,
  flexShrink: 0,
};
const matRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};
const matColorInput: React.CSSProperties = {
  width: 32,
  height: 22,
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  padding: 0,
};

/** Keys of MaterialOverride whose value is a hex color string. */
type MatColorKey = Exclude<
  {
    [K in keyof MaterialOverride]-?: NonNullable<
      MaterialOverride[K]
    > extends string
      ? K
      : never;
  }[keyof MaterialOverride],
  'shader' | 'alphaMode'
>;
/** Keys of MaterialOverride whose value is a number. */
type MatNumKey = {
  [K in keyof MaterialOverride]-?: NonNullable<
    MaterialOverride[K]
  > extends number
    ? K
    : never;
}[keyof MaterialOverride];

/** One material's editor: shader toggle + collapsible param body + reset. */
function MaterialRow({
  node,
  slot,
}: {
  node: NodeRecord;
  slot: ReturnType<typeof getMaterialSlots>[number];
}) {
  const { updateNode: storeUpdateNode } = useEditorStore();
  const [open, setOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const overrides = (node.properties?.materialOverrides ??
    {}) as MaterialOverrides;
  const ov = overrides[slot.key] as MaterialOverride | undefined;
  const d = slot.defaults;
  const defaultShader: ShaderKind = slot.supportsMToon ? 'mtoon' : 'pbr';
  let shader: ShaderKind = ov?.shader ?? defaultShader;
  if (shader === 'mtoon' && !slot.supportsMToon) shader = 'pbr';
  const isStandard = shader === 'pbr' || shader === 'apbr';

  const writeOverrides = (next: MaterialOverrides, persist: boolean) => {
    const properties = { ...node.properties, materialOverrides: next };
    storeUpdateNode(node.id, { properties });
    if (persist)
      api
        .updateNode(node.id, { properties: { materialOverrides: next } })
        .catch(() => {});
  };

  const patch = (p: Partial<MaterialOverride>, persist: boolean) => {
    const prev = (node.properties?.materialOverrides ??
      {}) as MaterialOverrides;
    const prevEntry: MaterialOverride = prev[slot.key] ?? {
      shader: defaultShader,
    };
    const next = { ...prev, [slot.key]: { ...prevEntry, ...p } };
    writeOverrides(next, persist);
  };

  const reset = () => {
    const prev = (node.properties?.materialOverrides ??
      {}) as MaterialOverrides;
    const next = { ...prev };
    delete next[slot.key];
    writeOverrides(next, true);
  };

  const val = <K extends keyof MaterialOverride>(
    key: K,
    fallback: NonNullable<MaterialOverride[K]>
  ): NonNullable<MaterialOverride[K]> =>
    (ov?.[key] as NonNullable<MaterialOverride[K]> | undefined) ?? fallback;

  const colorRow = (label: string, key: MatColorKey, fallback: string) => (
    <div style={matRow}>
      <span style={matLabel}>{label}</span>
      <input
        type="color"
        value={val(key, fallback)}
        style={matColorInput}
        onChange={(e) =>
          patch({ [key]: e.target.value } as Partial<MaterialOverride>, false)
        }
        onBlur={(e) =>
          patch({ [key]: e.target.value } as Partial<MaterialOverride>, true)
        }
      />
    </div>
  );

  const sliderRow = (
    label: string,
    key: MatNumKey,
    fallback: number,
    min: number,
    max: number,
    step: number,
    precision: number
  ) => (
    <div style={matRow}>
      <span style={matLabel}>{label}</span>
      <SliderInput
        value={val(key, fallback)}
        min={min}
        max={max}
        step={step}
        precision={precision}
        style={{ flex: 1 }}
        onChange={(v) =>
          patch({ [key]: v } as Partial<MaterialOverride>, false)
        }
        onCommit={(v) => patch({ [key]: v } as Partial<MaterialOverride>, true)}
      />
    </div>
  );

  const alphaMode = val('alphaMode', d.alphaMode);

  return (
    <div
      style={{
        border: '1px solid #222',
        borderRadius: 4,
        marginBottom: 6,
        background: '#141414',
      }}
    >
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 8px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span
          style={{
            fontSize: 9,
            color: '#666',
            display: 'inline-block',
            transform: open ? 'rotate(90deg)' : 'none',
          }}
        >
          ▶
        </span>
        <span
          style={{
            fontSize: 11,
            color: '#bbb',
            fontFamily: 'monospace',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={slot.displayName}
        >
          {slot.displayName}
        </span>
        <span
          style={{
            fontSize: 9,
            color:
              shader === 'apbr' ? '#7c9' : shader === 'pbr' ? '#7ab' : '#a8a',
            border: '1px solid #333',
            borderRadius: 3,
            padding: '1px 5px',
            textTransform: 'uppercase',
          }}
        >
          {shader}
        </span>
      </div>
      {open && (
        <div
          style={{
            padding: '6px 8px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            borderTop: '1px solid #222',
          }}
        >
          {/* Shader toggle */}
          <div style={matRow}>
            <span style={matLabel}>Shader</span>
            <div style={{ display: 'flex', gap: 0 }}>
              {(['mtoon', 'pbr', 'apbr'] as ShaderKind[]).map((s, i, arr) => {
                const active = shader === s;
                const disabled = s === 'mtoon' && !slot.supportsMToon;
                return (
                  <button
                    key={s}
                    disabled={disabled}
                    title={
                      s === 'apbr'
                        ? 'Advanced PBR (MeshPhysicalMaterial): specular, clearcoat, sheen, transmission…'
                        : undefined
                    }
                    onClick={() => patch({ shader: s }, true)}
                    style={{
                      background: active ? '#1a3a5a' : '#1e1e1e',
                      border: '1px solid #3a3a3a',
                      color: disabled ? '#555' : active ? '#cde' : '#aaa',
                      padding: '3px 10px',
                      fontSize: 11,
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      textTransform: 'uppercase',
                      borderRadius:
                        i === 0
                          ? '4px 0 0 4px'
                          : i === arr.length - 1
                            ? '0 4px 4px 0'
                            : 0,
                      marginLeft: i === 0 ? 0 : -1,
                    }}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Overlapping params */}
          {colorRow('Base color', 'baseColor', d.baseColor)}
          {colorRow('Emissive', 'emissive', d.emissive)}
          {sliderRow(
            'Emissive int.',
            'emissiveIntensity',
            d.emissiveIntensity,
            0,
            5,
            0.01,
            2
          )}
          {d.hasNormalMap &&
            sliderRow(
              'Normal scale',
              'normalScale',
              d.normalScale,
              0,
              2,
              0.01,
              2
            )}
          <div style={matRow}>
            <span style={matLabel}>Double sided</span>
            <input
              type="checkbox"
              checked={val('doubleSided', d.doubleSided)}
              onChange={(e) => patch({ doubleSided: e.target.checked }, true)}
            />
          </div>
          <div style={matRow}>
            <span style={matLabel}>Alpha mode</span>
            <select
              value={alphaMode}
              onChange={(e) =>
                patch({ alphaMode: e.target.value as AlphaMode }, true)
              }
              style={{
                background: '#2a2a2a',
                border: '1px solid #3a3a3a',
                color: '#e0e0e0',
                borderRadius: 4,
                padding: '3px 6px',
                fontSize: 11,
              }}
            >
              <option value="opaque">Opaque</option>
              <option value="mask">Mask (cutout)</option>
              <option value="blend">Blend</option>
            </select>
          </div>
          {alphaMode === 'mask' &&
            sliderRow(
              'Alpha cutoff',
              'alphaCutoff',
              d.alphaCutoff,
              0,
              1,
              0.01,
              2
            )}

          {/* MToon-only */}
          {shader === 'mtoon' && (
            <>
              {colorRow('Shade color', 'shadeColor', d.shadeColor)}
              {sliderRow(
                'Shading shift',
                'shadingShiftFactor',
                d.shadingShiftFactor,
                -1,
                1,
                0.01,
                2
              )}
              {sliderRow(
                'Shading toony',
                'shadingToonyFactor',
                d.shadingToonyFactor,
                0,
                1,
                0.01,
                2
              )}
              {sliderRow(
                'GI equalize',
                'giEqualization',
                d.giEqualization,
                0,
                1,
                0.01,
                2
              )}
              {colorRow('Matcap', 'matcapColor', d.matcapColor)}
              {colorRow('Rim color', 'rimColor', d.rimColor)}
              {sliderRow(
                'Rim mix',
                'rimLightingMix',
                d.rimLightingMix,
                0,
                1,
                0.01,
                2
              )}
              {sliderRow(
                'Rim fresnel',
                'rimFresnelPower',
                d.rimFresnelPower,
                0,
                50,
                0.1,
                1
              )}
              {sliderRow('Rim lift', 'rimLift', d.rimLift, 0, 1, 0.01, 2)}
              {d.hasOutline && (
                <>
                  {sliderRow(
                    'Outline width',
                    'outlineWidth',
                    d.outlineWidth,
                    0,
                    0.05,
                    0.001,
                    3
                  )}
                  {colorRow('Outline color', 'outlineColor', d.outlineColor)}
                  {sliderRow(
                    'Outline mix',
                    'outlineLightingMix',
                    d.outlineLightingMix,
                    0,
                    1,
                    0.01,
                    2
                  )}
                </>
              )}
            </>
          )}

          {/* PBR + APBR shared */}
          {isStandard && (
            <>
              {sliderRow('Roughness', 'roughness', d.roughness, 0, 1, 0.01, 2)}
              {sliderRow('Metalness', 'metalness', d.metalness, 0, 1, 0.01, 2)}
              {sliderRow(
                'Env intensity',
                'envMapIntensity',
                d.envMapIntensity,
                0,
                3,
                0.01,
                2
              )}
            </>
          )}

          {/* APBR-only advanced lobes (MeshPhysicalMaterial) */}
          {shader === 'apbr' && (
            <>
              <div
                onClick={() => setAdvOpen((o) => !o)}
                style={{
                  ...matRow,
                  cursor: 'pointer',
                  userSelect: 'none',
                  color: '#888',
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  marginTop: 4,
                }}
              >
                <span
                  style={{
                    fontSize: 9,
                    color: '#666',
                    display: 'inline-block',
                    transform: advOpen ? 'rotate(90deg)' : 'none',
                  }}
                >
                  ▶
                </span>
                Advanced
              </div>
              {advOpen && (
                <>
                  {sliderRow(
                    'Specular',
                    'specularIntensity',
                    d.specularIntensity,
                    0,
                    1,
                    0.01,
                    2
                  )}
                  {colorRow('Specular tint', 'specularColor', d.specularColor)}
                  {sliderRow(
                    'Clearcoat',
                    'clearcoat',
                    d.clearcoat,
                    0,
                    1,
                    0.01,
                    2
                  )}
                  {sliderRow(
                    'Clearcoat rgh',
                    'clearcoatRoughness',
                    d.clearcoatRoughness,
                    0,
                    1,
                    0.01,
                    2
                  )}
                  {sliderRow('Sheen', 'sheen', d.sheen, 0, 1, 0.01, 2)}
                  {sliderRow(
                    'Sheen rgh',
                    'sheenRoughness',
                    d.sheenRoughness,
                    0,
                    1,
                    0.01,
                    2
                  )}
                  {colorRow('Sheen color', 'sheenColor', d.sheenColor)}
                  {sliderRow(
                    'Transmission',
                    'transmission',
                    d.transmission,
                    0,
                    1,
                    0.01,
                    2
                  )}
                  {sliderRow(
                    'Thickness',
                    'thickness',
                    d.thickness,
                    0,
                    5,
                    0.01,
                    2
                  )}
                  {sliderRow('IOR', 'ior', d.ior, 1, 2.333, 0.001, 3)}
                  {colorRow(
                    'Attenuation',
                    'attenuationColor',
                    d.attenuationColor
                  )}
                  {sliderRow(
                    'Atten. dist.',
                    'attenuationDistance',
                    d.attenuationDistance,
                    0,
                    5,
                    0.01,
                    2
                  )}
                  {sliderRow(
                    'Iridescence',
                    'iridescence',
                    d.iridescence,
                    0,
                    1,
                    0.01,
                    2
                  )}
                  {sliderRow(
                    'Iridescence IOR',
                    'iridescenceIor',
                    d.iridescenceIor,
                    1,
                    2.333,
                    0.001,
                    3
                  )}
                  {sliderRow(
                    'Anisotropy',
                    'anisotropy',
                    d.anisotropy,
                    0,
                    1,
                    0.01,
                    2
                  )}
                </>
              )}
            </>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={reset}
              disabled={!ov}
              title="Drop overrides and rebuild this material from the VRM file"
              style={{
                background: 'none',
                border: '1px solid #3a3a3a',
                color: ov ? '#c88' : '#555',
                borderRadius: 4,
                padding: '2px 10px',
                fontSize: 11,
                cursor: ov ? 'pointer' : 'default',
              }}
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Lists every material on the loaded VRM with per-material shader controls. */
function MaterialSection({ node }: { node: NodeRecord }) {
  // Re-render when the VRM (re)loads — bones are set on load, cleared on unload.
  const loadedBones = useEditorStore((s) => s.vrmBonesByNode[node.id]);
  const vrm = vrmRegistry.get(node.id);
  if (!vrm || !loadedBones) {
    return (
      <CollapsibleSection title="Material">
        <div style={{ fontSize: 11, color: '#555' }}>
          Load a model to edit its materials.
        </div>
      </CollapsibleSection>
    );
  }
  const slots = getMaterialSlots(vrm);
  if (slots.length === 0) return null;
  return (
    <CollapsibleSection title="Material" count={slots.length}>
      <div
        style={{
          fontSize: 10,
          color: '#555',
          lineHeight: 1.4,
          marginBottom: 6,
        }}
      >
        MToon is the toon look (ignores environment light). PBR responds to
        scene lights and the camera's environment intensity — switch to PBR for
        full light falloff and darkness.
      </div>
      {slots.map((slot) => (
        <MaterialRow key={slot.key} node={node} slot={slot} />
      ))}
    </CollapsibleSection>
  );
}

// ---------- Calibration wizard ----------

function CalibrationSection({ comp }: { comp: NodeComponent }) {
  const [headSet, setHeadSet] = useState(false);
  const [leftSet, setLeftSet] = useState(false);
  const [rightSet, setRightSet] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const flash_ = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 1800);
  };

  const graphId = `vmc-pipeline:${comp.id}`;

  const fire = async (nodeId: string, label: string, onOk?: () => void) => {
    try {
      await fireSignalEvent(graphId, nodeId, 'trigger');
      flash_(label);
      onOk?.();
    } catch {
      flash_('Could not reach pipeline — is tracking active?');
    }
  };

  const reset = async () => {
    await Promise.allSettled([
      fireSignalEvent(graphId, 'head_calib_reset', 'trigger'),
      fireSignalEvent(graphId, 'arm_calib_reset', 'trigger'),
    ]);
    setHeadSet(false);
    setLeftSet(false);
    setRightSet(false);
    flash_('Calibration reset');
  };

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  };
  const btnStyle: React.CSSProperties = {
    background: '#1e2a3a',
    border: '1px solid #2a4060',
    color: '#7ab',
    borderRadius: 4,
    padding: '3px 8px',
    cursor: 'pointer',
    fontSize: 11,
    flexShrink: 0,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    color: '#666',
    flex: 1,
  };
  const dotStyle = (active: boolean): React.CSSProperties => ({
    width: 7,
    height: 7,
    borderRadius: '50%',
    flexShrink: 0,
    background: active ? '#4ade80' : '#333',
  });

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}
    >
      <div
        style={{
          fontSize: 10,
          color: '#555',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        Calibration
      </div>

      {flash && (
        <div
          style={{
            fontSize: 11,
            color: '#4ade80',
            padding: '3px 6px',
            background: '#0a1a0a',
            borderRadius: 4,
          }}
        >
          {flash}
        </div>
      )}

      <div style={rowStyle}>
        <div style={dotStyle(headSet)} />
        <span style={labelStyle}>Head — look straight ahead, relax neck</span>
        <button
          style={btnStyle}
          onClick={() =>
            fire('head_calib_capture', 'Head neutral captured ✓', () =>
              setHeadSet(true)
            )
          }
        >
          Capture
        </button>
      </div>

      <div style={rowStyle}>
        <div style={dotStyle(leftSet)} />
        <span style={labelStyle}>
          Left arm — touch index finger to left eye corner
        </span>
        <button
          style={btnStyle}
          onClick={() =>
            fire('left_arm_capture', 'Left arm captured ✓', () =>
              setLeftSet(true)
            )
          }
        >
          Capture
        </button>
      </div>

      <div style={rowStyle}>
        <div style={dotStyle(rightSet)} />
        <span style={labelStyle}>
          Right arm — touch index finger to right eye corner
        </span>
        <button
          style={btnStyle}
          onClick={() =>
            fire('right_arm_capture', 'Right arm captured ✓', () =>
              setRightSet(true)
            )
          }
        >
          Capture
        </button>
      </div>

      <div style={{ fontSize: 10, color: '#444', lineHeight: 1.5 }}>
        Head: relax into your natural posture. Arms: touch fingertip to eye
        corner, hold steady.
      </div>

      {(headSet || leftSet || rightSet) && (
        <button
          style={{
            ...btnStyle,
            background: '#2a1a1a',
            borderColor: '#5a2a2a',
            color: '#e05555',
            alignSelf: 'flex-start',
          }}
          onClick={reset}
        >
          Reset all calibration
        </button>
      )}
    </div>
  );
}

// ---------- Per-component property editors ----------

// ---------- ARKit mapper visual editor ----------

type OutputEntry = { target: string; weight: number };
type MappingEntry = { arkitShape: string; outputs: OutputEntry[] };

function parseMappingToEntries(
  obj: Record<string, [string, number][]>
): MappingEntry[] {
  return Object.entries(obj).map(([arkitShape, outputs]) => ({
    arkitShape,
    outputs: outputs.map(([target, weight]) => ({ target, weight })),
  }));
}

function entriesToMappingObj(
  entries: MappingEntry[]
): Record<string, [string, number][]> {
  const obj: Record<string, [string, number][]> = {};
  for (const { arkitShape, outputs } of entries) {
    if (!arkitShape.trim()) continue;
    const valid = outputs
      .filter((o) => o.target.trim())
      .map((o) => [o.target, o.weight] as [string, number]);
    if (valid.length) obj[arkitShape] = valid;
  }
  return obj;
}

function SearchableSelect({
  value,
  suggestions,
  onChange,
  placeholder = 'Search or type…',
}: {
  value: string;
  suggestions: string[];
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const ref = useRef<HTMLDivElement>(null);
  const cbRef = useRef(onChange);
  useEffect(() => {
    cbRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    setQuery(value);
  }, [value]);

  const filtered = query.trim()
    ? suggestions
        .filter((s) => s.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 24)
    : suggestions.slice(0, 24);

  const commit = (v: string) => {
    cbRef.current(v);
    setQuery(v);
    setOpen(false);
  };

  return (
    <div ref={ref} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <input
        value={query}
        placeholder={placeholder}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          background: '#1e1e1e',
          border: '1px solid #2e2e2e',
          color: '#ddd',
          borderRadius: 3,
          padding: '3px 6px',
          fontSize: 11,
          outline: 'none',
          fontFamily: 'monospace',
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          cbRef.current(query);
          setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit(query);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') {
            setQuery(value);
            setOpen(false);
          }
        }}
      />
      {open && filtered.length > 0 && (
        <div
          style={{
            position: 'absolute',
            zIndex: 200,
            top: '100%',
            left: 0,
            right: 0,
            background: '#161616',
            border: '1px solid #2e2e2e',
            borderTop: 'none',
            borderRadius: '0 0 4px 4px',
            maxHeight: 160,
            overflowY: 'auto',
          }}
        >
          {filtered.map((opt) => (
            <div
              key={opt}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(opt);
              }}
              style={{
                padding: '3px 8px',
                fontSize: 11,
                cursor: 'pointer',
                color: opt === value ? '#7ab' : '#bbb',
                fontFamily: 'monospace',
                background: opt === value ? '#182030' : 'transparent',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background =
                  '#202530';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background =
                  opt === value ? '#182030' : 'transparent';
              }}
            >
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MappingEditor({
  entries,
  arkitOptions,
  targetOptions,
  onChange,
}: {
  entries: MappingEntry[];
  arkitOptions: string[];
  targetOptions: string[];
  onChange: (entries: MappingEntry[]) => void;
}) {
  const xBtn: React.CSSProperties = {
    background: 'none',
    border: 'none',
    color: '#444',
    cursor: 'pointer',
    fontSize: 15,
    padding: '0 2px',
    lineHeight: 1,
    flexShrink: 0,
  };

  const setShape = (i: number, v: string) => {
    const n = [...entries];
    n[i] = { ...n[i], arkitShape: v };
    onChange(n);
  };
  const removeShape = (i: number) =>
    onChange(entries.filter((_, j) => j !== i));
  const addShape = () =>
    onChange([
      ...entries,
      { arkitShape: '', outputs: [{ target: '', weight: 1 }] },
    ]);

  const setOutput = (i: number, j: number, patch: Partial<OutputEntry>) => {
    const n = [...entries];
    const outs = [...n[i].outputs];
    outs[j] = { ...outs[j], ...patch };
    n[i] = { ...n[i], outputs: outs };
    onChange(n);
  };
  const removeOutput = (i: number, j: number) => {
    const n = [...entries];
    n[i] = { ...n[i], outputs: n[i].outputs.filter((_, k) => k !== j) };
    onChange(n);
  };
  const addOutput = (i: number) => {
    const n = [...entries];
    n[i] = { ...n[i], outputs: [...n[i].outputs, { target: '', weight: 1 }] };
    onChange(n);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {entries.map((entry, i) => (
        <div
          key={i}
          style={{
            background: '#181818',
            border: '1px solid #242424',
            borderRadius: 4,
            padding: '5px 6px',
          }}
        >
          {/* ARKit shape row */}
          <div
            style={{
              display: 'flex',
              gap: 4,
              alignItems: 'center',
              marginBottom: 4,
            }}
          >
            <SearchableSelect
              value={entry.arkitShape}
              suggestions={arkitOptions}
              onChange={(v) => setShape(i, v)}
              placeholder="ARKit shape…"
            />
            <button
              style={xBtn}
              title="Remove shape"
              onClick={() => removeShape(i)}
            >
              ×
            </button>
          </div>
          {/* Outputs */}
          {entry.outputs.map((out, j) => (
            <div key={j} style={{ marginLeft: 8, marginBottom: 4 }}>
              <div
                style={{
                  display: 'flex',
                  gap: 3,
                  alignItems: 'center',
                  marginBottom: 2,
                }}
              >
                <SearchableSelect
                  value={out.target}
                  suggestions={targetOptions}
                  onChange={(v) => setOutput(i, j, { target: v })}
                  placeholder="Morph target or expression…"
                />
                <button
                  style={xBtn}
                  title="Remove output"
                  onClick={() => removeOutput(i, j)}
                >
                  ×
                </button>
              </div>
              <SliderInput
                value={out.weight}
                min={-2}
                max={2}
                step={0.05}
                precision={2}
                onChange={(v) => setOutput(i, j, { weight: v })}
              />
            </div>
          ))}
          <button
            style={{
              background: 'none',
              border: 'none',
              color: '#2a4060',
              cursor: 'pointer',
              fontSize: 11,
              marginLeft: 8,
              padding: '2px 0',
            }}
            onClick={() => addOutput(i)}
          >
            + add output
          </button>
        </div>
      ))}
      <button
        style={{
          background: '#0e1520',
          border: '1px dashed #1e3048',
          color: '#2a5080',
          borderRadius: 4,
          padding: '5px',
          cursor: 'pointer',
          fontSize: 11,
        }}
        onClick={addShape}
      >
        + Add ARKit input
      </button>
    </div>
  );
}

// ---------- ARKit mapper node config editor ----------

interface MapperNodeConfig {
  enabled: boolean;
  customMapping: string; // JSON string for textarea
}

// Config is stored under the sibling config node IDs (not the mapper node IDs).
const MAPPER_NODES: {
  id: string;
  label: string;
  defaultEnabled: boolean;
  builtinMapping: Record<string, [string, number][]> | null;
}[] = [
  {
    id: 'arkit_fcl_cfg',
    label: 'VRoid (Fcl_*)',
    defaultEnabled: true,
    builtinMapping: ARKIT_TO_FCL as Record<string, [string, number][]>,
  },
  {
    id: 'arkit_expr_cfg',
    label: 'VRM Expressions',
    defaultEnabled: false,
    builtinMapping: ARKIT_TO_VRM as Record<string, [string, number][]>,
  },
  {
    id: 'arkit_pass_cfg',
    label: 'Passthrough (ARKit)',
    defaultEnabled: false,
    builtinMapping: null,
  },
];

function MapperSection({
  nodeId,
  label,
  builtinMapping,
  config,
  onSave,
  targetSuggestions,
}: {
  nodeId: string;
  label: string;
  builtinMapping: Record<string, [string, number][]> | null;
  config: MapperNodeConfig | undefined;
  onSave: (id: string, patch: Partial<MapperNodeConfig>) => void;
  targetSuggestions: string[];
}) {
  const enabled = config?.enabled ?? false;
  const customMapping = config?.customMapping ?? '';

  const defaultEntries = builtinMapping
    ? parseMappingToEntries(builtinMapping)
    : [];
  const defaultJson = builtinMapping
    ? JSON.stringify(builtinMapping, null, 2)
    : '{}';

  const parseCustom = (json: string): MappingEntry[] => {
    if (!json.trim()) return defaultEntries;
    try {
      return parseMappingToEntries(
        JSON.parse(json) as Record<string, [string, number][]>
      );
    } catch {
      return defaultEntries;
    }
  };

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'visual' | 'json'>('visual');
  const [entries, setEntries] = useState<MappingEntry[]>(() =>
    parseCustom(customMapping)
  );
  const [jsonText, setJsonText] = useState(customMapping || defaultJson);
  const [jsonErr, setJsonErr] = useState(false);

  useEffect(() => {
    const parsed = parseCustom(customMapping);
    setEntries(parsed);
    setJsonText(customMapping || defaultJson);
    setJsonErr(false);
  }, [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitEntries = (next: MappingEntry[]) => {
    setEntries(next);
    const obj = entriesToMappingObj(next);
    const text = JSON.stringify(obj, null, 2);
    setJsonText(text);
    onSave(nodeId, { customMapping: text });
  };

  const commitJson = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || trimmed === '{}') {
      setJsonErr(false);
      setEntries(defaultEntries);
      onSave(nodeId, { customMapping: '' });
      return;
    }
    try {
      const obj = JSON.parse(trimmed) as Record<string, [string, number][]>;
      setJsonErr(false);
      setEntries(parseMappingToEntries(obj));
      onSave(nodeId, { customMapping: trimmed });
    } catch {
      setJsonErr(true);
    }
  };

  const resetToDefault = () => {
    setEntries(defaultEntries);
    setJsonText(defaultJson);
    setJsonErr(false);
    onSave(nodeId, { customMapping: '' });
  };

  const smallBtn: React.CSSProperties = {
    background: '#1a1a1a',
    border: '1px solid #2e2e2e',
    color: '#555',
    borderRadius: 3,
    padding: '1px 6px',
    cursor: 'pointer',
    fontSize: 10,
    flexShrink: 0,
  };
  const arkitOptions = ARKIT_SHAPES as unknown as string[];

  return (
    <div
      style={{
        border: '1px solid #232323',
        borderRadius: 4,
        overflow: 'visible',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 8px',
          background: '#181818',
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          style={{ cursor: 'pointer', flexShrink: 0 }}
          onChange={(e) => onSave(nodeId, { enabled: e.target.checked })}
        />
        <span
          style={{
            fontSize: 12,
            color: enabled ? '#e0e0e0' : '#555',
            flex: 1,
            userSelect: 'none',
            cursor: 'pointer',
          }}
          onClick={() => setOpen((o) => !o)}
        >
          {label}
        </span>
        {open && (
          <button
            style={smallBtn}
            title="Switch between visual editor and raw JSON"
            onClick={() => setMode((m) => (m === 'visual' ? 'json' : 'visual'))}
          >
            {mode === 'visual' ? '{ }' : '⊞'}
          </button>
        )}
        <span
          style={{
            fontSize: 10,
            color: '#444',
            cursor: 'pointer',
            userSelect: 'none',
          }}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? '▲' : '▼'}
        </span>
      </div>

      {open && (
        <div
          style={{
            padding: 8,
            background: '#111',
            borderTop: '1px solid #1e1e1e',
          }}
        >
          {/* Toolbar */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              marginBottom: 6,
              gap: 4,
            }}
          >
            <button style={smallBtn} onClick={resetToDefault}>
              Reset to default
            </button>
          </div>

          {mode === 'visual' ? (
            <MappingEditor
              entries={entries}
              arkitOptions={arkitOptions}
              targetOptions={targetSuggestions}
              onChange={commitEntries}
            />
          ) : (
            <>
              <textarea
                value={jsonText}
                rows={14}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  background: '#1a1a1a',
                  border: `1px solid ${jsonErr ? '#aa3333' : '#2a2a2a'}`,
                  color: '#ccc',
                  borderRadius: 4,
                  padding: '6px 8px',
                  fontSize: 11,
                  fontFamily: 'monospace',
                  resize: 'vertical',
                  outline: 'none',
                }}
                onChange={(e) => {
                  setJsonText(e.target.value);
                  setJsonErr(false);
                }}
                onBlur={(e) => commitJson(e.target.value)}
              />
              {jsonErr && (
                <div style={{ fontSize: 10, color: '#e55', marginTop: 3 }}>
                  Invalid JSON
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const VRM_EXPR_PRESETS = [
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'neutral',
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'blink',
  'blinkLeft',
  'blinkRight',
  'lookUp',
  'lookDown',
  'lookLeft',
  'lookRight',
];

function VmcReceiverProps({ comp }: { comp: NodeComponent }) {
  const { updateNodeComponent, vrmMorphTargetsByNode, vrmExpressionsByNode } =
    useEditorStore();
  const morphTargets = vrmMorphTargetsByNode[comp.nodeId] ?? [];
  const expressions = vrmExpressionsByNode[comp.nodeId] ?? [];

  const fclSuggestions = [
    ...new Set([
      ...Object.values(ARKIT_TO_FCL as Record<string, [string, number][]>)
        .flat()
        .map(([t]) => t),
      ...morphTargets,
    ]),
  ].sort();

  const exprSuggestions = [
    ...new Set([
      ...VRM_EXPR_PRESETS,
      ...Object.values(ARKIT_TO_VRM as Record<string, [string, number][]>)
        .flat()
        .map(([t]) => t),
      ...expressions,
    ]),
  ].sort();

  const passSuggestions = [
    ...new Set([...(ARKIT_SHAPES as unknown as string[]), ...morphTargets]),
  ].sort();
  const cfg = (comp.config ?? {}) as {
    host?: string;
    port?: number;
    blendMode?: string;
    mirror?: boolean;
    poseTimeout?: number;
    nodeConfig?: Record<
      string,
      { enabled?: boolean; mapping?: Record<string, [string, number][]> }
    >;
  };
  const [host, setHost] = useState(cfg.host ?? '0.0.0.0');
  const [port, setPort] = useState(cfg.port ?? 39539);
  const [blendMode, setBlendMode] = useState(cfg.blendMode ?? 'override');
  const [mirror, setMirror] = useState(cfg.mirror ?? false);
  const [poseTimeout, setPoseTimeout] = useState(cfg.poseTimeout ?? 2);
  const [localIps, setLocalIps] = useState<string[]>([]);

  // Build mapper config state from stored nodeConfig, filling defaults.
  const getMapperConfigs = () =>
    Object.fromEntries(
      MAPPER_NODES.map(({ id, defaultEnabled }) => [
        id,
        {
          enabled: cfg.nodeConfig?.[id]?.enabled ?? defaultEnabled,
          customMapping: cfg.nodeConfig?.[id]?.mapping
            ? JSON.stringify(cfg.nodeConfig[id]!.mapping, null, 2)
            : '',
        } satisfies MapperNodeConfig,
      ])
    );
  const [mapperConfigs, setMapperConfigs] =
    useState<Record<string, MapperNodeConfig>>(getMapperConfigs);

  useEffect(() => {
    setHost(cfg.host ?? '0.0.0.0');
    setPort(cfg.port ?? 39539);
    setBlendMode(cfg.blendMode ?? 'override');
    setMirror(cfg.mirror ?? false);
    setPoseTimeout(cfg.poseTimeout ?? 2);
    setMapperConfigs(getMapperConfigs());

    // Persist defaults immediately if nodeConfig is absent so the stored config
    // is always explicit rather than relying on implicit fallbacks.
    if (!cfg.nodeConfig) {
      const defaultNodeConfig = Object.fromEntries(
        MAPPER_NODES.map(({ id, defaultEnabled }) => [
          id,
          { enabled: defaultEnabled, mapping: null },
        ])
      );
      save({ nodeConfig: defaultNodeConfig });
    }
  }, [comp.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api
      .getLocalIps()
      .then(setLocalIps)
      .catch(() => {});
  }, []);

  const save = async (patch: Partial<Record<string, unknown>>) => {
    const newConfig = { ...comp.config, ...patch };
    updateNodeComponent(comp.id, { config: newConfig });
    try {
      await api.updateNodeComponent(comp.id, { config: newConfig });
    } catch {
      /* non-fatal */
    }
  };

  const saveMapperNode = (nodeId: string, patch: Partial<MapperNodeConfig>) => {
    const updated = {
      ...mapperConfigs,
      [nodeId]: { ...mapperConfigs[nodeId], ...patch },
    };
    setMapperConfigs(updated);
    // Serialize to nodeConfig — strip empty mapping to keep the stored config clean.
    const nodeConfig = Object.fromEntries(
      Object.entries(updated).map(([id, mc]) => [
        id,
        {
          enabled: mc.enabled,
          ...(mc.customMapping.trim()
            ? { mapping: JSON.parse(mc.customMapping) }
            : {}),
        },
      ])
    );
    save({ nodeConfig });
  };

  const inputStyle: React.CSSProperties = {
    flex: 1,
    background: '#2a2a2a',
    border: '1px solid #3a3a3a',
    color: '#e0e0e0',
    borderRadius: 4,
    padding: '4px 8px',
    fontSize: 12,
    outline: 'none',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: '#888', width: 72, flexShrink: 0 }}>
          Host
        </span>
        <input
          style={inputStyle}
          value={host}
          onChange={(e) => setHost(e.target.value)}
          onBlur={() => save({ host })}
          placeholder="0.0.0.0"
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: '#888', width: 72, flexShrink: 0 }}>
          Port
        </span>
        <NumInput
          value={port}
          step={1}
          min={1}
          max={65535}
          precision={0}
          style={{ flex: 1 }}
          onChange={(v) => setPort(Math.round(v))}
          onCommit={(v) => {
            const p = Math.round(v);
            setPort(p);
            save({ port: p });
          }}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: '#888', width: 72, flexShrink: 0 }}>
          Blend
        </span>
        <select
          style={{ ...inputStyle, cursor: 'pointer' }}
          value={blendMode}
          onChange={(e) => {
            setBlendMode(e.target.value);
            save({ blendMode: e.target.value });
          }}
        >
          <option value="override">Override — VMC replaces animation</option>
          <option value="additive">Additive — layered on top</option>
        </select>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: '#888', width: 72, flexShrink: 0 }}>
          Mirror
        </span>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
            fontSize: 12,
            color: '#ccc',
          }}
        >
          <input
            type="checkbox"
            checked={mirror}
            onChange={(e) => {
              setMirror(e.target.checked);
              save({ mirror: e.target.checked });
            }}
            style={{ cursor: 'pointer' }}
          />
          Flip left / right
        </label>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: '#888', width: 72, flexShrink: 0 }}>
          Idle after
        </span>
        <NumInput
          value={poseTimeout}
          step={0.1}
          min={0.1}
          suffix="s"
          style={{ width: 80 }}
          onChange={(v) => setPoseTimeout(v)}
          onCommit={(v) => {
            setPoseTimeout(v);
            save({ poseTimeout: v });
          }}
        />
      </div>

      {/* Face mappers */}
      <div
        style={{
          fontSize: 10,
          color: '#666',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          marginTop: 4,
        }}
      >
        Face Mappers
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {MAPPER_NODES.map(({ id, label, builtinMapping }, idx) => (
          <MapperSection
            key={id}
            nodeId={id}
            label={label}
            builtinMapping={builtinMapping}
            config={mapperConfigs[id]}
            onSave={saveMapperNode}
            targetSuggestions={
              idx === 0
                ? fclSuggestions
                : idx === 1
                  ? exprSuggestions
                  : passSuggestions
            }
          />
        ))}
      </div>

      {/* Local IPs */}
      {localIps.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div
            style={{
              fontSize: 10,
              color: '#666',
              marginBottom: 5,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            This machine's IPs — point your capture app here
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {localIps.map((ip) => (
              <button
                key={ip}
                title={`Set host to ${ip}`}
                style={{
                  background: host === ip ? '#1a3a5a' : '#1e1e1e',
                  border: `1px solid ${host === ip ? '#2563eb' : '#2a2a2a'}`,
                  color: host === ip ? '#7ab' : '#888',
                  borderRadius: 4,
                  padding: '2px 8px',
                  fontSize: 11,
                  cursor: 'pointer',
                  fontFamily: 'monospace',
                }}
                onClick={() => {
                  setHost(ip);
                  save({ host: ip });
                }}
              >
                {ip}
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        style={{ fontSize: 10, color: '#555', lineHeight: 1.4, marginTop: 2 }}
      >
        Works with RhyLive, VSeeFace, VTube Studio, and any VMC-compatible app.
        Set your capture app's OSC output to the IP above and port {port}.
      </div>

      <div style={{ height: 1, background: '#222', margin: '4px 0' }} />
      <CalibrationSection comp={comp} />
    </div>
  );
}

// ── Lipsync props ─────────────────────────────────────────────────────────────

function LipsyncProcessorProps({ comp }: { comp: NodeComponent }) {
  const { updateNodeComponent } = useEditorStore();
  const { projectId } = useParams<{ projectId: string }>();
  const cfg = comp.config as {
    sensitivity?: number;
    vowelTemplates?: VowelTemplates;
  };
  const [sensitivity, setSensitivity] = useState(cfg.sensitivity ?? 1.0);

  const save = (patch: Record<string, unknown>) => {
    const config = { ...comp.config, ...patch };
    updateNodeComponent(comp.id, { config });
    api.updateNodeComponent(comp.id, { config }).catch(() => {});
  };

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: '#888',
    flex: 1,
  };
  const inputStyle: React.CSSProperties = {
    width: 72,
    background: '#2a2a2a',
    border: '1px solid #3a3a3a',
    color: '#e0e0e0',
    borderRadius: 4,
    padding: '2px 6px',
    fontSize: 12,
  };

  return (
    <div>
      <div style={rowStyle}>
        <span style={labelStyle}>Sensitivity</span>
        <input
          type="number"
          style={inputStyle}
          min={0.1}
          max={5}
          step={0.05}
          value={sensitivity}
          onChange={(e) => setSensitivity(Number(e.target.value))}
          onBlur={() => save({ sensitivity })}
        />
      </div>
      <div
        style={{ marginTop: 8, borderTop: '1px solid #2a2a2a', paddingTop: 8 }}
      >
        <button
          style={{
            background: '#2a2a2a',
            border: '1px solid #3a3a3a',
            color: '#ccc',
            borderRadius: 4,
            padding: '4px 10px',
            cursor: 'pointer',
            fontSize: 12,
          }}
          onClick={() =>
            projectId && window.open(`/media-input/${projectId}`, '_blank')
          }
        >
          🎤 Open Media Input
        </button>
      </div>
      <LipsyncCalibration
        templates={cfg.vowelTemplates}
        onSave={(t) => save({ vowelTemplates: t })}
        onReset={() => save({ vowelTemplates: undefined })}
      />
    </div>
  );
}

// ── Lipsync calibration ───────────────────────────────────────────────────────

const VOWEL_KEYS = ['A', 'E', 'I', 'O', 'U'] as const;
type CalibrationStatus = 'idle' | 'capturing' | 'error';

function LipsyncCalibration({
  templates,
  onSave,
  onReset,
}: {
  templates: VowelTemplates | undefined;
  onSave: (t: VowelTemplates) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState<Partial<VowelTemplates>>(templates ?? {});
  const [holding, setHolding] = useState<string | null>(null);
  const [status, setStatus] = useState<CalibrationStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const collectedRef = useRef<Float32Array[]>([]);

  useEffect(
    () => () => {
      micRef.current?.stop();
    },
    []
  );

  const startHold = async (v: string) => {
    setError(null);
    setStatus('capturing');
    setHolding(v);
    collectedRef.current = [];
    try {
      const mic = new MicCapture();
      mic.silenceRms = 0; // disable gate during calibration so even quiet samples land
      mic.onCaptureFrame((mfcc) => {
        // Defensive copy — the callback shares the analyser's working buffer.
        collectedRef.current.push(new Float32Array(mfcc));
      });
      await mic.start();
      micRef.current = mic;
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
      setHolding(null);
    }
  };

  const stopHold = async () => {
    if (!holding || !micRef.current) return;
    const v = holding;
    await micRef.current.stop();
    micRef.current = null;
    setHolding(null);

    const frames = collectedRef.current;
    if (frames.length === 0) {
      setStatus('idle');
      return;
    }
    // Average the MFCC vectors collected during the hold.
    const dim = frames[0].length;
    const avg = new Array<number>(dim).fill(0);
    for (const f of frames) for (let i = 0; i < dim; i++) avg[i] += f[i];
    for (let i = 0; i < dim; i++) avg[i] /= frames.length;
    setDraft({ ...draft, [v]: avg });
    setStatus('idle');
  };

  const canSave = VOWEL_KEYS.every((v) => draft[v] && draft[v]!.length > 0);

  const sectionStyle: React.CSSProperties = {
    marginTop: 12,
    borderTop: '1px solid #2a2a2a',
    paddingTop: 8,
  };
  const headerStyle: React.CSSProperties = {
    fontSize: 11,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  };
  const rowStyle: React.CSSProperties = {
    display: 'flex',
    gap: 4,
    marginBottom: 6,
  };
  const btnStyle = (v: string): React.CSSProperties => ({
    flex: 1,
    background:
      holding === v
        ? '#4a7a5a'
        : draft[v as keyof VowelTemplates]
          ? '#2a3a2a'
          : '#2a2a2a',
    border: '1px solid #3a3a3a',
    color: '#ddd',
    borderRadius: 4,
    padding: '6px 0',
    cursor: 'pointer',
    fontSize: 12,
    userSelect: 'none',
  });
  const actionBtn: React.CSSProperties = {
    background: '#2a2a2a',
    border: '1px solid #3a3a3a',
    color: '#ccc',
    borderRadius: 4,
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 12,
    marginRight: 6,
  };

  return (
    <div style={sectionStyle}>
      <div style={headerStyle}>Vowel Calibration</div>
      <div style={{ fontSize: 11, color: '#666', marginBottom: 8 }}>
        Hold each button while sustaining the vowel sound (~1s).
      </div>
      <div style={rowStyle}>
        {VOWEL_KEYS.map((v) => (
          <button
            key={v}
            style={btnStyle(v)}
            onMouseDown={() => startHold(v)}
            onMouseUp={stopHold}
            onMouseLeave={() => {
              if (holding === v) stopHold();
            }}
            disabled={status === 'capturing' && holding !== v}
          >
            {v}
            {draft[v] ? ' ✓' : ''}
          </button>
        ))}
      </div>
      <div>
        <button
          style={{ ...actionBtn, opacity: canSave ? 1 : 0.4 }}
          disabled={!canSave}
          onClick={() => canSave && onSave(draft as VowelTemplates)}
        >
          Save
        </button>
        <button
          style={actionBtn}
          onClick={() => {
            setDraft({});
            onReset();
          }}
        >
          Reset to defaults
        </button>
      </div>
      {error && (
        <div style={{ marginTop: 6, color: '#d66', fontSize: 11 }}>{error}</div>
      )}
    </div>
  );
}

// ── MediaPipe tracker props ────────────────────────────────────────────────────

function MediapipeTrackerProps({ comp }: { comp: NodeComponent }) {
  const { updateNodeComponent } = useEditorStore();
  const { projectId } = useParams<{ projectId: string }>();
  const cfg = comp.config as {
    enableFace?: boolean;
    enablePose?: boolean;
    enableHands?: boolean;
    useIk?: boolean;
    ikCalibration?: {
      xScale?: number;
      yScale?: number;
      zScale?: number;
      xOffset?: number;
      yOffset?: number;
      zOffset?: number;
      invertX?: boolean;
      invertY?: boolean;
      invertZ?: boolean;
    };
    headCalibration?: {
      pitchGain?: number;
      yawGain?: number;
      rollGain?: number;
      restPitch?: number;
    };
  };
  const headCfg = cfg.headCalibration ?? {};
  const head = {
    pitchGain: headCfg.pitchGain ?? 2.0,
    yawGain: headCfg.yawGain ?? 1.0,
    rollGain: headCfg.rollGain ?? 1.0,
    restPitch: headCfg.restPitch ?? -0.43,
  };
  const useIk = cfg.useIk ?? false;
  const ikCfg = cfg.ikCalibration ?? {};
  const ax = {
    x: {
      scale: ikCfg.xScale ?? 1,
      offset: ikCfg.xOffset ?? 0,
      invert: ikCfg.invertX ?? false,
    },
    y: {
      scale: ikCfg.yScale ?? 1,
      offset: ikCfg.yOffset ?? 0,
      invert: ikCfg.invertY ?? false,
    },
    z: {
      scale: ikCfg.zScale ?? 3,
      offset: ikCfg.zOffset ?? 0,
      invert: ikCfg.invertZ ?? false,
    },
  };

  const save = (patch: Record<string, unknown>) => {
    const config = { ...comp.config, ...patch };
    updateNodeComponent(comp.id, { config });
    api.updateNodeComponent(comp.id, { config }).catch(() => {});
  };

  const saveIk = (patch: Record<string, unknown>) => {
    save({ ikCalibration: { ...ikCfg, ...patch } });
  };
  const saveHead = (patch: Record<string, unknown>) => {
    save({ headCalibration: { ...headCfg, ...patch } });
  };

  const graphId = `mediapipe_tracker:${comp.id}`;
  const [calibFlash, setCalibFlash] = useState<string | null>(null);
  const flashCalib = (msg: string) => {
    setCalibFlash(msg);
    setTimeout(() => setCalibFlash(null), 1800);
  };
  const fireCalib = async (nodeId: string, label: string) => {
    try {
      await fireSignalEvent(graphId, nodeId, 'trigger');
      flashCalib(label);
    } catch {
      flashCalib('Could not reach pipeline — is tracking active?');
    }
  };

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: '#888',
    flex: 1,
  };

  return (
    <div>
      {(
        [
          ['enableFace', 'Face landmarks'],
          ['enablePose', 'Pose (body)'],
          ['enableHands', 'Hand tracking'],
        ] as const
      ).map(([field, label]) => (
        <div key={field} style={rowStyle}>
          <span style={labelStyle}>{label}</span>
          <input
            type="checkbox"
            checked={(cfg[field] as boolean | undefined) ?? true}
            onChange={(e) => save({ [field]: e.target.checked })}
            style={{ cursor: 'pointer' }}
          />
        </div>
      ))}

      <div
        style={{ marginTop: 8, borderTop: '1px solid #2a2a2a', paddingTop: 8 }}
      >
        <div
          style={{
            fontSize: 11,
            color: '#666',
            textTransform: 'uppercase',
            marginBottom: 4,
          }}
        >
          Calibration
        </div>
        <div style={{ fontSize: 10, color: '#777', marginBottom: 2 }}>
          Head/torso — capture in a relaxed neutral stance.
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <button
            style={{
              background: '#2a2a2a',
              border: '1px solid #3a3a3a',
              color: '#ccc',
              borderRadius: 4,
              padding: '4px 10px',
              cursor: 'pointer',
              fontSize: 12,
              flex: 1,
            }}
            onClick={() =>
              fireCalib('head_calib_capture', 'Head neutral captured ✓')
            }
          >
            Capture head
          </button>
          <button
            style={{
              background: '#2a2a2a',
              border: '1px solid #3a3a3a',
              color: '#ccc',
              borderRadius: 4,
              padding: '4px 10px',
              cursor: 'pointer',
              fontSize: 12,
              flex: 1,
            }}
            onClick={() =>
              fireCalib('head_calib_reset', 'Head calibration reset')
            }
          >
            Reset head
          </button>
        </div>
        <div style={{ fontSize: 10, color: '#777', marginBottom: 2 }}>
          Fingers — hold one hand up in the avatar's finger rest pose (for
          VRoid: straight fingers, thumb relaxed-out). The higher hand wins; the
          other side is mirrored from it.
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <button
            style={{
              background: '#2a2a2a',
              border: '1px solid #3a3a3a',
              color: '#ccc',
              borderRadius: 4,
              padding: '4px 10px',
              cursor: 'pointer',
              fontSize: 12,
              flex: 1,
            }}
            onClick={() =>
              fireCalib('finger_calib_capture', 'Finger neutral captured ✓')
            }
          >
            Capture fingers
          </button>
          <button
            style={{
              background: '#2a2a2a',
              border: '1px solid #3a3a3a',
              color: '#ccc',
              borderRadius: 4,
              padding: '4px 10px',
              cursor: 'pointer',
              fontSize: 12,
              flex: 1,
            }}
            onClick={() =>
              fireCalib('finger_calib_reset', 'Finger calibration reset')
            }
          >
            Reset fingers
          </button>
        </div>
        {calibFlash && (
          <div style={{ fontSize: 11, color: '#7d7', marginBottom: 6 }}>
            {calibFlash}
          </div>
        )}

        <div style={rowStyle}>
          <span style={labelStyle}>Use IK arms</span>
          <input
            type="checkbox"
            checked={useIk}
            onChange={(e) => save({ useIk: e.target.checked })}
            style={{ cursor: 'pointer' }}
          />
        </div>
        <div style={{ fontSize: 10, color: '#555', marginBottom: 6 }}>
          When off, arms are driven by per-bone quaternions (lower fidelity but
          always stable).
        </div>
        <div
          style={{
            fontSize: 11,
            color: '#666',
            textTransform: 'uppercase',
            marginBottom: 4,
          }}
        >
          IK calibration{' '}
          <span style={{ textTransform: 'none', color: '#555' }}>
            (X is symmetric: +offset spreads outward)
          </span>
        </div>
        {(['x', 'y', 'z'] as const).map((axis) => {
          const a = ax[axis];
          const scaleField = `${axis}Scale` as const;
          const offsetField = `${axis}Offset` as const;
          const invertField = `invert${axis.toUpperCase()}` as
            | 'invertX'
            | 'invertY'
            | 'invertZ';
          return (
            <div key={axis} style={{ marginBottom: 4 }}>
              <div style={{ fontSize: 10, color: '#777', marginBottom: 2 }}>
                {axis.toUpperCase()} axis
              </div>
              <SliderInput
                label="Scale"
                value={a.scale}
                min={0}
                max={8}
                step={0.1}
                precision={1}
                onChange={(v) => saveIk({ [scaleField]: v })}
              />
              <SliderInput
                label="Offset"
                value={a.offset}
                min={-0.5}
                max={0.5}
                step={0.01}
                precision={2}
                onChange={(v) => saveIk({ [offsetField]: v })}
              />
              <div style={rowStyle}>
                <span style={labelStyle}>Invert</span>
                <input
                  type="checkbox"
                  checked={a.invert}
                  onChange={(e) => saveIk({ [invertField]: e.target.checked })}
                  style={{ cursor: 'pointer' }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{ marginTop: 8, borderTop: '1px solid #2a2a2a', paddingTop: 8 }}
      >
        <div
          style={{
            fontSize: 11,
            color: '#666',
            textTransform: 'uppercase',
            marginBottom: 4,
          }}
        >
          Head calibration{' '}
          <span style={{ textTransform: 'none', color: '#555' }}>
            (gains amplify rotation axes; rest pitch shifts neutral nod)
          </span>
        </div>
        <SliderInput
          label="Pitch gain"
          value={head.pitchGain}
          min={0.5}
          max={5}
          step={0.1}
          precision={1}
          onChange={(v) => saveHead({ pitchGain: v })}
        />
        <SliderInput
          label="Yaw gain"
          value={head.yawGain}
          min={0.5}
          max={5}
          step={0.1}
          precision={1}
          onChange={(v) => saveHead({ yawGain: v })}
        />
        <SliderInput
          label="Roll gain"
          value={head.rollGain}
          min={0.5}
          max={5}
          step={0.1}
          precision={1}
          onChange={(v) => saveHead({ rollGain: v })}
        />
        <SliderInput
          label="Rest pitch"
          value={head.restPitch}
          min={-1.0}
          max={1.0}
          step={0.01}
          precision={2}
          onChange={(v) => saveHead({ restPitch: v })}
        />
      </div>

      <div
        style={{ marginTop: 8, borderTop: '1px solid #2a2a2a', paddingTop: 8 }}
      >
        <button
          style={{
            background: '#2a2a2a',
            border: '1px solid #3a3a3a',
            color: '#ccc',
            borderRadius: 4,
            padding: '4px 10px',
            cursor: 'pointer',
            fontSize: 12,
          }}
          onClick={() =>
            projectId && window.open(`/media-input/${projectId}`, '_blank')
          }
        >
          📷 Open Media Input
        </button>
      </div>
    </div>
  );
}

function ApiControllerProps({ comp }: { comp: NodeComponent }) {
  const { projectId } = useParams<{ projectId: string }>();
  const [copied, setCopied] = useState(false);
  const baseUrl = projectId
    ? `${window.location.origin}/api/projects/${projectId}/nodes/${comp.nodeId}/api-controller`
    : '';

  const copy = () => {
    if (!baseUrl) return;
    navigator.clipboard
      .writeText(baseUrl)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* ignore */
      });
  };

  return (
    <div>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
        Component API base URL
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
        <input
          readOnly
          value={baseUrl}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            flex: 1,
            background: '#1a1a1a',
            border: '1px solid #2a2a2a',
            color: '#ccc',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 11,
            fontFamily: 'monospace',
          }}
        />
        <button
          onClick={copy}
          disabled={!baseUrl}
          style={{
            background: '#2a2a2a',
            border: '1px solid #3a3a3a',
            color: copied ? '#7fd17f' : '#ccc',
            borderRadius: 4,
            padding: '4px 10px',
            cursor: baseUrl ? 'pointer' : 'not-allowed',
            fontSize: 12,
          }}
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <div
        style={{ fontSize: 11, color: '#666', marginTop: 6, lineHeight: 1.5 }}
      >
        Append <code style={{ color: '#aaa' }}>/animation</code>,{' '}
        <code style={{ color: '#aaa' }}>/animation-queue</code>,{' '}
        <code style={{ color: '#aaa' }}>/blendshapes</code>, or{' '}
        <code style={{ color: '#aaa' }}>/state</code>.
      </div>
    </div>
  );
}

// ── Breathing component panel ────────────────────────────────────────────────

function BreathingProps({ comp }: { comp: NodeComponent }) {
  const { updateNodeComponent } = useEditorStore();
  const cfg = (comp.config ?? {}) as {
    chestAmplitude?: number;
    shoulderAmplitude?: number;
  };
  const [chest, setChest] = useState(cfg.chestAmplitude ?? 0.04);
  const [shoulder, setShoulder] = useState(cfg.shoulderAmplitude ?? 0.02);

  useEffect(() => {
    setChest(cfg.chestAmplitude ?? 0.04);
    setShoulder(cfg.shoulderAmplitude ?? 0.02);
  }, [comp.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (patch: Record<string, unknown>) => {
    const config = { ...comp.config, ...patch };
    updateNodeComponent(comp.id, { config });
    api.updateNodeComponent(comp.id, { config }).catch(() => {});
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{ fontSize: 12, color: '#888', width: 100, flexShrink: 0 }}
        >
          Chest amplitude
        </span>
        <NumInput
          value={chest}
          step={0.01}
          min={0}
          suffix="rad"
          style={{ width: 96 }}
          onChange={(v) => setChest(v)}
          onCommit={(v) => {
            setChest(v);
            save({ chestAmplitude: v });
          }}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{ fontSize: 12, color: '#888', width: 100, flexShrink: 0 }}
        >
          Shoulder lift
        </span>
        <NumInput
          value={shoulder}
          step={0.01}
          min={0}
          suffix="rad"
          style={{ width: 96 }}
          onChange={(v) => setShoulder(v)}
          onCommit={(v) => {
            setShoulder(v);
            save({ shoulderAmplitude: v });
          }}
        />
      </div>
    </div>
  );
}

// ── Component dispatcher ──────────────────────────────────────────────────────

function ComponentProps({ comp }: { comp: NodeComponent }) {
  switch (comp.kind) {
    case 'vmc_receiver':
      return <VmcReceiverProps comp={comp} />;
    case 'lipsync_processor':
      return <LipsyncProcessorProps comp={comp} />;
    case 'mediapipe_tracker':
      return <MediapipeTrackerProps comp={comp} />;
    case 'api_controller':
      return <ApiControllerProps comp={comp} />;
    case 'breathing':
      return <BreathingProps comp={comp} />;
    default:
      return (
        <div style={{ fontSize: 12, color: '#555', fontStyle: 'italic' }}>
          No configurable properties.
        </div>
      );
  }
}

// ---------- Camera effect property panel ----------

function EffectRow({
  label,
  cfg,
  field,
  step,
  min,
  max,
  onSave,
}: {
  label: string;
  cfg: Record<string, unknown>;
  field: string;
  step?: number;
  min?: number;
  max?: number;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const value = (cfg[field] as number) ?? 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12, color: '#888', flex: 1 }}>{label}</span>
      <NumInput
        value={value}
        step={step ?? 0.01}
        min={min}
        max={max}
        onCommit={(v) => onSave({ [field]: v })}
        style={{ width: 96 }}
      />
    </div>
  );
}

function EffectPanel({ effectId, kind }: { effectId: string; kind: string }) {
  const effect = useEditorStore((s) =>
    s.cameraEffects.find((e) => e.id === effectId)
  );
  const updateCameraEffect = useEditorStore((s) => s.updateCameraEffect);

  if (!effect) return null;
  const cfg = effect.config;
  const ek = CAMERA_EFFECT_KINDS.find((k) => k.kind === kind)!;

  const save = (patch: Record<string, unknown>) => {
    const config = { ...cfg, ...patch };
    updateCameraEffect(effectId, { config });
    api.updateCameraEffect(effectId, { config }).catch(() => {});
  };

  const TONE_MAPPING_MODES: { label: string; value: number }[] = [
    { label: 'ACES Filmic', value: 6 },
    { label: 'AGX', value: 7 },
    { label: 'Neutral', value: 8 },
    { label: 'Reinhard', value: 1 },
    { label: 'Reinhard 2', value: 2 },
    { label: 'Reinhard 2 Adaptive', value: 3 },
    { label: 'Cineon', value: 5 },
    { label: 'Linear', value: 0 },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {kind === 'fx_tone_mapping' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#888', flex: 1 }}>Mode</span>
          <select
            value={(cfg.mode as number) ?? 6}
            onChange={(e) => save({ mode: Number(e.target.value) })}
            style={{
              background: '#2a2a2a',
              border: '1px solid #3a3a3a',
              color: '#e0e0e0',
              borderRadius: 4,
              padding: '3px 6px',
              fontSize: 12,
            }}
          >
            {TONE_MAPPING_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {kind === 'fx_brightness_contrast' && (
        <>
          <EffectRow
            label="Brightness"
            cfg={cfg}
            field="brightness"
            step={0.01}
            min={-1}
            max={1}
            onSave={save}
          />
          <EffectRow
            label="Contrast"
            cfg={cfg}
            field="contrast"
            step={0.01}
            min={-1}
            max={1}
            onSave={save}
          />
        </>
      )}
      {kind === 'fx_hue_saturation' && (
        <>
          <EffectRow
            label="Hue"
            cfg={cfg}
            field="hue"
            step={0.01}
            min={-Math.PI}
            max={Math.PI}
            onSave={save}
          />
          <EffectRow
            label="Saturation"
            cfg={cfg}
            field="saturation"
            step={0.01}
            min={-1}
            max={1}
            onSave={save}
          />
        </>
      )}
      {kind === 'fx_sepia' && (
        <EffectRow
          label="Intensity"
          cfg={cfg}
          field="intensity"
          step={0.01}
          min={0}
          max={1}
          onSave={save}
        />
      )}
      {kind === 'fx_bloom' && (
        <>
          <EffectRow
            label="Intensity"
            cfg={cfg}
            field="intensity"
            step={0.1}
            min={0}
            onSave={save}
          />
          <EffectRow
            label="Lum. Threshold"
            cfg={cfg}
            field="luminanceThreshold"
            step={0.01}
            min={0}
            max={1}
            onSave={save}
          />
          <EffectRow
            label="Lum. Smoothing"
            cfg={cfg}
            field="luminanceSmoothing"
            step={0.005}
            min={0}
            max={1}
            onSave={save}
          />
        </>
      )}
      {kind === 'fx_depth_of_field' &&
        (() => {
          const autofocus = (cfg.autofocus as boolean) ?? false;
          const afMode = (cfg.afMode as string) ?? 'point';
          const rowStyle: React.CSSProperties = {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          };
          const labelStyle: React.CSSProperties = {
            fontSize: 12,
            color: '#888',
            flex: 1,
          };
          const selectStyle: React.CSSProperties = {
            background: '#2a2a2a',
            border: '1px solid #3a3a3a',
            color: '#e0e0e0',
            borderRadius: 4,
            padding: '3px 6px',
            fontSize: 12,
          };
          return (
            <>
              <div style={{ height: 1, background: '#222', margin: '2px 0' }} />
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={autofocus}
                  onChange={(e) => save({ autofocus: e.target.checked })}
                />
                <span style={{ color: autofocus ? '#7ab' : '#888' }}>
                  Autofocus (Experimental)
                </span>
              </label>
              {autofocus ? (
                <>
                  <div style={rowStyle}>
                    <span style={labelStyle}>AF Mode</span>
                    <select
                      value={afMode}
                      onChange={(e) => save({ afMode: e.target.value })}
                      style={selectStyle}
                    >
                      <option value="point">Point</option>
                      <option value="percentile">Percentile</option>
                    </select>
                  </div>
                  {afMode === 'point' && (
                    <>
                      <EffectRow
                        label="Point X"
                        cfg={cfg}
                        field="afPointX"
                        step={0.01}
                        min={0}
                        max={1}
                        onSave={save}
                      />
                      <EffectRow
                        label="Point Y"
                        cfg={cfg}
                        field="afPointY"
                        step={0.01}
                        min={0}
                        max={1}
                        onSave={save}
                      />
                    </>
                  )}
                  {afMode === 'percentile' && (
                    <EffectRow
                      label="Percentile %"
                      cfg={cfg}
                      field="afPercentile"
                      step={1}
                      min={1}
                      max={99}
                      onSave={save}
                    />
                  )}
                  <div
                    style={{ height: 1, background: '#222', margin: '2px 0' }}
                  />
                  <EffectRow
                    label="AF Speed"
                    cfg={cfg}
                    field="afSpeed"
                    step={0.1}
                    min={0.1}
                    max={20}
                    onSave={save}
                  />
                  <EffectRow
                    label="AF Delay"
                    cfg={cfg}
                    field="afDelay"
                    step={0.05}
                    min={0}
                    max={2}
                    onSave={save}
                  />
                  <EffectRow
                    label="Overshoot"
                    cfg={cfg}
                    field="afOvershoot"
                    step={0.01}
                    min={0}
                    max={1}
                    onSave={save}
                  />
                </>
              ) : (
                <EffectRow
                  label="Focus Distance"
                  cfg={cfg}
                  field="worldFocusDistance"
                  step={0.1}
                  min={0}
                  onSave={save}
                />
              )}
              <div style={{ height: 1, background: '#222', margin: '2px 0' }} />
              <EffectRow
                label="Focus Range"
                cfg={cfg}
                field="worldFocusRange"
                step={0.1}
                min={0}
                onSave={save}
              />
              <EffectRow
                label="Bokeh Scale"
                cfg={cfg}
                field="bokehScale"
                step={0.1}
                min={0}
                onSave={save}
              />
            </>
          );
        })()}
      {kind === 'fx_chromatic_aberration' && (
        <>
          <EffectRow
            label="Offset X"
            cfg={cfg}
            field="offsetX"
            step={0.001}
            min={0}
            max={0.05}
            onSave={save}
          />
          <EffectRow
            label="Offset Y"
            cfg={cfg}
            field="offsetY"
            step={0.001}
            min={0}
            max={0.05}
            onSave={save}
          />
        </>
      )}
      {kind === 'fx_ssao' && (
        <>
          <EffectRow
            label="Intensity"
            cfg={cfg}
            field="intensity"
            step={0.1}
            min={0}
            max={10}
            onSave={save}
          />
          <EffectRow
            label="Radius"
            cfg={cfg}
            field="radius"
            step={0.01}
            min={0.001}
            max={1}
            onSave={save}
          />
          <EffectRow
            label="Bias"
            cfg={cfg}
            field="bias"
            step={0.001}
            min={0}
            max={0.1}
            onSave={save}
          />
          <EffectRow
            label="Rings"
            cfg={cfg}
            field="rings"
            step={1}
            min={1}
            max={16}
            onSave={save}
          />
          <EffectRow
            label="Samples"
            cfg={cfg}
            field="samples"
            step={1}
            min={1}
            max={64}
            onSave={save}
          />
        </>
      )}
      {kind === 'fx_outline' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#888', flex: 1 }}>Color</span>
            <input
              type="color"
              value={(cfg.color as string) ?? '#000000'}
              onChange={(e) => save({ color: e.target.value })}
              style={{
                width: 36,
                height: 24,
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            />
          </div>
          <EffectRow
            label="Threshold"
            cfg={cfg}
            field="threshold"
            step={0.0001}
            min={0}
            onSave={save}
          />
          <EffectRow
            label="Thickness"
            cfg={cfg}
            field="thickness"
            step={0.5}
            min={0.5}
            onSave={save}
          />
          <EffectRow
            label="Alpha"
            cfg={cfg}
            field="alpha"
            step={0.01}
            min={0}
            max={1}
            onSave={save}
          />
          <EffectRow
            label="Normal Strength"
            cfg={cfg}
            field="normalStrength"
            step={0.05}
            min={0}
            onSave={save}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#888', flex: 1 }}>
              Blend Mode
            </span>
            <select
              value={(cfg.blendMode as string) ?? 'NORMAL'}
              onChange={(e) => save({ blendMode: e.target.value })}
              style={{
                background: '#2a2a2a',
                border: '1px solid #3a3a3a',
                color: '#e0e0e0',
                borderRadius: 4,
                padding: '3px 6px',
                fontSize: 12,
              }}
            >
              {[
                'NORMAL',
                'MULTIPLY',
                'SCREEN',
                'OVERLAY',
                'DARKEN',
                'LIGHTEN',
                'ADD',
                'DIFFERENCE',
                'EXCLUSION',
                'SOFT_LIGHT',
                'HARD_LIGHT',
                'COLOR_BURN',
                'COLOR_DODGE',
                'SUBTRACT',
              ].map((m) => (
                <option key={m} value={m}>
                  {m.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      {kind === 'fx_vignette' && (
        <>
          <EffectRow
            label="Offset"
            cfg={cfg}
            field="offset"
            step={0.01}
            min={0}
            max={1}
            onSave={save}
          />
          <EffectRow
            label="Darkness"
            cfg={cfg}
            field="darkness"
            step={0.01}
            min={0}
            max={1}
            onSave={save}
          />
        </>
      )}
      {kind === 'fx_noise' && (
        <EffectRow
          label="Opacity"
          cfg={cfg}
          field="opacity"
          step={0.01}
          min={0}
          max={1}
          onSave={save}
        />
      )}
      {kind === 'fx_scanline' && (
        <>
          <EffectRow
            label="Density"
            cfg={cfg}
            field="density"
            step={0.05}
            min={0}
            onSave={save}
          />
          <EffectRow
            label="Opacity"
            cfg={cfg}
            field="opacity"
            step={0.01}
            min={0}
            max={1}
            onSave={save}
          />
        </>
      )}
      {kind === 'fx_pixelation' && (
        <EffectRow
          label="Granularity"
          cfg={cfg}
          field="granularity"
          step={1}
          min={1}
          onSave={save}
        />
      )}
      {kind === 'fx_ascii' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#888', flex: 1 }}>
              Characters
            </span>
            <input
              value={(cfg.characters as string) ?? ' .:-+*=%@#'}
              onChange={(e) => save({ characters: e.target.value })}
              style={{
                background: '#2a2a2a',
                border: '1px solid #3a3a3a',
                color: '#e0e0e0',
                borderRadius: 4,
                padding: '3px 6px',
                fontSize: 12,
                width: 120,
              }}
            />
          </div>
          <EffectRow
            label="Font Size"
            cfg={cfg}
            field="fontSize"
            step={1}
            min={8}
            onSave={save}
          />
          <EffectRow
            label="Cell Size"
            cfg={cfg}
            field="cellSize"
            step={1}
            min={4}
            onSave={save}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#888', flex: 1 }}>Color</span>
            <input
              type="color"
              value={(cfg.color as string) ?? '#ffffff'}
              onChange={(e) => save({ color: e.target.value })}
              style={{
                width: 36,
                height: 24,
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#888', flex: 1 }}>Invert</span>
            <input
              type="checkbox"
              checked={(cfg.invert as boolean) ?? false}
              onChange={(e) => save({ invert: e.target.checked })}
            />
          </div>
        </>
      )}
      {kind === 'fx_dot_screen' && (
        <>
          <EffectRow
            label="Angle"
            cfg={cfg}
            field="angle"
            step={0.01}
            min={0}
            onSave={save}
          />
          <EffectRow
            label="Scale"
            cfg={cfg}
            field="scale"
            step={0.05}
            min={0.1}
            onSave={save}
          />
        </>
      )}
      {kind === 'fx_glitch' && (
        <>
          {(
            [
              ['Delay min', 'delay', 0, 0.1],
              ['Delay max', 'delay', 1, 0.1],
              ['Strength min', 'strength', 0, 0.05],
              ['Strength max', 'strength', 1, 0.05],
            ] as [string, string, number, number][]
          ).map(([label, field, idx, step]) => {
            const pair =
              (cfg[field] as number[]) ??
              (field === 'delay' ? [1.5, 3.5] : [0.3, 1.0]);
            return (
              <div
                key={label}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <span style={{ fontSize: 12, color: '#888', flex: 1 }}>
                  {label}
                </span>
                <NumInput
                  value={pair[idx]}
                  step={step}
                  min={0}
                  onCommit={(v) => {
                    const next = [...pair];
                    next[idx] = v;
                    save({ [field]: next });
                  }}
                  style={{ width: 96 }}
                />
              </div>
            );
          })}
          <EffectRow
            label="Columns"
            cfg={cfg}
            field="columns"
            step={0.01}
            min={0}
            max={1}
            onSave={save}
          />
          <EffectRow
            label="Ratio"
            cfg={cfg}
            field="ratio"
            step={0.05}
            min={0}
            max={1}
            onSave={save}
          />
        </>
      )}
      {kind === 'fx_tilt_shift' && (
        <>
          <EffectRow
            label="Offset"
            cfg={cfg}
            field="offset"
            step={0.01}
            min={-1}
            max={1}
            onSave={save}
          />
          <EffectRow
            label="Rotation"
            cfg={cfg}
            field="rotation"
            step={0.01}
            onSave={save}
          />
          <EffectRow
            label="Focus Area"
            cfg={cfg}
            field="focusArea"
            step={0.01}
            min={0}
            max={1}
            onSave={save}
          />
          <EffectRow
            label="Feather"
            cfg={cfg}
            field="feather"
            step={0.01}
            min={0}
            max={1}
            onSave={save}
          />
        </>
      )}
      {kind === 'fx_water' && (
        <EffectRow
          label="Factor"
          cfg={cfg}
          field="factor"
          step={0.05}
          min={0}
          onSave={save}
        />
      )}
      <div style={{ fontSize: 10, color: '#555', marginTop: 4 }}>
        {ek.description}
      </div>
    </div>
  );
}

// ---------- Scene settings ----------

function SceneSettings({
  sceneId,
  sceneName,
  broadcastTickHz,
  onChange,
}: {
  sceneId: string;
  sceneName: string;
  broadcastTickHz: number;
  onChange: (hz: number) => void;
}) {
  const [local, setLocal] = useState<string>(String(broadcastTickHz));
  useEffect(() => {
    setLocal(String(broadcastTickHz));
  }, [sceneId, broadcastTickHz]);

  const commit = () => {
    const parsed = Number.parseFloat(local);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setLocal(String(broadcastTickHz));
      return;
    }
    const clamped = Math.max(1, Math.min(240, Math.round(parsed)));
    setLocal(String(clamped));
    if (clamped !== broadcastTickHz) onChange(clamped);
  };

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
        <span style={{ fontSize: 18 }}>🎬</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e0' }}>
            Scene Settings
          </div>
          <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>
            {sceneName}
          </div>
        </div>
      </div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>
          Broadcast Tick Rate (Hz)
        </div>
        <input
          type="number"
          min={1}
          max={240}
          step={1}
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          }}
          style={{
            width: '100%',
            background: '#1c1c1c',
            border: '1px solid #2a2a2a',
            borderRadius: 3,
            padding: '6px 8px',
            color: '#e0e0e0',
            fontSize: 12,
            fontFamily: 'inherit',
          }}
        />
        <div
          style={{ fontSize: 10, color: '#555', marginTop: 4, lineHeight: 1.4 }}
        >
          How often the server merges pose + blendshape sources and broadcasts a
          frame. Default 60. Lower values reduce bandwidth at the cost of
          smoothness.
        </div>
      </div>
    </>
  );
}

// ---------- Main panel ----------

export function PropertiesPanel() {
  const { projectId } = useParams<{ projectId: string }>();
  const {
    nodes,
    selectedNodeId,
    updateNode: storeUpdateNode,
    assets,
    selectedComponentId,
    nodeComponents,
    fbxDebugVisible,
    setFbxDebugVisible,
    vrmExpressionsByNode,
    vrmMorphTargetsByNode,
    componentKinds,
    cameraEffects,
    selectedEffect,
    scenes,
    activeSceneId,
    sceneSelected,
    updateSceneItem,
    composeLayers,
    selectedComposeLayerId,
  } = useEditorStore();
  const activeScene = scenes.find((s) => s.id === activeSceneId) ?? null;
  const animAssets: AssetFile[] = assets.filter((a) => a.kind === 'animation');
  const modelAssets: AssetFile[] = assets.filter((a) => a.kind === 'model');
  const node = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedComp =
    nodeComponents.find((c) => c.id === selectedComponentId) ?? null;
  const selectedCompType = selectedComp
    ? componentKinds.find((ct) => ct.kind === selectedComp.kind)
    : null;
  const selectedEffectRecord = selectedEffect
    ? cameraEffects.find(
        (e) =>
          e.nodeId === selectedEffect.nodeId && e.kind === selectedEffect.kind
      )
    : null;
  const selectedEffectNode = selectedEffect
    ? nodes.find((n) => n.id === selectedEffect.nodeId)
    : null;
  const selectedEffectKind = selectedEffect
    ? CAMERA_EFFECT_KINDS.find((k) => k.kind === selectedEffect.kind)
    : null;

  const { canRecord, recordKeyframe, recordKeyframes } = useTrackClipRecorder();
  const [name, setName] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const focusNameNonce = useEditorStore((s) => s.focusNameNonce);
  const lastFocusNonce = useRef(focusNameNonce);
  const flashBottomTab = useEditorStore((s) => s.flashBottomTab);
  const [transform, setTransform] = useState<Transform>({
    x: 0,
    y: 0,
    z: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    sx: 1,
    sy: 1,
    sz: 1,
    opacity: 1,
    castShadow: true,
    receiveShadow: true,
  });
  // Ref always holds the latest transform — avoids stale closures in onBlur handlers
  const transformRef = useRef<Transform>({
    x: 0,
    y: 0,
    z: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    sx: 1,
    sy: 1,
    sz: 1,
    opacity: 1,
    castShadow: true,
    receiveShadow: true,
  });
  const isEditingTransform = useRef(false);
  const [light, setLight] = useState<LightProps>({
    lightType: 'point',
    color: '#ffffff',
    intensity: 1,
  });
  const [camera, setCamera] = useState<CameraProps>({
    projection: 'perspective',
    fov: 50,
    near: 0.1,
    far: 1000,
    orthoSize: 2,
    shadowsEnabled: false,
    shadowQuality: 'medium',
    envIntensity: 1,
  });
  const [animPlaying, setAnimPlaying] = useState(true);
  const [animTime, setAnimTime] = useState(0);
  const [hasAnim, setHasAnim] = useState(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!node) return;
    setName(node.name);
    const t = getTransform(node);
    setTransform(t);
    transformRef.current = t;
    if (node.kind === 'light') setLight(getLightProps(node));
    if (node.kind === 'camera') setCamera(getCameraProps(node));
  }, [node?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus + select the name field on request (e.g. right after a node is
  // created from the Create palette, so the user can rename immediately).
  useEffect(() => {
    if (focusNameNonce === lastFocusNonce.current) return;
    lastFocusNonce.current = focusNameNonce;
    const el = nameInputRef.current;
    if (!el) return;
    // Defer one frame so the [node?.id] effect's setName has landed first.
    requestAnimationFrame(() => {
      el.focus();
      el.select();
    });
  }, [focusNameNonce]);

  // Sync transform inputs when gizmo updates the store (skip while user is typing)
  const nodeTransformStr = node
    ? JSON.stringify(node.components?.transform)
    : null;
  useEffect(() => {
    if (!node || isEditingTransform.current) return;
    const t = getTransform(node);
    setTransform(t);
    transformRef.current = t;
  }, [nodeTransformStr]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setAnimPlaying(true);
    setAnimTime(0);
    setHasAnim(false);
    if (!node?.id) return;
    if (animRegistry.has(node.id)) {
      setHasAnim(true);
      return;
    }
    const iv = setInterval(() => {
      if (animRegistry.has(node.id)) {
        setHasAnim(true);
        clearInterval(iv);
      }
    }, 100);
    return () => clearInterval(iv);
  }, [node?.id]);

  useEffect(() => {
    const entry = node ? animRegistry.get(node.id) : null;
    if (!entry || !animPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }
    const tick = () => {
      setAnimTime(entry.action.time / entry.duration);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [node?.id, animPlaying]);

  const panelShell = (children: React.ReactNode) => (
    <div
      style={{
        width: 280,
        flexShrink: 0,
        background: '#141414',
        borderLeft: '1px solid #2a2a2a',
        overflowY: 'auto',
        fontFamily: 'system-ui, sans-serif',
        color: '#e0e0e0',
      }}
    >
      <div style={{ padding: '14px 16px' }}>{children}</div>
    </div>
  );

  // Compose layer selected — show layer properties.
  const selectedComposeLayer = selectedComposeLayerId
    ? composeLayers.find((l) => l.id === selectedComposeLayerId)
    : null;
  if (selectedComposeLayer) {
    return panelShell(<ComposeLayerProperties layer={selectedComposeLayer} />);
  }

  // Effect selected — show focused effect panel.
  if (
    selectedEffect &&
    selectedEffectRecord &&
    selectedEffectNode &&
    selectedEffectKind
  ) {
    return panelShell(
      <>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 14,
          }}
        >
          <span style={{ fontSize: 18 }}>{selectedEffectKind.icon}</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e0' }}>
              {selectedEffectKind.label}
            </div>
            <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>
              {selectedEffectNode.name}
            </div>
          </div>
        </div>
        <EffectPanel
          effectId={selectedEffectRecord.id}
          kind={selectedEffect.kind}
        />
      </>
    );
  }

  if (sceneSelected && activeScene) {
    return panelShell(
      <SceneSettings
        sceneId={activeScene.id}
        sceneName={activeScene.name}
        broadcastTickHz={activeScene.runtimeSettings.broadcastTickHz ?? 60}
        onChange={(hz) => {
          // Optimistic store update so the input stays responsive.
          updateSceneItem(activeScene.id, {
            runtimeSettings: {
              ...activeScene.runtimeSettings,
              broadcastTickHz: hz,
            },
          });
          void updateScene(activeScene.id, {
            runtimeSettings: { broadcastTickHz: hz },
          });
        }}
      />
    );
  }

  if (!node && !selectedComp) {
    return (
      <div
        style={{
          width: 280,
          flexShrink: 0,
          background: '#141414',
          borderLeft: '1px solid #2a2a2a',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#555',
          fontSize: 13,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        Select a node to edit its properties.
      </div>
    );
  }

  // Component selected without a parent node selected — show a focused component panel.
  if (!node && selectedComp && selectedCompType) {
    return panelShell(
      <>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 14,
          }}
        >
          <span style={{ fontSize: 18 }}>{selectedCompType.icon}</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e0' }}>
              {selectedCompType.label}
            </div>
            <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>
              {selectedCompType.description}
            </div>
          </div>
        </div>
        <ComponentProps comp={selectedComp} />
      </>
    );
  }

  // At this point node is guaranteed to be non-null (component-only path handled above).
  if (!node) return null;

  const saveName = () => {
    if (name === node.name) return;
    storeUpdateNode(node.id, { name });
    api
      .updateNode(node.id, { name })
      .catch(() => storeUpdateNode(node.id, { name: node.name }));
  };

  // Called on blur: applies to Viewport + persists to DB in one shot.
  // Uses the ref (not state) so the value is always current regardless of render timing.
  const saveTransform = () => {
    const t = transformRef.current;
    const components = {
      ...node.components,
      transform: { type: 'transform', ...t },
    };
    storeUpdateNode(node.id, { components });
    api.updateNode(node.id, { components }).catch(() => {});
  };

  const saveLight = (l: LightProps) => {
    const components = { ...node.components, light: { type: 'light', ...l } };
    storeUpdateNode(node.id, { components });
    api.updateNode(node.id, { components }).catch(() => {});
  };

  const saveCamera = (c: CameraProps) => {
    // Merge over the existing camera component so fields not covered by
    // CameraProps (e.g. backgroundImage) survive the write.
    const components = {
      ...node.components,
      camera: { ...(node.components?.camera as object), type: 'camera', ...c },
    };
    storeUpdateNode(node.id, { components });
    api.updateNode(node.id, { components }).catch(() => {});
  };

  return (
    <div
      style={{
        width: 280,
        flexShrink: 0,
        background: '#141414',
        borderLeft: '1px solid #2a2a2a',
        fontFamily: 'system-ui, sans-serif',
        color: '#e0e0e0',
        overflowY: 'auto',
      }}
    >
      {/* Header */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #2a2a2a' }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: '#888',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          Properties
        </span>
      </div>

      <div style={{ padding: '12px 14px' }}>
        {/* Name */}
        <div style={sectionHeader}>Name</div>
        <input
          ref={nameInputRef}
          style={textInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
        />

        {/* Kind badge */}
        <div style={{ marginTop: 10 }}>
          <span
            style={{
              display: 'inline-block',
              background: '#2a2a2a',
              border: '1px solid #3a3a3a',
              borderRadius: 4,
              padding: '2px 8px',
              fontSize: 11,
              color: '#aaa',
            }}
          >
            {node.kind}
          </span>
        </div>

        {/* Transform */}
        <div style={sectionHeader}>Transform</div>

        <VecInput
          groupLabel="Position"
          labels={['X', 'Y', 'Z']}
          values={[transform.x, transform.y, transform.z]}
          onChange={(next, axis) => {
            isEditingTransform.current = true;
            const t = {
              ...transformRef.current,
              x: next[0],
              y: next[1],
              z: next[2],
            };
            transformRef.current = t;
            setTransform(t);
            // Suppress any active clip override for this axis so the user sees
            // their typed value land; cleared on the next clip event.
            const path =
              axis === 0
                ? 'position.x'
                : axis === 1
                  ? 'position.y'
                  : 'position.z';
            useEditorStore
              .getState()
              .suppressOverride('scene_node', node.id, path);
          }}
          onCommit={() => {
            isEditingTransform.current = false;
            saveTransform();
          }}
          canRecord={canRecord}
          onSetAxisKeyframe={(axis, value) => {
            const path =
              axis === 0
                ? 'position.x'
                : axis === 1
                  ? 'position.y'
                  : 'position.z';
            return recordKeyframe({
              targetKind: 'scene_node',
              targetId: node.id,
              paramPath: path,
              value,
            });
          }}
          onSetGroupKeyframe={() =>
            recordKeyframes([
              {
                targetKind: 'scene_node',
                targetId: node.id,
                paramPath: 'position.x',
                value: transformRef.current.x,
              },
              {
                targetKind: 'scene_node',
                targetId: node.id,
                paramPath: 'position.y',
                value: transformRef.current.y,
              },
              {
                targetKind: 'scene_node',
                targetId: node.id,
                paramPath: 'position.z',
                value: transformRef.current.z,
              },
            ])
          }
          style={{ marginBottom: 8 }}
        />

        {/* Rotation is stored in radians on the transform component but edited in degrees;
            convert at the UI boundary so VecInput stays unit-agnostic. */}
        <VecInput
          groupLabel="Rotation (deg)"
          labels={['X', 'Y', 'Z']}
          values={[transform.rx / RAD, transform.ry / RAD, transform.rz / RAD]}
          step={1}
          precision={2}
          onChange={(next, axis) => {
            isEditingTransform.current = true;
            const t = {
              ...transformRef.current,
              rx: next[0] * RAD,
              ry: next[1] * RAD,
              rz: next[2] * RAD,
            };
            transformRef.current = t;
            setTransform(t);
            const path =
              axis === 0
                ? 'rotation.x'
                : axis === 1
                  ? 'rotation.y'
                  : 'rotation.z';
            useEditorStore
              .getState()
              .suppressOverride('scene_node', node.id, path);
          }}
          onCommit={() => {
            isEditingTransform.current = false;
            saveTransform();
          }}
          canRecord={canRecord}
          onSetAxisKeyframe={(axis) => {
            const [path, rad] =
              axis === 0
                ? (['rotation.x', transformRef.current.rx] as const)
                : axis === 1
                  ? (['rotation.y', transformRef.current.ry] as const)
                  : (['rotation.z', transformRef.current.rz] as const);
            return recordKeyframe({
              targetKind: 'scene_node',
              targetId: node.id,
              paramPath: path,
              value: rad,
            });
          }}
          onSetGroupKeyframe={() =>
            recordKeyframes([
              {
                targetKind: 'scene_node',
                targetId: node.id,
                paramPath: 'rotation.x',
                value: transformRef.current.rx,
              },
              {
                targetKind: 'scene_node',
                targetId: node.id,
                paramPath: 'rotation.y',
                value: transformRef.current.ry,
              },
              {
                targetKind: 'scene_node',
                targetId: node.id,
                paramPath: 'rotation.z',
                value: transformRef.current.rz,
              },
            ])
          }
          style={{ marginBottom: 8 }}
        />

        <VecInput
          groupLabel="Scale"
          labels={['X', 'Y', 'Z']}
          values={[transform.sx, transform.sy, transform.sz]}
          onChange={(next, axis) => {
            isEditingTransform.current = true;
            const t = {
              ...transformRef.current,
              sx: next[0],
              sy: next[1],
              sz: next[2],
            };
            transformRef.current = t;
            setTransform(t);
            const path =
              axis === 0 ? 'scale.x' : axis === 1 ? 'scale.y' : 'scale.z';
            useEditorStore
              .getState()
              .suppressOverride('scene_node', node.id, path);
          }}
          onCommit={() => {
            isEditingTransform.current = false;
            saveTransform();
          }}
          canRecord={canRecord}
          onSetAxisKeyframe={(axis, value) => {
            const path =
              axis === 0 ? 'scale.x' : axis === 1 ? 'scale.y' : 'scale.z';
            return recordKeyframe({
              targetKind: 'scene_node',
              targetId: node.id,
              paramPath: path,
              value,
            });
          }}
          onSetGroupKeyframe={() =>
            recordKeyframes([
              {
                targetKind: 'scene_node',
                targetId: node.id,
                paramPath: 'scale.x',
                value: transformRef.current.sx,
              },
              {
                targetKind: 'scene_node',
                targetId: node.id,
                paramPath: 'scale.y',
                value: transformRef.current.sy,
              },
              {
                targetKind: 'scene_node',
                targetId: node.id,
                paramPath: 'scale.z',
                value: transformRef.current.sz,
              },
            ])
          }
        />

        {/* Opacity — walked across descendant materials by the viewport. */}
        <SliderInput
          label="Opacity"
          value={transform.opacity}
          min={0}
          max={1}
          step={0.01}
          onChange={(next) => {
            isEditingTransform.current = true;
            const t = { ...transformRef.current, opacity: next };
            transformRef.current = t;
            setTransform(t);
            useEditorStore
              .getState()
              .suppressOverride('scene_node', node.id, 'opacity');
          }}
          onCommit={() => {
            isEditingTransform.current = false;
            saveTransform();
          }}
          canRecord={canRecord}
          onSetKeyframe={(value) =>
            recordKeyframe({
              targetKind: 'scene_node',
              targetId: node.id,
              paramPath: 'opacity',
              value,
            })
          }
        />

        {/* Shadow flags — only meaningful for mesh-bearing kinds. Visible only
            when some camera has shadows enabled. */}
        {(node.kind === 'avatar' ||
          node.kind === 'model' ||
          node.kind === 'prop' ||
          node.kind === 'scene_instance' ||
          node.kind === 'group') && (
          <div
            style={{
              display: 'flex',
              gap: 16,
              marginTop: 8,
              fontSize: 12,
              color: '#aaa',
            }}
          >
            {(['castShadow', 'receiveShadow'] as const).map((key) => (
              <label
                key={key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={transform[key]}
                  onChange={(e) => {
                    const t = {
                      ...transformRef.current,
                      [key]: e.target.checked,
                    };
                    transformRef.current = t;
                    setTransform(t);
                    saveTransform();
                  }}
                />
                {key === 'castShadow' ? 'Cast shadows' : 'Receive shadows'}
              </label>
            ))}
          </div>
        )}

        {/* Light Properties */}
        {node.kind === 'light' && (
          <>
            <div style={sectionHeader}>Light Properties</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#888', width: 60 }}>
                  Type
                </span>
                <select
                  style={{ ...textInput, width: 'auto', flex: 1 }}
                  value={light.lightType}
                  onChange={(e) => {
                    const l = { ...light, lightType: e.target.value };
                    setLight(l);
                    saveLight(l);
                  }}
                >
                  <option value="point">Point</option>
                  <option value="directional">Directional</option>
                  <option value="ambient">Ambient</option>
                  <option value="spot">Spot</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#888', width: 60 }}>
                  Color
                </span>
                <input
                  type="color"
                  value={light.color}
                  onChange={(e) => {
                    const l = { ...light, color: e.target.value };
                    setLight(l);
                  }}
                  onBlur={() => saveLight(light)}
                  style={{
                    width: 40,
                    height: 28,
                    border: 'none',
                    background: 'none',
                    cursor: 'pointer',
                  }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#888', width: 60 }}>
                  Intensity
                </span>
                <NumInput
                  value={light.intensity}
                  step={0.1}
                  min={0}
                  style={{ width: 96 }}
                  onChange={(v) => setLight({ ...light, intensity: v })}
                  onCommit={(v) => {
                    const next = { ...light, intensity: v };
                    setLight(next);
                    saveLight(next);
                  }}
                />
              </div>

              {/* Shadows — ambient lights can't cast. Enabling requires the
                  camera to also have shadows on (see Camera Properties). */}
              {light.lightType !== 'ambient' && (
                <>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                      color: '#aaa',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={light.castShadow ?? false}
                      onChange={(e) => {
                        const next = { ...light, castShadow: e.target.checked };
                        setLight(next);
                        saveLight(next);
                      }}
                    />
                    Cast shadows
                  </label>
                  {light.castShadow && (
                    <>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <span
                          style={{ fontSize: 12, color: '#888', width: 60 }}
                        >
                          Map Size
                        </span>
                        <select
                          style={{ ...textInput, width: 'auto', flex: 1 }}
                          value={String(light.shadowMapSize ?? 1024)}
                          onChange={(e) => {
                            const next = {
                              ...light,
                              shadowMapSize: Number(e.target.value),
                            };
                            setLight(next);
                            saveLight(next);
                          }}
                        >
                          <option value="512">512 (fast)</option>
                          <option value="1024">1024</option>
                          <option value="2048">2048 (sharp)</option>
                          <option value="4096">4096</option>
                        </select>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <span
                          style={{ fontSize: 12, color: '#888', width: 60 }}
                          title="Depth bias — increase (toward 0) if shadows detach, decrease if you see acne"
                        >
                          Bias
                        </span>
                        <NumInput
                          value={light.shadowBias ?? -0.0005}
                          step={0.0001}
                          style={{ width: 96 }}
                          onChange={(v) =>
                            setLight({ ...light, shadowBias: v })
                          }
                          onCommit={(v) => {
                            const next = { ...light, shadowBias: v };
                            setLight(next);
                            saveLight(next);
                          }}
                        />
                      </div>
                      {light.lightType === 'directional' && (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                          }}
                        >
                          <span
                            style={{ fontSize: 12, color: '#888', width: 60 }}
                            title="Half-size of the area the shadow covers. Smaller = sharper shadows over a smaller region."
                          >
                            Area
                          </span>
                          <NumInput
                            value={light.shadowCameraSize ?? 10}
                            step={1}
                            min={1}
                            style={{ width: 96 }}
                            onChange={(v) =>
                              setLight({ ...light, shadowCameraSize: v })
                            }
                            onCommit={(v) => {
                              const next = { ...light, shadowCameraSize: v };
                              setLight(next);
                              saveLight(next);
                            }}
                          />
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {/* Camera Properties */}
        {node.kind === 'camera' && (
          <>
            <div style={sectionHeader}>Camera Properties</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#888', width: 60 }}>
                  Projection
                </span>
                <select
                  value={camera.projection}
                  onChange={(e) => {
                    const next = {
                      ...camera,
                      projection: e.target.value as CameraProjection,
                    };
                    setCamera(next);
                    saveCamera(next);
                  }}
                  style={{ ...textInput, width: 'auto', flex: 1 }}
                >
                  <option value="perspective">Perspective</option>
                  <option value="orthographic">Orthographic</option>
                </select>
              </div>
              {camera.projection === 'perspective' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#888', width: 60 }}>
                    FOV
                  </span>
                  <NumInput
                    value={camera.fov}
                    step={1}
                    suffix="°"
                    style={{ width: 96 }}
                    onChange={(v) => setCamera({ ...camera, fov: v })}
                    onCommit={(v) => {
                      const next = { ...camera, fov: v };
                      setCamera(next);
                      saveCamera(next);
                    }}
                  />
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{ fontSize: 12, color: '#888', width: 60 }}
                    title="Half-height of the orthographic view volume"
                  >
                    Size
                  </span>
                  <NumInput
                    value={camera.orthoSize}
                    step={0.1}
                    style={{ width: 96 }}
                    onChange={(v) => setCamera({ ...camera, orthoSize: v })}
                    onCommit={(v) => {
                      const next = { ...camera, orthoSize: v };
                      setCamera(next);
                      saveCamera(next);
                    }}
                  />
                </div>
              )}
              {(
                [
                  ['Near', 'near', 0.001],
                  ['Far', 'far', 1],
                ] as [string, 'near' | 'far', number][]
              ).map(([lab, key, step]) => (
                <div
                  key={key}
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <span style={{ fontSize: 12, color: '#888', width: 60 }}>
                    {lab}
                  </span>
                  <NumInput
                    value={camera[key]}
                    step={step}
                    style={{ width: 96 }}
                    onChange={(v) => setCamera({ ...camera, [key]: v })}
                    onCommit={(v) => {
                      const next = { ...camera, [key]: v };
                      setCamera(next);
                      saveCamera(next);
                    }}
                  />
                </div>
              ))}
            </div>

            <div style={sectionHeader}>Shadows</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  color: '#aaa',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={camera.shadowsEnabled}
                  onChange={(e) => {
                    const next = {
                      ...camera,
                      shadowsEnabled: e.target.checked,
                    };
                    setCamera(next);
                    saveCamera(next);
                  }}
                />
                Enable shadows
              </label>
              {camera.shadowsEnabled && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#888', width: 60 }}>
                    Quality
                  </span>
                  <select
                    style={{ ...textInput, width: 'auto', flex: 1 }}
                    value={camera.shadowQuality}
                    onChange={(e) => {
                      const next = {
                        ...camera,
                        shadowQuality: e.target.value as ShadowQuality,
                      };
                      setCamera(next);
                      saveCamera(next);
                    }}
                  >
                    <option value="low">Low (hard edges)</option>
                    <option value="medium">Medium (PCF)</option>
                    <option value="high">High (soft PCF)</option>
                  </select>
                </div>
              )}
              <div
                style={{
                  fontSize: 10,
                  color: '#555',
                  lineHeight: 1.4,
                }}
              >
                Lights only cast shadows if their own "Cast shadows" is on.
                Per-object cast/receive is set on each model's transform.
              </div>
            </div>

            <div style={sectionHeader}>Environment</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#888', width: 60 }}>
                  Intensity
                </span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.01}
                  value={camera.envIntensity}
                  style={{ flex: 1, accentColor: '#2563eb' }}
                  onChange={(e) => {
                    const next = {
                      ...camera,
                      envIntensity: parseFloat(e.target.value),
                    };
                    setCamera(next);
                    saveCamera(next);
                  }}
                />
                <span
                  style={{
                    fontSize: 12,
                    color: '#aaa',
                    width: 32,
                    textAlign: 'right',
                  }}
                >
                  {camera.envIntensity.toFixed(2)}
                </span>
              </div>
              <div style={{ fontSize: 10, color: '#555', lineHeight: 1.4 }}>
                Scales ambient light from the environment map in the output and
                viewer. Lower for more directional contrast; 0 lights the model
                with scene lights only.
              </div>
            </div>

            <div
              style={{
                ...sectionHeader,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              Background Image
              <PickButton onClick={() => flashBottomTab('images')} />
            </div>
            {(() => {
              const cam = (node.components?.camera ?? {}) as Record<
                string,
                unknown
              >;
              const bgAssets = assets.filter((a) => a.kind === 'image');
              const saveBgImage = (url: string | null) => {
                const components = {
                  ...node.components,
                  camera: { ...cam, backgroundImage: url },
                };
                api.updateNode(node.id, { components }).catch(() => {});
                storeUpdateNode(node.id, { components });
              };
              return (
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <datalist id="cam-bg-list">
                    {bgAssets.map((a) => (
                      <option key={a.id} value={a.url} label={a.name} />
                    ))}
                  </datalist>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      list="cam-bg-list"
                      style={{ ...textInput, flex: 1 }}
                      placeholder="URL or pick from Images…"
                      defaultValue={(cam.backgroundImage as string) ?? ''}
                      key={node.id + '-bg'}
                      onBlur={(e) => saveBgImage(e.target.value.trim() || null)}
                    />
                    {!!cam.backgroundImage && (
                      <button
                        title="Clear background image"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#666',
                          cursor: 'pointer',
                          fontSize: 16,
                          padding: '0 4px',
                          flexShrink: 0,
                        }}
                        onClick={() => saveBgImage(null)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                  {!!cam.backgroundImage && (
                    <img
                      src={cam.backgroundImage as string}
                      alt="preview"
                      style={{
                        width: '100%',
                        maxHeight: 80,
                        objectFit: 'cover',
                        borderRadius: 4,
                        background: '#111',
                      }}
                    />
                  )}
                </div>
              );
            })()}

            <div style={sectionHeader}>Viewer</div>
            {(() => {
              const url = `${window.location.origin}/viewer/${projectId ?? ''}/${node.id}`;
              return (
                <div style={{ display: 'flex', gap: 4 }}>
                  <input
                    readOnly
                    value={url}
                    style={{
                      ...textInput,
                      flex: 1,
                      color: '#666',
                      fontSize: 11,
                      cursor: 'default',
                    }}
                  />
                  <button
                    title="Copy viewer URL"
                    onClick={() => navigator.clipboard.writeText(url)}
                    style={{
                      background: '#2a2a2a',
                      border: '1px solid #3a3a3a',
                      color: '#888',
                      borderRadius: 4,
                      padding: '0 8px',
                      cursor: 'pointer',
                      fontSize: 14,
                      flexShrink: 0,
                    }}
                  >
                    ⎘
                  </button>
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    title="Open viewer in new tab"
                    style={{
                      background: '#2a2a2a',
                      border: '1px solid #3a3a3a',
                      color: '#888',
                      borderRadius: 4,
                      padding: '0 8px',
                      cursor: 'pointer',
                      fontSize: 13,
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      textDecoration: 'none',
                    }}
                  >
                    ↗
                  </a>
                </div>
              );
            })()}
          </>
        )}

        {/* Godray Caster Properties */}
        {node.kind === 'godray_caster' &&
          (() => {
            const gr =
              (node.components.godray as Record<string, unknown>) ?? {};
            const saveGr = (patch: Record<string, unknown>) => {
              const components = {
                ...node.components,
                godray: { ...gr, ...patch },
              };
              api.updateNode(node.id, { components }).catch(() => {});
              storeUpdateNode(node.id, { components });
            };
            const defaults: Record<string, number> = {
              scale: 0.3,
              samples: 60,
              density: 0.96,
              decay: 0.93,
              weight: 0.4,
              exposure: 0.6,
              clampMax: 1.0,
            };
            const grWithDefaults: Record<string, unknown> = {
              ...defaults,
              ...gr,
            };
            return (
              <>
                <div style={sectionHeader}>Sun Appearance</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <span style={{ fontSize: 12, color: '#888', flex: 1 }}>
                      Color
                    </span>
                    <input
                      type="color"
                      value={(gr.color as string) ?? '#ffffff'}
                      onChange={(e) => saveGr({ color: e.target.value })}
                      style={{
                        width: 36,
                        height: 24,
                        border: 'none',
                        background: 'none',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    />
                  </div>
                  <EffectRow
                    label="Scale"
                    cfg={grWithDefaults}
                    field="scale"
                    step={0.05}
                    min={0.01}
                    onSave={saveGr}
                  />
                </div>
                <div style={sectionHeader}>God Ray Parameters</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <EffectRow
                    label="Samples"
                    cfg={grWithDefaults}
                    field="samples"
                    step={1}
                    min={10}
                    max={120}
                    onSave={saveGr}
                  />
                  <EffectRow
                    label="Density"
                    cfg={grWithDefaults}
                    field="density"
                    step={0.01}
                    min={0}
                    max={1}
                    onSave={saveGr}
                  />
                  <EffectRow
                    label="Decay"
                    cfg={grWithDefaults}
                    field="decay"
                    step={0.01}
                    min={0}
                    max={1}
                    onSave={saveGr}
                  />
                  <EffectRow
                    label="Weight"
                    cfg={grWithDefaults}
                    field="weight"
                    step={0.01}
                    min={0}
                    max={1}
                    onSave={saveGr}
                  />
                  <EffectRow
                    label="Exposure"
                    cfg={grWithDefaults}
                    field="exposure"
                    step={0.01}
                    min={0}
                    max={2}
                    onSave={saveGr}
                  />
                  <EffectRow
                    label="Clamp Max"
                    cfg={grWithDefaults}
                    field="clampMax"
                    step={0.01}
                    min={0}
                    max={1}
                    onSave={saveGr}
                  />
                </div>
              </>
            );
          })()}

        {node.kind === 'billboard' &&
          (() => {
            const bc: Record<string, unknown> = {
              facing: 'screen',
              backface: 'none',
              width: 1,
              height: 1,
              alpha: 1,
              textureUrl: null,
              ...((node.components?.billboard ?? {}) as Record<
                string,
                unknown
              >),
            };
            const saveBc = (patch: Record<string, unknown>) => {
              const components = {
                ...node.components,
                billboard: { ...bc, ...patch },
              };
              api.updateNode(node.id, { components }).catch(() => {});
              storeUpdateNode(node.id, { components });
            };
            const imageAssets = assets.filter((a) => a.kind === 'image');
            const sel: React.CSSProperties = {
              background: '#2a2a2a',
              border: '1px solid #3a3a3a',
              color: '#e0e0e0',
              borderRadius: 4,
              padding: '3px 6px',
              fontSize: 12,
              outline: 'none',
            };
            const row = (label: string, children: React.ReactNode) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#888', flex: 1 }}>
                  {label}
                </span>
                {children}
              </div>
            );
            return (
              <>
                <div style={sectionHeader}>Billboard</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {row(
                    'Facing',
                    <select
                      style={sel}
                      value={bc.facing as string}
                      onChange={(e) => saveBc({ facing: e.target.value })}
                    >
                      <option value="screen">
                        Screen (always faces camera)
                      </option>
                      <option value="world">World (fixed rotation)</option>
                    </select>
                  )}
                  {row(
                    'Backface',
                    <select
                      style={sel}
                      value={bc.backface as string}
                      onChange={(e) => saveBc({ backface: e.target.value })}
                    >
                      <option value="none">None (single-sided)</option>
                      <option value="mirror">Mirror (flip X)</option>
                      <option value="unmirrored">
                        Unmirrored (double-sided)
                      </option>
                    </select>
                  )}
                  <EffectRow
                    label="Width"
                    cfg={bc}
                    field="width"
                    step={0.05}
                    min={0.01}
                    onSave={saveBc}
                  />
                  <EffectRow
                    label="Height"
                    cfg={bc}
                    field="height"
                    step={0.05}
                    min={0.01}
                    onSave={saveBc}
                  />
                  <EffectRow
                    label="Alpha"
                    cfg={bc}
                    field="alpha"
                    step={0.05}
                    min={0}
                    max={1}
                    onSave={saveBc}
                  />
                </div>
                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  Texture
                  <PickButton onClick={() => flashBottomTab('images')} />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <datalist id="billboard-img-list">
                    {imageAssets.map((a) => (
                      <option key={a.id} value={a.url} label={a.name} />
                    ))}
                  </datalist>
                  {row(
                    'Image',
                    <input
                      list="billboard-img-list"
                      style={{ ...numInput, width: 120 }}
                      placeholder="URL or pick asset…"
                      defaultValue={(bc.textureUrl as string) ?? ''}
                      key={node.id + '-bbtex'}
                      onBlur={(e) =>
                        saveBc({ textureUrl: e.target.value.trim() || null })
                      }
                    />
                  )}
                  {bc.textureUrl ? (
                    <img
                      src={bc.textureUrl as string}
                      alt="preview"
                      style={{
                        width: '100%',
                        maxHeight: 120,
                        objectFit: 'contain',
                        borderRadius: 4,
                        background: '#111',
                        marginTop: 4,
                      }}
                    />
                  ) : null}
                </div>
              </>
            );
          })()}

        {(node.kind === 'text_troika' || node.kind === 'text_canvas') &&
          (() => {
            const isCanvas = node.kind === 'text_canvas';
            const tc: Record<string, unknown> = {
              content: 'Text',
              fontSize: isCanvas ? 48 : 0.2,
              color: '#ffffff',
              // troika-specific
              anchorX: 'center',
              anchorY: 'middle',
              maxWidth: 0,
              // canvas-specific
              padding: 16,
              width: 2,
              height: 0.5,
              allowHtml: false,
              // shared
              billboard: true,
              facing: 'screen' as 'screen' | 'world',
              ...((node.components?.text ?? {}) as Record<string, unknown>),
            };
            const saveTc = (patch: Record<string, unknown>) => {
              // Keep facing + billboard in sync so the renderer (which reads
              // `billboard`) and the UI (which shows `facing`) never drift.
              const merged: Record<string, unknown> = { ...tc, ...patch };
              if ('facing' in patch) {
                merged.billboard = patch.facing === 'screen';
              } else if ('billboard' in patch) {
                merged.facing = patch.billboard ? 'screen' : 'world';
              }
              const components = {
                ...node.components,
                text: { type: 'text', ...merged },
              };
              api.updateNode(node.id, { components }).catch(() => {});
              storeUpdateNode(node.id, { components });
            };
            const sel: React.CSSProperties = {
              background: '#2a2a2a',
              border: '1px solid #3a3a3a',
              color: '#e0e0e0',
              borderRadius: 4,
              padding: '3px 6px',
              fontSize: 12,
              outline: 'none',
            };
            const row = (label: string, children: React.ReactNode) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#888', flex: 1 }}>
                  {label}
                </span>
                {children}
              </div>
            );
            return (
              <>
                <div style={sectionHeader}>Text</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {row(
                    'Content',
                    <input
                      style={{ ...textInput, width: 160 }}
                      defaultValue={(tc.content as string) ?? ''}
                      key={node.id + '-tc-content'}
                      onBlur={(e) => saveTc({ content: e.target.value })}
                    />
                  )}
                  {row(
                    'Facing',
                    <select
                      style={sel}
                      value={(tc.facing as string) ?? 'screen'}
                      onChange={(e) => saveTc({ facing: e.target.value })}
                    >
                      <option value="screen">
                        Screen (always faces camera)
                      </option>
                      <option value="world">World (fixed rotation)</option>
                    </select>
                  )}
                  {row(
                    'Color',
                    <input
                      type="color"
                      value={(tc.color as string) ?? '#ffffff'}
                      onChange={(e) => saveTc({ color: e.target.value })}
                      style={{
                        width: 40,
                        height: 24,
                        background: '#2a2a2a',
                        border: '1px solid #3a3a3a',
                        borderRadius: 4,
                        padding: 0,
                      }}
                    />
                  )}
                  <EffectRow
                    label="Font Size"
                    cfg={tc}
                    field="fontSize"
                    step={isCanvas ? 1 : 0.01}
                    min={0.001}
                    onSave={saveTc}
                  />
                  {isCanvas && (
                    <>
                      <EffectRow
                        label="Padding"
                        cfg={tc}
                        field="padding"
                        step={1}
                        min={0}
                        onSave={saveTc}
                      />
                      <EffectRow
                        label="Width"
                        cfg={tc}
                        field="width"
                        step={0.1}
                        min={0.01}
                        onSave={saveTc}
                      />
                      <EffectRow
                        label="Height"
                        cfg={tc}
                        field="height"
                        step={0.1}
                        min={0.01}
                        onSave={saveTc}
                      />
                      {row(
                        'Allow HTML',
                        <input
                          type="checkbox"
                          checked={Boolean(tc.allowHtml)}
                          onChange={(e) =>
                            saveTc({ allowHtml: e.target.checked })
                          }
                        />
                      )}
                    </>
                  )}
                  {!isCanvas && (
                    <>
                      {row(
                        'Anchor X',
                        <select
                          style={sel}
                          value={(tc.anchorX as string) ?? 'center'}
                          onChange={(e) => saveTc({ anchorX: e.target.value })}
                        >
                          <option value="left">left</option>
                          <option value="center">center</option>
                          <option value="right">right</option>
                        </select>
                      )}
                      {row(
                        'Anchor Y',
                        <select
                          style={sel}
                          value={(tc.anchorY as string) ?? 'middle'}
                          onChange={(e) => saveTc({ anchorY: e.target.value })}
                        >
                          <option value="top">top</option>
                          <option value="middle">middle</option>
                          <option value="bottom">bottom</option>
                        </select>
                      )}
                      <EffectRow
                        label="Max Width (0 = ∞)"
                        cfg={tc}
                        field="maxWidth"
                        step={0.1}
                        min={0}
                        onSave={saveTc}
                      />
                    </>
                  )}
                </div>
              </>
            );
          })()}

        {node.kind === 'feed' &&
          (() => {
            const fc: Record<string, unknown> = {
              template: '',
              css: '',
              width: 2,
              height: 1.2,
              padding: 16,
              fontSize: 28,
              color: '#ffffff',
              billboard: true,
              ...((node.components?.feed ?? {}) as Record<string, unknown>),
            };
            const saveFc = (patch: Record<string, unknown>) => {
              const merged: Record<string, unknown> = { ...fc, ...patch };
              const components = {
                ...node.components,
                feed: { type: 'feed', ...merged },
              };
              api.updateNode(node.id, { components }).catch(() => {});
              storeUpdateNode(node.id, { components });
            };
            const row = (label: string, children: React.ReactNode) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#888', flex: 1 }}>
                  {label}
                </span>
                {children}
              </div>
            );
            const area: React.CSSProperties = {
              background: '#1e1e1e',
              border: '1px solid #3a3a3a',
              color: '#e0e0e0',
              borderRadius: 4,
              padding: 6,
              fontSize: 11,
              fontFamily: 'monospace',
              outline: 'none',
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
            };
            return (
              <>
                <div style={sectionHeader}>Feed</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <span style={{ fontSize: 11, color: '#666' }}>
                    Renders the data-channel fields visible to this node (global
                    + this node as a <code>set_data</code> scope target) through
                    the template below.
                  </span>
                  {row(
                    'Billboard',
                    <input
                      type="checkbox"
                      checked={Boolean(fc.billboard)}
                      onChange={(e) => saveFc({ billboard: e.target.checked })}
                    />
                  )}
                  {row(
                    'Color',
                    <input
                      type="color"
                      value={(fc.color as string) ?? '#ffffff'}
                      onChange={(e) => saveFc({ color: e.target.value })}
                      style={{
                        width: 40,
                        height: 24,
                        background: '#2a2a2a',
                        border: '1px solid #3a3a3a',
                        borderRadius: 4,
                        padding: 0,
                      }}
                    />
                  )}
                  <EffectRow
                    label="Font Size (px)"
                    cfg={fc}
                    field="fontSize"
                    step={1}
                    min={1}
                    onSave={saveFc}
                  />
                  <EffectRow
                    label="Padding (px)"
                    cfg={fc}
                    field="padding"
                    step={1}
                    min={0}
                    onSave={saveFc}
                  />
                  <EffectRow
                    label="Width (m)"
                    cfg={fc}
                    field="width"
                    step={0.1}
                    min={0.01}
                    onSave={saveFc}
                  />
                  <EffectRow
                    label="Height (m)"
                    cfg={fc}
                    field="height"
                    step={0.1}
                    min={0.01}
                    onSave={saveFc}
                  />
                  <span style={{ fontSize: 12, color: '#888' }}>Template</span>
                  <textarea
                    style={{ ...area, minHeight: 120 }}
                    defaultValue={(fc.template as string) ?? ''}
                    key={node.id + '-feed-template'}
                    spellCheck={false}
                    onBlur={(e) => saveFc({ template: e.target.value })}
                  />
                  <span style={{ fontSize: 12, color: '#888' }}>CSS</span>
                  <textarea
                    style={{ ...area, minHeight: 100 }}
                    defaultValue={(fc.css as string) ?? ''}
                    key={node.id + '-feed-css'}
                    spellCheck={false}
                    onBlur={(e) => saveFc({ css: e.target.value })}
                  />
                </div>
              </>
            );
          })()}

        {node.kind === 'particle' &&
          (() => {
            const pc: Record<string, unknown> = {
              ...PARTICLE_DEFAULTS,
              ...((node.components?.particle ?? {}) as Record<string, unknown>),
            };
            const savePc = (patch: Record<string, unknown>) => {
              const components = {
                ...node.components,
                particle: { ...pc, ...patch },
              };
              api.updateNode(node.id, { components }).catch(() => {});
              storeUpdateNode(node.id, { components });
            };
            const imageAssets = assets.filter((a) => a.kind === 'image');
            const sel: React.CSSProperties = {
              background: '#2a2a2a',
              border: '1px solid #3a3a3a',
              color: '#e0e0e0',
              borderRadius: 4,
              padding: '3px 6px',
              fontSize: 12,
              outline: 'none',
            };
            const chk = (field: string) => (
              <input
                type="checkbox"
                checked={Boolean(pc[field])}
                onChange={(e) => savePc({ [field]: e.target.checked })}
              />
            );
            const row = (label: string, children: React.ReactNode) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#888', flex: 1 }}>
                  {label}
                </span>
                {children}
              </div>
            );
            return (
              <>
                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  Texture
                  <PickButton onClick={() => flashBottomTab('images')} />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {/* Built-in presets */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {getBuiltinParticleTextures().map((t) => {
                      const active = pc.textureUrl === t.dataUrl;
                      return (
                        <button
                          key={t.label}
                          title={t.label}
                          onClick={() => savePc({ textureUrl: t.dataUrl })}
                          style={{
                            background: active ? '#2a4a6a' : '#1e1e1e',
                            border: active
                              ? '1px solid #4a8aaa'
                              : '1px solid #2a2a2a',
                            borderRadius: 4,
                            padding: 2,
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: 2,
                          }}
                        >
                          <img
                            src={t.dataUrl}
                            alt={t.label}
                            style={{
                              width: 28,
                              height: 28,
                              imageRendering: 'pixelated',
                              background: '#333',
                              borderRadius: 2,
                            }}
                          />
                          <span
                            style={{
                              fontSize: 9,
                              color: active ? '#9cf' : '#666',
                              lineHeight: 1,
                            }}
                          >
                            {t.label}
                          </span>
                        </button>
                      );
                    })}
                    <button
                      title="None (default sprite)"
                      onClick={() => savePc({ textureUrl: null })}
                      style={{
                        background: !pc.textureUrl ? '#2a4a6a' : '#1e1e1e',
                        border: !pc.textureUrl
                          ? '1px solid #4a8aaa'
                          : '1px solid #2a2a2a',
                        borderRadius: 4,
                        padding: 2,
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 2,
                        width: 34,
                      }}
                    >
                      <span style={{ fontSize: 16, lineHeight: '28px' }}>
                        ○
                      </span>
                      <span
                        style={{
                          fontSize: 9,
                          color: !pc.textureUrl ? '#9cf' : '#666',
                          lineHeight: 1,
                        }}
                      >
                        Default
                      </span>
                    </button>
                  </div>
                  {/* Custom image asset or URL */}
                  <datalist id="particle-img-list">
                    {imageAssets.map((a) => (
                      <option key={a.id} value={a.url} label={a.name} />
                    ))}
                  </datalist>
                  {row(
                    'Custom',
                    <input
                      list="particle-img-list"
                      style={{ ...numInput, width: 120 }}
                      placeholder="URL or pick asset…"
                      defaultValue={(pc.textureUrl as string) ?? ''}
                      key={node.id + '-tex'}
                      onBlur={(e) =>
                        savePc({ textureUrl: e.target.value.trim() || null })
                      }
                    />
                  )}
                </div>

                <div style={sectionHeader}>Rendering</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {row(
                    'Blend Mode',
                    <select
                      style={sel}
                      value={pc.blendMode as string}
                      onChange={(e) => savePc({ blendMode: e.target.value })}
                    >
                      <option value="additive">Additive</option>
                      <option value="normal">Normal</option>
                      <option value="multiply">Multiply</option>
                    </select>
                  )}
                  {row(
                    'Simulation Space',
                    <select
                      style={sel}
                      value={pc.simulationSpace as string}
                      onChange={(e) =>
                        savePc({ simulationSpace: e.target.value })
                      }
                    >
                      <option value="world">
                        World (particles stay in place)
                      </option>
                      <option value="local">
                        Local (particles follow emitter)
                      </option>
                    </select>
                  )}
                  <EffectRow
                    label="Max Count"
                    cfg={pc}
                    field="maxCount"
                    step={10}
                    min={1}
                    max={5000}
                    onSave={savePc}
                  />
                  {row('Depth Write', chk('depthWrite'))}
                  {row('Depth Test', chk('depthTest'))}
                </div>

                <div style={sectionHeader}>Emission</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <EffectRow
                    label="Rate (p/s)"
                    cfg={pc}
                    field="emissionRate"
                    step={1}
                    min={0}
                    onSave={savePc}
                  />
                  {row('Burst Mode', chk('burstMode'))}
                  {row('Loop', chk('loop'))}
                  {row('Play on Start', chk('playOnStart'))}
                </div>

                <div style={sectionHeader}>Lifetime</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <EffectRow
                    label="Lifetime (s)"
                    cfg={pc}
                    field="lifetime"
                    step={0.1}
                    min={0.01}
                    onSave={savePc}
                  />
                  <EffectRow
                    label="Lifetime ±"
                    cfg={pc}
                    field="lifetimeRandom"
                    step={0.05}
                    min={0}
                    max={1}
                    onSave={savePc}
                  />
                </div>

                <div style={sectionHeader}>Size</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <EffectRow
                    label="Width"
                    cfg={pc}
                    field="sizeX"
                    step={0.005}
                    min={0.001}
                    onSave={savePc}
                  />
                  <EffectRow
                    label="Height"
                    cfg={pc}
                    field="sizeY"
                    step={0.005}
                    min={0.001}
                    onSave={savePc}
                  />
                  <EffectRow
                    label="Width ±"
                    cfg={pc}
                    field="sizeRandomX"
                    step={0.05}
                    min={0}
                    max={1}
                    onSave={savePc}
                  />
                  <EffectRow
                    label="Height ±"
                    cfg={pc}
                    field="sizeRandomY"
                    step={0.05}
                    min={0}
                    max={1}
                    onSave={savePc}
                  />
                  {row(
                    'Size Over Lifetime',
                    <select
                      style={sel}
                      value={pc.sizeOverLifetime as string}
                      onChange={(e) =>
                        savePc({ sizeOverLifetime: e.target.value })
                      }
                    >
                      <option value="constant">Constant</option>
                      <option value="shrink">Shrink</option>
                      <option value="grow">Grow</option>
                      <option value="pulse">Pulse</option>
                    </select>
                  )}
                </div>

                <div style={sectionHeader}>Color &amp; Alpha</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {row(
                    'Color Start',
                    <input
                      type="color"
                      value={(pc.colorStart as string) ?? '#ffffff'}
                      onChange={(e) => savePc({ colorStart: e.target.value })}
                      style={{
                        width: 36,
                        height: 24,
                        border: 'none',
                        background: 'none',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    />
                  )}
                  {row(
                    'Color End',
                    <input
                      type="color"
                      value={(pc.colorEnd as string) ?? '#ff6600'}
                      onChange={(e) => savePc({ colorEnd: e.target.value })}
                      style={{
                        width: 36,
                        height: 24,
                        border: 'none',
                        background: 'none',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    />
                  )}
                  <EffectRow
                    label="Alpha"
                    cfg={pc}
                    field="alpha"
                    step={0.05}
                    min={0}
                    max={1}
                    onSave={savePc}
                  />
                  {row(
                    'Alpha Over Lifetime',
                    <select
                      style={sel}
                      value={pc.alphaOverLifetime as string}
                      onChange={(e) =>
                        savePc({ alphaOverLifetime: e.target.value })
                      }
                    >
                      <option value="constant">Constant</option>
                      <option value="fade-in">Fade In</option>
                      <option value="fade-out">Fade Out</option>
                      <option value="fade-in-out">Fade In→Out</option>
                    </select>
                  )}
                  <EffectRow
                    label="Emissive Intensity"
                    cfg={pc}
                    field="emissiveIntensity"
                    step={0.1}
                    min={0}
                    onSave={savePc}
                  />
                </div>

                <div style={sectionHeader}>Direction &amp; Speed</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <EffectRow
                    label="Dir X"
                    cfg={pc}
                    field="directionX"
                    step={0.1}
                    onSave={savePc}
                  />
                  <EffectRow
                    label="Dir Y"
                    cfg={pc}
                    field="directionY"
                    step={0.1}
                    onSave={savePc}
                  />
                  <EffectRow
                    label="Dir Z"
                    cfg={pc}
                    field="directionZ"
                    step={0.1}
                    onSave={savePc}
                  />
                  <EffectRow
                    label="Spread (°)"
                    cfg={pc}
                    field="spread"
                    step={1}
                    min={0}
                    max={180}
                    onSave={savePc}
                  />
                  <EffectRow
                    label="Speed"
                    cfg={pc}
                    field="speed"
                    step={0.1}
                    min={0}
                    onSave={savePc}
                  />
                  <EffectRow
                    label="Speed ±"
                    cfg={pc}
                    field="speedRandom"
                    step={0.05}
                    min={0}
                    max={1}
                    onSave={savePc}
                  />
                </div>

                <div style={sectionHeader}>Origin Area</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <EffectRow
                    label="Width"
                    cfg={pc}
                    field="originW"
                    step={0.05}
                    min={0}
                    onSave={savePc}
                  />
                  <EffectRow
                    label="Height"
                    cfg={pc}
                    field="originH"
                    step={0.05}
                    min={0}
                    onSave={savePc}
                  />
                  <EffectRow
                    label="Depth"
                    cfg={pc}
                    field="originD"
                    step={0.05}
                    min={0}
                    onSave={savePc}
                  />
                </div>

                <div style={sectionHeader}>Motion</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <EffectRow
                    label="Gravity X"
                    cfg={pc}
                    field="gravityX"
                    step={0.05}
                    onSave={savePc}
                  />
                  <EffectRow
                    label="Gravity Y"
                    cfg={pc}
                    field="gravityY"
                    step={0.05}
                    onSave={savePc}
                  />
                  <EffectRow
                    label="Gravity Z"
                    cfg={pc}
                    field="gravityZ"
                    step={0.05}
                    onSave={savePc}
                  />
                  <EffectRow
                    label="Turbulence"
                    cfg={pc}
                    field="turbulence"
                    step={0.05}
                    min={0}
                    onSave={savePc}
                  />
                </div>

                <div style={sectionHeader}>Rotation</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {row(
                    'Mode',
                    <select
                      style={sel}
                      value={(pc.rotationMode as string) ?? 'free'}
                      onChange={(e) => savePc({ rotationMode: e.target.value })}
                    >
                      <option value="free">Free (spin over lifetime)</option>
                      <option value="velocity">Velocity aligned</option>
                    </select>
                  )}
                  {pc.rotationMode !== 'velocity' && (
                    <>
                      <EffectRow
                        label="Start Rotation ±(°)"
                        cfg={pc}
                        field="rotationStart"
                        step={5}
                        min={0}
                        max={180}
                        onSave={savePc}
                      />
                      <EffectRow
                        label="Angular Vel (°/s)"
                        cfg={pc}
                        field="angularVelocity"
                        step={5}
                        onSave={savePc}
                      />
                      <EffectRow
                        label="Angular Vel ±"
                        cfg={pc}
                        field="angularVelocityRandom"
                        step={5}
                        min={0}
                        onSave={savePc}
                      />
                    </>
                  )}
                </div>
              </>
            );
          })()}

        {/* Morph targets + expressions — avatar only, shown once model is loaded */}
        {node.kind === 'avatar' &&
          (() => {
            const morphs = vrmMorphTargetsByNode[node.id] ?? [];
            const exprs = vrmExpressionsByNode[node.id] ?? [];
            if (morphs.length === 0 && exprs.length === 0) return null;
            const listStyle: React.CSSProperties = {
              background: '#111',
              border: '1px solid #222',
              borderRadius: 4,
              maxHeight: 160,
              overflowY: 'auto',
            };
            const itemStyle: React.CSSProperties = {
              padding: '3px 10px',
              fontSize: 11,
              color: '#aaa',
              borderBottom: '1px solid #1a1a1a',
              fontFamily: 'monospace',
            };
            return (
              <>
                {morphs.length > 0 && (
                  <>
                    <div style={sectionHeader}>
                      Morph Targets ({morphs.length})
                    </div>
                    <div style={listStyle}>
                      {morphs.map((n) => (
                        <div key={n} style={itemStyle}>
                          {n}
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {exprs.length > 0 && (
                  <CollapsibleSection
                    title="Default Expression"
                    count={exprs.length}
                  >
                    <div
                      style={{
                        fontSize: 10,
                        color: '#555',
                        lineHeight: 1.4,
                        marginBottom: 6,
                      }}
                    >
                      Resting expression weights held until a blendshape
                      broadcast (VMC, lipsync, tracking) overrides them.
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                      }}
                    >
                      {exprs.map((n) => {
                        const defaults = (node.properties?.defaultExpressions ??
                          {}) as Record<string, number>;
                        const setDefaultExpr = (
                          v: number,
                          persist: boolean
                        ) => {
                          const prev = (node.properties?.defaultExpressions ??
                            {}) as Record<string, number>;
                          // Keep 0 entries (don't delete) so the viewport keeps
                          // driving the expression back to 0 — dropping the key
                          // would leave the last applied weight stuck on the VRM.
                          const next = { ...prev, [n]: v };
                          const properties = {
                            ...node.properties,
                            defaultExpressions: next,
                          };
                          storeUpdateNode(node.id, { properties });
                          if (persist)
                            api
                              .updateNode(node.id, {
                                properties: { defaultExpressions: next },
                              })
                              .catch(() => {});
                        };
                        return (
                          <div
                            key={n}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 11,
                                color: '#aaa',
                                fontFamily: 'monospace',
                                width: 110,
                                flexShrink: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              title={n}
                            >
                              {n}
                            </span>
                            <SliderInput
                              value={defaults[n] ?? 0}
                              min={0}
                              max={1}
                              step={0.01}
                              precision={2}
                              style={{ flex: 1 }}
                              onChange={(v) => setDefaultExpr(v, false)}
                              onCommit={(v) => setDefaultExpr(v, true)}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </CollapsibleSection>
                )}
              </>
            );
          })()}

        {/* Material editor — avatar only, lists materials once the VRM loads */}
        {node.kind === 'avatar' && <MaterialSection node={node} />}

        {/* Avatar properties — broadcast pose blend, etc. */}
        {node.kind === 'avatar' && (
          <>
            <div style={sectionHeader}>Properties</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  fontSize: 12,
                  color: '#888',
                  width: 110,
                  flexShrink: 0,
                }}
              >
                Blend transition
              </span>
              <NumInput
                value={node.properties?.blendTransitionTime ?? 0.5}
                step={0.05}
                min={0}
                suffix="s"
                style={{ width: 96 }}
                onChange={(v) => {
                  const properties = {
                    ...node.properties,
                    blendTransitionTime: v,
                  };
                  storeUpdateNode(node.id, { properties });
                }}
                onCommit={(v) => {
                  const properties = {
                    ...node.properties,
                    blendTransitionTime: v,
                  };
                  storeUpdateNode(node.id, { properties });
                  api
                    .updateNode(node.id, {
                      properties: { blendTransitionTime: v },
                    })
                    .catch(() => {});
                }}
              />
            </div>
          </>
        )}

        {/* FBX debug toggle — avatar only */}
        {node.kind === 'avatar' && (
          <>
            <div style={sectionHeader}>Debug</div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                color: '#888',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={fbxDebugVisible[node.id] ?? false}
                onChange={(e) => setFbxDebugVisible(node.id, e.target.checked)}
              />
              Show FBX animation model
            </label>
          </>
        )}

        {/* Model (avatar/model file) */}
        {(node.kind === 'avatar' || node.kind === 'model') && (
          <>
            <div
              style={{
                ...sectionHeader,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              Model
              <PickButton onClick={() => flashBottomTab('models')} />
            </div>
            <datalist id="model-list">
              {modelAssets.map((a) => (
                <option key={a.id} value={a.url} label={a.name} />
              ))}
            </datalist>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                list="model-list"
                style={{ ...textInput, flex: 1 }}
                placeholder={
                  modelAssets.length
                    ? 'Search or paste URL…'
                    : 'No models uploaded yet'
                }
                defaultValue={node.filePath ?? ''}
                key={node.id + ':model'}
                onBlur={(e) => {
                  const filePath = e.target.value.trim();
                  api
                    .updateNode(node.id, { filePath: filePath || '' })
                    .catch(() => {});
                  storeUpdateNode(node.id, { filePath: filePath || null });
                }}
              />
              {node.filePath && (
                <button
                  title="Clear model"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#666',
                    cursor: 'pointer',
                    fontSize: 16,
                    padding: '0 2px',
                    flexShrink: 0,
                  }}
                  onClick={() => {
                    api.updateNode(node.id, { filePath: '' }).catch(() => {});
                    storeUpdateNode(node.id, { filePath: null });
                  }}
                >
                  ×
                </button>
              )}
            </div>
            {modelAssets.length > 0 && (
              <div
                style={{
                  marginTop: 6,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 4,
                }}
              >
                {modelAssets.map((a) => (
                  <button
                    key={a.id}
                    style={{
                      background:
                        node.filePath === a.url ? '#1a3a5a' : '#1e1e1e',
                      border: '1px solid #3a3a3a',
                      color: '#ccc',
                      borderRadius: 4,
                      padding: '2px 8px',
                      cursor: 'pointer',
                      fontSize: 11,
                      maxWidth: 220,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={a.name}
                    onClick={() => {
                      api
                        .updateNode(node.id, { filePath: a.url })
                        .catch(() => {});
                      storeUpdateNode(node.id, { filePath: a.url });
                    }}
                  >
                    {a.name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* Animation */}
        {/* TODO: Overhaul this section in a dedicated pass. The Speed/Offset
            number inputs and the seek slider were intentionally left on the
            raw <input type="number"|"range"> primitives during the
            NumInput/VecInput/SliderInput unification because the playback
            transport + custom "current/total" readout aren't a clean fit for
            the shared components yet. Revisit when the FBX animation flow gets
            its planned UX update. */}
        {(node.kind === 'avatar' || node.kind === 'model') && (
          <>
            <div
              style={{
                ...sectionHeader,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              Animation
              <PickButton onClick={() => flashBottomTab('animations')} />
            </div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>
              Idle Animation
            </div>
            <datalist id="anim-list">
              {animAssets.map((a) => (
                <option key={a.id} value={a.url} label={a.name} />
              ))}
            </datalist>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                list="anim-list"
                style={{ ...textInput, flex: 1 }}
                placeholder={
                  animAssets.length
                    ? 'Search or paste URL…'
                    : 'No animations uploaded yet'
                }
                defaultValue={
                  (node.components?.animation as { idleUrl?: string })
                    ?.idleUrl ?? ''
                }
                key={node.id}
                onBlur={(e) => {
                  const idleUrl = e.target.value.trim() || null;
                  const animation = idleUrl ? { idleUrl } : undefined;
                  const components = { ...node.components, animation };
                  api.updateNode(node.id, { components }).catch(() => {});
                  storeUpdateNode(node.id, { components });
                }}
              />
              {(node.components?.animation as { idleUrl?: string })
                ?.idleUrl && (
                <button
                  title="Clear animation"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#666',
                    cursor: 'pointer',
                    fontSize: 16,
                    padding: '0 2px',
                    flexShrink: 0,
                  }}
                  onClick={() => {
                    const components = {
                      ...node.components,
                      animation: undefined,
                    };
                    api.updateNode(node.id, { components }).catch(() => {});
                    storeUpdateNode(node.id, { components });
                  }}
                >
                  ×
                </button>
              )}
            </div>
            {/* Speed and offset */}
            {(node.components?.animation as { idleUrl?: string })?.idleUrl && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <label
                  style={{
                    flex: 1,
                    fontSize: 12,
                    color: '#888',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                  }}
                >
                  Speed
                  <input
                    type="number"
                    style={{ ...textInput }}
                    step={0.1}
                    min={0}
                    defaultValue={
                      (node.components?.animation as { speed?: number })
                        ?.speed ?? 1
                    }
                    key={`${node.id}-speed`}
                    onBlur={(e) => {
                      const speed = parseFloat(e.target.value);
                      if (isNaN(speed) || speed < 0) return;
                      const animation = {
                        ...(node.components?.animation as object),
                        speed,
                      };
                      const components = { ...node.components, animation };
                      api.updateNode(node.id, { components }).catch(() => {});
                      storeUpdateNode(node.id, { components });
                    }}
                  />
                </label>
                <label
                  style={{
                    flex: 1,
                    fontSize: 12,
                    color: '#888',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                  }}
                >
                  Offset (s)
                  <input
                    type="number"
                    style={{ ...textInput }}
                    step={0.1}
                    min={0}
                    defaultValue={
                      (node.components?.animation as { offset?: number })
                        ?.offset ?? 0
                    }
                    key={`${node.id}-offset`}
                    onBlur={(e) => {
                      const offset = parseFloat(e.target.value);
                      if (isNaN(offset) || offset < 0) return;
                      const animation = {
                        ...(node.components?.animation as object),
                        offset,
                      };
                      const components = { ...node.components, animation };
                      api.updateNode(node.id, { components }).catch(() => {});
                      storeUpdateNode(node.id, { components });
                    }}
                  />
                </label>
              </div>
            )}
            {/* Animation playback controls */}
            {hasAnim &&
              (() => {
                const entry = animRegistry.get(node.id);
                if (!entry) return null;
                const pauseBoth = (paused: boolean) => {
                  entry.action.paused = paused;
                  entry.fbxAction.paused = paused;
                };
                const stopBoth = () => {
                  entry.action.stop();
                  entry.mixer.update(0);
                  entry.fbxAction.stop();
                  entry.fbxMixer.update(0);
                  const LOG_BONES = new Set([
                    'thigh_l',
                    'thigh_r',
                    'upperarm_l',
                    'upperarm_r',
                  ]);
                  const _wq = new (entry.fbxScene.quaternion
                    .constructor as typeof import('three').Quaternion)();
                  entry.fbxScene.traverse((o) => {
                    if (LOG_BONES.has(o.name)) {
                      const q = o.quaternion;
                      o.getWorldQuaternion(_wq);
                      console.log(
                        `[A-pose] ${o.name} localQ=(${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)},${q.w.toFixed(4)}) worldQ=(${_wq.x.toFixed(4)},${_wq.y.toFixed(4)},${_wq.z.toFixed(4)},${_wq.w.toFixed(4)})`
                      );
                    }
                  });
                };
                const seekBoth = (t: number) => {
                  entry.action.paused = true;
                  entry.action.time = t * entry.duration;
                  entry.mixer.update(0);
                  entry.fbxAction.paused = true;
                  entry.fbxAction.time = t * entry.duration;
                  entry.fbxMixer.update(0);
                };
                return (
                  <div
                    style={{
                      marginTop: 10,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <div
                      style={{ display: 'flex', gap: 6, alignItems: 'center' }}
                    >
                      <button
                        style={{
                          background: '#2a2a2a',
                          border: '1px solid #3a3a3a',
                          color: '#e0e0e0',
                          borderRadius: 4,
                          padding: '3px 10px',
                          cursor: 'pointer',
                          fontSize: 12,
                        }}
                        onClick={() => {
                          pauseBoth(animPlaying);
                          setAnimPlaying(!animPlaying);
                        }}
                      >
                        {animPlaying ? '⏸ Pause' : '▶ Play'}
                      </button>
                      <button
                        style={{
                          background: '#2a2a2a',
                          border: '1px solid #3a3a3a',
                          color: '#e0e0e0',
                          borderRadius: 4,
                          padding: '3px 10px',
                          cursor: 'pointer',
                          fontSize: 12,
                        }}
                        onClick={() => {
                          stopBoth();
                          setAnimPlaying(false);
                          setAnimTime(0);
                        }}
                      >
                        ⏹ Rest
                      </button>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.001}
                      value={animTime}
                      style={{ width: '100%', accentColor: '#2563eb' }}
                      onChange={(e) => {
                        const t = parseFloat(e.target.value);
                        setAnimTime(t);
                        seekBoth(t);
                        setAnimPlaying(false);
                      }}
                    />
                    <div
                      style={{
                        fontSize: 10,
                        color: '#666',
                        textAlign: 'right',
                      }}
                    >
                      {(animTime * entry.duration).toFixed(2)}s /{' '}
                      {entry.duration.toFixed(2)}s
                    </div>
                  </div>
                );
              })()}
          </>
        )}

        {/* File Path */}
        {node.filePath && (
          <>
            <div style={{ ...sectionHeader, marginTop: 16 }}>File</div>
            <div
              style={{ fontSize: 11, color: '#666', wordBreak: 'break-all' }}
            >
              {node.filePath}
            </div>
          </>
        )}

        {/* Selected component properties */}
        {selectedComp && selectedCompType && (
          <>
            <div
              style={{
                marginTop: 20,
                borderTop: '1px solid #2a2a2a',
                paddingTop: 14,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 14,
                }}
              >
                <span style={{ fontSize: 18 }}>{selectedCompType.icon}</span>
                <div>
                  <div
                    style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e0' }}
                  >
                    {selectedCompType.label}
                  </div>
                  <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>
                    {selectedCompType.description}
                  </div>
                </div>
              </div>
              <ComponentProps comp={selectedComp} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
