/**
 * Small pill toggle switch — a styled replacement for `<input type="checkbox">`
 * in the property inspectors. Same logical interface (`checked` + `onChange`),
 * but renders an on/off switch with a sliding knob.
 */
interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  title?: string;
  'aria-label'?: string;
  /** Extra wrapper styles, e.g. `marginLeft: 'auto'` to right-align in a row. */
  style?: React.CSSProperties;
}

export function Toggle({
  checked,
  onChange,
  disabled,
  title,
  'aria-label': ariaLabel,
  style,
}: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
      style={{
        position: 'relative',
        width: 32,
        height: 18,
        flexShrink: 0,
        borderRadius: 9,
        border: 'none',
        padding: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: checked ? '#2563eb' : '#3a3a3a',
        transition: 'background 120ms',
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 16 : 2,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,0.4)',
          transition: 'left 120ms',
        }}
      />
    </button>
  );
}
