/**
 * Input primitives of the Actions settings forms. Text and number fields keep
 * a local draft and commit on blur / Enter, so typing a reply is one write
 * (one undo step), not one per keystroke. Each takes the caller's `vs-` handle
 * as `className`; the control enumerator (`e2e/scripts/controls.mjs`
 * COMPONENTS) counts their call sites, and this file is excluded from the
 * coverage denominator like `numericInputs.tsx`.
 */
import { useEffect, useState } from 'react';
import { inputStyle, labelStyle } from './styles';

/** Text input committing on blur / Enter. */
export function DraftText({
  className,
  value,
  onCommit,
  placeholder,
  width,
}: {
  className: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  width?: number | string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      type="text"
      className={className}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(value);
      }}
      style={{
        ...inputStyle,
        flex: width === undefined ? 1 : undefined,
        width,
      }}
    />
  );
}

/** Number input committing on blur / Enter; an empty or invalid entry
 *  reverts. */
export function DraftNumber({
  className,
  value,
  onCommit,
  min,
  step,
}: {
  className: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  step?: number;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(n)) setDraft(String(value));
    else if (n !== value) onCommit(n);
  };
  return (
    <input
      type="number"
      className={className}
      value={draft}
      min={min}
      step={step}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      style={{ ...inputStyle, width: 64 }}
    />
  );
}

export function SettingCheck({
  className,
  checked,
  onChange,
  label,
}: {
  className: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label style={{ ...labelStyle, cursor: 'pointer' }}>
      <input
        type="checkbox"
        className={className}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
