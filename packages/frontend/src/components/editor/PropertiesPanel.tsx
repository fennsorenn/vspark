import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { HelpButton } from '../../help/HelpButton';
import {
  DEFAULT_POSE_DYNAMICS,
  type PoseDynamicsConfig,
} from '../../secondOrderDynamics';
import { PARTICLE_DEFAULTS } from '../../particleUtils';
import {
  getBuiltinParticleTextures,
  builtinParticleTextureUrl,
} from '../../particleTextures';
import { ARKIT_TO_FCL, ARKIT_TO_VRM, ARKIT_SHAPES } from '@vspark/shared/arkit';
import {
  defaultBlendshapeLimits,
  normalizeBlendshapeLimits,
  type BlendshapeLimitsConfig,
  type ClampRule,
  type ExclusiveGroup,
  type ExclusiveMember,
} from '@vspark/shared/blendshapeLimits';
import { VRM_BONE_NAMES } from '@vspark/shared/signal';
import {
  STYLE_DRIVER_NAMES,
  STYLE_PRESET_NAMES,
  styleRigPreset,
  styleRigPresetLag,
  resolveStyleResponse,
  DEFAULT_STYLE_STRENGTH,
  MAX_STYLE_STRENGTH,
  SIMPLE_CHANNELS,
  SIMPLE_COLUMNS,
  SIMPLE_CHANNEL_SPEC,
  deriveSimpleRig,
  compileSimpleRig,
  resolveRigMode,
  mergeStyleRig,
  diffStyleRig,
  type StyleDriverName,
  type StyleRig,
  type StyleBoneResponse,
  type StyleResponse,
  type DriverResponse,
  type StyleSimpleRig,
  type SimpleChannel,
  type SimpleColumn,
  type RigMode,
} from '@vspark/shared/style_rig';
import type { PoseSection, PoseSource } from '@vspark/shared';
import { useParams } from 'react-router-dom';
import { useEditorStore } from '../../store/editorStore';
import { api, fireSignalEvent, updateScene } from '../../api/client';
import type { StageObject, Behavior } from '../../store/editorStore';
import { CAMERA_EFFECT_KINDS } from '../../store/editorStore';
import {
  ComposeLayerProperties,
  ComposeSceneProperties,
} from './ComposeLayerProperties';
import type { AssetFile } from '../../api/client';
import { MicCapture, type VowelTemplates } from '../../media/MicCapture';
import { useTrackClipRecorder } from '../../hooks/useTrackClipRecorder';
import { useMeshField } from '../../hooks/useMeshField';
import {
  commitNodePatch,
  commitNodePath,
  previewNodePath,
  previewNodeTransform,
} from '../../mesh/writes';

/** Small "Pick…" button that routes the user to a bottom-dock asset tab and
 *  flashes it as a hint. The asset tab's existing "Apply to <node>" buttons do
 *  the actual assignment (flash-only picker). */
function PickButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('properties');
  return (
    <button
      onClick={onClick}
      title={t('pickButton')}
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
      {t('pickLabel')}
    </button>
  );
}
import { NumInput, VecInput, SliderInput } from './numericInputs';
import { vrmRegistry } from '../../vrmRegistry';
import { BEHAVIOR_ICON, BEHAVIOR_FALLBACK } from '../icons';
import { Check, Clapperboard } from 'lucide-react';
import {
  getMaterialSlots,
  type MaterialOverride,
  type MaterialOverrides,
  type ShaderKind,
  type AlphaMode,
  type EmissiveMapMode,
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

function getTransform(node: StageObject): Transform {
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

function getLightProps(node: StageObject): LightProps {
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

function getCameraProps(node: StageObject): CameraProps {
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
  extra,
  children,
}: {
  title: string;
  count?: number;
  defaultCollapsed?: boolean;
  /** Optional node rendered after the title (e.g. a HelpButton). It receives
   *  a stopPropagation wrapper so clicks don't toggle open/closed. */
  extra?: React.ReactNode;
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
        {extra && (
          <span
            onClick={(e) => e.stopPropagation()}
            style={{ display: 'inline-flex', alignItems: 'center' }}
          >
            {extra}
          </span>
        )}
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
  node: StageObject;
  slot: ReturnType<typeof getMaterialSlots>[number];
}) {
  const { t } = useTranslation('properties');
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

  const overridesPath = 'properties.materialOverrides';
  const slotPath = `${overridesPath}.${slot.key}`;

  /** Whole-map replace — used by reset, which removes a slot entry. */
  const writeOverrides = (next: MaterialOverrides, persist: boolean) =>
    (persist ? commitNodePath : previewNodePath)(node.id, overridesPath, next);

  /** One field of this material. Path writes stamp exactly the field touched,
   *  so editing two materials (or two params) concurrently no longer clobbers.
   *  `persist: false` is the live gesture value; `true` commits one undo step. */
  const patch = (p: Partial<MaterialOverride>, persist: boolean) => {
    const write = persist ? commitNodePath : previewNodePath;
    // No entry yet: seed shader + fields as one write, so the slot never exists
    // in a half-formed state and the edit stays a single undo step.
    if (!ov) return write(node.id, slotPath, { shader: defaultShader, ...p });
    for (const [k, v] of Object.entries(p))
      write(node.id, `${slotPath}.${k}`, v);
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
            <span
              style={{
                ...matLabel,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              {t('material.shader')}
              <HelpButton
                topic="materials"
                anchor="mode"
                tip={t('help.matMode')}
                size={12}
              />
            </span>
            <div style={{ display: 'flex', gap: 0 }}>
              {(['mtoon', 'pbr', 'apbr'] as ShaderKind[]).map((s, i, arr) => {
                const active = shader === s;
                const disabled = s === 'mtoon' && !slot.supportsMToon;
                return (
                  <button
                    key={s}
                    disabled={disabled}
                    title={s === 'apbr' ? t('material.apbrTip') : undefined}
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
          {colorRow(t('material.baseColor'), 'baseColor', d.baseColor)}
          {/* Emissive group — help on the color label (one affordance for color+intensity) */}
          <div style={matRow}>
            <span
              style={{
                ...matLabel,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              {t('material.emissive')}
              <HelpButton
                topic="materials"
                anchor="emissive"
                tip={t('help.matEmissive')}
                size={12}
              />
            </span>
            <input
              type="color"
              value={val('emissive', d.emissive)}
              style={matColorInput}
              onChange={(e) =>
                patch(
                  { emissive: e.target.value } as Partial<MaterialOverride>,
                  false
                )
              }
              onBlur={(e) =>
                patch(
                  { emissive: e.target.value } as Partial<MaterialOverride>,
                  true
                )
              }
            />
          </div>
          {sliderRow(
            t('material.emissiveInt'),
            'emissiveIntensity',
            d.emissiveIntensity,
            0,
            5,
            0.01,
            2
          )}
          <div style={matRow}>
            <span style={matLabel}>{t('material.emissiveMap')}</span>
            <select
              value={val('emissiveMapMode', 'original')}
              onChange={(e) =>
                patch(
                  { emissiveMapMode: e.target.value as EmissiveMapMode },
                  true
                )
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
              <option value="original">
                {t('material.emissiveMapOriginal')}
              </option>
              <option value="flat">{t('material.emissiveMapFlat')}</option>
              <option value="albedo">{t('material.emissiveMapAlbedo')}</option>
            </select>
          </div>
          {d.hasNormalMap &&
            sliderRow(
              t('material.normalScale'),
              'normalScale',
              d.normalScale,
              0,
              2,
              0.01,
              2
            )}
          {sliderRow(
            t('material.normalSmoothing'),
            'normalSmoothing',
            0,
            0,
            1,
            0.01,
            2
          )}
          <div style={matRow}>
            <span style={matLabel}>{t('material.flatShading')}</span>
            <input
              type="checkbox"
              checked={val('flatShading', d.flatShading)}
              onChange={(e) => patch({ flatShading: e.target.checked }, true)}
            />
          </div>
          <div style={matRow}>
            <span style={matLabel}>{t('material.doubleSided')}</span>
            <input
              type="checkbox"
              checked={val('doubleSided', d.doubleSided)}
              onChange={(e) => patch({ doubleSided: e.target.checked }, true)}
            />
          </div>
          <div style={matRow}>
            <span style={matLabel}>{t('material.alphaMode')}</span>
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
              <option value="opaque">{t('material.alphaModeOpaque')}</option>
              <option value="mask">{t('material.alphaModeMask')}</option>
              <option value="blend">{t('material.alphaModeBlend')}</option>
            </select>
          </div>
          {alphaMode === 'mask' &&
            sliderRow(
              t('material.alphaCutoff'),
              'alphaCutoff',
              d.alphaCutoff,
              0,
              1,
              0.01,
              2
            )}
          {sliderRow(
            t('material.opacity'),
            'opacity',
            d.opacity,
            0,
            1,
            0.01,
            2
          )}

          {/* MToon-only */}
          {shader === 'mtoon' && (
            <>
              {colorRow(t('material.shadeColor'), 'shadeColor', d.shadeColor)}
              {sliderRow(
                t('material.shadingShift'),
                'shadingShiftFactor',
                d.shadingShiftFactor,
                -1,
                1,
                0.01,
                2
              )}
              {sliderRow(
                t('material.shadingToony'),
                'shadingToonyFactor',
                d.shadingToonyFactor,
                0,
                1,
                0.01,
                2
              )}
              {sliderRow(
                t('material.giEqualize'),
                'giEqualization',
                d.giEqualization,
                0,
                1,
                0.01,
                2
              )}
              {colorRow(t('material.matcap'), 'matcapColor', d.matcapColor)}
              {colorRow(t('material.rimColor'), 'rimColor', d.rimColor)}
              {sliderRow(
                t('material.rimMix'),
                'rimLightingMix',
                d.rimLightingMix,
                0,
                1,
                0.01,
                2
              )}
              {sliderRow(
                t('material.rimFresnel'),
                'rimFresnelPower',
                d.rimFresnelPower,
                0,
                50,
                0.1,
                1
              )}
              {sliderRow(
                t('material.rimLift'),
                'rimLift',
                d.rimLift,
                0,
                1,
                0.01,
                2
              )}
              {d.hasOutline && (
                <>
                  {sliderRow(
                    t('material.outlineWidth'),
                    'outlineWidth',
                    d.outlineWidth,
                    0,
                    0.05,
                    0.001,
                    3
                  )}
                  {colorRow(
                    t('material.outlineColor'),
                    'outlineColor',
                    d.outlineColor
                  )}
                  {sliderRow(
                    t('material.outlineMix'),
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
              {/* Roughness + Metalness group — one ? on roughness label */}
              <div style={matRow}>
                <span
                  style={{
                    ...matLabel,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {t('material.roughness')}
                  <HelpButton
                    topic="materials"
                    anchor="metalrough"
                    tip={t('help.matMetalRough')}
                    size={12}
                  />
                </span>
                <SliderInput
                  value={val('roughness', d.roughness)}
                  min={0}
                  max={1}
                  step={0.01}
                  precision={2}
                  style={{ flex: 1 }}
                  onChange={(v) =>
                    patch({ roughness: v } as Partial<MaterialOverride>, false)
                  }
                  onCommit={(v) =>
                    patch({ roughness: v } as Partial<MaterialOverride>, true)
                  }
                />
              </div>
              {sliderRow(
                t('material.metalness'),
                'metalness',
                d.metalness,
                0,
                1,
                0.01,
                2
              )}
              <div style={matRow}>
                <span
                  style={{
                    ...matLabel,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {t('material.envIntensity')}
                  <HelpButton
                    topic="materials"
                    anchor="env"
                    tip={t('help.matEnv')}
                    size={12}
                  />
                </span>
                <SliderInput
                  value={val('envMapIntensity', d.envMapIntensity)}
                  min={0}
                  max={3}
                  step={0.01}
                  precision={2}
                  style={{ flex: 1 }}
                  onChange={(v) =>
                    patch(
                      { envMapIntensity: v } as Partial<MaterialOverride>,
                      false
                    )
                  }
                  onCommit={(v) =>
                    patch(
                      { envMapIntensity: v } as Partial<MaterialOverride>,
                      true
                    )
                  }
                />
              </div>
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
                {t('material.advanced')}
                <span
                  onClick={(e) => e.stopPropagation()}
                  style={{ display: 'inline-flex', alignItems: 'center' }}
                >
                  <HelpButton
                    topic="materials"
                    anchor="advanced"
                    tip={t('help.matAdvanced')}
                    size={12}
                  />
                </span>
              </div>
              {advOpen && (
                <>
                  {sliderRow(
                    t('material.specular'),
                    'specularIntensity',
                    d.specularIntensity,
                    0,
                    1,
                    0.01,
                    2
                  )}
                  {colorRow(
                    t('material.specularTint'),
                    'specularColor',
                    d.specularColor
                  )}
                  {sliderRow(
                    t('material.clearcoat'),
                    'clearcoat',
                    d.clearcoat,
                    0,
                    1,
                    0.01,
                    2
                  )}
                  {sliderRow(
                    t('material.clearcoatRoughness'),
                    'clearcoatRoughness',
                    d.clearcoatRoughness,
                    0,
                    1,
                    0.01,
                    2
                  )}
                  {sliderRow(
                    t('material.sheen'),
                    'sheen',
                    d.sheen,
                    0,
                    1,
                    0.01,
                    2
                  )}
                  {sliderRow(
                    t('material.sheenRoughness'),
                    'sheenRoughness',
                    d.sheenRoughness,
                    0,
                    1,
                    0.01,
                    2
                  )}
                  {colorRow(
                    t('material.sheenColor'),
                    'sheenColor',
                    d.sheenColor
                  )}
                  {sliderRow(
                    t('material.transmission'),
                    'transmission',
                    d.transmission,
                    0,
                    1,
                    0.01,
                    2
                  )}
                  {sliderRow(
                    t('material.thickness'),
                    'thickness',
                    d.thickness,
                    0,
                    5,
                    0.01,
                    2
                  )}
                  {sliderRow(
                    t('material.ior'),
                    'ior',
                    d.ior,
                    1,
                    2.333,
                    0.001,
                    3
                  )}
                  {colorRow(
                    t('material.attenuation'),
                    'attenuationColor',
                    d.attenuationColor
                  )}
                  {sliderRow(
                    t('material.attenuationDist'),
                    'attenuationDistance',
                    d.attenuationDistance,
                    0,
                    5,
                    0.01,
                    2
                  )}
                  {sliderRow(
                    t('material.iridescence'),
                    'iridescence',
                    d.iridescence,
                    0,
                    1,
                    0.01,
                    2
                  )}
                  {sliderRow(
                    t('material.iridescenceIor'),
                    'iridescenceIor',
                    d.iridescenceIor,
                    1,
                    2.333,
                    0.001,
                    3
                  )}
                  {sliderRow(
                    t('material.anisotropy'),
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
              title={t('material.resetTip')}
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
              {t('material.reset')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Lists every material on the loaded VRM with per-material shader controls. */
function MaterialSection({ node }: { node: StageObject }) {
  const { t } = useTranslation('properties');
  // Re-render when the VRM (re)loads. The materials slice is written LAST in the
  // Viewport load path (after vrmRegistry.set), so when this fires the registry
  // read below is guaranteed populated — the fix for the empty-until-reload bug.
  const loadedMaterials = useEditorStore((s) => s.vrmMaterialsByNode[node.id]);
  const vrm = vrmRegistry.get(node.id);
  if (!vrm || !loadedMaterials) {
    return (
      <CollapsibleSection title={t('material.header')}>
        <div style={{ fontSize: 11, color: '#555' }}>
          {t('material.noModel')}
        </div>
      </CollapsibleSection>
    );
  }
  const slots = getMaterialSlots(vrm);
  if (slots.length === 0) return null;
  return (
    <CollapsibleSection title={t('material.header')} count={slots.length}>
      <div
        style={{
          fontSize: 10,
          color: '#555',
          lineHeight: 1.4,
          marginBottom: 6,
        }}
      >
        {t('material.toonHint')}
      </div>
      {slots.map((slot) => (
        <MaterialRow key={slot.key} node={node} slot={slot} />
      ))}
    </CollapsibleSection>
  );
}

// ---------- Calibration wizard ----------

/**
 * Head/arm neutral-pose capture. Shared by the VMC and iFacialMocap receivers —
 * both wire the same `head_calib_capture` / `head_calib_reset` trigger nodes.
 * `arms` is off for face-only sources, which have no arm calibration stage.
 */
function CalibrationSection({
  comp,
  graphPrefix = 'vmc-pipeline:',
  arms = true,
}: {
  comp: Behavior;
  graphPrefix?: string;
  arms?: boolean;
}) {
  const { t } = useTranslation('properties');
  const [headSet, setHeadSet] = useState(false);
  const [leftSet, setLeftSet] = useState(false);
  const [rightSet, setRightSet] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const flash_ = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 1800);
  };

  const graphId = `${graphPrefix}${comp.id}`;

  const fire = async (nodeId: string, label: string, onOk?: () => void) => {
    try {
      await fireSignalEvent(graphId, nodeId, 'trigger');
      flash_(label);
      onOk?.();
    } catch {
      flash_(t('calibration.pipelineError'));
    }
  };

  const reset = async () => {
    await Promise.allSettled([
      fireSignalEvent(graphId, 'head_calib_reset', 'trigger'),
      ...(arms ? [fireSignalEvent(graphId, 'arm_calib_reset', 'trigger')] : []),
    ]);
    setHeadSet(false);
    setLeftSet(false);
    setRightSet(false);
    flash_(t('calibration.calibReset'));
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
        {t('calibration.header')}
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
        <span style={labelStyle}>{t('calibration.headLabel')}</span>
        <button
          style={btnStyle}
          onClick={() =>
            fire('head_calib_capture', t('calibration.headCaptured'), () =>
              setHeadSet(true)
            )
          }
        >
          {t('calibration.capture')}
        </button>
      </div>

      {arms && (
        <>
          <div style={rowStyle}>
            <div style={dotStyle(leftSet)} />
            <span style={labelStyle}>{t('calibration.leftArmLabel')}</span>
            <button
              style={btnStyle}
              onClick={() =>
                fire('left_arm_capture', t('calibration.leftCaptured'), () =>
                  setLeftSet(true)
                )
              }
            >
              {t('calibration.capture')}
            </button>
          </div>

          <div style={rowStyle}>
            <div style={dotStyle(rightSet)} />
            <span style={labelStyle}>{t('calibration.rightArmLabel')}</span>
            <button
              style={btnStyle}
              onClick={() =>
                fire('right_arm_capture', t('calibration.rightCaptured'), () =>
                  setRightSet(true)
                )
              }
            >
              {t('calibration.capture')}
            </button>
          </div>
        </>
      )}

      <div style={{ fontSize: 10, color: '#444', lineHeight: 1.5 }}>
        {arms ? t('calibration.hint') : t('calibration.headOnlyHint')}
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
          {t('calibration.resetAll')}
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
  const { t } = useTranslation('properties');
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
              placeholder={t('vmc.mapperArkitPlaceholder')}
            />
            <button
              style={xBtn}
              title={t('vmc.mapperRemoveShape')}
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
                  placeholder={t('vmc.mapperTargetPlaceholder')}
                />
                <button
                  style={xBtn}
                  title={t('vmc.mapperRemoveOutput')}
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
            {t('vmc.mapperAddOutput')}
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
        {t('vmc.mapperAddArkit')}
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
    label: 'VRoid Blendshapes',
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
  const { t } = useTranslation('properties');
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
            title={t('vmc.mapperVisualJson')}
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
              {t('vmc.mapperResetDefault')}
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
                  {t('vmc.mapperInvalidJson')}
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

/** Asset metadata (bones / materials / morph targets / expressions) for a
 *  node's model file, matched by stored path. Null when the node has no model
 *  or the asset predates metadata extraction. */
function assetMetaForNode(
  filePath: string | null | undefined,
  assets: AssetFile[]
): AssetFile['metadata'] {
  if (!filePath) return null;
  return assets.find((a) => a.url === filePath)?.metadata ?? null;
}

/** Prefer the live VRM list (exact for the loaded instance); fall back to the
 *  upload-time metadata list so name pickers populate even before / without the
 *  viewport loading the model (avatar in a non-active scene, just after a swap). */
function liveOrMetaList(
  live: string[] | undefined,
  meta: AssetFile['metadata'],
  key: 'bones' | 'materials' | 'morphTargets' | 'expressions'
): string[] {
  if (live && live.length) return live;
  return meta?.[key] ?? [];
}

function VmcReceiverProps({ comp }: { comp: Behavior }) {
  const { t } = useTranslation('properties');
  const {
    updateBehavior,
    vrmMorphTargetsByNode,
    vrmExpressionsByNode,
    nodes,
    assets,
  } = useEditorStore();
  const meta = assetMetaForNode(
    nodes.find((n) => n.id === comp.nodeId)?.filePath,
    assets
  );
  const morphTargets = liveOrMetaList(
    vrmMorphTargetsByNode[comp.nodeId],
    meta,
    'morphTargets'
  );
  const expressions = liveOrMetaList(
    vrmExpressionsByNode[comp.nodeId],
    meta,
    'expressions'
  );

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
    nodeConfig?: Record<
      string,
      { enabled?: boolean; mapping?: Record<string, [string, number][]> }
    >;
  };
  const [host, setHost] = useState(cfg.host ?? '0.0.0.0');
  const [port, setPort] = useState(cfg.port ?? 39539);
  const [blendMode, setBlendMode] = useState(cfg.blendMode ?? 'override');
  const [mirror, setMirror] = useState(cfg.mirror ?? false);
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
    updateBehavior(comp.id, { config: newConfig });
    try {
      await api.updateBehavior(comp.id, { config: newConfig });
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
          {t('vmc.host')}
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
          {t('vmc.port')}
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
          {t('vmc.blend')}
        </span>
        <select
          style={{ ...inputStyle, cursor: 'pointer' }}
          value={blendMode}
          onChange={(e) => {
            setBlendMode(e.target.value);
            save({ blendMode: e.target.value });
          }}
        >
          <option value="override">{t('vmc.blendOverride')}</option>
          <option value="additive">{t('vmc.blendAdditive')}</option>
        </select>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: '#888', width: 72, flexShrink: 0 }}>
          {t('vmc.mirror')}
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
          {t('vmc.flipLR')}
        </label>
      </div>

      {/* "Idle after" moved to the avatar node's properties (Idle fallback) —
          it describes the avatar's transition, not this receiver, and every
          tracking source on the node now shares the one setting. */}

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
        {t('vmc.faceMappersHeader')}
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
            {t('vmc.localIpsHeader')}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {localIps.map((ip) => (
              <button
                key={ip}
                title={t('vmc.setHostTip', { ip })}
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
        {t('vmc.compatHint', { port })}
      </div>

      <div style={{ height: 1, background: '#222', margin: '4px 0' }} />
      <CalibrationSection comp={comp} />
    </div>
  );
}

// ── iFacialMocap props ────────────────────────────────────────────────────────

/**
 * iFacialMocap receiver settings. Deliberately laid out like `VmcReceiverProps`
 * — same blend / mirror / idle-after / face-mapper controls, same calibration
 * block — with three protocol-driven differences:
 *   • Device IP instead of a bind Host (the phone only streams after we hand-
 *     shake it, so the receiver needs to know where the phone is).
 *   • Axis inversion toggles, because the published spec doesn't pin down the
 *     sign convention of the head/eye euler angles.
 *   • Head-only calibration — there is no arm data in an ARKit face stream.
 */
function IFacialMocapReceiverProps({ comp }: { comp: Behavior }) {
  const { t } = useTranslation('properties');
  const {
    updateBehavior,
    vrmMorphTargetsByNode,
    vrmExpressionsByNode,
    nodes,
    assets,
  } = useEditorStore();
  const meta = assetMetaForNode(
    nodes.find((n) => n.id === comp.nodeId)?.filePath,
    assets
  );
  const morphTargets = liveOrMetaList(
    vrmMorphTargetsByNode[comp.nodeId],
    meta,
    'morphTargets'
  );
  const expressions = liveOrMetaList(
    vrmExpressionsByNode[comp.nodeId],
    meta,
    'expressions'
  );

  const fclSuggestions = [
    ...new Set([
      ...Object.values(ARKIT_TO_FCL as Record<string, [string, number][]>)
        .flat()
        .map(([target]) => target),
      ...morphTargets,
    ]),
  ].sort();

  const exprSuggestions = [
    ...new Set([
      ...VRM_EXPR_PRESETS,
      ...Object.values(ARKIT_TO_VRM as Record<string, [string, number][]>)
        .flat()
        .map(([target]) => target),
      ...expressions,
    ]),
  ].sort();

  const passSuggestions = [
    ...new Set([...(ARKIT_SHAPES as unknown as string[]), ...morphTargets]),
  ].sort();

  const cfg = (comp.config ?? {}) as {
    deviceHost?: string;
    port?: number;
    blendMode?: string;
    mirror?: boolean;
    invertPitch?: boolean;
    invertYaw?: boolean;
    invertRoll?: boolean;
    nodeConfig?: Record<
      string,
      { enabled?: boolean; mapping?: Record<string, [string, number][]> }
    >;
  };
  const [deviceHost, setDeviceHost] = useState(cfg.deviceHost ?? '');
  const [port, setPort] = useState(cfg.port ?? 49983);
  const [blendMode, setBlendMode] = useState(cfg.blendMode ?? 'override');
  const [mirror, setMirror] = useState(cfg.mirror ?? false);
  const [invertPitch, setInvertPitch] = useState(cfg.invertPitch ?? false);
  const [invertYaw, setInvertYaw] = useState(cfg.invertYaw ?? false);
  const [invertRoll, setInvertRoll] = useState(cfg.invertRoll ?? false);
  const [localIps, setLocalIps] = useState<string[]>([]);

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
    setDeviceHost(cfg.deviceHost ?? '');
    setPort(cfg.port ?? 49983);
    setBlendMode(cfg.blendMode ?? 'override');
    setMirror(cfg.mirror ?? false);
    setInvertPitch(cfg.invertPitch ?? false);
    setInvertYaw(cfg.invertYaw ?? false);
    setInvertRoll(cfg.invertRoll ?? false);
    setMapperConfigs(getMapperConfigs());

    // Persist mapper defaults immediately so the stored config is always
    // explicit rather than relying on implicit fallbacks (mirrors the VMC panel).
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
    updateBehavior(comp.id, { config: newConfig });
    try {
      await api.updateBehavior(comp.id, { config: newConfig });
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
  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: '#888',
    width: 72,
    flexShrink: 0,
  };
  const checkLabelStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    cursor: 'pointer',
    fontSize: 12,
    color: '#ccc',
  };

  const axisToggles: {
    key: 'invertPitch' | 'invertYaw' | 'invertRoll';
    label: string;
    value: boolean;
    set: (v: boolean) => void;
  }[] = [
    {
      key: 'invertPitch',
      label: t('ifm.invertPitch'),
      value: invertPitch,
      set: setInvertPitch,
    },
    {
      key: 'invertYaw',
      label: t('ifm.invertYaw'),
      value: invertYaw,
      set: setInvertYaw,
    },
    {
      key: 'invertRoll',
      label: t('ifm.invertRoll'),
      value: invertRoll,
      set: setInvertRoll,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={labelStyle}>{t('ifm.deviceHost')}</span>
        <input
          className="vs-ifm-device-host"
          style={inputStyle}
          value={deviceHost}
          onChange={(e) => setDeviceHost(e.target.value)}
          onBlur={() => save({ deviceHost })}
          placeholder={t('ifm.deviceHostPlaceholder')}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={labelStyle}>{t('vmc.port')}</span>
        <NumInput
          className="vs-ifm-port"
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

      {/*
        Sits directly under Port, aligned to the input column: the handshake is
        one-way, so the app reports "connected" even when a blocked inbound port
        means nothing arrives. One-line reminder; full symptom/fix behind the
        help button.
      */}
      <div
        className="vs-ifm-firewall-hint"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          marginLeft: 80,
          marginTop: -4,
          fontSize: 10,
          color: '#8a7a4a',
          lineHeight: 1.4,
        }}
      >
        <span>{t('ifm.firewallHint', { port })}</span>
        <HelpButton
          topic="behaviors"
          anchor="ifacialmocap-firewall"
          tip={t('help.ifmFirewall')}
          size={12}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={labelStyle}>{t('vmc.blend')}</span>
        <select
          className="vs-ifm-blend-mode"
          style={{ ...inputStyle, cursor: 'pointer' }}
          value={blendMode}
          onChange={(e) => {
            setBlendMode(e.target.value);
            save({ blendMode: e.target.value });
          }}
        >
          <option value="override">{t('ifm.blendOverride')}</option>
          <option value="additive">{t('vmc.blendAdditive')}</option>
        </select>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={labelStyle}>{t('vmc.mirror')}</span>
        <label style={checkLabelStyle}>
          <input
            className="vs-ifm-mirror"
            type="checkbox"
            checked={mirror}
            onChange={(e) => {
              setMirror(e.target.checked);
              save({ mirror: e.target.checked });
            }}
            style={{ cursor: 'pointer' }}
          />
          {t('vmc.flipLR')}
        </label>
      </div>

      {/* Head axis orientation */}
      <div
        style={{
          fontSize: 10,
          color: '#666',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          marginTop: 4,
        }}
      >
        {t('ifm.axesHeader')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {axisToggles.map(({ key, label, value, set }) => (
          <label key={key} style={checkLabelStyle}>
            <input
              className={`vs-ifm-${key.toLowerCase()}`}
              type="checkbox"
              checked={value}
              onChange={(e) => {
                set(e.target.checked);
                save({ [key]: e.target.checked });
              }}
              style={{ cursor: 'pointer' }}
            />
            {label}
          </label>
        ))}
      </div>
      <div style={{ fontSize: 10, color: '#555', lineHeight: 1.4 }}>
        {t('ifm.axesHint')}
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
        {t('vmc.faceMappersHeader')}
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

      {/* Local IPs — the address to type into the app when not using Device IP */}
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
            {t('ifm.localIpsHeader')}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {localIps.map((ip) => (
              <span
                key={ip}
                style={{
                  background: '#1e1e1e',
                  border: '1px solid #2a2a2a',
                  color: '#888',
                  borderRadius: 4,
                  padding: '2px 8px',
                  fontSize: 11,
                  fontFamily: 'monospace',
                }}
              >
                {ip}
              </span>
            ))}
          </div>
        </div>
      )}

      <div
        style={{ fontSize: 10, color: '#555', lineHeight: 1.4, marginTop: 2 }}
      >
        {t('ifm.compatHint', { port })}
      </div>

      <div style={{ height: 1, background: '#222', margin: '4px 0' }} />
      <CalibrationSection
        comp={comp}
        graphPrefix="ifacialmocap-pipeline:"
        arms={false}
      />
    </div>
  );
}

// ── Lipsync props ─────────────────────────────────────────────────────────────

function LipsyncProcessorProps({ comp }: { comp: Behavior }) {
  const { t } = useTranslation('properties');
  const { updateBehavior } = useEditorStore();
  const { projectId } = useParams<{ projectId: string }>();
  const cfg = comp.config as {
    sensitivity?: number;
    vowelTemplates?: VowelTemplates;
  };
  const [sensitivity, setSensitivity] = useState(cfg.sensitivity ?? 1.0);

  const save = (patch: Record<string, unknown>) => {
    const config = { ...comp.config, ...patch };
    updateBehavior(comp.id, { config });
    api.updateBehavior(comp.id, { config }).catch(() => {});
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
        <span style={labelStyle}>{t('lipsync.sensitivity')}</span>
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
          {t('lipsync.openMediaInput')}
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
  const { t } = useTranslation('properties');
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
      <div style={headerStyle}>{t('lipsync.vowelCalibHeader')}</div>
      <div style={{ fontSize: 11, color: '#666', marginBottom: 8 }}>
        {t('lipsync.vowelCalibHint')}
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
            {draft[v] ? (
              <Check
                size={12}
                style={{ marginLeft: 4, verticalAlign: '-1px' }}
              />
            ) : null}
          </button>
        ))}
      </div>
      <div>
        <button
          style={{ ...actionBtn, opacity: canSave ? 1 : 0.4 }}
          disabled={!canSave}
          onClick={() => canSave && onSave(draft as VowelTemplates)}
        >
          {t('lipsync.save')}
        </button>
        <button
          style={actionBtn}
          onClick={() => {
            setDraft({});
            onReset();
          }}
        >
          {t('lipsync.resetDefaults')}
        </button>
      </div>
      {error && (
        <div style={{ marginTop: 6, color: '#d66', fontSize: 11 }}>{error}</div>
      )}
    </div>
  );
}

// ── MediaPipe tracker props ────────────────────────────────────────────────────

function MediapipeTrackerProps({ comp }: { comp: Behavior }) {
  const { t } = useTranslation('properties');
  const { updateBehavior } = useEditorStore();
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
    updateBehavior(comp.id, { config });
    api.updateBehavior(comp.id, { config }).catch(() => {});
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
      flashCalib(t('mediapipe.pipelineError'));
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
          ['enableFace', t('mediapipe.faceLandmarks')],
          ['enablePose', t('mediapipe.poseBody')],
          ['enableHands', t('mediapipe.handTracking')],
        ] as [keyof typeof cfg, string][]
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
          {t('mediapipe.calibrationHeader')}
        </div>
        <div style={{ fontSize: 10, color: '#777', marginBottom: 2 }}>
          {t('mediapipe.headTorsoHint')}
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
              fireCalib('head_calib_capture', t('mediapipe.headCaptured'))
            }
          >
            {t('mediapipe.captureHead')}
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
              fireCalib('head_calib_reset', t('mediapipe.headReset'))
            }
          >
            {t('mediapipe.resetHead')}
          </button>
        </div>
        <div style={{ fontSize: 10, color: '#777', marginBottom: 2 }}>
          {t('mediapipe.fingersHint')}
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
              fireCalib('finger_calib_capture', t('mediapipe.fingerCaptured'))
            }
          >
            {t('mediapipe.captureFingers')}
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
              fireCalib('finger_calib_reset', t('mediapipe.fingerReset'))
            }
          >
            {t('mediapipe.resetFingers')}
          </button>
        </div>
        {calibFlash && (
          <div style={{ fontSize: 11, color: '#7d7', marginBottom: 6 }}>
            {calibFlash}
          </div>
        )}

        <div style={rowStyle}>
          <span style={labelStyle}>{t('mediapipe.useIkArms')}</span>
          <input
            type="checkbox"
            checked={useIk}
            onChange={(e) => save({ useIk: e.target.checked })}
            style={{ cursor: 'pointer' }}
          />
        </div>
        <div style={{ fontSize: 10, color: '#555', marginBottom: 6 }}>
          {t('mediapipe.ikHint')}
        </div>
        <div
          style={{
            fontSize: 11,
            color: '#666',
            textTransform: 'uppercase',
            marginBottom: 4,
          }}
        >
          {t('mediapipe.ikCalibHeader')}{' '}
          <span style={{ textTransform: 'none', color: '#555' }}>
            {t('mediapipe.ikCalibNote')}
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
                {t('mediapipe.ikAxis', { axis: axis.toUpperCase() })}
              </div>
              <SliderInput
                label={t('mediapipe.ikScale')}
                value={a.scale}
                min={0}
                max={8}
                step={0.1}
                precision={1}
                onChange={(v) => saveIk({ [scaleField]: v })}
              />
              <SliderInput
                label={t('mediapipe.ikOffset')}
                value={a.offset}
                min={-0.5}
                max={0.5}
                step={0.01}
                precision={2}
                onChange={(v) => saveIk({ [offsetField]: v })}
              />
              <div style={rowStyle}>
                <span style={labelStyle}>{t('mediapipe.ikInvert')}</span>
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
          {t('mediapipe.headCalibHeader')}{' '}
          <span style={{ textTransform: 'none', color: '#555' }}>
            {t('mediapipe.headCalibNote')}
          </span>
        </div>
        <SliderInput
          label={t('mediapipe.pitchGain')}
          value={head.pitchGain}
          min={0.5}
          max={5}
          step={0.1}
          precision={1}
          onChange={(v) => saveHead({ pitchGain: v })}
        />
        <SliderInput
          label={t('mediapipe.yawGain')}
          value={head.yawGain}
          min={0.5}
          max={5}
          step={0.1}
          precision={1}
          onChange={(v) => saveHead({ yawGain: v })}
        />
        <SliderInput
          label={t('mediapipe.rollGain')}
          value={head.rollGain}
          min={0.5}
          max={5}
          step={0.1}
          precision={1}
          onChange={(v) => saveHead({ rollGain: v })}
        />
        <SliderInput
          label={t('mediapipe.restPitch')}
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
          {t('mediapipe.openMediaInput')}
        </button>
      </div>
    </div>
  );
}

function ApiControllerProps({ comp }: { comp: Behavior }) {
  const { t } = useTranslation('properties');
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
        {t('apiController.baseUrlLabel')}
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
          {copied ? t('apiController.copied') : t('apiController.copy')}
        </button>
      </div>
      <div
        style={{ fontSize: 11, color: '#666', marginTop: 6, lineHeight: 1.5 }}
      >
        {t('apiController.hint')}
      </div>
    </div>
  );
}

// ── Breathing component panel ────────────────────────────────────────────────

function BreathingProps({ comp }: { comp: Behavior }) {
  const { t } = useTranslation('properties');
  const { updateBehavior } = useEditorStore();
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
    updateBehavior(comp.id, { config });
    api.updateBehavior(comp.id, { config }).catch(() => {});
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{ fontSize: 12, color: '#888', width: 100, flexShrink: 0 }}
        >
          {t('breathing.chestAmplitude')}
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
          {t('breathing.shoulderLift')}
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

// ── Manual calibration component panel ───────────────────────────────────────

interface BoneCalibration {
  multiplier?: [number, number, number];
  offset?: [number, number, number];
}

const DEFAULT_MULTIPLIER: [number, number, number] = [1, 1, 1];
const DEFAULT_OFFSET: [number, number, number] = [0, 0, 0];

function isDefaultCalibration(cal: BoneCalibration): boolean {
  const m = cal.multiplier ?? DEFAULT_MULTIPLIER;
  const o = cal.offset ?? DEFAULT_OFFSET;
  return (
    m[0] === 1 &&
    m[1] === 1 &&
    m[2] === 1 &&
    o[0] === 0 &&
    o[1] === 0 &&
    o[2] === 0
  );
}

const resetBtnStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  background: 'transparent',
  color: '#a66',
  border: '1px solid #533',
  borderRadius: 4,
  fontSize: 10,
  padding: '1px 6px',
  cursor: 'pointer',
};

/** Compact, self-contained collapsible row for one bone (tight spacing — the
 *  generic CollapsibleSection's 16px header margins stack badly across 55 bones). */
function BoneCalibRow({
  bone,
  cal,
  modified,
  onChange,
  onReset,
}: {
  bone: string;
  cal: BoneCalibration;
  modified: boolean;
  onChange: (patch: BoneCalibration) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const m = cal.multiplier ?? DEFAULT_MULTIPLIER;
  const o = cal.offset ?? DEFAULT_OFFSET;
  return (
    <div style={{ borderBottom: '1px solid #262626' }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          userSelect: 'none',
          padding: '3px 2px',
          fontSize: 11,
          color: modified ? '#c9b86a' : '#aaa',
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
        <span style={{ flex: 1, minWidth: 0 }}>{bone}</span>
        {modified && <span style={{ color: '#c9b86a', fontSize: 9 }}>●</span>}
      </div>
      {open && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '2px 2px 8px 16px',
          }}
        >
          <VecInput
            values={m as number[]}
            labels={['X', 'Y', 'Z']}
            step={0.1}
            groupLabel="Multiplier"
            onChange={(next) =>
              onChange({ multiplier: next as [number, number, number] })
            }
            onCommit={(next) =>
              onChange({ multiplier: next as [number, number, number] })
            }
            style={{ minWidth: 0 }}
          />
          <VecInput
            values={o as number[]}
            labels={['X', 'Y', 'Z']}
            step={1}
            suffix="°"
            groupLabel="Offset (°)"
            onChange={(next) =>
              onChange({ offset: next as [number, number, number] })
            }
            onCommit={(next) =>
              onChange({ offset: next as [number, number, number] })
            }
            style={{ minWidth: 0 }}
          />
          {modified && (
            <button onClick={onReset} style={resetBtnStyle}>
              Reset bone
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ManualCalibrationProps({ comp }: { comp: Behavior }) {
  const { updateBehavior } = useEditorStore();
  const cfg = (comp.config ?? {}) as {
    calibrations?: Record<string, BoneCalibration>;
  };
  const calibrations = cfg.calibrations ?? {};

  const saveCalibrations = (next: Record<string, BoneCalibration>) => {
    const config = { ...comp.config, calibrations: next };
    updateBehavior(comp.id, { config });
    api.updateBehavior(comp.id, { config }).catch(() => {});
  };

  const setBone = (bone: string, patch: BoneCalibration) => {
    const merged: BoneCalibration = { ...calibrations[bone], ...patch };
    const next = { ...calibrations };
    // Prune entries that are back at the identity so the stored map stays lean.
    if (isDefaultCalibration(merged)) delete next[bone];
    else next[bone] = merged;
    saveCalibrations(next);
  };

  const resetBone = (bone: string) => {
    if (!(bone in calibrations)) return;
    const next = { ...calibrations };
    delete next[bone];
    saveCalibrations(next);
  };

  const modifiedCount = Object.keys(calibrations).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 11, color: '#888' }}>
          {modifiedCount > 0
            ? `${modifiedCount} bone${modifiedCount === 1 ? '' : 's'} calibrated`
            : 'No calibration'}
        </span>
        {modifiedCount > 0 && (
          <button onClick={() => saveCalibrations({})} style={resetBtnStyle}>
            Reset all
          </button>
        )}
      </div>
      <div style={{ fontSize: 10, color: '#555', lineHeight: 1.4 }}>
        Multiplier scales how far a rotation travels along each axis (2 = twice
        as far). Offset shifts the neutral 0, in degrees.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {VRM_BONE_NAMES.map((bone) => (
          <BoneCalibRow
            key={bone}
            bone={bone}
            cal={calibrations[bone] ?? {}}
            modified={bone in calibrations}
            onChange={(patch) => setBone(bone, patch)}
            onReset={() => resetBone(bone)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Expression limits (blendshape_limiter) ────────────────────────────────────

const limitRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const limitCardStyle: React.CSSProperties = {
  border: '1px solid #222',
  borderRadius: 4,
  padding: 8,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  background: '#141414',
};

const limitLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#888',
  width: 74,
  flexShrink: 0,
};

const limitTextInputStyle: React.CSSProperties = {
  background: '#0d0d0d',
  border: '1px solid #2a2a2a',
  borderRadius: 3,
  color: '#ccc',
  fontSize: 11,
  padding: '2px 6px',
  minWidth: 0,
  flex: 1,
};

const limitSmallBtnStyle: React.CSSProperties = {
  background: '#1a2a3a',
  border: '1px solid #2a3a4a',
  borderRadius: 3,
  color: '#8ab',
  fontSize: 10,
  padding: '2px 7px',
  cursor: 'pointer',
};

/**
 * Chip editor for a list of expression-name patterns. The add-field is backed by
 * a datalist of the names the loaded avatar actually exposes, so users pick real
 * shapes instead of guessing spellings — while still being free to type a `*`
 * wildcard the model list can't offer.
 */
function NameListEditor({
  values,
  listId,
  placeholder,
  onChange,
}: {
  values: string[];
  /** id of the shared <datalist> holding the model's real shape names. */
  listId: string;
  placeholder: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const name = raw.trim();
    if (!name || values.includes(name)) return;
    onChange([...values, name]);
    setDraft('');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {values.map((v) => (
          <span
            key={v}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              background: '#1d1d1d',
              border: '1px solid #2c2c2c',
              borderRadius: 10,
              padding: '1px 4px 1px 8px',
              fontSize: 10,
              fontFamily: 'monospace',
              color: '#bbb',
            }}
          >
            {v}
            <button
              className="vs-bslimits-name-remove"
              onClick={() => onChange(values.filter((n) => n !== v))}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#a66',
                cursor: 'pointer',
                fontSize: 11,
                lineHeight: 1,
                padding: '0 2px',
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        className="vs-bslimits-name-add"
        value={draft}
        list={listId}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(draft);
          }
        }}
        onBlur={() => add(draft)}
        style={{ ...limitTextInputStyle, fontFamily: 'monospace' }}
      />
    </div>
  );
}

function BlendshapeLimiterProps({ comp }: { comp: Behavior }) {
  const { t } = useTranslation('properties');
  const {
    updateBehavior,
    vrmMorphTargetsByNode,
    vrmExpressionsByNode,
    nodes,
    assets,
  } = useEditorStore();

  // Names the loaded model actually exposes — offered as datalist suggestions.
  const meta = assetMetaForNode(
    nodes.find((n) => n.id === comp.nodeId)?.filePath,
    assets
  );
  const nameOptions = [
    ...new Set([
      ...liveOrMetaList(vrmExpressionsByNode[comp.nodeId], meta, 'expressions'),
      ...liveOrMetaList(
        vrmMorphTargetsByNode[comp.nodeId],
        meta,
        'morphTargets'
      ),
    ]),
  ].sort();
  const listId = `vs-bslimits-names-${comp.id}`;

  const limits = normalizeBlendshapeLimits(
    (comp.config as { limits?: unknown } | undefined)?.limits
  );
  const groups = limits.groups ?? [];
  const clamps = limits.clamps ?? [];

  const save = (next: BlendshapeLimitsConfig) => {
    const config = { ...comp.config, limits: next };
    updateBehavior(comp.id, { config });
    api.updateBehavior(comp.id, { config }).catch(() => {});
  };
  const patch = (p: Partial<BlendshapeLimitsConfig>) =>
    save({ ...limits, ...p });

  const patchGroup = (idx: number, p: Partial<ExclusiveGroup>) =>
    patch({ groups: groups.map((g, i) => (i === idx ? { ...g, ...p } : g)) });
  const patchMember = (gi: number, mi: number, p: Partial<ExclusiveMember>) =>
    patchGroup(gi, {
      members: groups[gi].members.map((m, i) =>
        i === mi ? { ...m, ...p } : m
      ),
    });
  const patchClamp = (idx: number, p: Partial<ClampRule>) =>
    patch({ clamps: clamps.map((c, i) => (i === idx ? { ...c, ...p } : c)) });

  // Raw JSON escape hatch. Kept in local state while editing so a half-typed
  // document doesn't get written back on every keystroke.
  const [jsonDraft, setJsonDraft] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const applyJson = () => {
    if (jsonDraft == null) return;
    try {
      save(normalizeBlendshapeLimits(JSON.parse(jsonDraft)));
      setJsonDraft(null);
      setJsonError(null);
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <datalist id={listId}>
        {nameOptions.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      <div style={{ ...limitRowStyle, justifyContent: 'space-between' }}>
        <label style={{ ...limitRowStyle, cursor: 'pointer' }}>
          <input
            type="checkbox"
            className="vs-bslimits-enabled"
            checked={limits.enabled !== false}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span style={{ fontSize: 12, color: '#aaa' }}>
            {t('blendshapeLimits.enabled')}
          </span>
        </label>
        <div style={limitRowStyle}>
          <HelpButton
            topic="behaviors"
            anchor="expression-limits"
            tip={t('help.expressionLimits')}
          />
          <button
            className="vs-bslimits-reset"
            onClick={() => save(defaultBlendshapeLimits())}
            style={resetBtnStyle}
          >
            {t('blendshapeLimits.resetDefaults')}
          </button>
        </div>
      </div>

      <div style={{ fontSize: 10, color: '#555', lineHeight: 1.4 }}>
        {t('blendshapeLimits.hint')}
      </div>

      {/* ── Exclusive groups ─────────────────────────────────────────────── */}
      <CollapsibleSection
        title={t('blendshapeLimits.groupsHeader')}
        count={groups.length}
        defaultCollapsed={false}
      >
        <div style={{ fontSize: 10, color: '#555', lineHeight: 1.4 }}>
          {t('blendshapeLimits.groupsHint')}
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            marginTop: 6,
          }}
        >
          {groups.map((g, gi) => (
            <div key={g.id} style={limitCardStyle}>
              <div
                style={{ ...limitRowStyle, justifyContent: 'space-between' }}
              >
                <label style={{ ...limitRowStyle, flex: 1, minWidth: 0 }}>
                  <input
                    type="checkbox"
                    className="vs-bslimits-group-enabled"
                    checked={g.enabled !== false}
                    onChange={(e) =>
                      patchGroup(gi, { enabled: e.target.checked })
                    }
                  />
                  <input
                    className="vs-bslimits-group-label"
                    value={g.label ?? g.id}
                    onChange={(e) => patchGroup(gi, { label: e.target.value })}
                    style={limitTextInputStyle}
                  />
                </label>
                <button
                  className="vs-bslimits-group-remove"
                  onClick={() =>
                    patch({ groups: groups.filter((_, i) => i !== gi) })
                  }
                  style={resetBtnStyle}
                >
                  {t('blendshapeLimits.remove')}
                </button>
              </div>

              <div style={limitRowStyle}>
                <span style={limitLabelStyle}>
                  {t('blendshapeLimits.mode')}
                </span>
                <select
                  className="vs-bslimits-group-mode"
                  value={g.mode ?? 'suppress'}
                  onChange={(e) =>
                    patchGroup(gi, {
                      mode: e.target.value as ExclusiveGroup['mode'],
                    })
                  }
                  style={{ ...limitTextInputStyle, flex: 'none', width: 120 }}
                >
                  <option value="suppress">
                    {t('blendshapeLimits.modeSuppress')}
                  </option>
                  <option value="normalize">
                    {t('blendshapeLimits.modeNormalize')}
                  </option>
                </select>
                <span style={{ ...limitLabelStyle, width: 'auto' }}>
                  {t('blendshapeLimits.strength')}
                </span>
                <NumInput
                  className="vs-bslimits-group-strength"
                  value={g.strength ?? 1}
                  step={0.05}
                  min={0}
                  max={1}
                  style={{ width: 70 }}
                  onCommit={(v) => patchGroup(gi, { strength: v })}
                />
              </div>

              <div style={{ fontSize: 10, color: '#666' }}>
                {t('blendshapeLimits.membersHeader')}
              </div>
              {g.members.map((m, mi) => (
                <div
                  key={m.id}
                  style={{
                    ...limitRowStyle,
                    alignItems: 'flex-start',
                    gap: 6,
                  }}
                >
                  <input
                    className="vs-bslimits-member-label"
                    value={m.label ?? m.id}
                    onChange={(e) =>
                      patchMember(gi, mi, { label: e.target.value })
                    }
                    style={{ ...limitTextInputStyle, flex: '0 0 90px' }}
                  />
                  <NameListEditor
                    values={m.patterns}
                    listId={listId}
                    placeholder={t('blendshapeLimits.addName')}
                    onChange={(patterns) => patchMember(gi, mi, { patterns })}
                  />
                  <button
                    className="vs-bslimits-member-remove"
                    onClick={() =>
                      patchGroup(gi, {
                        members: g.members.filter((_, i) => i !== mi),
                      })
                    }
                    style={resetBtnStyle}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                className="vs-bslimits-add-member"
                onClick={() =>
                  patchGroup(gi, {
                    members: [
                      ...g.members,
                      {
                        id: `member-${Date.now()}`,
                        label: t('blendshapeLimits.newMember'),
                        patterns: [],
                      },
                    ],
                  })
                }
                style={limitSmallBtnStyle}
              >
                + {t('blendshapeLimits.addMember')}
              </button>
            </div>
          ))}
        </div>
        <button
          className="vs-bslimits-add-group"
          onClick={() =>
            patch({
              groups: [
                ...groups,
                {
                  id: `group-${Date.now()}`,
                  label: t('blendshapeLimits.newGroup'),
                  enabled: true,
                  mode: 'suppress',
                  strength: 1,
                  members: [],
                },
              ],
            })
          }
          style={{ ...limitSmallBtnStyle, marginTop: 6 }}
        >
          + {t('blendshapeLimits.addGroup')}
        </button>
      </CollapsibleSection>

      {/* ── Clamp rules ──────────────────────────────────────────────────── */}
      <CollapsibleSection
        title={t('blendshapeLimits.clampsHeader')}
        count={clamps.length}
        defaultCollapsed={false}
      >
        <div style={{ fontSize: 10, color: '#555', lineHeight: 1.4 }}>
          {t('blendshapeLimits.clampsHint')}
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            marginTop: 6,
          }}
        >
          {clamps.map((c, ci) => (
            <div key={c.id} style={limitCardStyle}>
              <div
                style={{ ...limitRowStyle, justifyContent: 'space-between' }}
              >
                <label style={{ ...limitRowStyle, flex: 1, minWidth: 0 }}>
                  <input
                    type="checkbox"
                    className="vs-bslimits-clamp-enabled"
                    checked={c.enabled !== false}
                    onChange={(e) =>
                      patchClamp(ci, { enabled: e.target.checked })
                    }
                  />
                  <input
                    className="vs-bslimits-clamp-label"
                    value={c.label ?? c.id}
                    onChange={(e) => patchClamp(ci, { label: e.target.value })}
                    style={limitTextInputStyle}
                  />
                </label>
                <button
                  className="vs-bslimits-clamp-remove"
                  onClick={() =>
                    patch({ clamps: clamps.filter((_, i) => i !== ci) })
                  }
                  style={resetBtnStyle}
                >
                  {t('blendshapeLimits.remove')}
                </button>
              </div>

              <div style={{ ...limitRowStyle, alignItems: 'flex-start' }}>
                <span style={limitLabelStyle}>
                  {t('blendshapeLimits.when')}
                </span>
                <NameListEditor
                  values={c.when ?? []}
                  listId={listId}
                  placeholder={t('blendshapeLimits.addDriver')}
                  onChange={(when) => patchClamp(ci, { when })}
                />
              </div>

              <div style={{ ...limitRowStyle, alignItems: 'flex-start' }}>
                <span style={limitLabelStyle}>
                  {t('blendshapeLimits.targets')}
                </span>
                <NameListEditor
                  values={c.targets}
                  listId={listId}
                  placeholder={t('blendshapeLimits.addName')}
                  onChange={(targets) => patchClamp(ci, { targets })}
                />
              </div>

              <div style={limitRowStyle}>
                <span style={limitLabelStyle}>
                  {t('blendshapeLimits.range')}
                </span>
                <NumInput
                  className="vs-bslimits-clamp-min"
                  value={c.min ?? 0}
                  step={0.05}
                  min={0}
                  max={1}
                  prefix={t('blendshapeLimits.min')}
                  style={{ width: 84 }}
                  onCommit={(v) => patchClamp(ci, { min: v })}
                />
                <NumInput
                  className="vs-bslimits-clamp-max"
                  value={c.max ?? 1}
                  step={0.05}
                  min={0}
                  max={1}
                  prefix={t('blendshapeLimits.max')}
                  style={{ width: 84 }}
                  onCommit={(v) => patchClamp(ci, { max: v })}
                />
              </div>

              <div style={limitRowStyle}>
                <span style={limitLabelStyle}>
                  {t('blendshapeLimits.threshold')}
                </span>
                <NumInput
                  className="vs-bslimits-clamp-threshold"
                  value={c.threshold ?? 0}
                  step={0.05}
                  min={0}
                  max={1}
                  style={{ width: 70 }}
                  onCommit={(v) => patchClamp(ci, { threshold: v })}
                />
                <label style={{ ...limitRowStyle, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    className="vs-bslimits-clamp-ramp"
                    checked={c.ramp !== false}
                    onChange={(e) => patchClamp(ci, { ramp: e.target.checked })}
                  />
                  <span style={{ fontSize: 11, color: '#888' }}>
                    {t('blendshapeLimits.ramp')}
                  </span>
                </label>
              </div>
            </div>
          ))}
        </div>
        <button
          className="vs-bslimits-add-clamp"
          onClick={() =>
            patch({
              clamps: [
                ...clamps,
                {
                  id: `clamp-${Date.now()}`,
                  label: t('blendshapeLimits.newClamp'),
                  enabled: true,
                  when: [],
                  threshold: 0.3,
                  ramp: true,
                  targets: [],
                  min: 0,
                  max: 1,
                },
              ],
            })
          }
          style={{ ...limitSmallBtnStyle, marginTop: 6 }}
        >
          + {t('blendshapeLimits.addClamp')}
        </button>
      </CollapsibleSection>

      {/* ── Raw JSON ─────────────────────────────────────────────────────── */}
      <CollapsibleSection title={t('blendshapeLimits.jsonHeader')}>
        <div style={{ fontSize: 10, color: '#555', lineHeight: 1.4 }}>
          {t('blendshapeLimits.jsonHint')}
        </div>
        <textarea
          className="vs-bslimits-json"
          value={jsonDraft ?? JSON.stringify(limits, null, 2)}
          onChange={(e) => {
            setJsonDraft(e.target.value);
            setJsonError(null);
          }}
          spellCheck={false}
          style={{
            ...limitTextInputStyle,
            width: '100%',
            minHeight: 180,
            marginTop: 6,
            fontFamily: 'monospace',
            resize: 'vertical',
          }}
        />
        {jsonError && (
          <div style={{ fontSize: 10, color: '#c66', marginTop: 4 }}>
            {jsonError}
          </div>
        )}
        <div style={{ ...limitRowStyle, marginTop: 6 }}>
          <button
            className="vs-bslimits-json-apply"
            onClick={applyJson}
            disabled={jsonDraft == null}
            style={{
              ...limitSmallBtnStyle,
              opacity: jsonDraft == null ? 0.4 : 1,
            }}
          >
            {t('blendshapeLimits.jsonApply')}
          </button>
          <button
            className="vs-bslimits-json-revert"
            onClick={() => {
              setJsonDraft(null);
              setJsonError(null);
            }}
            disabled={jsonDraft == null}
            style={{ ...resetBtnStyle, opacity: jsonDraft == null ? 0.4 : 1 }}
          >
            {t('blendshapeLimits.jsonRevert')}
          </button>
        </div>
      </CollapsibleSection>
    </div>
  );
}

// ── Stylized tracking (pose_stylizer) component panel ────────────────────────

const rigSelectStyle: React.CSSProperties = {
  background: '#2a2a2a',
  border: '1px solid #3a3a3a',
  color: '#e0e0e0',
  borderRadius: 4,
  padding: '3px 6px',
  fontSize: 11,
};

interface StylizerConfig {
  amount?: number;
  strength?: number;
  lag?: number | null;
  restUnmapped?: boolean;
  preset?: string;
  response?: Partial<StyleResponse>;
  rig?: StyleRig | null;
  rigMode?: string;
  simpleRig?: StyleSimpleRig | null;
}

/**
 * The simplified rig editor: a 6 × 6 grid of section totals. Rows are the motion
 * produced, columns the driver producing it, so the diagonal is a section
 * answering its own driver and everything off it is cross-coupling (including the
 * head↔body counter-rotations).
 */
function SimpleRigGrid({
  effective,
  overrides,
  onChange,
}: {
  /** The rig actually running — supplies the displayed totals. */
  effective: StyleRig;
  overrides: StyleSimpleRig;
  onChange: (next: StyleSimpleRig) => void;
}) {
  const { t } = useTranslation('properties');
  const derived = deriveSimpleRig(effective);

  const valueOf = (row: SimpleChannel, col: SimpleColumn) =>
    overrides[row]?.[col] ?? derived[row]?.[col] ?? 0;

  const setCell = (row: SimpleChannel, col: SimpleColumn, v: number) =>
    onChange({ ...overrides, [row]: { ...overrides[row], [col]: v } });

  // Shift rows are a TRANSLATION in hip-height fractions, not degrees, so they
  // need their own unit and a finer step than the rotation rows.
  const isShift = (row: SimpleChannel) =>
    SIMPLE_CHANNEL_SPEC[row].section === 'shift';

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            <th />
            {SIMPLE_COLUMNS.map((col) => (
              <th
                key={col}
                title={t(`stylizedTracking.channel.${col}`)}
                style={{
                  fontWeight: 400,
                  color: '#888',
                  padding: '2px 4px',
                  textAlign: 'center',
                  whiteSpace: 'nowrap',
                }}
              >
                {t(`stylizedTracking.channelShort.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SIMPLE_CHANNELS.map((row) => (
            <tr key={row}>
              <th
                style={{
                  fontWeight: 400,
                  color: '#888',
                  padding: '2px 6px 2px 0',
                  textAlign: 'right',
                  whiteSpace: 'nowrap',
                }}
              >
                {t(`stylizedTracking.channel.${row}`)}
              </th>
              {SIMPLE_COLUMNS.map((col) => (
                <td key={col} style={{ padding: 1 }}>
                  <NumInput
                    className={`vs-stylize-cell-${row}-${col}`}
                    value={valueOf(row, col)}
                    step={isShift(row) ? 0.01 : 1}
                    suffix={isShift(row) ? '×' : '°'}
                    precision={isShift(row) ? 2 : undefined}
                    style={{ width: 62 }}
                    onChange={(v) => setCell(row, col, v)}
                    onCommit={(v) => setCell(row, col, v)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The tunable half of `StyleResponse`, in panel order. */
const RESPONSE_FIELDS: Array<{
  key: keyof StyleResponse;
  step: number;
  min: number;
  max?: number;
  suffix?: string;
}> = [
  { key: 'headRange', step: 5, min: 5, max: 180, suffix: '°' },
  { key: 'bodyRange', step: 5, min: 5, max: 180, suffix: '°' },
  { key: 'armRange', step: 5, min: 5, max: 180, suffix: '°' },
  { key: 'armNeutral', step: 5, min: -90, max: 90, suffix: '°' },
  { key: 'deadzone', step: 0.01, min: 0, max: 0.5 },
  { key: 'maxRate', step: 0.5, min: 0 },
  { key: 'smoothing', step: 0.05, min: 0, max: 0.95 },
  { key: 'energyScale', step: 0.5, min: 0.1 },
];

/**
 * One bone of the response rig: which drivers move it, how far, in which mode,
 * and how far it trails. Collapsed by default — same tight-row treatment as the
 * manual-calibration bone list, since the rig runs to a dozen bones.
 */
function RigBoneRow({
  bone,
  entry,
  modified,
  onChange,
  onReset,
}: {
  bone: string;
  entry: StyleBoneResponse;
  modified: boolean;
  onChange: (patch: Partial<StyleBoneResponse>) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation('properties');
  const [open, setOpen] = useState(false);
  const used = Object.keys(entry.drivers) as StyleDriverName[];
  const unused = STYLE_DRIVER_NAMES.filter((d) => !used.includes(d));

  const setDriver = (driver: StyleDriverName, next: DriverResponse) =>
    onChange({ drivers: { ...entry.drivers, [driver]: next } });

  return (
    <div style={{ borderBottom: '1px solid #262626' }}>
      <div
        className={`vs-stylize-bone-${bone}`}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          userSelect: 'none',
          padding: '3px 2px',
          fontSize: 11,
          color: modified ? '#c9b86a' : '#aaa',
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
        <span style={{ flex: 1, minWidth: 0 }}>{bone}</span>
        <span style={{ fontSize: 9, color: '#666' }}>
          {t(`stylizedTracking.mode.${entry.mode ?? 'replace'}`)}
        </span>
        {modified && <span style={{ color: '#c9b86a', fontSize: 9 }}>●</span>}
      </div>
      {open && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '2px 2px 8px 16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: '#888', width: 70 }}>
              {t('stylizedTracking.boneMode')}
            </span>
            <select
              className={`vs-stylize-mode-${bone}`}
              value={entry.mode ?? 'replace'}
              onChange={(e) =>
                onChange({ mode: e.target.value as 'replace' | 'add' })
              }
              style={{ ...rigSelectStyle, flex: 1 }}
            >
              <option value="replace">
                {t('stylizedTracking.mode.replace')}
              </option>
              <option value="add">{t('stylizedTracking.mode.add')}</option>
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: '#888', width: 70 }}>
              {t('stylizedTracking.boneLag')}
            </span>
            <NumInput
              className={`vs-stylize-bonelag-${bone}`}
              value={entry.lag ?? 1}
              step={0.1}
              min={0}
              suffix="×"
              style={{ width: 90 }}
              onChange={(v) => onChange({ lag: v })}
              onCommit={(v) => onChange({ lag: v })}
            />
          </div>
          {used.map((driver) => (
            <VecInput
              key={driver}
              className={`vs-stylize-drv-${bone}-${driver}`}
              values={(entry.drivers[driver] ?? [0, 0, 0]) as number[]}
              labels={['X', 'Y', 'Z']}
              step={1}
              suffix="°"
              groupLabel={t(`stylizedTracking.driver.${driver}`)}
              onChange={(next) => setDriver(driver, next as DriverResponse)}
              onCommit={(next) => setDriver(driver, next as DriverResponse)}
              style={{ minWidth: 0 }}
            />
          ))}
          {unused.length > 0 && (
            <select
              className={`vs-stylize-adddrv-${bone}`}
              value=""
              onChange={(e) => {
                if (e.target.value)
                  setDriver(e.target.value as StyleDriverName, [0, 0, 0]);
              }}
              style={{ ...rigSelectStyle, alignSelf: 'flex-start' }}
            >
              <option value="">{t('stylizedTracking.addDriver')}</option>
              {unused.map((d) => (
                <option key={d} value={d}>
                  {t(`stylizedTracking.driver.${d}`)}
                </option>
              ))}
            </select>
          )}
          {modified && (
            <button
              className={`vs-stylize-resetbone-${bone}`}
              onClick={onReset}
              style={resetBtnStyle}
            >
              {t('stylizedTracking.resetBone')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StylizedTrackingProps({ comp }: { comp: Behavior }) {
  const { t } = useTranslation('properties');
  const { updateBehavior } = useEditorStore();
  const cfg = (comp.config ?? {}) as StylizerConfig;
  const overrides = cfg.rig ?? {};
  // The rig editor shows the selected preset as the baseline; the stored
  // override holds only the bones the user actually changed.
  const rigMode: RigMode = resolveRigMode(cfg.rigMode);
  const simpleOverrides = cfg.simpleRig ?? {};
  const baseRig = styleRigPreset(cfg.preset);
  // The detailed rig (preset + per-bone overrides) is the SHAPE; in simple mode
  // the section totals rescale it. Both editors read this same effective rig, so
  // whichever one is open is showing what is actually running.
  const shapeRig = mergeStyleRig(baseRig, cfg.rig);
  const effectiveRig =
    rigMode === 'simple' ? compileSimpleRig(shapeRig, cfg.simpleRig) : shapeRig;

  /**
   * Switching editors must never change the pose. Going to `detailed` bakes the
   * compiled result into the per-bone overrides so the bone list opens showing
   * exactly what was running; going back to `simple` needs no data change at all,
   * because an empty section-total override is the identity.
   */
  const setRigMode = (next: RigMode) => {
    if (next === rigMode) return;
    if (next !== 'detailed') {
      save({ rigMode: next });
      return;
    }
    // Bake the MINIMAL difference from the preset, not the whole resolved rig —
    // pinning every bone would reproduce the pose but leave the preset dropdown
    // with nothing left to change. With no simplified edits this is empty, so the
    // preset stays completely live.
    const baked = diffStyleRig(baseRig, effectiveRig);
    save({
      rigMode: next,
      rig: Object.keys(baked).length > 0 ? baked : null,
      simpleRig: null,
    });
  };
  // Response and follow-through layer defaults → the preset's own baseline → the
  // user's overrides, so switching preset re-baselines anything untouched.
  const response: StyleResponse = resolveStyleResponse(
    cfg.response,
    cfg.preset
  );
  const lag = cfg.lag ?? styleRigPresetLag(cfg.preset);

  const save = (patch: Record<string, unknown>) => {
    const config = { ...comp.config, ...patch };
    updateBehavior(comp.id, { config });
    api.updateBehavior(comp.id, { config }).catch(() => {});
  };

  // Bones the panel offers: everything the stock rig drives, plus anything the
  // user has added on top. The stored override holds ONLY the deltas.
  const rigBones = [
    ...new Set([...Object.keys(effectiveRig), ...Object.keys(overrides)]),
  ];
  const effectiveEntry = (bone: string): StyleBoneResponse => {
    const base = effectiveRig[bone];
    const over = overrides[bone];
    return {
      mode: over?.mode ?? base?.mode ?? 'replace',
      lag: over?.lag ?? base?.lag ?? 1,
      drivers: { ...(base?.drivers ?? {}), ...(over?.drivers ?? {}) },
    };
  };

  const setBone = (bone: string, patch: Partial<StyleBoneResponse>) => {
    const next: StyleRig = { ...overrides };
    next[bone] = { ...effectiveEntry(bone), ...patch };
    save({ rig: next });
  };
  const resetBone = (bone: string) => {
    const next: StyleRig = { ...overrides };
    delete next[bone];
    save({ rig: Object.keys(next).length ? next : null });
  };

  const unusedBones = VRM_BONE_NAMES.filter((b) => !rigBones.includes(b));
  const modifiedCount = Object.keys(overrides).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 10, color: '#555', lineHeight: 1.4 }}>
        {t('stylizedTracking.hint')}
      </div>

      {/* Which of the two 2D-rig conventions the body follows. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{ fontSize: 12, color: '#888', width: 100, flexShrink: 0 }}
        >
          {t('stylizedTracking.preset')}
        </span>
        <select
          className="vs-stylize-preset"
          value={cfg.preset ?? 'follow'}
          onChange={(e) => save({ preset: e.target.value })}
          style={{ ...rigSelectStyle, flex: 1 }}
        >
          {STYLE_PRESET_NAMES.map((name) => (
            <option key={name} value={name}>
              {t(`stylizedTracking.presetName.${name}`)}
            </option>
          ))}
        </select>
      </div>
      <div style={{ fontSize: 10, color: '#555', lineHeight: 1.4 }}>
        {t(`stylizedTracking.presetHint.${cfg.preset ?? 'follow'}`)}
      </div>

      {/* Headline dial: accurate ←→ pretty. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{ fontSize: 12, color: '#888', width: 100, flexShrink: 0 }}
          title={t('stylizedTracking.amountHint')}
        >
          {t('stylizedTracking.amount')}
        </span>
        <SliderInput
          className="vs-stylize-amount"
          value={cfg.amount ?? 1}
          min={0}
          max={1}
          step={0.05}
          precision={2}
          style={{ flex: 1, minWidth: 0 }}
          onChange={(v) => save({ amount: v })}
          onCommit={(v) => save({ amount: v })}
        />
      </div>

      {/* Overall multiplier on the rig's contributions — how FAR it travels. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{ fontSize: 12, color: '#888', width: 100, flexShrink: 0 }}
          title={t('stylizedTracking.strengthHint')}
        >
          {t('stylizedTracking.strength')}
        </span>
        <SliderInput
          className="vs-stylize-strength"
          value={cfg.strength ?? DEFAULT_STYLE_STRENGTH}
          min={0}
          max={MAX_STYLE_STRENGTH}
          step={0.05}
          precision={2}
          style={{ flex: 1, minWidth: 0 }}
          onChange={(v) => save({ strength: v })}
          onCommit={(v) => save({ strength: v })}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{ fontSize: 12, color: '#888', width: 100, flexShrink: 0 }}
        >
          {t('stylizedTracking.lag')}
        </span>
        <NumInput
          className="vs-stylize-lag"
          value={lag}
          step={0.01}
          min={0}
          suffix="s"
          style={{ width: 96 }}
          onChange={(v) => save({ lag: v })}
          onCommit={(v) => save({ lag: v })}
        />
      </div>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          color: '#888',
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          className="vs-stylize-rest-unmapped"
          checked={cfg.restUnmapped ?? false}
          onChange={(e) => save({ restUnmapped: e.target.checked })}
        />
        {t('stylizedTracking.restUnmapped')}
      </label>

      <CollapsibleSection title={t('stylizedTracking.responseSection')}>
        <div
          style={{
            fontSize: 10,
            color: '#555',
            lineHeight: 1.4,
            marginBottom: 6,
          }}
        >
          {t('stylizedTracking.responseHint')}
        </div>
        {RESPONSE_FIELDS.map((f) => (
          <div
            key={f.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 4,
            }}
          >
            <span
              style={{ fontSize: 12, color: '#888', width: 110, flexShrink: 0 }}
              title={t(`stylizedTracking.responseTip.${f.key}`)}
            >
              {t(`stylizedTracking.response.${f.key}`)}
            </span>
            <NumInput
              className={`vs-stylize-response-${f.key}`}
              value={response[f.key]}
              step={f.step}
              min={f.min}
              max={f.max}
              suffix={f.suffix}
              style={{ width: 96 }}
              onChange={(v) =>
                save({ response: { ...cfg.response, [f.key]: v } })
              }
              onCommit={(v) =>
                save({ response: { ...cfg.response, [f.key]: v } })
              }
            />
          </div>
        ))}
        {((cfg.response && Object.keys(cfg.response).length > 0) ||
          cfg.lag != null) && (
          <button
            className="vs-stylize-reset-response"
            style={resetBtnStyle}
            onClick={() => save({ response: {}, lag: null })}
          >
            {t('stylizedTracking.resetResponse')}
          </button>
        )}
      </CollapsibleSection>

      <CollapsibleSection
        title={t('stylizedTracking.rigSection')}
        count={rigBones.length}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            marginBottom: 4,
          }}
        >
          <span style={{ fontSize: 11, color: '#888' }}>
            {modifiedCount > 0
              ? t('stylizedTracking.rigModified', { count: modifiedCount })
              : t('stylizedTracking.rigStock')}
          </span>
          {modifiedCount > 0 && (
            <button
              className="vs-stylize-reset-rig"
              style={resetBtnStyle}
              onClick={() => save({ rig: null, simpleRig: null })}
            >
              {t('stylizedTracking.resetRig')}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: '#888' }}>
            {t('stylizedTracking.rigModeLabel')}
          </span>
          <select
            className="vs-stylize-rigmode"
            value={rigMode}
            onChange={(e) => setRigMode(e.target.value as RigMode)}
            style={{ ...rigSelectStyle, flex: 1 }}
          >
            <option value="simple">
              {t('stylizedTracking.rigMode.simple')}
            </option>
            <option value="detailed">
              {t('stylizedTracking.rigMode.detailed')}
            </option>
          </select>
        </div>
        <div style={{ fontSize: 10, color: '#555', lineHeight: 1.4 }}>
          {t(`stylizedTracking.rigModeHint.${rigMode}`)}
        </div>

        {rigMode === 'simple' ? (
          <>
            <SimpleRigGrid
              effective={effectiveRig}
              overrides={simpleOverrides}
              onChange={(next) => save({ simpleRig: next })}
            />
            {Object.keys(simpleOverrides).length > 0 && (
              <button
                className="vs-stylize-reset-simple"
                style={resetBtnStyle}
                onClick={() => save({ simpleRig: null })}
              >
                {t('stylizedTracking.resetRig')}
              </button>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: 10, color: '#555', lineHeight: 1.4 }}>
              {t('stylizedTracking.rigHint')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {rigBones.map((bone) => (
                <RigBoneRow
                  key={bone}
                  bone={bone}
                  entry={effectiveEntry(bone)}
                  modified={bone in overrides}
                  onChange={(patch) => setBone(bone, patch)}
                  onReset={() => resetBone(bone)}
                />
              ))}
            </div>
            {unusedBones.length > 0 && (
              <select
                className="vs-stylize-addbone"
                value=""
                onChange={(e) => {
                  if (e.target.value)
                    setBone(e.target.value, {
                      mode: 'add',
                      lag: 1,
                      drivers: { bodyRoll: [0, 0, 0] },
                    });
                }}
                style={{ ...rigSelectStyle, marginTop: 6 }}
              >
                <option value="">{t('stylizedTracking.addBone')}</option>
                {unusedBones.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
      </CollapsibleSection>
    </div>
  );
}

// ── Component dispatcher ──────────────────────────────────────────────────────

function BehaviorProps({ comp }: { comp: Behavior }) {
  const { t } = useTranslation('properties');
  switch (comp.kind) {
    case 'vmc_receiver':
      return <VmcReceiverProps comp={comp} />;
    case 'ifacialmocap_receiver':
      return <IFacialMocapReceiverProps comp={comp} />;
    case 'lipsync_processor':
      return <LipsyncProcessorProps comp={comp} />;
    case 'mediapipe_tracker':
      return <MediapipeTrackerProps comp={comp} />;
    case 'api_controller':
      return <ApiControllerProps comp={comp} />;
    case 'breathing':
      return <BreathingProps comp={comp} />;
    case 'manual_calibration':
      return <ManualCalibrationProps comp={comp} />;
    case 'pose_stylizer':
      return <StylizedTrackingProps comp={comp} />;
    case 'blendshape_limiter':
      return <BlendshapeLimiterProps comp={comp} />;
    default:
      return (
        <div style={{ fontSize: 12, color: '#555', fontStyle: 'italic' }}>
          {t('behaviorFallback')}
        </div>
      );
  }
}

// ---------- Camera effect property panel ----------

/** Maps effect kind → the matching doc anchor in camera-effects.md */
const EFFECT_KIND_ANCHOR: Record<string, string> = {
  fx_tone_mapping: 'tonemap',
  fx_brightness_contrast: 'colorgrade',
  fx_hue_saturation: 'hue-saturation',
  fx_sepia: 'sepia',
  fx_bloom: 'bloom',
  fx_depth_of_field: 'dof',
  fx_chromatic_aberration: 'chromatic',
  fx_ssao: 'ssao',
  fx_outline: 'outline',
  fx_vignette: 'vignette',
  fx_noise: 'noise',
  fx_scanline: 'scanline',
  fx_pixelation: 'pixelate',
  fx_ascii: 'ascii',
  fx_dot_screen: 'dotscreen',
  fx_glitch: 'glitch',
  fx_smaa: 'smaa',
  fx_tilt_shift: 'tiltshift',
  fx_water: 'water',
};

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
      <span style={{ fontSize: 12, color: '#888', flex: '0 0 42%' }}>
        {label}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
        <NumInput
          value={value}
          step={step ?? 0.01}
          min={min}
          max={max}
          onCommit={(v) => onSave({ [field]: v })}
          style={{ width: '100%' }}
        />
      </div>
    </div>
  );
}

function EffectPanel({ effectId, kind }: { effectId: string; kind: string }) {
  const { t } = useTranslation('properties');
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
          <span style={{ fontSize: 12, color: '#888', flex: 1 }}>
            {t('effect.toneMapping.mode')}
          </span>
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
            label={t('effect.brightnessContrast.brightness')}
            cfg={cfg}
            field="brightness"
            step={0.01}
            min={-1}
            max={1}
            onSave={save}
          />
          <EffectRow
            label={t('effect.brightnessContrast.contrast')}
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
            label={t('effect.hueSaturation.hue')}
            cfg={cfg}
            field="hue"
            step={0.01}
            min={-Math.PI}
            max={Math.PI}
            onSave={save}
          />
          <EffectRow
            label={t('effect.hueSaturation.saturation')}
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
          label={t('effect.sepia.intensity')}
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
            label={t('effect.bloom.intensity')}
            cfg={cfg}
            field="intensity"
            step={0.1}
            min={0}
            onSave={save}
          />
          <EffectRow
            label={t('effect.bloom.lumThreshold')}
            cfg={cfg}
            field="luminanceThreshold"
            step={0.01}
            min={0}
            max={1}
            onSave={save}
          />
          <EffectRow
            label={t('effect.bloom.lumSmoothing')}
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
                  {t('effect.dof.autofocus')}
                </span>
              </label>
              {autofocus ? (
                <>
                  <div style={rowStyle}>
                    <span style={labelStyle}>{t('effect.dof.afMode')}</span>
                    <select
                      value={afMode}
                      onChange={(e) => save({ afMode: e.target.value })}
                      style={selectStyle}
                    >
                      <option value="point">
                        {t('effect.dof.afModePoint')}
                      </option>
                      <option value="percentile">
                        {t('effect.dof.afModePercentile')}
                      </option>
                    </select>
                  </div>
                  {afMode === 'point' && (
                    <>
                      <EffectRow
                        label={t('effect.dof.pointX')}
                        cfg={cfg}
                        field="afPointX"
                        step={0.01}
                        min={0}
                        max={1}
                        onSave={save}
                      />
                      <EffectRow
                        label={t('effect.dof.pointY')}
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
                      label={t('effect.dof.percentile')}
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
                    label={t('effect.dof.afSpeed')}
                    cfg={cfg}
                    field="afSpeed"
                    step={0.1}
                    min={0.1}
                    max={20}
                    onSave={save}
                  />
                  <EffectRow
                    label={t('effect.dof.afDelay')}
                    cfg={cfg}
                    field="afDelay"
                    step={0.05}
                    min={0}
                    max={2}
                    onSave={save}
                  />
                  <EffectRow
                    label={t('effect.dof.overshoot')}
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
                  label={t('effect.dof.focusDistance')}
                  cfg={cfg}
                  field="worldFocusDistance"
                  step={0.1}
                  min={0}
                  onSave={save}
                />
              )}
              <div style={{ height: 1, background: '#222', margin: '2px 0' }} />
              <EffectRow
                label={t('effect.dof.focusRange')}
                cfg={cfg}
                field="worldFocusRange"
                step={0.1}
                min={0}
                onSave={save}
              />
              <EffectRow
                label={t('effect.dof.bokehScale')}
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
            label={t('effect.chromatic.offsetX')}
            cfg={cfg}
            field="offsetX"
            step={0.001}
            min={0}
            max={0.05}
            onSave={save}
          />
          <EffectRow
            label={t('effect.chromatic.offsetY')}
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
            label={t('effect.ssao.intensity')}
            cfg={cfg}
            field="intensity"
            step={0.1}
            min={0}
            max={10}
            onSave={save}
          />
          <EffectRow
            label={t('effect.ssao.radius')}
            cfg={cfg}
            field="radius"
            step={0.01}
            min={0.001}
            max={1}
            onSave={save}
          />
          <EffectRow
            label={t('effect.ssao.bias')}
            cfg={cfg}
            field="bias"
            step={0.001}
            min={0}
            max={0.1}
            onSave={save}
          />
          <EffectRow
            label={t('effect.ssao.rings')}
            cfg={cfg}
            field="rings"
            step={1}
            min={1}
            max={16}
            onSave={save}
          />
          <EffectRow
            label={t('effect.ssao.samples')}
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
            <span style={{ fontSize: 12, color: '#888', flex: 1 }}>
              {t('effect.outline.color')}
            </span>
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
            label={t('effect.outline.threshold')}
            cfg={cfg}
            field="threshold"
            step={0.0001}
            min={0}
            onSave={save}
          />
          <EffectRow
            label={t('effect.outline.thickness')}
            cfg={cfg}
            field="thickness"
            step={0.5}
            min={0.5}
            onSave={save}
          />
          <EffectRow
            label={t('effect.outline.alpha')}
            cfg={cfg}
            field="alpha"
            step={0.01}
            min={0}
            max={1}
            onSave={save}
          />
          <EffectRow
            label={t('effect.outline.normalStrength')}
            cfg={cfg}
            field="normalStrength"
            step={0.05}
            min={0}
            onSave={save}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#888', flex: 1 }}>
              {t('effect.outline.blendMode')}
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
                  {m
                    .toLowerCase()
                    .replace(/_/g, ' ')
                    .replace(/\b\w/g, (c) => c.toUpperCase())}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      {kind === 'fx_vignette' && (
        <>
          <EffectRow
            label={t('effect.vignette.offset')}
            cfg={cfg}
            field="offset"
            step={0.01}
            min={0}
            max={1}
            onSave={save}
          />
          <EffectRow
            label={t('effect.vignette.darkness')}
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
          label={t('effect.noise.opacity')}
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
            label={t('effect.scanline.density')}
            cfg={cfg}
            field="density"
            step={0.05}
            min={0}
            onSave={save}
          />
          <EffectRow
            label={t('effect.scanline.opacity')}
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
          label={t('effect.pixelation.granularity')}
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
              {t('effect.ascii.characters')}
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
            label={t('effect.ascii.fontSize')}
            cfg={cfg}
            field="fontSize"
            step={1}
            min={8}
            onSave={save}
          />
          <EffectRow
            label={t('effect.ascii.cellSize')}
            cfg={cfg}
            field="cellSize"
            step={1}
            min={4}
            onSave={save}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#888', flex: 1 }}>
              {t('effect.ascii.color')}
            </span>
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
            <span style={{ fontSize: 12, color: '#888', flex: 1 }}>
              {t('effect.ascii.invert')}
            </span>
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
            label={t('effect.dotScreen.angle')}
            cfg={cfg}
            field="angle"
            step={0.01}
            min={0}
            onSave={save}
          />
          <EffectRow
            label={t('effect.dotScreen.scale')}
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
              [t('effect.glitch.delayMin'), 'delay', 0, 0.1],
              [t('effect.glitch.delayMax'), 'delay', 1, 0.1],
              [t('effect.glitch.strengthMin'), 'strength', 0, 0.05],
              [t('effect.glitch.strengthMax'), 'strength', 1, 0.05],
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
            label={t('effect.glitch.columns')}
            cfg={cfg}
            field="columns"
            step={0.01}
            min={0}
            max={1}
            onSave={save}
          />
          <EffectRow
            label={t('effect.glitch.ratio')}
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
            label={t('effect.tiltShift.offset')}
            cfg={cfg}
            field="offset"
            step={0.01}
            min={-1}
            max={1}
            onSave={save}
          />
          <EffectRow
            label={t('effect.tiltShift.rotation')}
            cfg={cfg}
            field="rotation"
            step={0.01}
            onSave={save}
          />
          <EffectRow
            label={t('effect.tiltShift.focusArea')}
            cfg={cfg}
            field="focusArea"
            step={0.01}
            min={0}
            max={1}
            onSave={save}
          />
          <EffectRow
            label={t('effect.tiltShift.feather')}
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
          label={t('effect.water.factor')}
          cfg={cfg}
          field="factor"
          step={0.05}
          min={0}
          onSave={save}
        />
      )}
      <div style={{ fontSize: 10, color: '#555', marginTop: 4 }}>
        {t(`kinds:effect.${ek.kind}.description`, {
          defaultValue: ek.description,
        })}
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
  const { t } = useTranslation('properties');
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
        <span style={{ display: 'inline-flex', color: '#cfcfcf' }}>
          <Clapperboard size={18} />
        </span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e0' }}>
            {t('scene.header')}
          </div>
          <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>
            {sceneName}
          </div>
        </div>
      </div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>
          {t('scene.broadcastRate')}
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
          {t('scene.broadcastHint')}
        </div>
      </div>
    </>
  );
}

// ---------- Main panel ----------

export function PropertiesPanel() {
  const { t } = useTranslation('properties');
  const { projectId } = useParams<{ projectId: string }>();
  const {
    nodes,
    selectedNodeId,
    assets,
    selectedBehaviorId,
    behaviors,
    fbxDebugVisible,
    setFbxDebugVisible,
    vrmExpressionsByNode,
    vrmMorphTargetsByNode,
    behaviorKinds,
    cameraEffects,
    selectedEffect,
    scenes,
    activeSceneId,
    sceneSelected,
    updateSceneItem,
    composeLayers,
    composeScenes,
    activeComposeSceneId,
    selectedComposeLayerId,
    leftTab,
    activeLogicId,
  } = useEditorStore();
  const activeScene = scenes.find((s) => s.id === activeSceneId) ?? null;
  const animAssets: AssetFile[] = assets.filter((a) => a.kind === 'animation');
  const modelAssets: AssetFile[] = assets.filter((a) => a.kind === 'model');
  const node = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const animationClips = useEditorStore((s) => s.animationClips);
  const selectedBehavior =
    behaviors.find((c) => c.id === selectedBehaviorId) ?? null;
  const selectedCompType = selectedBehavior
    ? behaviorKinds.find((ct) => ct.kind === selectedBehavior.kind)
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
  // Bound straight to the node's mesh doc: no draft state, no re-sync effect,
  // and (unlike the old `useState` + `[node.id]` effect) it tracks renames from
  // other tabs live instead of going stale until the node is reselected.
  const nameField = useMeshField<string>(node?.id ?? '', 'name', '');
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

  useEffect(() => {
    if (!node) return;
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

  // Idle animation, resolved across the legacy (components.animation.idleUrl)
  // and content-addressed (properties.animation.idle.clipId) shapes. Editing
  // always writes the legacy shape and clears the migrated idle, so the
  // Viewport re-derives a fresh clip id (one edit path; collab-correct once
  // migrated). The clip-id url resolves through the synced animation_clips.
  const idleProp = (
    node?.properties as
      | { animation?: { idle?: { clipId?: string; speed?: number } } }
      | undefined
  )?.animation?.idle;
  const legacyIdle = node?.components?.animation as
    | { idleUrl?: string; speed?: number }
    | undefined;
  const idleUrlDisplay =
    (idleProp?.clipId
      ? animationClips[idleProp.clipId]?.sourceFilePath
      : undefined) ??
    legacyIdle?.idleUrl ??
    '';
  const idleSpeedDisplay = legacyIdle?.speed ?? idleProp?.speed ?? 1;
  const writeIdle = (idleUrl: string | null, speed: number) => {
    if (!node) return;
    // Both fields in one op: retiring the legacy `components.animation` slot
    // and clearing the new `properties.animation.idle` are one edit, so they
    // must also be one undo step.
    commitNodePatch(node.id, {
      components: { animation: idleUrl ? { idleUrl, speed } : undefined },
      properties: { animation: { idle: undefined } },
    } as Partial<StageObject>);
  };

  // Base animation — the loop live tracking stacks onto (see the stacking
  // composition in Viewport). Stored as a raw url slot under
  // properties.animation.base; falls back to the idle when unset.
  const baseProp = (
    node?.properties as
      | {
          animation?: {
            base?: { clipId?: string; url?: string; speed?: number };
          };
        }
      | undefined
  )?.animation?.base;
  const baseUrlDisplay =
    (baseProp?.clipId
      ? animationClips[baseProp.clipId]?.sourceFilePath
      : undefined) ??
    baseProp?.url ??
    '';
  const baseSpeedDisplay = baseProp?.speed ?? 1;
  const writeBase = (url: string | null, speed: number) => {
    if (!node) return;
    commitNodePath(
      node.id,
      'properties.animation.base',
      url ? { url, speed } : undefined
    );
  };

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

  // The inspector follows the active main-view tab. Each tab owns a distinct
  // selection model, so a leftover selection from another tab never leaks in:
  //   • Compose tab → compose layers
  //   • Graphs tab  → nothing (signal nodes are edited inline on the canvas)
  //   • Scene tab   → 3D scene nodes + their components / camera effects
  const emptyState = (text: string) => (
    <div
      style={{
        width: 280,
        flexShrink: 0,
        background: '#141414',
        borderLeft: '1px solid #2a2a2a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '0 20px',
        color: '#555',
        fontSize: 13,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {text}
    </div>
  );

  // Compose tab: the inspector targets compose layers only.
  if (leftTab === 'compose') {
    const selectedComposeLayer = selectedComposeLayerId
      ? composeLayers.find((l) => l.id === selectedComposeLayerId)
      : null;
    if (selectedComposeLayer) {
      return panelShell(
        <ComposeLayerProperties layer={selectedComposeLayer} />
      );
    }
    // No layer selected → show the active compose scene's own settings
    // (resolution + preview background).
    const activeComposeScene = composeScenes.find(
      (s) => s.id === activeComposeSceneId
    );
    if (activeComposeScene) {
      return panelShell(<ComposeSceneProperties scene={activeComposeScene} />);
    }
    return emptyState(t('emptyState.selectLayer'));
  }

  // Graphs tab: signal nodes are edited inline on the canvas, so the right
  // inspector has nothing node-shaped to show here. Only claim a graph is being
  // edited once one is actually open, otherwise the hint contradicts the
  // canvas' "select or create a graph" prompt.
  if (leftTab === 'graphs') {
    return emptyState(
      activeLogicId
        ? t('emptyState.graphsTab')
        : t('emptyState.graphsTabNoGraph')
    );
  }

  // Scene tab (everything below): the inspector targets 3D scene nodes only.

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
          <span style={{ display: 'inline-flex', color: '#cfcfcf' }}>
            {(() => {
              const I = selectedEffectKind.icon;
              return <I size={18} />;
            })()}
          </span>
          <div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: '#e0e0e0',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {t(`kinds:effect.${selectedEffectKind.kind}.label`, {
                defaultValue: selectedEffectKind.label,
              })}
              <HelpButton
                topic="camera-effects"
                anchor={EFFECT_KIND_ANCHOR[selectedEffect.kind] ?? 'what'}
                tip={t('help.cameraEffects')}
              />
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

  if (!node && !selectedBehavior) {
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
        {t('emptyState.selectNode')}
      </div>
    );
  }

  // Component selected without a parent node selected — show a focused component panel.
  if (!node && selectedBehavior && selectedCompType) {
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
          <span style={{ display: 'inline-flex', color: '#cfcfcf' }}>
            {(() => {
              const I =
                BEHAVIOR_ICON[selectedCompType.kind] ?? BEHAVIOR_FALLBACK;
              return <I size={18} />;
            })()}
          </span>
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: '#e0e0e0',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {selectedCompType.label}
              {selectedBehavior.kind === 'breathing' && (
                <HelpButton
                  topic="behaviors"
                  anchor="breathing"
                  tip={t('help.breathing')}
                />
              )}
              {selectedBehavior.kind === 'pose_stylizer' && (
                <HelpButton
                  topic="behaviors"
                  anchor="stylized"
                  tip={t('help.stylizedTracking')}
                />
              )}
              {selectedBehavior.kind === 'ifacialmocap_receiver' && (
                <HelpButton
                  topic="behaviors"
                  anchor="ifacialmocap"
                  tip={t('help.ifacialmocap')}
                />
              )}
            </div>
            <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>
              {selectedCompType.description}
            </div>
          </div>
        </div>
        <BehaviorProps comp={selectedBehavior} />
      </>
    );
  }

  // At this point node is guaranteed to be non-null (component-only path handled above).
  if (!node) return null;

  // Called on blur: applies to Viewport + persists to DB in one shot.
  // Uses the ref (not state) so the value is always current regardless of render timing.
  const saveTransform = () => {
    const t = transformRef.current;
    commitNodePath(node.id, 'components.transform', {
      type: 'transform',
      ...t,
    });
  };

  const saveLight = (l: LightProps) => {
    commitNodePath(node.id, 'components.light', { type: 'light', ...l });
  };

  const saveCamera = (c: CameraProps) => {
    // Merge over the existing camera component so fields not covered by
    // CameraProps (e.g. backgroundImage) survive the write.
    commitNodePath(node.id, 'components.camera', {
      ...(node.components?.camera as object),
      type: 'camera',
      ...c,
    });
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
          {t('header')}
        </span>
      </div>

      <div style={{ padding: '12px 14px' }}>
        {/* Name */}
        <div style={sectionHeader}>{t('name')}</div>
        <input
          ref={nameInputRef}
          className="vs-node-name"
          style={textInput}
          {...nameField.bind()}
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
        <div style={sectionHeader}>{t('transform.header')}</div>

        <VecInput
          className="vs-transform-position"
          groupLabel={t('transform.position')}
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
            // Live feedback while dragging: fan the in-flight value out on the
            // mesh preview channel so the 3D viewport and every watching tab
            // track the gesture. Committed on release by saveTransform.
            previewNodeTransform(node.id, { x: t.x, y: t.y, z: t.z });
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
          className="vs-transform-rotation"
          groupLabel={t('transform.rotation')}
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
            // Live feedback while dragging: fan the in-flight value out on the
            // mesh preview channel so the 3D viewport and every watching tab
            // track the gesture. Committed on release by saveTransform.
            previewNodeTransform(node.id, { rx: t.rx, ry: t.ry, rz: t.rz });
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
          className="vs-transform-scale"
          groupLabel={t('transform.scale')}
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
            // Live feedback while dragging: fan the in-flight value out on the
            // mesh preview channel so the 3D viewport and every watching tab
            // track the gesture. Committed on release by saveTransform.
            previewNodeTransform(node.id, { sx: t.sx, sy: t.sy, sz: t.sz });
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
          className="vs-transform-opacity"
          label={t('transform.opacity')}
          value={transform.opacity}
          min={0}
          max={1}
          step={0.01}
          onChange={(next) => {
            isEditingTransform.current = true;
            const t = { ...transformRef.current, opacity: next };
            transformRef.current = t;
            setTransform(t);
            // Live feedback while dragging: fan the in-flight value out on the
            // mesh preview channel so the 3D viewport and every watching tab
            // track the gesture. Committed on release by saveTransform.
            previewNodeTransform(node.id, { opacity: t.opacity });
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
                  className={
                    key === 'castShadow'
                      ? 'vs-transform-cast-shadow'
                      : 'vs-transform-receive-shadow'
                  }
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
                {key === 'castShadow'
                  ? t('transform.castShadow')
                  : t('transform.receiveShadow')}
              </label>
            ))}
          </div>
        )}

        {/* Light Properties */}
        {node.kind === 'light' && (
          <>
            <div style={sectionHeader}>{t('light.header')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    fontSize: 12,
                    color: '#888',
                    width: 60,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {t('light.type')}
                  <HelpButton
                    topic="lighting"
                    anchor="type"
                    tip={t('help.lightType')}
                    size={12}
                  />
                </span>
                <select
                  className="vs-light-type"
                  style={{ ...textInput, width: 'auto', flex: 1 }}
                  value={light.lightType}
                  onChange={(e) => {
                    const l = { ...light, lightType: e.target.value };
                    setLight(l);
                    saveLight(l);
                  }}
                >
                  <option value="point">{t('light.typePoint')}</option>
                  <option value="directional">
                    {t('light.typeDirectional')}
                  </option>
                  <option value="ambient">{t('light.typeAmbient')}</option>
                  <option value="spot">{t('light.typeSpot')}</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#888', width: 60 }}>
                  {t('light.color')}
                </span>
                <input
                  type="color"
                  className="vs-light-color"
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
                <span
                  style={{
                    fontSize: 12,
                    color: '#888',
                    width: 60,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {t('light.intensity')}
                  <HelpButton
                    topic="lighting"
                    anchor="intensity"
                    tip={t('help.lightIntensity')}
                    size={12}
                  />
                </span>
                <NumInput
                  className="vs-light-intensity"
                  value={light.intensity}
                  step={0.1}
                  min={0}
                  style={{ flex: 1, minWidth: 0 }}
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
                      className="vs-light-cast-shadow"
                      checked={light.castShadow ?? false}
                      onChange={(e) => {
                        const next = { ...light, castShadow: e.target.checked };
                        setLight(next);
                        saveLight(next);
                      }}
                    />
                    {t('light.castShadow')}
                    <HelpButton
                      topic="lighting"
                      anchor="shadows"
                      tip={t('help.lightShadows')}
                      size={12}
                    />
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
                          {t('light.mapSize')}
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
                          <option value="512">{t('light.mapSize512')}</option>
                          <option value="1024">{t('light.mapSize1024')}</option>
                          <option value="2048">{t('light.mapSize2048')}</option>
                          <option value="4096">{t('light.mapSize4096')}</option>
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
                          title={t('light.biasTip')}
                        >
                          {t('light.bias')}
                        </span>
                        <NumInput
                          value={light.shadowBias ?? -0.0005}
                          step={0.0001}
                          style={{ flex: 1, minWidth: 0 }}
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
                            title={t('light.areaTip')}
                          >
                            {t('light.area')}
                          </span>
                          <NumInput
                            value={light.shadowCameraSize ?? 10}
                            step={1}
                            min={1}
                            style={{ flex: 1, minWidth: 0 }}
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
            <div style={sectionHeader}>{t('camera.header')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    fontSize: 12,
                    color: '#888',
                    width: 60,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {t('camera.projection')}
                  <HelpButton
                    topic="camera"
                    anchor="projection"
                    tip={t('help.camProjection')}
                    size={12}
                  />
                </span>
                <select
                  className="vs-camera-projection"
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
                  <option value="perspective">
                    {t('camera.projectionPerspective')}
                  </option>
                  <option value="orthographic">
                    {t('camera.projectionOrthographic')}
                  </option>
                </select>
              </div>
              {camera.projection === 'perspective' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontSize: 12,
                      color: '#888',
                      width: 60,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    {t('camera.fov')}
                    <HelpButton
                      topic="camera"
                      anchor="fov"
                      tip={t('help.camFov')}
                      size={12}
                    />
                  </span>
                  <NumInput
                    className="vs-camera-fov"
                    value={camera.fov}
                    step={1}
                    suffix="°"
                    style={{ flex: 1, minWidth: 0 }}
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
                    style={{
                      fontSize: 12,
                      color: '#888',
                      width: 60,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                    title={t('camera.sizeTip')}
                  >
                    {t('camera.size')}
                    <HelpButton
                      topic="camera"
                      anchor="projection"
                      tip={t('help.camProjection')}
                      size={12}
                    />
                  </span>
                  <NumInput
                    value={camera.orthoSize}
                    step={0.1}
                    style={{ flex: 1, minWidth: 0 }}
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
                  [t('camera.near'), 'near', 0.001],
                  [t('camera.far'), 'far', 1],
                ] as [string, 'near' | 'far', number][]
              ).map(([lab, key, step]) => (
                <div
                  key={key}
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      color: '#888',
                      width: 60,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    {lab}
                    {key === 'near' && (
                      <HelpButton
                        topic="camera"
                        anchor="clipping"
                        tip={t('help.camClipping')}
                        size={12}
                      />
                    )}
                  </span>
                  <NumInput
                    className={
                      key === 'near' ? 'vs-camera-near' : 'vs-camera-far'
                    }
                    value={camera[key]}
                    step={step}
                    style={{ flex: 1, minWidth: 0 }}
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

            <div style={sectionHeader}>{t('camera.shadowsHeader')}</div>
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
                  className="vs-camera-shadows-enable"
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
                {t('camera.shadowsEnable')}
              </label>
              {camera.shadowsEnabled && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#888', width: 60 }}>
                    {t('camera.shadowQuality')}
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
                    <option value="low">{t('camera.shadowLow')}</option>
                    <option value="medium">{t('camera.shadowMedium')}</option>
                    <option value="high">{t('camera.shadowHigh')}</option>
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
                {t('camera.shadowHint')}
              </div>
            </div>

            <div style={sectionHeader}>{t('camera.envHeader')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    fontSize: 12,
                    color: '#888',
                    width: 60,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {t('camera.envIntensity')}
                  <HelpButton
                    topic="camera"
                    anchor="env"
                    tip={t('help.camEnv')}
                    size={12}
                  />
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
                {t('camera.envHint')}
              </div>
            </div>

            <div
              style={{
                ...sectionHeader,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              {t('camera.bgHeader')}
              <PickButton onClick={() => flashBottomTab('images')} />
            </div>
            {(() => {
              const cam = (node.components?.camera ?? {}) as Record<
                string,
                unknown
              >;
              const bgAssets = assets.filter((a) => a.kind === 'image');
              const saveBgImage = (url: string | null) =>
                commitNodePath(
                  node.id,
                  'components.camera.backgroundImage',
                  url
                );
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
                      placeholder={t('camera.bgPlaceholder')}
                      defaultValue={(cam.backgroundImage as string) ?? ''}
                      key={node.id + '-bg'}
                      onBlur={(e) => saveBgImage(e.target.value.trim() || null)}
                    />
                    {!!cam.backgroundImage && (
                      <button
                        title={t('camera.bgClear')}
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

            <div style={sectionHeader}>{t('camera.viewerHeader')}</div>
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
                    title={t('camera.viewerCopy')}
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
                    title={t('camera.viewerOpen')}
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

        {/* Light Rays Properties */}
        {node.kind === 'godray_caster' &&
          (() => {
            const gr =
              (node.components.godray as Record<string, unknown>) ?? {};
            const saveGr = (patch: Record<string, unknown>) =>
              commitNodePatch(node.id, {
                components: { godray: patch },
              } as Partial<StageObject>);
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
                <div style={sectionHeader}>{t('godray.sunHeader')}</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <span style={{ fontSize: 12, color: '#888', flex: 1 }}>
                      {t('godray.color')}
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
                    label={t('godray.scale')}
                    cfg={grWithDefaults}
                    field="scale"
                    step={0.05}
                    min={0.01}
                    onSave={saveGr}
                  />
                </div>
                <div style={sectionHeader}>{t('godray.rayHeader')}</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <EffectRow
                    label={t('godray.samples')}
                    cfg={grWithDefaults}
                    field="samples"
                    step={1}
                    min={10}
                    max={120}
                    onSave={saveGr}
                  />
                  <EffectRow
                    label={t('godray.density')}
                    cfg={grWithDefaults}
                    field="density"
                    step={0.01}
                    min={0}
                    max={1}
                    onSave={saveGr}
                  />
                  <EffectRow
                    label={t('godray.decay')}
                    cfg={grWithDefaults}
                    field="decay"
                    step={0.01}
                    min={0}
                    max={1}
                    onSave={saveGr}
                  />
                  <EffectRow
                    label={t('godray.weight')}
                    cfg={grWithDefaults}
                    field="weight"
                    step={0.01}
                    min={0}
                    max={1}
                    onSave={saveGr}
                  />
                  <EffectRow
                    label={t('godray.exposure')}
                    cfg={grWithDefaults}
                    field="exposure"
                    step={0.01}
                    min={0}
                    max={2}
                    onSave={saveGr}
                  />
                  <EffectRow
                    label={t('godray.clampMax')}
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
              facing: 'world',
              backface: 'mirror',
              width: 1,
              height: 1,
              alpha: 1,
              textureUrl: null,
              ...((node.components?.billboard ?? {}) as Record<
                string,
                unknown
              >),
            };
            const saveBc = (patch: Record<string, unknown>) =>
              commitNodePath(node.id, 'components.billboard', {
                ...bc,
                ...patch,
              });
            const imageAssets = assets.filter((a) => a.kind === 'image');
            const sel: React.CSSProperties = {
              background: '#2a2a2a',
              border: '1px solid #3a3a3a',
              color: '#e0e0e0',
              borderRadius: 4,
              padding: '3px 6px',
              fontSize: 12,
              outline: 'none',
              width: '100%',
              boxSizing: 'border-box',
            };
            // Consistent two-column field row: label on the left, a fixed-width
            // control column on the right that the control fills, so every row's
            // inputs share the same left/right edges instead of floating at their
            // own content width.
            const row = (label: string, children: React.ReactNode) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#888', flex: '0 0 42%' }}>
                  {label}
                </span>
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 6,
                  }}
                >
                  {children}
                </div>
              </div>
            );
            return (
              <>
                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t('billboard.header')}
                  <HelpButton
                    topic="props"
                    anchor="image"
                    tip={t('help.propImage')}
                  />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {row(
                    t('billboard.facing'),
                    <select
                      style={sel}
                      value={bc.facing as string}
                      onChange={(e) => saveBc({ facing: e.target.value })}
                    >
                      <option value="screen">
                        {t('billboard.facingScreen')}
                      </option>
                      <option value="world">
                        {t('billboard.facingWorld')}
                      </option>
                    </select>
                  )}
                  {row(
                    t('billboard.backface'),
                    <select
                      style={sel}
                      value={bc.backface as string}
                      onChange={(e) => saveBc({ backface: e.target.value })}
                    >
                      <option value="none">
                        {t('billboard.backfaceNone')}
                      </option>
                      <option value="mirror">
                        {t('billboard.backfaceMirror')}
                      </option>
                      <option value="unmirrored">
                        {t('billboard.backfaceUnmirrored')}
                      </option>
                    </select>
                  )}
                  <EffectRow
                    label={t('billboard.width')}
                    cfg={bc}
                    field="width"
                    step={0.05}
                    min={0.01}
                    onSave={saveBc}
                  />
                  <EffectRow
                    label={t('billboard.height')}
                    cfg={bc}
                    field="height"
                    step={0.05}
                    min={0.01}
                    onSave={saveBc}
                  />
                  <EffectRow
                    label={t('billboard.alpha')}
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
                  {t('billboard.textureHeader')}
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
                    t('billboard.image'),
                    <input
                      list="billboard-img-list"
                      style={{ ...numInput, width: 120 }}
                      placeholder={t('billboard.imagePlaceholder')}
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

        {node.kind === 'video' &&
          (() => {
            const vc: Record<string, unknown> = {
              facing: 'world',
              backface: 'none',
              width: 1.6,
              height: 0.9,
              alpha: 1,
              sourceUrl: null,
              autoplay: true,
              loop: true,
              onEnd: 'freeze',
              muted: true,
              volume: 1,
              ...((node.components?.video ?? {}) as Record<string, unknown>),
            };
            const saveVc = (patch: Record<string, unknown>) => {
              const next = { ...vc, ...patch };
              const filePatch =
                'sourceUrl' in patch
                  ? { filePath: (patch.sourceUrl as string) ?? null }
                  : {};
              // One op, so swapping the source stays a single undo step even
              // though it touches both the component and the node's filePath.
              commitNodePatch(node.id, {
                components: { video: next },
                ...filePatch,
              } as Partial<StageObject>);
            };
            const videoAssets = assets.filter((a) => a.kind === 'video');
            const sel: React.CSSProperties = {
              background: '#2a2a2a',
              border: '1px solid #3a3a3a',
              color: '#e0e0e0',
              borderRadius: 4,
              padding: '3px 6px',
              fontSize: 12,
              outline: 'none',
              width: '100%',
              boxSizing: 'border-box',
            };
            // Consistent two-column field row: label on the left, a fixed-width
            // control column on the right that the control fills, so every row's
            // inputs share the same left/right edges instead of floating at their
            // own content width.
            const row = (label: string, children: React.ReactNode) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#888', flex: '0 0 42%' }}>
                  {label}
                </span>
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 6,
                  }}
                >
                  {children}
                </div>
              </div>
            );
            const check = (label: string, field: string, checked: boolean) =>
              row(
                label,
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => saveVc({ [field]: e.target.checked })}
                />
              );
            return (
              <>
                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t('video.sourceHeader')}
                  <HelpButton
                    topic="props"
                    anchor="video"
                    tip={t('help.propVideo')}
                  />
                  <PickButton onClick={() => flashBottomTab('videos')} />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <datalist id="video-src-list">
                    {videoAssets.map((a) => (
                      <option key={a.id} value={a.url} label={a.name} />
                    ))}
                  </datalist>
                  {row(
                    t('video.source'),
                    <input
                      list="video-src-list"
                      style={{ ...numInput, width: 120 }}
                      placeholder={t('video.sourcePlaceholder')}
                      defaultValue={(vc.sourceUrl as string) ?? ''}
                      key={node.id + '-vidsrc'}
                      onBlur={(e) =>
                        saveVc({ sourceUrl: e.target.value.trim() || null })
                      }
                    />
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
                  {t('video.playbackHeader')}
                  <HelpButton
                    topic="props"
                    anchor="video-playback"
                    tip={t('help.videoPlayback')}
                    size={12}
                  />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {check(
                    t('video.autoplay'),
                    'autoplay',
                    vc.autoplay as boolean
                  )}
                  {check(t('video.loop'), 'loop', vc.loop as boolean)}
                  {row(
                    t('video.onEnd'),
                    <select
                      style={sel}
                      value={vc.onEnd as string}
                      onChange={(e) => saveVc({ onEnd: e.target.value })}
                    >
                      <option value="freeze">{t('video.onEndFreeze')}</option>
                      <option value="hide">{t('video.onEndHide')}</option>
                    </select>
                  )}
                  {check(t('video.muted'), 'muted', vc.muted as boolean)}
                  <EffectRow
                    label={t('video.volume')}
                    cfg={vc}
                    field="volume"
                    step={0.05}
                    min={0}
                    max={1}
                    onSave={saveVc}
                  />
                </div>
                <div style={sectionHeader}>{t('video.effectsHeader')}</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {row(
                    t('video.blend'),
                    <select
                      style={sel}
                      value={(vc.blendMode as string) ?? 'normal'}
                      onChange={(e) => saveVc({ blendMode: e.target.value })}
                    >
                      <option value="normal">{t('video.blendNormal')}</option>
                      <option value="additive">
                        {t('video.blendAdditive')}
                      </option>
                      <option value="multiply">
                        {t('video.blendMultiply')}
                      </option>
                      <option value="screen">{t('video.blendScreen')}</option>
                    </select>
                  )}
                  {(() => {
                    const ck: Record<string, unknown> = {
                      enabled: false,
                      color: '#00ff00',
                      similarity: 0.4,
                      smoothness: 0.08,
                      spill: 0.1,
                      ...((vc.chromaKey ?? {}) as Record<string, unknown>),
                    };
                    const saveCk = (p: Record<string, unknown>) =>
                      saveVc({ chromaKey: { ...ck, ...p } });
                    return (
                      <>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                          }}
                        >
                          <span
                            style={{
                              fontSize: 12,
                              color: '#888',
                              flex: 1,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            {t('video.chromaKey')}
                            <HelpButton
                              topic="props"
                              anchor="video-chroma"
                              tip={t('help.videoChroma')}
                              size={12}
                            />
                          </span>
                          <input
                            type="checkbox"
                            checked={ck.enabled as boolean}
                            onChange={(e) =>
                              saveCk({ enabled: e.target.checked })
                            }
                          />
                        </div>
                        {(ck.enabled as boolean) && (
                          <>
                            {row(
                              t('video.chromaKeyColor'),
                              <input
                                type="color"
                                value={ck.color as string}
                                onChange={(e) =>
                                  saveCk({ color: e.target.value })
                                }
                                style={{
                                  width: 40,
                                  height: 22,
                                  background: 'none',
                                  border: '1px solid #3a3a3a',
                                  borderRadius: 4,
                                  cursor: 'pointer',
                                }}
                              />
                            )}
                            <EffectRow
                              label={t('video.chromaSimilarity')}
                              cfg={ck}
                              field="similarity"
                              step={0.01}
                              min={0}
                              max={1}
                              onSave={saveCk}
                            />
                            <EffectRow
                              label={t('video.chromaSmoothness')}
                              cfg={ck}
                              field="smoothness"
                              step={0.01}
                              min={0}
                              max={1}
                              onSave={saveCk}
                            />
                            <EffectRow
                              label={t('video.chromaSpill')}
                              cfg={ck}
                              field="spill"
                              step={0.01}
                              min={0}
                              max={1}
                              onSave={saveCk}
                            />
                          </>
                        )}
                      </>
                    );
                  })()}
                </div>
                <div style={sectionHeader}>{t('video.planeHeader')}</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {row(
                    t('billboard.facing'),
                    <select
                      style={sel}
                      value={vc.facing as string}
                      onChange={(e) => saveVc({ facing: e.target.value })}
                    >
                      <option value="screen">{t('video.facingScreen')}</option>
                      <option value="world">{t('video.facingWorld')}</option>
                    </select>
                  )}
                  {row(
                    t('billboard.backface'),
                    <select
                      style={sel}
                      value={vc.backface as string}
                      onChange={(e) => saveVc({ backface: e.target.value })}
                    >
                      <option value="none">{t('video.backfaceNone')}</option>
                      <option value="mirror">
                        {t('video.backfaceMirror')}
                      </option>
                      <option value="unmirrored">
                        {t('video.backfaceUnmirrored')}
                      </option>
                    </select>
                  )}
                  <EffectRow
                    label={t('billboard.width')}
                    cfg={vc}
                    field="width"
                    step={0.05}
                    min={0.01}
                    onSave={saveVc}
                  />
                  <EffectRow
                    label={t('billboard.height')}
                    cfg={vc}
                    field="height"
                    step={0.05}
                    min={0.01}
                    onSave={saveVc}
                  />
                  <EffectRow
                    label={t('billboard.alpha')}
                    cfg={vc}
                    field="alpha"
                    step={0.05}
                    min={0}
                    max={1}
                    onSave={saveVc}
                  />
                </div>
              </>
            );
          })()}

        {node.kind === 'audio' &&
          (() => {
            const ac: Record<string, unknown> = {
              audioType: 'simple',
              sourceUrl: null,
              autoplay: true,
              loop: false,
              onEnd: 'stop',
              volume: 1,
              fadeTime: 0,
              refDistance: 1,
              rolloffFactor: 1,
              maxDistance: 100,
              coneInnerAngle: 360,
              coneOuterAngle: 360,
              coneOuterGain: 0,
              ...((node.components?.audio ?? {}) as Record<string, unknown>),
            };
            const saveAc = (patch: Record<string, unknown>) => {
              const next = { ...ac, ...patch };
              const filePatch =
                'sourceUrl' in patch
                  ? { filePath: (patch.sourceUrl as string) ?? null }
                  : {};
              // One op, so swapping the source stays a single undo step even
              // though it touches both the component and the node's filePath.
              commitNodePatch(node.id, {
                components: { audio: next },
                ...filePatch,
              } as Partial<StageObject>);
            };
            const audioAssets = assets.filter((a) => a.kind === 'audio');
            const sel: React.CSSProperties = {
              background: '#2a2a2a',
              border: '1px solid #3a3a3a',
              color: '#e0e0e0',
              borderRadius: 4,
              padding: '3px 6px',
              fontSize: 12,
              outline: 'none',
              width: '100%',
              boxSizing: 'border-box',
            };
            // Consistent two-column field row: label on the left, a fixed-width
            // control column on the right that the control fills, so every row's
            // inputs share the same left/right edges instead of floating at their
            // own content width.
            const row = (label: string, children: React.ReactNode) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#888', flex: '0 0 42%' }}>
                  {label}
                </span>
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 6,
                  }}
                >
                  {children}
                </div>
              </div>
            );
            const check = (label: string, field: string, checked: boolean) =>
              row(
                label,
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => saveAc({ [field]: e.target.checked })}
                />
              );
            const isDirectional = ac.audioType === 'directional';
            return (
              <>
                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t('audio.sourceHeader')}
                  <HelpButton
                    topic="props"
                    anchor="audio"
                    tip={t('help.propAudio')}
                  />
                  <PickButton onClick={() => flashBottomTab('audio')} />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <datalist id="audio-src-list">
                    {audioAssets.map((a) => (
                      <option key={a.id} value={a.url} label={a.name} />
                    ))}
                  </datalist>
                  {row(
                    t('audio.source'),
                    <input
                      list="audio-src-list"
                      style={{ ...numInput, width: 120 }}
                      placeholder={t('audio.sourcePlaceholder')}
                      defaultValue={(ac.sourceUrl as string) ?? ''}
                      key={node.id + '-audsrc'}
                      onBlur={(e) =>
                        saveAc({ sourceUrl: e.target.value.trim() || null })
                      }
                    />
                  )}
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        color: '#888',
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      {t('audio.type')}
                      <HelpButton
                        topic="props"
                        anchor="audio"
                        tip={t('help.audioType')}
                        size={12}
                      />
                    </span>
                    <select
                      style={sel}
                      value={ac.audioType as string}
                      onChange={(e) => saveAc({ audioType: e.target.value })}
                    >
                      <option value="simple">{t('audio.typeSimple')}</option>
                      <option value="directional">
                        {t('audio.typeDirectional')}
                      </option>
                    </select>
                  </div>
                </div>
                <div style={sectionHeader}>{t('audio.playbackHeader')}</div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {check(
                    t('audio.autoplay'),
                    'autoplay',
                    ac.autoplay as boolean
                  )}
                  {check(t('audio.loop'), 'loop', ac.loop as boolean)}
                  <EffectRow
                    label={t('audio.volume')}
                    cfg={ac}
                    field="volume"
                    step={0.05}
                    min={0}
                    max={1}
                    onSave={saveAc}
                  />
                </div>
                {isDirectional && (
                  <>
                    <div
                      style={{
                        ...sectionHeader,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      {t('audio.spatialHeader')}
                      <HelpButton
                        topic="props"
                        anchor="audio-spatial"
                        tip={t('help.audioSpatial')}
                        size={12}
                      />
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <EffectRow
                        label={t('audio.refDistance')}
                        cfg={ac}
                        field="refDistance"
                        step={0.1}
                        min={0}
                        onSave={saveAc}
                      />
                      <EffectRow
                        label={t('audio.rolloff')}
                        cfg={ac}
                        field="rolloffFactor"
                        step={0.1}
                        min={0}
                        onSave={saveAc}
                      />
                      <EffectRow
                        label={t('audio.maxDistance')}
                        cfg={ac}
                        field="maxDistance"
                        step={1}
                        min={0}
                        onSave={saveAc}
                      />
                      <EffectRow
                        label={t('audio.coneInner')}
                        cfg={ac}
                        field="coneInnerAngle"
                        step={1}
                        min={0}
                        max={360}
                        onSave={saveAc}
                      />
                      <EffectRow
                        label={t('audio.coneOuter')}
                        cfg={ac}
                        field="coneOuterAngle"
                        step={1}
                        min={0}
                        max={360}
                        onSave={saveAc}
                      />
                      <EffectRow
                        label={t('audio.coneOuterGain')}
                        cfg={ac}
                        field="coneOuterGain"
                        step={0.05}
                        min={0}
                        max={1}
                        onSave={saveAc}
                      />
                    </div>
                  </>
                )}
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
              commitNodePath(node.id, 'components.text', {
                type: 'text',
                ...merged,
              });
            };
            const sel: React.CSSProperties = {
              background: '#2a2a2a',
              border: '1px solid #3a3a3a',
              color: '#e0e0e0',
              borderRadius: 4,
              padding: '3px 6px',
              fontSize: 12,
              outline: 'none',
              width: '100%',
              boxSizing: 'border-box',
            };
            // Consistent two-column field row: label on the left, a fixed-width
            // control column on the right that the control fills, so every row's
            // inputs share the same left/right edges instead of floating at their
            // own content width.
            const row = (label: string, children: React.ReactNode) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#888', flex: '0 0 42%' }}>
                  {label}
                </span>
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 6,
                  }}
                >
                  {children}
                </div>
              </div>
            );
            return (
              <>
                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t('text.header')}
                  <HelpButton
                    topic="props"
                    anchor="text"
                    tip={t('help.propText')}
                  />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {row(
                    t('text.content'),
                    <input
                      style={{ ...textInput, width: '100%' }}
                      defaultValue={(tc.content as string) ?? ''}
                      key={node.id + '-tc-content'}
                      onBlur={(e) => saveTc({ content: e.target.value })}
                    />
                  )}
                  {row(
                    t('text.facing'),
                    <select
                      style={sel}
                      value={(tc.facing as string) ?? 'screen'}
                      onChange={(e) => saveTc({ facing: e.target.value })}
                    >
                      <option value="screen">{t('text.facingScreen')}</option>
                      <option value="world">{t('text.facingWorld')}</option>
                    </select>
                  )}
                  {row(
                    t('text.color'),
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
                    label={t('text.fontSize')}
                    cfg={tc}
                    field="fontSize"
                    step={isCanvas ? 1 : 0.01}
                    min={0.001}
                    onSave={saveTc}
                  />
                  {isCanvas && (
                    <>
                      <EffectRow
                        label={t('text.padding')}
                        cfg={tc}
                        field="padding"
                        step={1}
                        min={0}
                        onSave={saveTc}
                      />
                      <EffectRow
                        label={t('text.width')}
                        cfg={tc}
                        field="width"
                        step={0.1}
                        min={0.01}
                        onSave={saveTc}
                      />
                      <EffectRow
                        label={t('text.height')}
                        cfg={tc}
                        field="height"
                        step={0.1}
                        min={0.01}
                        onSave={saveTc}
                      />
                      {row(
                        t('text.allowHtml'),
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
                        t('text.anchorX'),
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
                        t('text.anchorY'),
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
                        label={t('text.maxWidth')}
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
              commitNodePath(node.id, 'components.feed', {
                type: 'feed',
                ...fc,
                ...patch,
              });
            };
            const row = (label: string, children: React.ReactNode) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: '#888', flex: '0 0 42%' }}>
                  {label}
                </span>
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 6,
                  }}
                >
                  {children}
                </div>
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
                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t('feed.header')}
                  <HelpButton
                    topic="props"
                    anchor="feed"
                    tip={t('help.propFeed')}
                  />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <span style={{ fontSize: 11, color: '#666' }}>
                    {t('feed.description')}
                  </span>
                  {row(
                    t('feed.billboard'),
                    <input
                      type="checkbox"
                      checked={Boolean(fc.billboard)}
                      onChange={(e) => saveFc({ billboard: e.target.checked })}
                    />
                  )}
                  {row(
                    t('feed.color'),
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
                    label={t('feed.fontSize')}
                    cfg={fc}
                    field="fontSize"
                    step={1}
                    min={1}
                    onSave={saveFc}
                  />
                  <EffectRow
                    label={t('feed.padding')}
                    cfg={fc}
                    field="padding"
                    step={1}
                    min={0}
                    onSave={saveFc}
                  />
                  <EffectRow
                    label={t('feed.width')}
                    cfg={fc}
                    field="width"
                    step={0.1}
                    min={0.01}
                    onSave={saveFc}
                  />
                  <EffectRow
                    label={t('feed.height')}
                    cfg={fc}
                    field="height"
                    step={0.1}
                    min={0.01}
                    onSave={saveFc}
                  />
                  <span style={{ fontSize: 12, color: '#888' }}>
                    {t('feed.template')}
                  </span>
                  <textarea
                    style={{ ...area, minHeight: 120 }}
                    defaultValue={(fc.template as string) ?? ''}
                    key={node.id + '-feed-template'}
                    spellCheck={false}
                    onBlur={(e) => saveFc({ template: e.target.value })}
                  />
                  <span style={{ fontSize: 12, color: '#888' }}>
                    {t('feed.css')}
                  </span>
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
            const savePc = (patch: Record<string, unknown>) =>
              commitNodePath(node.id, 'components.particle', {
                ...pc,
                ...patch,
              });
            const imageAssets = assets.filter((a) => a.kind === 'image');
            const sel: React.CSSProperties = {
              background: '#2a2a2a',
              border: '1px solid #3a3a3a',
              color: '#e0e0e0',
              borderRadius: 4,
              padding: '3px 6px',
              fontSize: 12,
              outline: 'none',
              width: '100%',
              boxSizing: 'border-box',
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
                <span style={{ fontSize: 12, color: '#888', flex: '0 0 42%' }}>
                  {label}
                </span>
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 6,
                  }}
                >
                  {children}
                </div>
              </div>
            );
            return (
              <>
                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t('particle.textureHeader')}
                  <HelpButton
                    topic="props"
                    anchor="particles"
                    tip={t('help.propParticles')}
                  />
                  <PickButton onClick={() => flashBottomTab('images')} />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {/* Built-in presets */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {getBuiltinParticleTextures().map((tex) => {
                      const url = builtinParticleTextureUrl(tex.key);
                      // Match the canonical `builtin-tex:<key>` ref; also treat a
                      // legacy inlined data URI as selected.
                      const active =
                        pc.textureUrl === url || pc.textureUrl === tex.dataUrl;
                      return (
                        <button
                          key={tex.key}
                          title={tex.label}
                          onClick={() => savePc({ textureUrl: url })}
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
                            src={tex.dataUrl}
                            alt={tex.label}
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
                            {tex.label}
                          </span>
                        </button>
                      );
                    })}
                    <button
                      title={t('particle.textureDefault')}
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
                        {t('particle.textureDefault')}
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
                    t('particle.textureCustom'),
                    <input
                      list="particle-img-list"
                      style={{ ...numInput, width: 120 }}
                      placeholder={t('particle.texturePlaceholder')}
                      defaultValue={(pc.textureUrl as string) ?? ''}
                      key={node.id + '-tex'}
                      onBlur={(e) =>
                        savePc({ textureUrl: e.target.value.trim() || null })
                      }
                    />
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
                  {t('particle.renderingHeader')}
                  <HelpButton
                    topic="particles"
                    anchor="rendering"
                    tip={t('help.partRendering')}
                    size={12}
                  />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {row(
                    t('particle.blendMode'),
                    <select
                      style={sel}
                      value={pc.blendMode as string}
                      onChange={(e) => savePc({ blendMode: e.target.value })}
                    >
                      <option value="additive">
                        {t('particle.blendAdditive')}
                      </option>
                      <option value="normal">
                        {t('particle.blendNormal')}
                      </option>
                      <option value="multiply">
                        {t('particle.blendMultiply')}
                      </option>
                    </select>
                  )}
                  {row(
                    t('particle.simulationSpace'),
                    <select
                      style={sel}
                      value={pc.simulationSpace as string}
                      onChange={(e) =>
                        savePc({ simulationSpace: e.target.value })
                      }
                    >
                      <option value="world">
                        {t('particle.simulationWorld')}
                      </option>
                      <option value="local">
                        {t('particle.simulationLocal')}
                      </option>
                    </select>
                  )}
                  <EffectRow
                    label={t('particle.maxCount')}
                    cfg={pc}
                    field="maxCount"
                    step={10}
                    min={1}
                    max={5000}
                    onSave={savePc}
                  />
                  {row(t('particle.depthWrite'), chk('depthWrite'))}
                  {row(t('particle.depthTest'), chk('depthTest'))}
                </div>

                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t('particle.emissionHeader')}
                  <HelpButton
                    topic="particles"
                    anchor="emission"
                    tip={t('help.partEmission')}
                    size={12}
                  />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <EffectRow
                    label={t('particle.emissionRate')}
                    cfg={pc}
                    field="emissionRate"
                    step={1}
                    min={0}
                    onSave={savePc}
                  />
                  {row(t('particle.burstMode'), chk('burstMode'))}
                  {row(t('particle.loop'), chk('loop'))}
                  {row(t('particle.playOnStart'), chk('playOnStart'))}
                </div>

                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t('particle.lifetimeHeader')}
                  <HelpButton
                    topic="particles"
                    anchor="lifetime"
                    tip={t('help.partLifetime')}
                    size={12}
                  />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <EffectRow
                    label={t('particle.lifetime')}
                    cfg={pc}
                    field="lifetime"
                    step={0.1}
                    min={0.01}
                    onSave={savePc}
                  />
                  <EffectRow
                    label={t('particle.lifetimeRandom')}
                    cfg={pc}
                    field="lifetimeRandom"
                    step={0.05}
                    min={0}
                    max={1}
                    onSave={savePc}
                  />
                </div>

                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t('particle.sizeHeader')}
                  <HelpButton
                    topic="particles"
                    anchor="size"
                    tip={t('help.partSize')}
                    size={12}
                  />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <EffectRow
                    label={t('particle.sizeWidth')}
                    cfg={pc}
                    field="sizeX"
                    step={0.005}
                    min={0.001}
                    onSave={savePc}
                  />
                  <EffectRow
                    label={t('particle.sizeHeight')}
                    cfg={pc}
                    field="sizeY"
                    step={0.005}
                    min={0.001}
                    onSave={savePc}
                  />
                  <EffectRow
                    label={t('particle.sizeWidthRandom')}
                    cfg={pc}
                    field="sizeRandomX"
                    step={0.05}
                    min={0}
                    max={1}
                    onSave={savePc}
                  />
                  <EffectRow
                    label={t('particle.sizeHeightRandom')}
                    cfg={pc}
                    field="sizeRandomY"
                    step={0.05}
                    min={0}
                    max={1}
                    onSave={savePc}
                  />
                  {row(
                    t('particle.sizeOverLifetime'),
                    <select
                      style={sel}
                      value={pc.sizeOverLifetime as string}
                      onChange={(e) =>
                        savePc({ sizeOverLifetime: e.target.value })
                      }
                    >
                      <option value="constant">
                        {t('particle.sizeConstant')}
                      </option>
                      <option value="shrink">{t('particle.sizeShrink')}</option>
                      <option value="grow">{t('particle.sizeGrow')}</option>
                      <option value="pulse">{t('particle.sizePulse')}</option>
                    </select>
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
                  {t('particle.colorHeader')}
                  <HelpButton
                    topic="particles"
                    anchor="color"
                    tip={t('help.partColor')}
                    size={12}
                  />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {row(
                    t('particle.colorStart'),
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
                    t('particle.colorEnd'),
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
                    label={t('particle.alpha')}
                    cfg={pc}
                    field="alpha"
                    step={0.05}
                    min={0}
                    max={1}
                    onSave={savePc}
                  />
                  {row(
                    t('particle.alphaOverLifetime'),
                    <select
                      style={sel}
                      value={pc.alphaOverLifetime as string}
                      onChange={(e) =>
                        savePc({ alphaOverLifetime: e.target.value })
                      }
                    >
                      <option value="constant">
                        {t('particle.alphaConstant')}
                      </option>
                      <option value="fade-in">
                        {t('particle.alphaFadeIn')}
                      </option>
                      <option value="fade-out">
                        {t('particle.alphaFadeOut')}
                      </option>
                      <option value="fade-in-out">
                        {t('particle.alphaFadeInOut')}
                      </option>
                    </select>
                  )}
                  <EffectRow
                    label={t('particle.emissiveIntensity')}
                    cfg={pc}
                    field="emissiveIntensity"
                    step={0.1}
                    min={0}
                    onSave={savePc}
                  />
                </div>

                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t('particle.directionHeader')}
                  <HelpButton
                    topic="particles"
                    anchor="direction"
                    tip={t('help.partDirection')}
                    size={12}
                  />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <EffectRow
                    label={t('particle.dirX')}
                    cfg={pc}
                    field="directionX"
                    step={0.1}
                    onSave={savePc}
                  />
                  <EffectRow
                    label={t('particle.dirY')}
                    cfg={pc}
                    field="directionY"
                    step={0.1}
                    onSave={savePc}
                  />
                  <EffectRow
                    label={t('particle.dirZ')}
                    cfg={pc}
                    field="directionZ"
                    step={0.1}
                    onSave={savePc}
                  />
                  <EffectRow
                    label={t('particle.spread')}
                    cfg={pc}
                    field="spread"
                    step={1}
                    min={0}
                    max={180}
                    onSave={savePc}
                  />
                  <EffectRow
                    label={t('particle.speed')}
                    cfg={pc}
                    field="speed"
                    step={0.1}
                    min={0}
                    onSave={savePc}
                  />
                  <EffectRow
                    label={t('particle.speedRandom')}
                    cfg={pc}
                    field="speedRandom"
                    step={0.05}
                    min={0}
                    max={1}
                    onSave={savePc}
                  />
                </div>

                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t('particle.originHeader')}
                  <HelpButton
                    topic="particles"
                    anchor="origin"
                    tip={t('help.partOrigin')}
                    size={12}
                  />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <EffectRow
                    label={t('particle.originWidth')}
                    cfg={pc}
                    field="originW"
                    step={0.05}
                    min={0}
                    onSave={savePc}
                  />
                  <EffectRow
                    label={t('particle.originHeight')}
                    cfg={pc}
                    field="originH"
                    step={0.05}
                    min={0}
                    onSave={savePc}
                  />
                  <EffectRow
                    label={t('particle.originDepth')}
                    cfg={pc}
                    field="originD"
                    step={0.05}
                    min={0}
                    onSave={savePc}
                  />
                </div>

                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t('particle.motionHeader')}
                  <HelpButton
                    topic="particles"
                    anchor="motion"
                    tip={t('help.partMotion')}
                    size={12}
                  />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <EffectRow
                    label={t('particle.gravityX')}
                    cfg={pc}
                    field="gravityX"
                    step={0.05}
                    onSave={savePc}
                  />
                  <EffectRow
                    label={t('particle.gravityY')}
                    cfg={pc}
                    field="gravityY"
                    step={0.05}
                    onSave={savePc}
                  />
                  <EffectRow
                    label={t('particle.gravityZ')}
                    cfg={pc}
                    field="gravityZ"
                    step={0.05}
                    onSave={savePc}
                  />
                  <EffectRow
                    label={t('particle.turbulence')}
                    cfg={pc}
                    field="turbulence"
                    step={0.05}
                    min={0}
                    onSave={savePc}
                  />
                </div>

                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t('particle.rotationHeader')}
                  <HelpButton
                    topic="particles"
                    anchor="rotation"
                    tip={t('help.partRotation')}
                    size={12}
                  />
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {row(
                    t('particle.rotationMode'),
                    <select
                      style={sel}
                      value={(pc.rotationMode as string) ?? 'free'}
                      onChange={(e) => savePc({ rotationMode: e.target.value })}
                    >
                      <option value="free">{t('particle.rotationFree')}</option>
                      <option value="velocity">
                        {t('particle.rotationVelocity')}
                      </option>
                    </select>
                  )}
                  {pc.rotationMode !== 'velocity' && (
                    <>
                      <EffectRow
                        label={t('particle.rotationStart')}
                        cfg={pc}
                        field="rotationStart"
                        step={5}
                        min={0}
                        max={180}
                        onSave={savePc}
                      />
                      <EffectRow
                        label={t('particle.angularVelocity')}
                        cfg={pc}
                        field="angularVelocity"
                        step={5}
                        onSave={savePc}
                      />
                      <EffectRow
                        label={t('particle.angularVelocityRandom')}
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
            const meta = assetMetaForNode(node.filePath, assets);
            const morphs = liveOrMetaList(
              vrmMorphTargetsByNode[node.id],
              meta,
              'morphTargets'
            );
            const exprs = liveOrMetaList(
              vrmExpressionsByNode[node.id],
              meta,
              'expressions'
            );
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
                      {t('avatar.morphHeader')} ({morphs.length})
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
                    title={t('avatar.defaultExpressionHeader')}
                    count={exprs.length}
                    extra={
                      <HelpButton
                        topic="avatar"
                        anchor="expressions"
                        tip={t('help.expressions')}
                      />
                    }
                  >
                    <div
                      style={{
                        fontSize: 10,
                        color: '#555',
                        lineHeight: 1.4,
                        marginBottom: 6,
                      }}
                    >
                      {t('avatar.defaultExpressionHint')}
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
                          // Keep 0 entries (don't delete) so the viewport keeps
                          // driving the expression back to 0 — dropping the key
                          // would leave the last applied weight stuck on the VRM.
                          const path = `properties.defaultExpressions.${n}`;
                          if (persist) commitNodePath(node.id, path, v);
                          else previewNodePath(node.id, path, v);
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
            <div style={sectionHeader}>{t('avatar.propertiesHeader')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  fontSize: 12,
                  color: '#888',
                  width: 110,
                  flexShrink: 0,
                }}
              >
                {t('avatar.blendTransition')}
              </span>
              <NumInput
                value={node.properties?.blendTransitionTime ?? 0.5}
                step={0.05}
                min={0}
                suffix="s"
                style={{ flex: 1, minWidth: 0 }}
                onChange={(v) =>
                  previewNodePath(node.id, 'properties.blendTransitionTime', v)
                }
                onCommit={(v) =>
                  commitNodePath(node.id, 'properties.blendTransitionTime', v)
                }
              />
            </div>

            {/* Sits next to the blend time on purpose: that one is how *fast*
                the return to idle runs, this one is *when* it starts. Every
                tracking source on the avatar (VMC, MediaPipe) shares it. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  fontSize: 12,
                  color: '#888',
                  width: 110,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {t('avatar.trackingGracePeriod')}
                <HelpButton
                  topic="avatar"
                  anchor="animation"
                  tip={t('help.trackingGracePeriod')}
                  size={12}
                />
              </span>
              <NumInput
                className="vs-avatar-tracking-grace"
                value={node.properties?.trackingGracePeriod ?? 2}
                step={0.1}
                min={0.1}
                max={60}
                suffix="s"
                style={{ flex: 1, minWidth: 0 }}
                onChange={(v) =>
                  previewNodePath(node.id, 'properties.trackingGracePeriod', v)
                }
                onCommit={(v) =>
                  commitNodePath(node.id, 'properties.trackingGracePeriod', v)
                }
              />
            </div>
          </>
        )}

        {/* Motion snappiness (second-order dynamics) — avatar only */}
        {node.kind === 'avatar' &&
          (() => {
            const dyn: PoseDynamicsConfig = {
              ...DEFAULT_POSE_DYNAMICS,
              ...node.properties?.poseDynamics,
            };
            const liveDyn = (next: PoseDynamicsConfig) =>
              previewNodePath(node.id, 'properties.poseDynamics', next);
            const commitDyn = (next: PoseDynamicsConfig) =>
              commitNodePath(node.id, 'properties.poseDynamics', next);
            const labelStyle = {
              fontSize: 12,
              color: '#888',
              width: 110,
              flexShrink: 0,
            } as const;
            return (
              <>
                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t('avatar.dynamicsHeader')}
                  <HelpButton
                    topic="avatar"
                    anchor="snappiness"
                    tip={t('help.dynamics')}
                  />
                </div>
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
                    checked={dyn.enabled}
                    onChange={(e) =>
                      commitDyn({ ...dyn, enabled: e.target.checked })
                    }
                  />
                  {t('avatar.dynamicsEnable')}
                </label>
                {dyn.enabled && (
                  <>
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      <span style={labelStyle}>
                        {t('avatar.dynamicsFrequency')}
                      </span>
                      <NumInput
                        value={dyn.frequency}
                        step={0.1}
                        min={0.05}
                        max={30}
                        suffix="Hz"
                        style={{ flex: 1, minWidth: 0 }}
                        onChange={(v) => liveDyn({ ...dyn, frequency: v })}
                        onCommit={(v) => commitDyn({ ...dyn, frequency: v })}
                      />
                    </div>
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      <span style={labelStyle}>
                        {t('avatar.dynamicsDamping')}
                      </span>
                      <NumInput
                        value={dyn.damping}
                        step={0.05}
                        min={0}
                        max={4}
                        style={{ flex: 1, minWidth: 0 }}
                        onChange={(v) => liveDyn({ ...dyn, damping: v })}
                        onCommit={(v) => commitDyn({ ...dyn, damping: v })}
                      />
                    </div>
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      <span style={labelStyle}>
                        {t('avatar.dynamicsResponse')}
                      </span>
                      <NumInput
                        value={dyn.response}
                        step={0.1}
                        min={-5}
                        max={5}
                        style={{ flex: 1, minWidth: 0 }}
                        onChange={(v) => liveDyn({ ...dyn, response: v })}
                        onCommit={(v) => commitDyn({ ...dyn, response: v })}
                      />
                    </div>
                  </>
                )}
              </>
            );
          })()}

        {/* Partial tracking — per-section animation/tracking influence (avatar only) */}
        {node.kind === 'avatar' &&
          (() => {
            const SECTIONS: PoseSection[] = [
              'head',
              'gaze',
              'body',
              'arms',
              'hands',
              'legs',
            ];
            const src: PoseSource = node.properties?.poseSource ?? {};
            const infOf = (sec: PoseSection) =>
              src[sec] ?? { anim: 1, track: 1 };
            const apply = (next: PoseSource, persist: boolean) => {
              // Prune sections left at the { anim:1, track:1 } default so we only
              // store deviations.
              const pruned: PoseSource = {};
              for (const s of SECTIONS) {
                const v = next[s];
                if (v && (v.anim !== 1 || v.track !== 1)) pruned[s] = v;
              }
              if (persist)
                commitNodePath(node.id, 'properties.poseSource', pruned);
              else previewNodePath(node.id, 'properties.poseSource', pruned);
            };
            const setInf = (
              sec: PoseSection,
              patch: Partial<{ anim: number; track: number }>,
              persist: boolean
            ) => apply({ ...src, [sec]: { ...infOf(sec), ...patch } }, persist);
            const anyConfigured = SECTIONS.some((s) => {
              const v = src[s];
              return v && (v.anim !== 1 || v.track !== 1);
            });
            const colLabel = {
              fontSize: 10,
              color: '#666',
              flexShrink: 0,
            } as const;
            return (
              <>
                <div
                  style={{
                    ...sectionHeader,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t('avatar.poseSourceHeader')}
                  <HelpButton
                    topic="avatar"
                    anchor="partial-tracking"
                    tip={t('help.poseSource')}
                  />
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: '#555',
                    lineHeight: 1.4,
                    marginBottom: 6,
                  }}
                >
                  {t('avatar.poseSourceHint')}
                </div>
                {SECTIONS.map((sec) => {
                  const inf = infOf(sec);
                  return (
                    <div
                      key={sec}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        marginBottom: 4,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          color: '#999',
                          width: 48,
                          flexShrink: 0,
                        }}
                      >
                        {t(`avatar.poseSection.${sec}`)}
                      </span>
                      <span style={colLabel}>{t('avatar.poseSourceAnim')}</span>
                      <SliderInput
                        className={`vs-posesrc-anim-${sec}`}
                        value={inf.anim}
                        min={0}
                        max={1}
                        step={0.05}
                        precision={2}
                        onChange={(v) => setInf(sec, { anim: v }, false)}
                        onCommit={(v) => setInf(sec, { anim: v }, true)}
                        style={{ flex: 1, minWidth: 0 }}
                      />
                      <span style={colLabel}>
                        {t('avatar.poseSourceTrack')}
                      </span>
                      <SliderInput
                        className={`vs-posesrc-track-${sec}`}
                        value={inf.track}
                        min={0}
                        max={1}
                        step={0.05}
                        precision={2}
                        onChange={(v) => setInf(sec, { track: v }, false)}
                        onCommit={(v) => setInf(sec, { track: v }, true)}
                        style={{ flex: 1, minWidth: 0 }}
                      />
                    </div>
                  );
                })}
                {anyConfigured && (
                  <button
                    className="vs-posesrc-reset"
                    style={resetBtnStyle}
                    onClick={() => apply({}, true)}
                  >
                    {t('avatar.poseSourceReset')}
                  </button>
                )}
              </>
            );
          })()}

        {/* Forearm twist — avatar only */}
        {node.kind === 'avatar' && (
          <>
            <div
              style={{
                ...sectionHeader,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {t('avatar.twistHeader')}
              <HelpButton topic="avatar" anchor="twist" tip={t('help.twist')} />
            </div>
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
                checked={node.properties?.forceTwistBone === true}
                onChange={(e) => {
                  commitNodePath(
                    node.id,
                    'properties.forceTwistBone',
                    e.target.checked
                  );
                }}
              />
              {t('avatar.twistForce')}
            </label>
            {node.properties?.forceTwistBone === true && (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  color: '#888',
                  cursor: 'pointer',
                  userSelect: 'none',
                  marginLeft: 20,
                }}
              >
                <input
                  type="checkbox"
                  checked={node.properties?.excludeSleeves === true}
                  onChange={(e) => {
                    commitNodePath(
                      node.id,
                      'properties.excludeSleeves',
                      e.target.checked
                    );
                  }}
                />
                {t('avatar.twistExcludeSleeves')}
              </label>
            )}
          </>
        )}

        {/* FBX debug toggle — avatar only */}
        {node.kind === 'avatar' && (
          <>
            <div style={sectionHeader}>{t('avatar.debugHeader')}</div>
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
              {t('avatar.showFbxModel')}
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
              {node.kind === 'avatar' ? (
                <>
                  {t('avatar.modelHeader')}
                  <HelpButton
                    topic="avatar"
                    anchor="loading"
                    tip={t('help.avatar')}
                  />
                </>
              ) : (
                t('avatar.modelHeader')
              )}
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
                    ? t('avatar.modelPlaceholder')
                    : t('avatar.modelNoAssets')
                }
                defaultValue={node.filePath ?? ''}
                key={node.id + ':model'}
                onBlur={(e) => {
                  // '' (not null) is the cleared value: REST's field-presence
                  // merge drops a null, so the fallback would never clear it.
                  commitNodePath(node.id, 'filePath', e.target.value.trim());
                }}
              />
              {node.filePath && (
                <button
                  title={t('avatar.modelClear')}
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
                    commitNodePath(node.id, 'filePath', '');
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
                      commitNodePath(node.id, 'filePath', a.url);
                    }}
                  >
                    {a.name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* Animation. Idle is a content-addressed clip (auto-migrated from the
            legacy URL). Speed is on the raw number input pending the planned
            NumInput unification; the clock-anchored transport has no local
            seek/pause (playback is driven by the synced timeline). */}
        {(node.kind === 'avatar' || node.kind === 'model') && (
          <>
            <div
              style={{
                ...sectionHeader,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              {t('avatar.animationHeader')}
              <PickButton onClick={() => flashBottomTab('animations')} />
            </div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>
              {t('avatar.idleAnimation')}
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
                    ? t('avatar.animPlaceholder')
                    : t('avatar.animNoAssets')
                }
                defaultValue={idleUrlDisplay}
                key={`${node.id}-${idleUrlDisplay}`}
                onBlur={(e) => {
                  writeIdle(e.target.value.trim() || null, idleSpeedDisplay);
                }}
              />
              {idleUrlDisplay && (
                <button
                  title={t('avatar.animClear')}
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
                    writeIdle(null, idleSpeedDisplay);
                  }}
                >
                  ×
                </button>
              )}
            </div>
            {/* Speed */}
            {idleUrlDisplay && (
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
                  {t('avatar.animSpeed')}
                  <input
                    type="number"
                    style={{ ...textInput }}
                    step={0.1}
                    min={0}
                    defaultValue={idleSpeedDisplay}
                    key={`${node.id}-speed-${idleSpeedDisplay}`}
                    onBlur={(e) => {
                      const speed = parseFloat(e.target.value);
                      if (isNaN(speed) || speed < 0) return;
                      writeIdle(idleUrlDisplay || null, speed);
                    }}
                  />
                </label>
              </div>
            )}

            {/* Base animation — the layer live tracking stacks onto (avatars
                only). Played while a source is connected; falls back to the idle
                when tracking drops. */}
            {node.kind === 'avatar' && (
              <>
                <div
                  style={{
                    fontSize: 12,
                    color: '#888',
                    marginTop: 12,
                    marginBottom: 6,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t('avatar.baseAnimation')}
                  <HelpButton
                    topic="avatar"
                    anchor="partial-tracking"
                    tip={t('help.baseAnimation')}
                  />
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    className="vs-base-anim-url"
                    list="anim-list"
                    style={{ ...textInput, flex: 1 }}
                    placeholder={
                      animAssets.length
                        ? t('avatar.animPlaceholder')
                        : t('avatar.animNoAssets')
                    }
                    defaultValue={baseUrlDisplay}
                    key={`${node.id}-base-${baseUrlDisplay}`}
                    onBlur={(e) => {
                      writeBase(
                        e.target.value.trim() || null,
                        baseSpeedDisplay
                      );
                    }}
                  />
                  {baseUrlDisplay && (
                    <button
                      className="vs-base-anim-clear"
                      title={t('avatar.animClear')}
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
                        writeBase(null, baseSpeedDisplay);
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
                {baseUrlDisplay && (
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
                      {t('avatar.animSpeed')}
                      <input
                        className="vs-base-anim-speed"
                        type="number"
                        style={{ ...textInput }}
                        step={0.1}
                        min={0}
                        defaultValue={baseSpeedDisplay}
                        key={`${node.id}-base-speed-${baseSpeedDisplay}`}
                        onBlur={(e) => {
                          const speed = parseFloat(e.target.value);
                          if (isNaN(speed) || speed < 0) return;
                          writeBase(baseUrlDisplay || null, speed);
                        }}
                      />
                    </label>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* File Path */}
        {node.filePath && (
          <>
            <div style={{ ...sectionHeader, marginTop: 16 }}>
              {t('file.header')}
            </div>
            <div
              style={{ fontSize: 11, color: '#666', wordBreak: 'break-all' }}
            >
              {node.filePath}
            </div>
          </>
        )}

        {/* Selected component properties */}
        {selectedBehavior && selectedCompType && (
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
                <span style={{ display: 'inline-flex', color: '#cfcfcf' }}>
                  {(() => {
                    const I =
                      BEHAVIOR_ICON[selectedCompType.kind] ?? BEHAVIOR_FALLBACK;
                    return <I size={18} />;
                  })()}
                </span>
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: '#e0e0e0',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    {selectedCompType.label}
                    {selectedBehavior.kind === 'breathing' && (
                      <HelpButton
                        topic="behaviors"
                        anchor="breathing"
                        tip={t('help.breathing')}
                      />
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>
                    {selectedCompType.description}
                  </div>
                </div>
              </div>
              <BehaviorProps comp={selectedBehavior} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
