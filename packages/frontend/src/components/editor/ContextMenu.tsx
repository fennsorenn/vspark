import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

/** A single line in a context menu. `divider` renders a hairline separator;
 *  `submenu` opens a nested menu on hover. Regular items run `onClick`
 *  (and the parent menu auto-closes). `danger` colours the label red. */
export type ContextMenuItem =
  | { kind: 'divider' }
  | {
      kind: 'item';
      label: ReactNode;
      onClick: () => void;
      danger?: boolean;
      disabled?: boolean;
    }
  | {
      kind: 'submenu';
      label: ReactNode;
      items: ContextMenuItem[];
      /** Optional: when set, the submenu is hidden when this returns false.
       *  Use for "Paste foo here" submenus that only make sense for
       *  matching clipboard contents. */
      visible?: boolean;
    };

interface Props {
  /** Viewport-space anchor. Usually (e.clientX, e.clientY) from the
   *  triggering contextmenu event. */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Optional override for the menu's min width; defaults to 180px. */
  minWidth?: number;
}

const menuStyle = (x: number, y: number, minWidth: number): CSSProperties => ({
  position: 'fixed',
  top: y,
  left: x,
  background: '#1e1e1e',
  border: '1px solid #3a3a3a',
  borderRadius: 6,
  zIndex: 9999,
  minWidth,
  boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
  fontFamily: 'system-ui, sans-serif',
  overflow: 'visible',
});

const itemStyle: CSSProperties = {
  padding: '7px 14px',
  fontSize: 13,
  color: '#e0e0e0',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  userSelect: 'none',
  position: 'relative',
};

const dividerStyle: CSSProperties = {
  height: 1,
  background: '#2a2a2a',
  margin: '3px 0',
};

/** Generic right-click context menu. Renders a flat or nested item list,
 *  auto-closes on outside click. Replaces the various
 *  window.prompt(`Action on …`) shims that had grown across the editor. */
export function ContextMenu({ x, y, items, onClose, minWidth = 180 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // mousedown rather than click so the menu closes before the
    // following click can fire on something underneath.
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div ref={ref} style={menuStyle(x, y, minWidth)}>
      {items.map((it, i) => (
        <MenuRow key={i} item={it} onClose={onClose} />
      ))}
    </div>
  );
}

function MenuRow({
  item,
  onClose,
}: {
  item: ContextMenuItem;
  onClose: () => void;
}) {
  const [hover, setHover] = useState(false);
  if (item.kind === 'divider') return <div style={dividerStyle} />;
  if (item.kind === 'submenu') {
    if (item.visible === false) return null;
    return (
      <div
        style={{
          ...itemStyle,
          background: hover ? '#2a2a2a' : 'transparent',
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <span>{item.label}</span>
        <span style={{ color: '#666' }}>▶</span>
        {hover && (
          <div
            // Position submenu to the right; submenus inherit the same
            // outer-click handler via the menu's wrapper since the ref
            // covers the whole tree.
            style={{
              position: 'absolute',
              left: '100%',
              top: 0,
              background: '#1e1e1e',
              border: '1px solid #3a3a3a',
              borderRadius: 6,
              minWidth: 180,
              maxHeight: 320,
              overflowY: 'auto',
              boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
            }}
          >
            {item.items.map((sub, i) => (
              <MenuRow key={i} item={sub} onClose={onClose} />
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      style={{
        ...itemStyle,
        color: item.disabled ? '#555' : item.danger ? '#e05555' : '#e0e0e0',
        cursor: item.disabled ? 'default' : 'pointer',
        background: hover && !item.disabled ? '#2a2a2a' : 'transparent',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => {
        if (item.disabled) return;
        item.onClick();
        onClose();
      }}
    >
      {item.label}
    </div>
  );
}
