/**
 * Centralised numeric input primitives shared across scene-node and compose-layer
 * properties. Three building blocks:
 *
 *   NumInput     — one scalar; optional prefix label (e.g. "X"), suffix unit,
 *                  inline ◆ keyframe button, drag-to-scrub + wheel-to-scrub.
 *                  Fires `onChange` live (drag / typing) and `onCommit` on
 *                  blur / Enter / drag-release / wheel-idle.
 *
 *   VecInput     — variadic group of NumInputs sharing a row. Common case:
 *                  Vec3 transforms with X/Y/Z labels and a group keyframe button.
 *
 *   SliderInput  — range slider with the numeric value overlaid in the middle.
 *                  Frameless until focused; click the value to edit it directly.
 *                  Optional inline keyframe button.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { HelpButton } from '../../help/HelpButton';

/** Field-level help: a doc topic/anchor + an explanatory hover tooltip. */
export interface FieldHelp {
  topic: string;
  anchor?: string;
  tip: string;
}

// ── shared styles ─────────────────────────────────────────────────────────────

const COLORS = {
  inputBg: '#2a2a2a',
  inputBorder: '#3a3a3a',
  inputBorderFocus: '#5a8acc',
  text: '#e0e0e0',
  mutedText: '#888',
  faintText: '#555',
  kfBtn: '#1a3a5a',
  kfBtnFg: '#8af',
  kfBtnBorder: '#2a4a6a',
  sliderTrack: '#1e2530',
  sliderFill: '#2a4060',
} as const;

const baseInputStyle: CSSProperties = {
  background: COLORS.inputBg,
  border: `1px solid ${COLORS.inputBorder}`,
  color: COLORS.text,
  borderRadius: 4,
  fontSize: 12,
  outline: 'none',
  textAlign: 'right',
};

// Frameless keyframe icon. Visible inside / next to numeric inputs only when
// the bottom dock is on the Clips tab; we lean on contrast (color, not box)
// to save space.
const kfBtnStyle: CSSProperties = {
  background: 'transparent',
  color: COLORS.kfBtnFg,
  border: 'none',
  fontSize: 11,
  lineHeight: '1',
  padding: '0 3px',
  cursor: 'pointer',
  flexShrink: 0,
};

const kfGroupBtnStyle: CSSProperties = {
  background: 'transparent',
  color: COLORS.kfBtnFg,
  border: 'none',
  fontSize: 10,
  lineHeight: '1',
  padding: '0 4px',
  cursor: 'pointer',
  textTransform: 'none',
  letterSpacing: 'normal',
};

// ── NumInput ──────────────────────────────────────────────────────────────────

export interface NumInputProps {
  value: number;
  /** Fired on every change (typing, drag, wheel). Use for optimistic UI / live preview. */
  onChange?: (v: number) => void;
  /** Fired on blur, Enter, drag release, or after a wheel-idle debounce. Use for persistence. */
  onCommit?: (v: number) => void;
  /** Increment per drag pixel / wheel tick / spinner click. */
  step?: number;
  /** Inclusive lower bound; values typed/dragged below are clamped. */
  min?: number;
  /** Inclusive upper bound. */
  max?: number;
  /** Decimals shown in the input. Internal value retains full precision. */
  precision?: number;
  /** Short label rendered inside the box, to the left of the value (e.g. "X", "W"). */
  prefix?: string;
  /** Short text rendered inside the box, to the right of the value (e.g. "s", "px", "rad"). */
  suffix?: string;
  /** Show an inline ◆ keyframe button. If undefined, no button. */
  onSetKeyframe?: (value: number) => void | Promise<void>;
  /** Whether the keyframe button should render. Defaults to true when `onSetKeyframe` is provided. */
  canRecord?: boolean;
  /** Tooltip text. */
  title?: string;
  /** Outer wrapper width / styling. */
  style?: CSSProperties;
  disabled?: boolean;
}

const WHEEL_COMMIT_DEBOUNCE_MS = 250;

export function NumInput({
  value,
  onChange,
  onCommit,
  step = 0.01,
  min,
  max,
  precision,
  prefix,
  suffix,
  onSetKeyframe,
  canRecord,
  title,
  style,
  disabled,
}: NumInputProps) {
  const { t } = useTranslation('misc');
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState<string>(formatValue(value, precision));
  // Sync external value into the local text buffer when not actively editing.
  useEffect(() => {
    if (!focused) setText(formatValue(value, precision));
  }, [value, focused, precision]);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const onChangeRef = useRef(onChange);
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  // Refs for primitives that drag/wheel handlers need without stale closures.
  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);
  const minRef = useRef(min);
  useEffect(() => {
    minRef.current = min;
  }, [min]);
  const maxRef = useRef(max);
  useEffect(() => {
    maxRef.current = max;
  }, [max]);
  const precisionRef = useRef(precision);
  useEffect(() => {
    precisionRef.current = precision;
  }, [precision]);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  const wheelCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleWheelCommit = () => {
    if (wheelCommitTimer.current) clearTimeout(wheelCommitTimer.current);
    wheelCommitTimer.current = setTimeout(() => {
      onCommitRef.current?.(valueRef.current);
      wheelCommitTimer.current = null;
    }, WHEEL_COMMIT_DEBOUNCE_MS);
  };

  const clamp = (n: number): number => {
    const lo = minRef.current,
      hi = maxRef.current;
    if (lo !== undefined && n < lo) n = lo;
    if (hi !== undefined && n > hi) n = hi;
    return n;
  };

  const setValue = (v: number) => {
    const next = clamp(v);
    setText(formatValue(next, precisionRef.current));
    onChangeRef.current?.(next);
  };

  // Native non-passive wheel listener — React's synthetic onWheel is registered
  // passive by default, so preventDefault() inside it is ignored. Attach our own
  // so we can both scroll the value and stop the page from scrolling.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (disabledRef.current) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      const s = stepRef.current;
      setValue(parseFloat((valueRef.current + dir * s).toFixed(10)));
      scheduleWheelCommit();
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drag-to-scrub from the prefix label. The prefix preventDefaults so the input
  // never steals focus on prefix-down (so the drag feels like a knob, not a click).
  const startDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (disabled) return;
    if (e.button !== 0) return;
    e.preventDefault();
    runDrag(e.clientY, /*onCommitIfMoved=*/ true);
  };

  // Drag-to-scrub from the input itself. We do NOT preventDefault here — that
  // would block the browser from placing the caret on a plain click. Instead,
  // we only start adjusting the value once the pointer has moved more than a
  // small threshold; up to that point, the click reaches the input normally.
  const startDragFromInput = (e: React.PointerEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.button !== 0) return;
    runDrag(e.clientY, /*onCommitIfMoved=*/ true, /*movementThresholdPx=*/ 3);
  };

  const runDrag = (
    startY: number,
    commitIfMoved: boolean,
    movementThresholdPx: number = 0
  ) => {
    const startVal = valueRef.current;
    let moved = false;
    let exceededThreshold = movementThresholdPx <= 0;
    const onMove = (me: PointerEvent) => {
      const dy = startY - me.clientY;
      if (!exceededThreshold) {
        if (Math.abs(dy) < movementThresholdPx) return;
        exceededThreshold = true;
        // Suppress the pending caret placement / focus once we know it's a drag.
        document.body.style.cursor = 'ns-resize';
        if (document.activeElement instanceof HTMLElement) {
          // Don't pull focus away if the input is already focused (user dragging
          // an already-focused field); only blur if focus is unrelated.
        }
      }
      const delta = dy * stepRef.current;
      if (Math.abs(delta) > 0.0001) moved = true;
      setValue(parseFloat((startVal + delta).toFixed(10)));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      if (commitIfMoved && moved) onCommitRef.current?.(valueRef.current);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    if (movementThresholdPx <= 0) document.body.style.cursor = 'ns-resize';
  };

  const commit = () => {
    const parsed = parseFloat(text);
    if (Number.isFinite(parsed)) {
      const clamped = clamp(parsed);
      if (clamped !== valueRef.current) onChangeRef.current?.(clamped);
      onCommitRef.current?.(clamped);
      setText(formatValue(clamped, precision));
    } else {
      // Reset to current external value on bad input.
      setText(formatValue(value, precision));
    }
  };

  const showKfBtn = onSetKeyframe != null && (canRecord ?? true);

  return (
    <div
      ref={wrapperRef}
      style={{
        ...baseInputStyle,
        display: 'inline-flex',
        alignItems: 'center',
        padding: 0,
        cursor: disabled ? 'not-allowed' : 'ns-resize',
        borderColor: focused ? COLORS.inputBorderFocus : COLORS.inputBorder,
        opacity: disabled ? 0.5 : 1,
        // Lift the focused cell so its border isn't clipped by neighbouring
        // joined siblings (see VecInput's negative-margin trick).
        position: 'relative',
        zIndex: focused ? 1 : 0,
        ...style,
      }}
      title={title}
    >
      {prefix && (
        <span
          onPointerDown={startDrag}
          style={{
            color: COLORS.mutedText,
            fontSize: 10,
            fontWeight: 600,
            padding: '0 3px 0 4px',
            userSelect: 'none',
            cursor: 'ns-resize',
          }}
        >
          {prefix}
        </span>
      )}
      <input
        type="text"
        inputMode="decimal"
        disabled={disabled}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseFloat(e.target.value);
          if (Number.isFinite(parsed)) onChangeRef.current?.(clamp(parsed));
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setValue(parseFloat((valueRef.current + step).toFixed(10)));
            scheduleWheelCommit();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setValue(parseFloat((valueRef.current - step).toFixed(10)));
            scheduleWheelCommit();
          }
        }}
        onPointerDown={startDragFromInput}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: COLORS.text,
          fontSize: 12,
          textAlign: 'right',
          padding: '3px 4px',
          // The input has its own cursor when focused (caret); otherwise let the
          // wrapper drive ns-resize.
          cursor: focused ? 'text' : 'ns-resize',
        }}
      />
      {suffix && (
        <span
          style={{
            color: COLORS.faintText,
            fontSize: 10,
            padding: '0 4px 0 1px',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        >
          {suffix}
        </span>
      )}
      {showKfBtn && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void onSetKeyframe!(valueRef.current);
          }}
          title={t('numericInputs.setKeyframe')}
          style={kfBtnStyle}
        >
          ◆
        </button>
      )}
    </div>
  );
}

function formatValue(v: number, precision?: number): string {
  if (!Number.isFinite(v)) return '';
  if (precision != null) return v.toFixed(precision);
  // Trim trailing zeros / unnecessary decimals so the input stays readable.
  return String(parseFloat(v.toFixed(6)));
}

// ── VecInput ──────────────────────────────────────────────────────────────────

export interface VecInputProps {
  values: number[];
  labels?: readonly string[];
  /** Fired live for the axis the user is changing. */
  onChange?: (next: number[], axis: number) => void;
  /** Fired on commit (blur / Enter / drag release) for the axis. */
  onCommit?: (next: number[], axis: number) => void;
  step?: number | readonly number[];
  min?: number | readonly number[];
  max?: number | readonly number[];
  precision?: number | readonly number[];
  suffix?: string;
  /** Optional per-axis keyframe handler — renders an inline ◆ on each scalar. */
  onSetAxisKeyframe?: (axis: number, value: number) => void | Promise<void>;
  /** Optional group keyframe handler — renders a "◆ set group" button in the row header. */
  onSetGroupKeyframe?: (values: number[]) => void | Promise<void>;
  canRecord?: boolean;
  /** Title shown before the inputs (e.g. "Position"). When omitted, just renders the inputs. */
  groupLabel?: string;
  /** Row container style override. */
  style?: CSSProperties;
  /** Style applied to every NumInput. */
  inputStyle?: CSSProperties;
}

const ax = (
  arr: readonly number[] | number | undefined,
  i: number,
  fallback?: number
): number | undefined => {
  if (arr === undefined) return fallback;
  if (typeof arr === 'number') return arr;
  return arr[i] ?? fallback;
};

export function VecInput({
  values,
  labels,
  onChange,
  onCommit,
  step,
  min,
  max,
  precision,
  suffix,
  onSetAxisKeyframe,
  onSetGroupKeyframe,
  canRecord,
  groupLabel,
  style,
  inputStyle,
}: VecInputProps) {
  const { t } = useTranslation('misc');
  const hasHeader =
    groupLabel != null || (onSetGroupKeyframe != null && (canRecord ?? true));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, ...style }}>
      {hasHeader && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 11,
            color: COLORS.mutedText,
            gap: 8,
          }}
        >
          <span>{groupLabel}</span>
          {onSetGroupKeyframe != null && (canRecord ?? true) && (
            <button
              onClick={(e) => {
                e.preventDefault();
                void onSetGroupKeyframe(values);
              }}
              title={t('numericInputs.setKeyframeAll')}
              style={kfGroupBtnStyle}
            >
              {t('numericInputs.setGroupBtn')}
            </button>
          )}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
        {values.map((v, i) => {
          const isFirst = i === 0;
          const isLast = i === values.length - 1;
          // Visually connect the cells: collapse internal borders, only the
          // first/last cells keep rounded corners. A 1px negative margin on
          // non-first cells overlaps the shared edge so we don't see a double border.
          const joinedStyle: CSSProperties = {
            flex: 1,
            minWidth: 0,
            borderTopLeftRadius: isFirst ? 4 : 0,
            borderBottomLeftRadius: isFirst ? 4 : 0,
            borderTopRightRadius: isLast ? 4 : 0,
            borderBottomRightRadius: isLast ? 4 : 0,
            marginLeft: isFirst ? 0 : -1,
            ...inputStyle,
          };
          return (
            <NumInput
              key={i}
              value={v}
              prefix={labels?.[i]}
              suffix={suffix}
              step={ax(step, i, 0.01)}
              min={ax(min, i)}
              max={ax(max, i)}
              precision={ax(precision, i)}
              onChange={(nv) => {
                const next = values.slice();
                next[i] = nv;
                onChange?.(next, i);
              }}
              onCommit={(nv) => {
                const next = values.slice();
                next[i] = nv;
                onCommit?.(next, i);
              }}
              onSetKeyframe={
                onSetAxisKeyframe
                  ? (cur) => onSetAxisKeyframe(i, cur)
                  : undefined
              }
              canRecord={canRecord}
              style={joinedStyle}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── SliderInput ───────────────────────────────────────────────────────────────

export interface SliderInputProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Live updates while dragging the slider. */
  onChange?: (v: number) => void;
  /** Fires on slider release / blur of the centered number input. */
  onCommit?: (v: number) => void;
  /** Optional inline keyframe button. */
  onSetKeyframe?: (value: number) => void | Promise<void>;
  canRecord?: boolean;
  /** Optional label displayed to the left of the slider. */
  label?: string;
  /** Decimals shown in the overlaid number. */
  precision?: number;
  /** Suffix shown after the number (e.g. "°", "%"). */
  suffix?: string;
  /** Optional field-level help shown as a `?` next to the label. */
  help?: FieldHelp;
  style?: CSSProperties;
}

/** Slider with a number readout overlaid in the middle. The readout is
 *  click-to-edit; the surrounding border only appears once it's focused or hovered,
 *  so the control reads as a clean slider until you interact with it. */
export function SliderInput({
  value,
  min,
  max,
  step = 0.01,
  onChange,
  onCommit,
  onSetKeyframe,
  canRecord,
  label,
  precision,
  suffix,
  help,
  style,
}: SliderInputProps) {
  const { t } = useTranslation('misc');
  const [hover, setHover] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(formatValue(value, precision));
  useEffect(() => {
    if (!editing) setText(formatValue(value, precision));
  }, [value, editing, precision]);

  const showKfBtn = onSetKeyframe != null && (canRecord ?? true);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        ...style,
      }}
    >
      {label && (
        <span
          style={{
            fontSize: 12,
            color: COLORS.mutedText,
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {label}
          {help && (
            <HelpButton
              topic={help.topic}
              anchor={help.anchor}
              tip={help.tip}
              size={12}
            />
          )}
        </span>
      )}
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          flex: 1,
          position: 'relative',
          height: 22,
          borderRadius: 4,
          border: `1px solid ${editing ? COLORS.inputBorderFocus : hover ? COLORS.inputBorder : 'transparent'}`,
          background: COLORS.sliderTrack,
          overflow: 'hidden',
          transition: 'border-color 120ms',
        }}
      >
        {/* Fill bar */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            bottom: 0,
            width: `${((value - min) / Math.max(0.0001, max - min)) * 100}%`,
            background: COLORS.sliderFill,
            pointerEvents: 'none',
          }}
        />
        {/* The actual range slider — transparent appearance, full-area hit target */}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange?.(parseFloat(e.target.value))}
          onPointerUp={(e) =>
            onCommit?.(parseFloat((e.target as HTMLInputElement).value))
          }
          onKeyUp={(e) =>
            onCommit?.(parseFloat((e.target as HTMLInputElement).value))
          }
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            margin: 0,
            padding: 0,
            opacity: 0,
            cursor: editing ? 'text' : 'ew-resize',
          }}
        />
        {/* Centred numeric readout / editor */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            fontSize: 11,
            color: COLORS.text,
          }}
        >
          {editing ? (
            <input
              autoFocus
              type="text"
              inputMode="decimal"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => {
                setEditing(false);
                const parsed = parseFloat(text);
                if (Number.isFinite(parsed)) {
                  const clamped = Math.max(min, Math.min(max, parsed));
                  onChange?.(clamped);
                  onCommit?.(clamped);
                } else {
                  setText(formatValue(value, precision));
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              style={{
                pointerEvents: 'auto',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: COLORS.text,
                fontSize: 11,
                textAlign: 'center',
                width: '70%',
              }}
            />
          ) : (
            <span
              onDoubleClick={() => setEditing(true)}
              style={{
                pointerEvents: 'auto',
                cursor: 'text',
                padding: '0 6px',
                userSelect: 'none',
              }}
              title={t('numericInputs.doubleClickEdit')}
            >
              {formatValue(value, precision)}
              {suffix ?? ''}
            </span>
          )}
        </div>
      </div>
      {showKfBtn && (
        <button
          onClick={(e) => {
            e.preventDefault();
            void onSetKeyframe!(value);
          }}
          title={t('numericInputs.setKeyframe')}
          style={kfBtnStyle}
        >
          ◆
        </button>
      )}
    </div>
  );
}
