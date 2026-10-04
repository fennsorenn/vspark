/**
 * Tracking Mix UI — per-source influence over each bone and blendshape of an
 * avatar (replaced the per-section "Partial Tracking" sliders).
 *
 * Two surfaces, one data model (`properties.trackingMix`, see
 * `@vspark/shared/trackingMix`):
 *   - `TrackingMixSection` — the compact sidebar block: one master slider per
 *     source plus the button that opens the mixer.
 *   - `TrackingMixModal` — the full editor: Body / Face tabs, a matrix of
 *     regions (expandable to bones) or face groups (expandable to shapes) ×
 *     sources, and the tracking-source order.
 *
 * Grouped controls (master, region, face group) write every member. When the
 * members disagree the control shows "Custom" with a reset that sets them all to
 * `resetValueFor(members)` — the most frequent value, higher on ties, 1 when
 * nothing repeats.
 */
import { useCallback, useMemo, useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import type { TrackingMix } from '@vspark/shared';
import { VRM_BONE_NAMES } from '@vspark/shared/signal';
import {
  ANIMATION_SOURCE,
  BLENDSHAPE_SOURCE_KINDS,
  BONE_SOURCE_KINDS,
  MIX_FACE_GROUPS,
  MIX_REGIONS,
  MIX_REGION_BONES,
  MIX_WEIGHT_MAX,
  MIX_WEIGHT_MIN,
  blendshapeWeight,
  boneWeight,
  faceGroupOf,
  orderSources,
  pruneMix,
  pruneStaleSources,
  resetValueFor,
  setBlendshapeWeights,
  setBoneWeights,
  uniformValue,
} from '@vspark/shared/trackingMix';
import type { MixFaceGroup } from '@vspark/shared/trackingMix';
import { HelpButton } from '../../help/HelpButton';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useNodeBehaviors } from '../../mesh/hooks';
import { commitNodePath, previewNodePath } from '../../mesh/writes';
import { useEditorStore } from '../../store/editorStore';
import type { Behavior, StageObject } from '../../store/editorStore';
import { SliderInput } from './numericInputs';

// ── Sources ──────────────────────────────────────────────────────────────────

export interface MixSource {
  /** Behavior id, or ANIMATION_SOURCE. */
  id: string;
  kind: string;
  /** Display label (behavior kind label, numbered when a kind repeats). */
  label: string;
  bones: boolean;
  blendshapes: boolean;
}

const BONE_KINDS = new Set<string>(BONE_SOURCE_KINDS);
const SHAPE_KINDS = new Set<string>(BLENDSHAPE_SOURCE_KINDS);

/** The bus's legacy priority for a source kind (used for unlisted sources). */
const legacyPriority = (kind: string) => (kind === 'breathing' ? 10 : 0);

/**
 * The mix's sources for a node: Animation first (fixed, bones only), then the
 * node's bone/blendshape-publishing behaviors in composition order (`mix.order`
 * first, the rest by the bus's legacy priority). Pure, for tests.
 */
export function buildMixSources(
  behaviors: readonly Pick<Behavior, 'id' | 'kind'>[],
  kindLabel: (kind: string) => string,
  animationLabel: string,
  mix: TrackingMix | undefined
): MixSource[] {
  const relevant = behaviors.filter(
    (b) => BONE_KINDS.has(b.kind) || SHAPE_KINDS.has(b.kind)
  );
  const perKind = new Map<string, number>();
  for (const b of relevant) perKind.set(b.kind, (perKind.get(b.kind) ?? 0) + 1);
  const seen = new Map<string, number>();
  const tracking = relevant.map((b) => {
    const n = (seen.get(b.kind) ?? 0) + 1;
    seen.set(b.kind, n);
    const base = kindLabel(b.kind);
    return {
      id: b.id,
      kind: b.kind,
      label: (perKind.get(b.kind) ?? 0) > 1 ? `${base} ${n}` : base,
      bones: BONE_KINDS.has(b.kind),
      blendshapes: SHAPE_KINDS.has(b.kind),
      priority: legacyPriority(b.kind),
    };
  });
  const ordered = orderSources(mix, tracking).map(
    ({ priority: _p, ...s }) => s
  );
  return [
    {
      id: ANIMATION_SOURCE,
      kind: ANIMATION_SOURCE,
      label: animationLabel,
      bones: true,
      blendshapes: false,
    },
    ...ordered,
  ];
}

/** Face rows: the model's expressions + morph targets, plus any shape the mix
 *  already weights (so a customised shape stays visible), grouped. */
export function buildFaceGroups(
  names: readonly string[],
  mix: TrackingMix | undefined
): { group: MixFaceGroup; shapes: string[] }[] {
  const all = new Set(names);
  for (const src of Object.values(mix?.sources ?? {}))
    for (const s of Object.keys(src.blendshapes ?? {})) all.add(s);
  const byGroup = new Map<MixFaceGroup, string[]>();
  for (const n of [...all].sort((a, b) => a.localeCompare(b))) {
    const g = faceGroupOf(n);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(n);
  }
  return MIX_FACE_GROUPS.filter((g) => byGroup.has(g)).map((g) => ({
    group: g,
    shapes: byGroup.get(g)!,
  }));
}

const ALL_BONES = VRM_BONE_NAMES as readonly string[];

/** Shared state + writers for both surfaces. */
function useTrackingMix(node: StageObject) {
  const { t } = useTranslation('properties');
  const behaviors = useNodeBehaviors(node.id);
  const behaviorKinds = useEditorStore((s) => s.behaviorKinds);
  const expressions = useEditorStore((s) => s.vrmExpressionsByNode[node.id]);
  const morphs = useEditorStore((s) => s.vrmMorphTargetsByNode[node.id]);
  const mix = node.properties?.trackingMix as TrackingMix | undefined;

  const sources = useMemo(
    () =>
      buildMixSources(
        behaviors,
        (k) => behaviorKinds.find((c) => c.kind === k)?.label ?? k,
        t('trackingMix.animation'),
        mix
      ),
    [behaviors, behaviorKinds, mix, t]
  );
  const faceGroups = useMemo(
    () => buildFaceGroups([...(expressions ?? []), ...(morphs ?? [])], mix),
    [expressions, morphs, mix]
  );
  const faceShapes = useMemo(
    () => faceGroups.flatMap((g) => g.shapes),
    [faceGroups]
  );

  const write = useCallback(
    (next: TrackingMix | undefined, persist: boolean) => {
      const live = new Set(behaviors.map((b) => b.id));
      const cleaned = pruneMix(pruneStaleSources(next, live)) ?? {};
      if (persist) commitNodePath(node.id, 'properties.trackingMix', cleaned);
      else previewNodePath(node.id, 'properties.trackingMix', cleaned);
    },
    [behaviors, node.id]
  );

  return { mix, sources, faceGroups, faceShapes, write };
}

// ── Grouped cell ─────────────────────────────────────────────────────────────

/** One slider standing for a set of members; "Custom" + reset when they
 *  disagree. */
function GroupCell({
  values,
  onSet,
  master = false,
}: {
  values: number[];
  onSet: (v: number, persist: boolean) => void;
  /** The sidebar's per-source master (vs a region / face-group cell). */
  master?: boolean;
}) {
  const { t } = useTranslation('properties');
  const uniform = uniformValue(values);
  if (uniform === null) {
    const target = resetValueFor(values);
    return (
      <div style={customCellStyle}>
        <span style={{ fontSize: 11, color: '#c9a35a', fontStyle: 'italic' }}>
          {t('trackingMix.custom')}
        </span>
        <button
          className={master ? 'vs-mix-master-reset' : 'vs-mix-group-reset'}
          style={smallBtnStyle}
          title={t('trackingMix.resetTo', { value: target })}
          onClick={() => onSet(target, true)}
        >
          ↺
        </button>
      </div>
    );
  }
  return (
    <SliderInput
      className={master ? 'vs-mix-master' : 'vs-mix-group-cell'}
      value={uniform}
      min={MIX_WEIGHT_MIN}
      max={MIX_WEIGHT_MAX}
      step={0.05}
      precision={2}
      onChange={(v) => onSet(v, false)}
      onCommit={(v) => onSet(v, true)}
      style={{ minWidth: 0, flex: 1 }}
    />
  );
}

// ── Sidebar section ──────────────────────────────────────────────────────────

export function TrackingMixSection({ node }: { node: StageObject }) {
  const { t } = useTranslation('properties');
  const { mix, sources, faceShapes, write } = useTrackingMix(node);
  const [open, setOpen] = useState(false);

  /** Every weight a source's master slider stands for. */
  const membersOf = (s: (typeof sources)[number]) => {
    const vals: number[] = [];
    if (s.bones) for (const b of ALL_BONES) vals.push(boneWeight(mix, s.id, b));
    if (s.blendshapes) {
      const shapes = new Set([
        ...faceShapes,
        ...Object.keys(mix?.sources?.[s.id]?.blendshapes ?? {}),
      ]);
      for (const sh of shapes) vals.push(blendshapeWeight(mix, s.id, sh));
    }
    return vals;
  };
  const setAll = (s: (typeof sources)[number], v: number, persist: boolean) => {
    let next = mix;
    if (s.bones) next = setBoneWeights(next, s.id, ALL_BONES, v);
    if (s.blendshapes) {
      const shapes = new Set([
        ...faceShapes,
        ...Object.keys(mix?.sources?.[s.id]?.blendshapes ?? {}),
      ]);
      next = setBlendshapeWeights(next, s.id, [...shapes], v);
    }
    write(next, persist);
  };

  return (
    <>
      <div style={sectionHeaderStyle}>
        {t('trackingMix.header')}
        <HelpButton
          topic="avatar"
          anchor="tracking-mix"
          tip={t('help.trackingMix')}
        />
      </div>
      <div style={hintStyle}>{t('trackingMix.hint')}</div>
      {sources.map((s) => (
        <div key={s.id} style={rowStyle}>
          <span style={sourceLabelStyle} title={s.label}>
            {s.label}
          </span>
          <GroupCell
            values={membersOf(s)}
            onSet={(v, p) => setAll(s, v, p)}
            master
          />
        </div>
      ))}
      <button
        className="vs-mix-open"
        style={openBtnStyle}
        onClick={() => setOpen(true)}
      >
        {t('trackingMix.open')}
      </button>
      {open && <TrackingMixModal node={node} onClose={() => setOpen(false)} />}
    </>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

type Tab = 'body' | 'face';

export function TrackingMixModal({
  node,
  onClose,
}: {
  node: StageObject;
  onClose: () => void;
}) {
  const { t } = useTranslation('properties');
  const { mix, sources, faceGroups, write } = useTrackingMix(node);
  const [tab, setTab] = useState<Tab>('body');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEscapeKey(onClose);

  const bodySources = sources.filter((s) => s.bones);
  const faceSources = sources.filter((s) => s.blendshapes);
  const tracking = sources.filter((s) => s.id !== ANIMATION_SOURCE);

  const toggle = (key: string) =>
    setExpanded((e) => ({ ...e, [key]: !e[key] }));

  const move = (id: string, dir: -1 | 1) => {
    // Order only matters for bones (blendshapes sum), so only bone sources
    // are listed and reordered.
    const ids = tracking.filter((s) => s.bones).map((s) => s.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    write({ ...mix, order: ids }, true);
  };

  const columns = tab === 'body' ? bodySources : faceSources;
  const groups =
    tab === 'body'
      ? MIX_REGIONS.map((r) => ({
          key: r,
          label: t(`trackingMix.region.${r}`),
          members: MIX_REGION_BONES[r] as readonly string[],
        }))
      : faceGroups.map((g) => ({
          key: g.group,
          label: t(`trackingMix.faceGroup.${g.group}`),
          members: g.shapes,
        }));
  const weightOf = (src: string, member: string) =>
    tab === 'body'
      ? boneWeight(mix, src, member)
      : blendshapeWeight(mix, src, member);
  const setMembers = (
    src: string,
    members: readonly string[],
    v: number,
    persist: boolean
  ) =>
    write(
      tab === 'body'
        ? setBoneWeights(mix, src, members, v)
        : setBlendshapeWeights(mix, src, members, v),
      persist
    );

  return (
    <div
      className="vs-mix-backdrop"
      style={overlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={modalStyle} role="dialog" aria-label={t('trackingMix.title')}>
        <div style={headerStyle}>
          <h2 style={titleStyle}>
            {t('trackingMix.title')} — {node.name}
            <HelpButton
              topic="avatar"
              anchor="tracking-mix"
              tip={t('help.trackingMix')}
            />
          </h2>
          <button
            className="vs-mix-close"
            style={closeBtnStyle}
            onClick={onClose}
            aria-label={t('trackingMix.close')}
          >
            ×
          </button>
        </div>

        <div style={tabBarStyle}>
          {(['body', 'face'] as Tab[]).map((k) => (
            <button
              key={k}
              className={`vs-mix-tab-${k}`}
              style={tabStyle(tab === k)}
              onClick={() => setTab(k)}
            >
              {t(`trackingMix.tab.${k}`)}
            </button>
          ))}
        </div>

        <div style={{ padding: '10px 16px', overflow: 'auto' }}>
          {tab === 'body' && tracking.some((s) => s.bones) && (
            <div style={{ marginBottom: 12 }}>
              <div style={subHeaderStyle}>
                {t('trackingMix.order')}
                <HelpButton
                  topic="avatar"
                  anchor="tracking-mix-order"
                  tip={t('help.trackingMixOrder')}
                  size={12}
                />
              </div>
              <div style={orderRowStyle}>
                <span style={orderChipStyle(true)}>
                  {t('trackingMix.animationBase')}
                </span>
                {tracking
                  .filter((s) => s.bones)
                  .map((s) => (
                    <span key={s.id} style={orderChipStyle(false)}>
                      <button
                        className="vs-mix-order-up"
                        style={smallBtnStyle}
                        title={t('trackingMix.moveEarlier')}
                        onClick={() => move(s.id, -1)}
                      >
                        ‹
                      </button>
                      {s.label}
                      <button
                        className="vs-mix-order-down"
                        style={smallBtnStyle}
                        title={t('trackingMix.moveLater')}
                        onClick={() => move(s.id, 1)}
                      >
                        ›
                      </button>
                    </span>
                  ))}
              </div>
            </div>
          )}

          {columns.length === 0 ? (
            <div style={hintStyle}>
              {t(
                tab === 'body'
                  ? 'trackingMix.noBodySources'
                  : 'trackingMix.noFaceSources'
              )}
            </div>
          ) : groups.length === 0 ? (
            <div style={hintStyle}>{t('trackingMix.noShapes')}</div>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle} />
                  {columns.map((s) => (
                    <th key={s.id} style={thStyle} title={s.label}>
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const key = `${tab}:${g.key}`;
                  const isOpen = !!expanded[key];
                  return [
                    <tr key={key}>
                      <td style={groupLabelStyle}>
                        <button
                          className="vs-mix-expand"
                          style={expandBtnStyle}
                          onClick={() => toggle(key)}
                          aria-expanded={isOpen}
                        >
                          {isOpen ? '▾' : '▸'} {g.label}
                          <span style={{ color: '#555', marginLeft: 4 }}>
                            ({g.members.length})
                          </span>
                        </button>
                      </td>
                      {columns.map((s) => (
                        <td key={s.id} style={tdStyle}>
                          <GroupCell
                            values={g.members.map((m) => weightOf(s.id, m))}
                            onSet={(v, p) => setMembers(s.id, g.members, v, p)}
                          />
                        </td>
                      ))}
                    </tr>,
                    ...(isOpen
                      ? g.members.map((m) => (
                          <tr key={`${key}:${m}`}>
                            <td style={memberLabelStyle} title={m}>
                              {m}
                            </td>
                            {columns.map((s) => (
                              <td key={s.id} style={tdStyle}>
                                <SliderInput
                                  className="vs-mix-member-cell"
                                  value={weightOf(s.id, m)}
                                  min={MIX_WEIGHT_MIN}
                                  max={MIX_WEIGHT_MAX}
                                  step={0.05}
                                  precision={2}
                                  onChange={(v) =>
                                    setMembers(s.id, [m], v, false)
                                  }
                                  onCommit={(v) =>
                                    setMembers(s.id, [m], v, true)
                                  }
                                />
                              </td>
                            ))}
                          </tr>
                        ))
                      : []),
                  ];
                })}
              </tbody>
            </table>
          )}
          <div style={{ ...hintStyle, marginTop: 10 }}>
            {t(
              tab === 'body' ? 'trackingMix.bodyHint' : 'trackingMix.faceHint'
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 8,
  marginTop: 16,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};
const hintStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#555',
  lineHeight: 1.4,
  marginBottom: 6,
};
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginBottom: 4,
};
const sourceLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#999',
  width: 96,
  flexShrink: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const customCellStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 4,
  height: 22,
  padding: '0 4px',
  border: '1px dashed #4a4030',
  borderRadius: 4,
  minWidth: 0,
};
const smallBtnStyle: React.CSSProperties = {
  background: 'transparent',
  color: '#aaa',
  border: '1px solid #3a3a3a',
  borderRadius: 3,
  fontSize: 11,
  lineHeight: 1,
  padding: '1px 5px',
  cursor: 'pointer',
};
const openBtnStyle: React.CSSProperties = {
  marginTop: 4,
  background: '#252525',
  color: '#ccc',
  border: '1px solid #3a3a3a',
  borderRadius: 4,
  fontSize: 11,
  padding: '3px 10px',
  cursor: 'pointer',
};
const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  zIndex: 1000,
  paddingTop: 48,
};
const modalStyle: React.CSSProperties = {
  background: '#181818',
  border: '1px solid #2a2a2a',
  borderRadius: 8,
  width: '94%',
  maxWidth: 1000,
  maxHeight: '84vh',
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'system-ui, sans-serif',
};
const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 16px',
  borderBottom: '1px solid #2a2a2a',
};
const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 16,
  color: '#fff',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};
const closeBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#777',
  cursor: 'pointer',
  fontSize: 20,
  padding: 0,
  lineHeight: 1,
};
const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  gap: 2,
  padding: '0 16px',
  borderBottom: '1px solid #2a2a2a',
};
const tabStyle = (active: boolean): React.CSSProperties => ({
  background: 'transparent',
  border: 'none',
  borderBottom: `2px solid ${active ? '#6a9eff' : 'transparent'}`,
  color: active ? '#eee' : '#888',
  fontSize: 12,
  padding: '8px 12px',
  cursor: 'pointer',
});
const subHeaderStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#888',
  marginBottom: 6,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};
const orderRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
};
const orderChipStyle = (fixed: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  color: fixed ? '#777' : '#ccc',
  background: fixed ? 'transparent' : '#222',
  border: `1px ${fixed ? 'dashed' : 'solid'} #3a3a3a`,
  borderRadius: 4,
  padding: '2px 6px',
});
const tableStyle: React.CSSProperties = {
  borderCollapse: 'collapse',
  width: '100%',
  tableLayout: 'fixed',
};
const thStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#999',
  fontWeight: 600,
  textAlign: 'left',
  padding: '4px 6px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const tdStyle: React.CSSProperties = { padding: '2px 6px', minWidth: 110 };
const groupLabelStyle: React.CSSProperties = {
  padding: '2px 6px',
  width: 170,
};
const memberLabelStyle: React.CSSProperties = {
  padding: '2px 6px 2px 24px',
  fontSize: 11,
  color: '#888',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const expandBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#ccc',
  fontSize: 12,
  cursor: 'pointer',
  padding: 0,
  textAlign: 'left',
};
