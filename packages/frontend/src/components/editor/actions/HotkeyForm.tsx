/**
 * Settings form of the Hotkey action kind: shortcut (value), mode and number
 * of cycle positions (shape), and per position a response — its type is a
 * shape setting, its fields are values.
 */
import { useTranslation } from 'react-i18next';
import {
  HOTKEY_MODES,
  MAX_CYCLE_POSITIONS,
  MIN_CYCLE_POSITIONS,
  hotkeyPositionCount,
} from '@vspark/shared/actions';
import type { ActionRecord } from '../../../mesh/actions';
import { ShortcutRecorder } from './ShortcutRecorder';
import { EMPTY_COMBO, type HotkeyCombo } from './keymap';
import { HelpButton } from '../../../help/HelpButton';
import { inputStyle, labelStyle } from './styles';
import { ResponseEditor, isObj } from './fields';

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
      {Array.from({ length: n }, (_, i) => (
        <ResponseEditor
          key={i}
          label={n > 1 ? t('form.position', { n: i + 1 }) : t('form.response')}
          path={`responses.${i}`}
          slot={responses[String(i)]}
          onSetting={onSetting}
        />
      ))}
    </div>
  );
}
