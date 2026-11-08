/**
 * The Settings section of a composite root's properties: one control per
 * setting of its type, read from and written straight into the parts (live
 * link, see @vspark/shared/composites). A setting whose part is gone shows as
 * unavailable. Every change is one undo step.
 */
import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useCollection, useMeshDoc, useMeshSubtree } from '@vspark/mesh-react';
import {
  readSetting,
  settingVisible,
  writeSetting,
  type CompositeRootRtype,
  type CompositeSetting,
} from '@vspark/shared/composites';
import { useEditorStore } from '../../../store/editorStore';
import { HelpButton } from '../../../help/HelpButton';
import { DraftNumber, DraftText } from '../actions/draftInputs';
import { inputStyle } from '../actions/styles';
import {
  commitSettingWrites,
  compositeOf,
  compositeView,
  dissolveComposite,
  owningCompositeId,
} from './compositeModel';

const sectionHeader: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  margin: '14px 0 6px',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};
const groupHeader: CSSProperties = {
  fontSize: 10,
  color: '#666',
  margin: '10px 0 4px',
};
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginBottom: 6,
  fontSize: 11,
  color: '#bbb',
};
const labelCol: CSSProperties = { minWidth: 84, color: '#999' };

/** Re-render whenever anything under the composite changes: its parts are
 *  its child entities and their owned graphs and clips. */
function useCompositeVersion(rtype: CompositeRootRtype, rootId: string) {
  const own = useMeshDoc(useCollection<Record<string, unknown>>(rtype), rootId);
  const a = useMeshSubtree(useCollection('compose_layer'), rootId);
  const b = useMeshSubtree(useCollection('scene_node'), rootId);
  const c = useMeshSubtree(useCollection('logic'), rootId);
  const d = useMeshSubtree(useCollection('track_clip'), rootId);
  return [own, a, b, c, d];
}

export function CompositeSettings({
  rtype,
  rootId,
}: {
  rtype: CompositeRootRtype;
  rootId: string;
}) {
  const { t } = useTranslation('composites');
  const [root] = useCompositeVersion(rtype, rootId);
  const found = compositeOf(rtype, root);
  if (!found) return null;
  const { marker, def } = found;
  const view = compositeView(rtype, rootId, marker);

  const shown = def.settings.filter((s) => settingVisible(view, def, s));
  const groups: { group: string; settings: CompositeSetting[] }[] = [];
  for (const s of shown) {
    const g = groups.find((x) => x.group === s.group);
    if (g) g.settings.push(s);
    else groups.push({ group: s.group, settings: [s] });
  }

  return (
    <div className="vs-composite-settings">
      <div style={sectionHeader}>
        {t('section')}
        <span style={{ color: '#666', fontWeight: 400, textTransform: 'none' }}>
          · {t(`type.${def.type}`)}
        </span>
        <HelpButton
          topic="composites"
          anchor="settings"
          tip={t('help.settings')}
          size={11}
        />
      </div>
      {groups.map(({ group, settings }) => (
        <div key={group}>
          <div style={groupHeader}>{t(`group.${group}`)}</div>
          {settings.map((s) => (
            <SettingRow
              key={s.key}
              setting={s}
              value={readSetting(view, def, s)}
              onValue={(v) =>
                commitSettingWrites(writeSetting(view, def, s, v))
              }
            />
          ))}
        </div>
      ))}
      <div style={{ ...rowStyle, marginTop: 12 }}>
        <button
          type="button"
          className="vs-composite-dissolve"
          onClick={() => dissolveComposite(rtype, rootId)}
          title={t('dissolveTip')}
          style={{
            ...inputStyle,
            cursor: 'pointer',
            padding: '3px 10px',
          }}
        >
          {t('dissolve')}
        </button>
        <HelpButton
          topic="composites"
          anchor="dissolve"
          tip={t('help.dissolve')}
          size={11}
        />
      </div>
    </div>
  );
}

function SettingRow({
  setting: s,
  value,
  onValue,
}: {
  setting: CompositeSetting;
  value: unknown;
  onValue: (v: unknown) => void;
}) {
  const { t } = useTranslation('composites');
  return (
    <div style={rowStyle}>
      <span style={labelCol}>{t(`setting.${s.key}`)}</span>
      {value === undefined ? (
        <span style={{ color: '#666', fontStyle: 'italic' }}>
          {t('unavailable')}
        </span>
      ) : (
        <SettingControl
          setting={s}
          value={value}
          onValue={onValue}
          keyClass={`vs-composite-setting-${s.key}`}
        />
      )}
    </div>
  );
}

function SettingControl({
  setting: s,
  value,
  onValue: onChange,
  keyClass,
}: {
  setting: CompositeSetting;
  value: unknown;
  onValue: (v: unknown) => void;
  /** `vs-composite-setting-<key>`: which setting, next to the shared
   *  `vs-composite-setting` handle every control carries. */
  keyClass: string;
}) {
  const { t } = useTranslation('composites');
  const assets = useEditorStore((st) => st.assets);
  const accounts = useEditorStore((st) => st.overliveAccounts);
  const str = typeof value === 'string' ? value : '';

  switch (s.control) {
    case 'text':
      return (
        <DraftText
          className={`vs-composite-setting ${keyClass}`}
          value={str}
          onCommit={onChange}
        />
      );
    case 'number':
      return (
        <DraftNumber
          className={`vs-composite-setting ${keyClass}`}
          value={typeof value === 'number' ? value : 0}
          min={s.min}
          step={s.step}
          onCommit={onChange}
        />
      );
    case 'slider':
      return (
        <CompositeSlider
          setting={s}
          value={typeof value === 'number' ? value : (s.min ?? 0)}
          onValue={onChange}
          keyClass={keyClass}
        />
      );
    case 'select':
      return (
        <select
          className={`vs-composite-setting ${keyClass}`}
          value={str}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...inputStyle, flex: 1 }}
        >
          {(s.options ?? []).map((o) => (
            <option key={o} value={o}>
              {t(`option.${s.key}.${o === '' ? 'any' : o}`)}
            </option>
          ))}
        </select>
      );
    case 'color':
      return (
        <>
          {/^#[0-9a-f]{6}$/i.test(str) && (
            <input
              type="color"
              className={`vs-composite-setting ${keyClass}`}
              value={str}
              onChange={(e) => onChange(e.target.value)}
              style={{ width: 28, height: 20, padding: 0, border: 'none' }}
            />
          )}
          <DraftText
            className={`vs-composite-setting ${keyClass}`}
            value={str}
            onCommit={onChange}
          />
        </>
      );
    case 'asset': {
      const fits = assets.filter((a) =>
        s.assetKind === 'image'
          ? a.kind === 'image'
          : a.mimeType.startsWith(`${s.assetKind}/`)
      );
      return (
        <select
          className={`vs-composite-setting ${keyClass}`}
          value={str}
          onChange={(e) => onChange(e.target.value || null)}
          style={{ ...inputStyle, flex: 1, minWidth: 0 }}
        >
          <option value="">{t('noAsset')}</option>
          {fits.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      );
    }
    case 'account': {
      const known = !str || accounts.some((a) => a.id === str);
      return (
        <select
          className={`vs-composite-setting ${keyClass}`}
          value={str}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...inputStyle, flex: 1, minWidth: 0 }}
        >
          <option value="">{t('defaultAccount')}</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
          {!known && <option value={str}>{t('missingAccount')}</option>}
        </select>
      );
    }
  }
}

/** A range input committing once per gesture (pointer up / key up / blur),
 *  so dragging is one undo step. */
function CompositeSlider({
  setting: s,
  value,
  onValue,
  keyClass,
}: {
  setting: CompositeSetting;
  value: number;
  onValue: (v: number) => void;
  keyClass: string;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const commit = () => {
    if (draft !== null && draft !== value) onValue(draft);
    setDraft(null);
  };
  const min = s.min ?? 0;
  const max = s.max ?? 1;
  return (
    <>
      <input
        type="range"
        className={`vs-composite-setting ${keyClass}`}
        min={min}
        max={max}
        step={s.step ?? (max - min) / 100}
        value={shown}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        style={{ flex: 1 }}
      />
      <span style={{ minWidth: 38, fontVariantNumeric: 'tabular-nums' }}>
        {s.percent ? `${Math.round(shown * 100)} %` : shown}
      </span>
    </>
  );
}

/** On a part's properties: which composite it belongs to, and that it stays
 *  where it is until that composite is dissolved. */
export function CompositePartNote({
  rtype,
  id,
}: {
  rtype: CompositeRootRtype;
  id: string;
}) {
  const { t } = useTranslation('composites');
  // Re-evaluate when the entity (its parent) changes.
  useMeshDoc(useCollection<Record<string, unknown>>(rtype), id);
  const ownerId = owningCompositeId(rtype, id);
  const owner = useMeshDoc(
    useCollection<Record<string, unknown>>(rtype),
    ownerId ?? ''
  );
  if (!ownerId || !owner) return null;
  return (
    <div
      style={{
        fontSize: 11,
        color: '#9ab',
        background: '#1c2630',
        border: '1px solid #2a3a4a',
        borderRadius: 4,
        padding: '6px 8px',
        margin: '0 0 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <span style={{ flex: 1 }}>
        {t('partNote', { name: String(owner.name ?? '') })}
      </span>
      <HelpButton
        topic="composites"
        anchor="parts"
        tip={t('help.parts')}
        size={11}
      />
    </div>
  );
}
