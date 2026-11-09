/**
 * Records a keyboard shortcut: click, then press the keys (Escape cancels).
 * The combo is stored by key name as the backend's global keyboard hook
 * reports it (see keymap.ts).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  comboFromKeyboardEvent,
  formatCombo,
  type HotkeyCombo,
} from './keymap';
import { inputStyle } from './styles';

export function ShortcutRecorder({
  combo,
  onChange,
  className,
}: {
  combo: HotkeyCombo;
  onChange: (c: HotkeyCombo) => void;
  /** The `vs-` handle. */
  className: string;
}) {
  const { t } = useTranslation('actions');
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
    ? t('shortcut.recording')
    : combo.key
      ? formatCombo(combo)
      : t('shortcut.set');

  return (
    <button
      className={className}
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
      title={t('shortcut.set')}
    >
      {label}
    </button>
  );
}
