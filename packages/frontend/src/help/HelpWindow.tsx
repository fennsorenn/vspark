import { useEffect, useState } from 'react';
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
const MIN_W = 380;
const MIN_H = 280;

export function HelpWindow() {
  const { t } = useTranslation('help');
  const { open, topic, anchor, goTo, closeHelp } = useHelpStore();
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 640, h: 480 });
  const [placed, setPlaced] = useState(false);

  // Place centred-right on first open; keep position across topic navigation.
  useEffect(() => {
    if (open && !placed) {
      const w = Math.min(640, window.innerWidth - 32);
      const h = Math.min(480, window.innerHeight - 32);
      setSize({ w, h });
      setPos({
        x: Math.max(16, window.innerWidth - w - 40),
        y: Math.max(16, (window.innerHeight - h) / 2),
      });
      setPlaced(true);
    }
    if (!open) setPlaced(false);
  }, [open, placed]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeHelp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeHelp]);

  // Drag: attach listeners synchronously on pointer-down so a press always
  // starts a drag (an effect-based listener would miss presses that don't
  // trigger a re-render).
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const dx = e.clientX - pos.x;
    const dy = e.clientY - pos.y;
    const onMove = (ev: PointerEvent) => {
      setPos({
        x: Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 120),
        y: Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40),
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Resize from the bottom-right corner.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const sw = size.w;
    const sh = size.h;
    const onMove = (ev: PointerEvent) => {
      setSize({
        w: Math.max(MIN_W, Math.min(sw + (ev.clientX - sx), window.innerWidth - pos.x - 8)),
        h: Math.max(MIN_H, Math.min(sh + (ev.clientY - sy), window.innerHeight - pos.y - 8)),
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  if (!open || !topic) return null;

  const popOut = () => {
    const url = `/docs/${topic}${anchor ? `#${anchor}` : ''}`;
    // Prefer a real popup window; if the browser routes it to a tab, that's fine too.
    const features = `popup=yes,width=${Math.round(size.w)},height=${Math.round(size.h) + 60},left=120,top=120`;
    const win = window.open(url, 'vsparkHelp', features);
    if (win) {
      win.focus();
      closeHelp();
    } else {
      // Popup blocked — fall back to a new tab.
      window.open(url, '_blank');
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: size.w,
        height: size.h,
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
        onPointerDown={startDrag}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px 8px 14px',
          borderBottom: '1px solid #2a2a2a',
          cursor: 'move',
          background: '#1c1c1c',
          userSelect: 'none',
          touchAction: 'none',
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

      {/* Resize handle (bottom-right) */}
      <div
        onPointerDown={startResize}
        title={t('window.resize')}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 16,
          height: 16,
          cursor: 'nwse-resize',
          touchAction: 'none',
          // Subtle corner grip.
          background:
            'linear-gradient(135deg, transparent 0 50%, #555 50% 60%, transparent 60% 70%, #555 70% 80%, transparent 80%)',
        }}
      />
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
