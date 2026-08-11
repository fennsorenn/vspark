/**
 * Macros panel — a friendly "When I press [shortcut] → [do action]" list that is
 * a live projection over system_hotkey→action logic graphs (see useMacros +
 * projection). Left-dock tab. Single-action macros are fully editable here;
 * toggle/cycle and unrecognised ("custom") shapes show read-only with an
 * "Open in graph" escape hatch to the full signal-graph editor.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import {
  getParamPathSpec,
  listAllParamPaths,
} from '@vspark/shared/paramPaths';
import { useEditorStore } from '../../../store/editorStore';
import { HelpButton } from '../../../help/HelpButton';
import { useMacros } from './useMacros';
import { MACRO_ACTION_DEFS, macroActionById } from './actionRegistry';
import { comboFromKeyboardEvent, formatCombo } from './keymap';
import type {
  HotkeyCombo,
  MacroActionInstance,
  MacroField,
  MacroFieldValue,
  MacroRow,
} from './types';

const EMPTY_COMBO: HotkeyCombo = {
  key: '',
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
};

const inputStyle: React.CSSProperties = {
  background: '#0e0e1a',
  border: '1px solid #333',
  color: '#ccc',
  borderRadius: 3,
  padding: '3px 6px',
  fontSize: 11,
  outline: 'none',
  minWidth: 0,
};

// ── Shortcut recorder ─────────────────────────────────────────────────────────

function ShortcutRecorder({
  combo,
  onChange,
}: {
  combo: HotkeyCombo;
  onChange: (c: HotkeyCombo) => void;
}) {
  const { t } = useTranslation('macros');
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(false);
        return;
      }
      const next = comboFromKeyboardEvent(e);
      if (next) {
        onChange(next);
        setRecording(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, onChange]);

  const label = recording
    ? t('recording')
    : combo.key
      ? formatCombo(combo)
      : t('setShortcut');

  return (
    <button
      className="vs-macro-shortcut"
      onClick={() => setRecording((r) => !r)}
      style={{
        ...inputStyle,
        cursor: 'pointer',
        minWidth: 120,
        textAlign: 'left',
        borderColor: recording ? '#4a90d9' : '#333',
        color: combo.key || recording ? '#ddd' : '#777',
        fontFamily: 'monospace',
      }}
      title={t('setShortcut')}
    >
      {label}
    </button>
  );
}

// ── Field editors ─────────────────────────────────────────────────────────────

function FieldEditor({
  field,
  value,
  values,
  onChange,
}: {
  field: MacroField;
  value: MacroFieldValue;
  values: Record<string, MacroFieldValue>;
  onChange: (v: MacroFieldValue) => void;
}) {
  const { t } = useTranslation('macros');
  const nodes = useEditorStore((s) => s.nodes);
  const composeLayers = useEditorStore((s) => s.composeLayers);
  const trackClips = useEditorStore((s) => s.trackClips);
  const expressionsByNode = useEditorStore((s) => s.vrmExpressionsByNode);
  const cls = `vs-macro-field-${field.key}`;
  const cur = value === undefined ? '' : String(value);

  const wrap = (el: React.ReactNode) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#888' }}>
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
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        style={{ ...inputStyle, width: 70 }}
      />
    );
  }
  if (field.control === 'enum') {
    return wrap(
      <select className={cls} value={cur} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle }}>
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
    options = composeLayers.map((l) => ({ value: l.id, label: l.name || l.id }));
  } else if (field.control === 'sceneEntity') {
    options = [
      ...nodes.filter((n) => n.kind !== 'scene').map((n) => ({ value: n.id, label: n.name || n.id })),
      ...composeLayers.map((l) => ({ value: l.id, label: l.name || l.id })),
    ];
  } else if (field.control === 'expression') {
    const nodeId = typeof values.nodeId === 'string' ? values.nodeId : '';
    options = (expressionsByNode[nodeId] ?? []).map((name) => ({ value: name, label: name }));
  } else if (field.control === 'paramPath') {
    options = listAllParamPaths(field.paramTargetKind ?? 'scene_node').map((p) => ({
      value: p.path,
      label: p.path,
    }));
  }

  if (options) {
    return wrap(
      <select className={cls} value={cur} onChange={(e) => onChange(e.target.value || undefined)} style={{ ...inputStyle, maxWidth: 150 }}>
        <option value="">{t('choose')}</option>
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

/** For set-property actions, derive the value field's control from the chosen
 *  paramPath's type (so "visible" is a checkbox, "opacity" a number, etc.). */
function effectiveFields(instance: MacroActionInstance): MacroField[] {
  const def = macroActionById(instance.defId);
  if (!def) return [];
  const valueField = def.fields.find((f) => f.key === 'value' && f.control === 'string' && f.port === 'value');
  const pathField = def.fields.find((f) => f.control === 'paramPath');
  if (!valueField || !pathField) return def.fields;
  const path = typeof instance.values.paramPath === 'string' ? instance.values.paramPath : '';
  const spec = path ? getParamPathSpec(pathField.paramTargetKind ?? 'scene_node', path) : undefined;
  const valueControl = spec?.type === 'Bool' ? 'bool' : spec?.type === 'Float' ? 'number' : 'string';
  return def.fields.map((f) => (f.key === 'value' ? { ...f, control: valueControl } : f));
}

function ActionEditor({
  instance,
  onChange,
}: {
  instance: MacroActionInstance;
  onChange: (next: MacroActionInstance) => void;
}) {
  const { t } = useTranslation('macros');
  const setValue = (key: string, v: MacroFieldValue) =>
    onChange({ ...instance, values: { ...instance.values, [key]: v } });

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <select
        className="vs-macro-action-select"
        value={instance.defId}
        onChange={(e) => onChange({ defId: e.target.value, values: {} })}
        style={{ ...inputStyle }}
      >
        {MACRO_ACTION_DEFS.map((d) => (
          <option key={d.id} value={d.id}>
            {t(d.labelKey)}
          </option>
        ))}
      </select>
      {effectiveFields(instance).map((f) => (
        <FieldEditor
          key={f.key}
          field={f}
          value={instance.values[f.key]}
          values={instance.values}
          onChange={(v) => setValue(f.key, v)}
        />
      ))}
    </div>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

function MacroRowView({
  row,
  macros,
}: {
  row: MacroRow;
  macros: ReturnType<typeof useMacros>;
}) {
  const { t } = useTranslation('macros');
  const setActiveLogic = useEditorStore((s) => s.setActiveLogic);
  const setLeftTab = useEditorStore((s) => s.setLeftTab);
  const openInGraph = () => {
    setActiveLogic(row.logicId);
    setLeftTab('graphs');
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 8,
        borderRadius: 5,
        background: '#141420',
        border: '1px solid #262636',
        opacity: row.enabled ? 1 : 0.55,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, color: '#666' }}>{t('when')}</span>
        <ShortcutRecorder combo={row.shortcut} onChange={(c) => void macros.setShortcut(row, c)} />
        <span style={{ fontSize: 10, color: '#666', margin: '0 2px' }}>→</span>
        <div style={{ flex: 1 }} />
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: '#888', cursor: 'pointer' }}
          title={t('enabledLabel')}
        >
          <input
            type="checkbox"
            className="vs-macro-enable"
            checked={row.enabled}
            onChange={(e) => void macros.setEnabled(row, e.target.checked)}
          />
          {t('on')}
        </label>
        <button
          className="vs-macro-delete"
          onClick={() => void macros.removeRow(row)}
          title={t('delete')}
          style={{ ...inputStyle, cursor: 'pointer', color: '#c66', padding: '2px 6px' }}
        >
          ✕
        </button>
      </div>

      {(row.kind === 'single' || row.kind === 'empty') && (
        <ActionEditor
          instance={row.action ?? { defId: MACRO_ACTION_DEFS[0].id, values: {} }}
          onChange={(next) => void macros.setAction(row, next)}
        />
      )}
      {row.kind === 'cycle' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#aa9' }}>
          <span>{t('toggleStates', { count: row.states?.length ?? 0 })}</span>
          <button className="vs-macro-open-graph" onClick={openInGraph} style={{ ...inputStyle, cursor: 'pointer' }}>
            {t('openInGraph')}
          </button>
        </div>
      )}
      {row.kind === 'opaque' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#aa9' }}>
          <span>{t('customActions')}</span>
          <button className="vs-macro-open-graph" onClick={openInGraph} style={{ ...inputStyle, cursor: 'pointer' }}>
            {t('openInGraph')}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function MacrosPanel() {
  const { t } = useTranslation('macros');
  const { projectId } = useParams<{ projectId: string }>();
  const macros = useMacros(projectId);
  const addingRef = useRef(false);

  const onAdd = async () => {
    if (addingRef.current) return;
    addingRef.current = true;
    try {
      await macros.addMacro(EMPTY_COMBO, null);
    } finally {
      addingRef.current = false;
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 10px',
          borderBottom: '1px solid #222',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#ccc' }}>{t('title')}</span>
          <HelpButton topic="logic" anchor="macros" size={12} />
        </div>
        <button
          className="vs-macro-add"
          onClick={() => void onAdd()}
          style={{ ...inputStyle, cursor: 'pointer', color: '#8ac' }}
        >
          + {t('add')}
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {macros.rows.length === 0 && !macros.loading && (
          <div style={{ fontSize: 11, color: '#555', padding: 12, textAlign: 'center' }}>{t('empty')}</div>
        )}
        {macros.rows.map((row) => (
          <MacroRowView key={`${row.logicId}:${row.hotkeyNodeId}`} row={row} macros={macros} />
        ))}
      </div>
    </div>
  );
}
