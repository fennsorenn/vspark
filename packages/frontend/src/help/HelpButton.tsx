import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useHelpStore } from './helpStore';

interface Props {
  /** Documentation page id, e.g. `avatar`. */
  topic: string;
  /** Optional heading anchor within the page, e.g. `animation`. */
  anchor?: string;
  /** Short tooltip text shown on hover (already translated by the caller). */
  tip?: string;
  /** Diameter in px. */
  size?: number;
  style?: React.CSSProperties;
}

const MARGIN = 8;

/**
 * Small inline `?` affordance. Hovering shows a short tooltip; clicking opens
 * the floating help window on `topic`, deep-scrolled to `anchor`.
 *
 * The tooltip is portaled to `document.body` and positioned with fixed
 * coordinates so it is never clipped by a panel's `overflow: hidden`, and it is
 * clamped to the viewport (flipping below the button when there is no room
 * above, and shifting horizontally to stay on-screen).
 */
export function HelpButton({ topic, anchor, tip, size = 14, style }: Props) {
  const openHelp = useHelpStore((s) => s.openHelp);
  const { t } = useTranslation('help');
  const btnRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  // null until measured, so the tooltip doesn't flash at an unclamped position.
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);

  const showTip = () => {
    if (!tip) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      setAnchorRect(r);
      setCoords(null);
    }
  };
  const hideTip = () => {
    setAnchorRect(null);
    setCoords(null);
  };

  // After the tooltip renders we know its real size, so clamp it to the viewport.
  useLayoutEffect(() => {
    if (!anchorRect || !tipRef.current) return;
    const tw = tipRef.current.offsetWidth;
    const th = tipRef.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = anchorRect.left + anchorRect.width / 2 - tw / 2;
    left = Math.max(MARGIN, Math.min(left, vw - tw - MARGIN));

    // Prefer above the button; flip below if it would clip the top.
    let top = anchorRect.top - th - MARGIN;
    if (top < MARGIN) top = anchorRect.bottom + MARGIN;
    // As a last resort (very short viewport) clamp into view.
    top = Math.max(MARGIN, Math.min(top, vh - th - MARGIN));

    setCoords({ left, top });
  }, [anchorRect, tip]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={tip ?? t('button.aria')}
        onMouseEnter={showTip}
        onMouseLeave={hideTip}
        onFocus={showTip}
        onBlur={hideTip}
        onClick={(e) => {
          e.stopPropagation();
          hideTip();
          openHelp(topic, anchor);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
          flexShrink: 0,
          borderRadius: '50%',
          border: '1px solid #3a4a6a',
          background: '#1c2536',
          color: '#7ea2e0',
          fontSize: size * 0.72,
          fontWeight: 700,
          lineHeight: 1,
          cursor: 'help',
          padding: 0,
          fontFamily: 'system-ui, sans-serif',
          ...style,
        }}
      >
        ?
      </button>
      {anchorRect &&
        tip &&
        createPortal(
          <div
            ref={tipRef}
            style={{
              position: 'fixed',
              left: coords ? coords.left : -9999,
              top: coords ? coords.top : -9999,
              visibility: coords ? 'visible' : 'hidden',
              maxWidth: 260,
              width: 'max-content',
              background: '#10151f',
              border: '1px solid #38456a',
              borderRadius: 6,
              boxShadow: '0 4px 18px rgba(0,0,0,.55)',
              color: '#dce6f7',
              fontSize: 12,
              lineHeight: 1.45,
              padding: '6px 9px',
              pointerEvents: 'none',
              zIndex: 99999,
              fontFamily: 'system-ui, sans-serif',
            }}
          >
            {tip}
            <div style={{ fontSize: 10, color: '#6c7a99', marginTop: 3 }}>
              ⌕ {t('button.clickHint')}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
