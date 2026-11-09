/**
 * The editor for one response field (see responseFields.ts): a picker for the
 * entity it references (clip, node, layer, asset, expression, property), a
 * number, slider, checkbox, option list or text.
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { listAllParamPaths } from '@vspark/shared/paramPaths';
import { useEditorStore } from '../../../store/editorStore';
import { useSceneNodes } from '../../../mesh/nodes';
import { useComposeLayers } from '../../../mesh/compose';
import { useTrackClips } from '../../../mesh/hooks';
import type { ResponseField, ResponseFieldValue } from './responseFields';
import { inputStyle } from './styles';

export function FieldEditor({
  field,
  value,
  values,
  onChange,
  className,
}: {
  field: ResponseField;
  value: ResponseFieldValue;
  values: Record<string, ResponseFieldValue>;
  onChange: (v: ResponseFieldValue) => void;
  /** The `vs-` handle; the control also gets `<className>-<field key>`. */
  className: string;
}) {
  const { t } = useTranslation('actions');
  const nodes = useSceneNodes();
  const composeLayers = useComposeLayers();
  const trackClips = useTrackClips();
  const expressionsByNode = useEditorStore((s) => s.vrmExpressionsByNode);
  const assets = useEditorStore((s) => s.assets);
  const cls = `${className} ${className}-${field.key}`;
  const cur = value === undefined ? '' : String(value);

  const wrap = (el: ReactNode) => (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 10,
        color: '#888',
      }}
    >
      <span style={{ minWidth: 52 }}>{t(field.labelKey)}</span>
      {el}
    </label>
  );

  if (field.control === 'bool') {
    return wrap(
      <input
        type="checkbox"
        className={cls}
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (field.control === 'number') {
    return wrap(
      <input
        type="number"
        className={cls}
        value={cur}
        min={field.min}
        max={field.max}
        step={field.step}
        onChange={(e) =>
          onChange(e.target.value === '' ? undefined : Number(e.target.value))
        }
        style={{ ...inputStyle, width: 70 }}
      />
    );
  }
  if (field.control === 'slider') {
    return wrap(
      <SliderField
        field={field}
        value={value}
        onChange={onChange}
        className={cls}
      />
    );
  }
  if (field.control === 'enum') {
    return wrap(
      <select
        className={cls}
        value={cur}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle }}
      >
        <option value="">—</option>
        {(field.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.labelKey ? t(o.labelKey) : o.value}
          </option>
        ))}
      </select>
    );
  }

  // Reference pickers.
  let options: { value: string; label: string }[] | null = null;
  if (field.control === 'clip') {
    options = trackClips.map((c) => ({ value: c.id, label: c.name || c.id }));
  } else if (field.control === 'sceneNode') {
    options = nodes
      .filter((n) => n.kind !== 'scene')
      .map((n) => ({ value: n.id, label: n.name || n.id }));
  } else if (field.control === 'composeLayer') {
    options = composeLayers.map((l) => ({
      value: l.id,
      label: l.name || l.id,
    }));
  } else if (field.control === 'sceneEntity') {
    options = [
      ...nodes
        .filter((n) => n.kind !== 'scene')
        .map((n) => ({ value: n.id, label: n.name || n.id })),
      ...composeLayers.map((l) => ({ value: l.id, label: l.name || l.id })),
    ];
  } else if (field.control === 'videoEntity') {
    options = [
      ...nodes
        .filter((n) => n.kind === 'video')
        .map((n) => ({ value: n.id, label: n.name || n.id })),
      ...composeLayers
        .filter((l) => l.kind === 'video')
        .map((l) => ({ value: l.id, label: l.name || l.id })),
    ];
  } else if (field.control === 'asset') {
    options = assets
      .filter((a) => !field.assetKind || a.kind === field.assetKind)
      .map((a) => ({ value: a.id, label: a.name || a.id }));
  } else if (field.control === 'expression') {
    const nodeId = typeof values.nodeId === 'string' ? values.nodeId : '';
    options = (expressionsByNode[nodeId] ?? []).map((name) => ({
      value: name,
      label: name,
    }));
  } else if (field.control === 'paramPath') {
    options = listAllParamPaths(field.paramTargetKind ?? 'scene_node').map(
      (p) => ({
        value: p.path,
        label: p.path,
      })
    );
  }

  if (options) {
    return wrap(
      <select
        className={cls}
        value={cur}
        onChange={(e) => onChange(e.target.value || undefined)}
        style={{ ...inputStyle, maxWidth: 150 }}
      >
        <option value="">{t('field.choose')}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  // string fallback
  return wrap(
    <input
      type="text"
      className={cls}
      value={cur}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, width: 130 }}
    />
  );
}

/** A range slider with its value beside it. The value is committed when the
 *  drag (or key press) ends, not on every step, so a drag is one edit. */
function SliderField({
  field,
  value,
  onChange,
  className,
}: {
  field: ResponseField;
  value: ResponseFieldValue;
  onChange: (v: ResponseFieldValue) => void;
  className: string;
}) {
  const min = field.min ?? 0;
  const max = field.max ?? 1;
  const saved = typeof value === 'number' ? value : (field.defaultValue ?? min);
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? saved;
  const commit = () => {
    if (draft !== null && draft !== saved) onChange(draft);
    setDraft(null);
  };
  return (
    <>
      <input
        type="range"
        className={className}
        min={min}
        max={max}
        step={field.step ?? (max - min) / 100}
        value={shown}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        style={{ width: 100 }}
      />
      <span
        style={{
          minWidth: 34,
          fontVariantNumeric: 'tabular-nums',
          color: '#bbb',
        }}
      >
        {field.percent ? `${Math.round(shown * 100)} %` : shown}
      </span>
    </>
  );
}
