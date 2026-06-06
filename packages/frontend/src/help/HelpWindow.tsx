import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHelpStore } from './helpStore';
import { DocViewer } from './DocViewer';

/**
 * Floating, draggable in-app documentation window. Mounted once near the root
 * of a page; it renders only while `open` is true in the help store.
 *
 * The header carries a pop-out button that opens the same page as a standalone
 * `/docs/:topic#anchor` route in a new browser tab.
 */
export function HelpWindow() {
  const { t } = useTranslation('help');
  const { open, topic, anchor, goTo, closeHelp } = useHelpStore();
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [placed, setPlaced] = useState(false);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const WIDTH = 620;
  const HEIGHT = 460;

  // Place centred-right on first open; keep position across topic navigation.
  useEffect(() => {
    if (open && !placed) {
      const x = Math.max(16, window.innerWidth - WIDTH - 40);
      const y = Math.max(16, (window.innerHeight - HEIGHT) / 2);
      setPos({ x, y });
      setPlaced(true);
    }
    if (!open) setPlaced(false);
  }, [open, placed]);

  useEffect(() => {
    if (!drag.current) return;
    const onMove = (e: PointerEvent) => {
      if (!drag.current) return;
      const x = Math.min(
        Math.max(0, e.clientX - drag.current.dx),
        window.innerWidth - 120
      );
      const y = Math.min(
        Math.max(0, e.clientY - drag.current.dy),
        window.innerHeight - 40
      );
      setPos({ x, y });
    };
    const onUp = () => {
      drag.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  });

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeHelp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeHelp]);

  if (!open || !topic) return null;

  const popOut = () => {
    const url = `/docs/${topic}${anchor ? `#${anchor}` : ''}`;
    window.open(url, '_blank', 'noopener');
  };

  return (
    <div
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: WIDTH,
        height: HEIGHT,
        background: '#181818',
        border: '1px solid #333',
        borderRadius: 9,
        boxShadow: '0 8px 40px rgba(0,0,0,.6)',
        zIndex: 9500,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Header (drag handle) */}
      <div
        onPointerDown={(e) => {
          drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px 8px 14px',
          borderBottom: '1px solid #2a2a2a',
          cursor: 'move',
          background: '#1c1c1c',
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: '#e8e8e8' }}>
          {t('window.title')}
        </span>
        <div style={{ flex: 1 }} />
        <HeaderButton title={t('window.popOut')} onClick={popOut}>
          ↗
        </HeaderButton>
        <HeaderButton title={t('window.close')} onClick={closeHelp}>
          ×
        </HeaderButton>
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <DocViewer topic={topic} anchor={anchor} onNavigate={goTo} variant="window" />
      </div>
    </div>
  );
}

function HeaderButton({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        background: 'none',
        border: 'none',
        color: '#999',
        cursor: 'pointer',
        fontSize: 16,
        lineHeight: 1,
        padding: '2px 6px',
        borderRadius: 4,
      }}
    >
      {children}
    </button>
  );
}
