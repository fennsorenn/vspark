/**
 * Settings form of the Hotkey action kind: shortcut (value), mode and number
 * of cycle positions (shape), and per position a response — its type is a
 * shape setting, its fields are values. Reuses the Macros panel's shortcut
 * recorder and response field editors.
 */
import { useTranslation } from 'react-i18next';
import {
  HOTKEY_MODES,
  MAX_CYCLE_POSITIONS,
  MIN_CYCLE_POSITIONS,
  RESPONSE_TYPE_IDS,
  hotkeyPositionCount,
} from '@vspark/shared/actions';
import type { ActionRecord } from '../../../mesh/actions';
import {
  FieldEditor,
  ShortcutRecorder,
  effectiveFields,
} from '../macros/MacrosPanel';
import type { HotkeyCombo, MacroFieldValue } from '../macros/types';
import { HelpButton } from '../../../help/HelpButton';
import { inputStyle } from './styles';

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const labelStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 10,
  color: '#888',
} as const;

const EMPTY_COMBO: HotkeyCombo = {
  key: '',
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
};

export function HotkeyForm({
  action,
  onSetting,
}: {
  action: ActionRecord;
  onSetting: (path: string, value: unknown) => void;
}) {
  const { t } = useTranslation('actions');
  const s = action.settings;
  const combo = (isObj(s.shortcut) ? { ...EMPTY_COMBO, ...s.shortcut } : EMPTY_COMBO) as HotkeyCombo;
  const mode = typeof s.mode === 'string' ? s.mode : 'single';
  const n = hotkeyPositionCount(s);
  const responses = isObj(s.responses) ? s.responses : {};
  const positionOptions: number[] = [];
  for (let i = MIN_CYCLE_POSITIONS; i <= MAX_CYCLE_POSITIONS; i++) positionOptions.push(i);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={labelStyle}>
        <span style={{ minWidth: 52 }}>{t('form.shortcut')}</span>
        <ShortcutRecorder
          className="vs-action-shortcut"
          combo={combo}
          onChange={(c) => onSetting('shortcut', c)}
        />
      </label>
      <label style={labelStyle}>
        <span style={{ minWidth: 52 }}>{t('form.mode')}</span>
        <select
          className="vs-action-mode"
          value={mode}
          onChange={(e) => onSetting('mode', e.target.value)}
          style={inputStyle}
        >
          {HOTKEY_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`mode.${m}`)}
            </option>
          ))}
        </select>
        <HelpButton topic="actions" anchor="value-shape" tip={t('help.shape')} size={11} />
      </label>
      {mode === 'cycle' && (
        <label style={labelStyle}>
          <span style={{ minWidth: 52 }}>{t('form.positions')}</span>
          <select
            className="vs-action-positions"
            value={n}
            onChange={(e) => onSetting('positions', Number(e.target.value))}
            style={inputStyle}
          >
            {positionOptions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      )}
      {Array.from({ length: n }, (_, i) => {
        const slot = isObj(responses[String(i)]) ? (responses[String(i)] as Record<string, unknown>) : {};
        const type = typeof slot.type === 'string' ? slot.type : '';
        const values = slot as Record<string, MacroFieldValue>;
        return (
          <div
            key={i}
            className="vs-action-response"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              alignItems: 'center',
              padding: 6,
              borderRadius: 4,
              background: '#10101a',
            }}
          >
            <span style={{ fontSize: 10, color: '#888', minWidth: 52 }}>
              {n > 1 ? t('form.position', { n: i + 1 }) : t('form.response')}
            </span>
            <select
              className="vs-action-response-type"
              value={type}
              onChange={(e) => onSetting(`responses.${i}.type`, e.target.value)}
              style={inputStyle}
            >
              <option value="" disabled>
                {t('form.chooseResponse')}
              </option>
              {RESPONSE_TYPE_IDS.map((id) => (
                <option key={id} value={id}>
                  {t(`responses.${id}`)}
                </option>
              ))}
            </select>
            {type &&
              effectiveFields({ defId: type, values }).map((f) => (
                <FieldEditor
                  key={f.key}
                  field={f}
                  value={values[f.key]}
                  values={values}
                  className="vs-action-field"
                  onChange={(v) => onSetting(`responses.${i}.${f.key}`, v ?? null)}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}
