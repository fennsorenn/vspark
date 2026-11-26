/**
 * Input primitives of the Actions settings forms. Text and number fields keep
 * a local draft and commit on blur / Enter, so typing a reply is one write
 * (one undo step), not one per keystroke. Each takes the caller's `vs-` handle
 * as `className`; the control enumerator (`e2e/scripts/controls.mjs`
 * COMPONENTS) counts their call sites, and this file is excluded from the
 * coverage denominator like `numericInputs.tsx`.
 */
import { useEffect, useId, useState } from 'react';
import { inputStyle, labelStyle } from './styles';

/** A suggestion: a value, optionally shown with a label. */
export type Suggestion = string | { value: string; label: string };

/** Text input committing on blur / Enter. With `suggestions`, offers them as
 *  you type (a `<datalist>`) — any other text is still taken. */
export function DraftText({
  className,
  value,
  onCommit,
  placeholder,
  width,
  suggestions,
}: {
  className: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  width?: number | string;
  suggestions?: Suggestion[];
}) {
  const listId = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  const input = (
    <input
      type="text"
      className={className}
      value={draft}
      placeholder={placeholder}
      list={suggestions ? listId : undefined}
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
  if (!suggestions) return input;
  return (
    <>
      {input}
      <SuggestionList id={listId} suggestions={suggestions} />
    </>
  );
}

/** The `<datalist>` behind a suggesting input. */
export function SuggestionList({
  id,
  suggestions,
}: {
  id: string;
  suggestions: Suggestion[];
}) {
  return (
    <datalist id={id}>
      {suggestions.map((s) =>
        typeof s === 'string' ? (
          <option key={s} value={s} />
        ) : (
          <option key={s.value} value={s.value} label={s.label} />
        )
      )}
    </datalist>
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
