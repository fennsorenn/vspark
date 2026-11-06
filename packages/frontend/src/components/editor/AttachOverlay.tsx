import { useEffect, useState } from 'react';
import type { AssistantAttachment } from '@vspark/shared';
import { useAssistantStore } from '../../store/assistantStore';

/**
 * Attach-picker overlay. While the assistant's attach mode is on, it dims the
 * whole editor and draws a bright, clickable hotspot over every element marked
 * `data-attach-*` (scene-node rows, compose-layer rows, asset items). Clicking a
 * hotspot attaches that element to the next assistant message. The highlight is
 * drawn from each element's bounding rect in a single top-level overlay, so it
 * sidesteps z-index/stacking-context fights with the panels underneath.
 */
interface Hotspot {
  rect: { top: number; left: number; width: number; height: number };
  att: AssistantAttachment;
}

function collect(): Hotspot[] {
  const out: Hotspot[] = [];
  document.querySelectorAll<HTMLElement>('[data-attach-id]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return; // hidden / collapsed
    if (r.bottom < 0 || r.top > window.innerHeight) return; // scrolled away
    const kind = el.dataset.attachKind as AssistantAttachment['kind'];
    const id = el.dataset.attachId;
    if (!kind || !id) return;
    out.push({
      rect: { top: r.top, left: r.left, width: r.width, height: r.height },
      att: { kind, id, name: el.dataset.attachName ?? id, url: el.dataset.attachUrl },
    });
  });
  return out;
}

export function AttachOverlay() {
  const attachMode = useAssistantStore((s) => s.attachMode);
  const setAttachMode = useAssistantStore((s) => s.setAttachMode);
  const addAttachment = useAssistantStore((s) => s.addAttachment);
  const attached = useAssistantStore((s) => s.attachments);
  const [spots, setSpots] = useState<Hotspot[]>([]);

  // Keep hotspots in sync with the DOM (scroll/resize/layout) via a rAF loop.
  useEffect(() => {
    if (!attachMode) return;
    let raf = 0;
    const tick = () => {
      setSpots(collect());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAttachMode(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
    };
  }, [attachMode, setAttachMode]);

  if (!attachMode) return null;
  const isAttached = (h: Hotspot) =>
    attached.some((a) => a.id === h.att.id && a.kind === h.att.kind);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 4000 }}>
      {/* Dim backdrop — blocks the dimmed UI; click = no-op (Esc / 📎 exits). */}
      <div
        onClick={() => setAttachMode(false)}
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }}
      />
      {/* Hint banner */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: '50%',
          transform: 'translateX(-50%)',
          background: '#2563eb',
          color: '#fff',
          padding: '4px 12px',
          borderRadius: 6,
          fontSize: 12,
          pointerEvents: 'none',
        }}
      >
        Click an object, layer, or asset to attach it · Esc to cancel
      </div>
      {/* Bright clickable hotspots over each attachable element. */}
      {spots.map((h) => {
        const on = isAttached(h);
        return (
          <button
            key={`${h.att.kind}:${h.att.id}`}
            className="vs-attach-target"
            onClick={() => addAttachment(h.att)}
            title={`${h.att.kind}: ${h.att.name}`}
            style={{
              position: 'absolute',
              top: h.rect.top - 2,
              left: h.rect.left - 2,
              width: h.rect.width + 4,
              height: h.rect.height + 4,
              border: `2px solid ${on ? '#34d399' : '#63b3ff'}`,
              borderRadius: 6,
              background: on ? 'rgba(52,211,153,0.25)' : 'rgba(99,179,255,0.18)',
              boxShadow: `0 0 0 3px ${on ? 'rgba(52,211,153,0.35)' : 'rgba(99,179,255,0.3)'}`,
              cursor: 'pointer',
              padding: 0,
            }}
          />
        );
      })}
    </div>
  );
}
