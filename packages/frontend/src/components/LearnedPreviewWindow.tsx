import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HolisticLandmarkerResult } from '@mediapipe/tasks-vision';
import { CameraCapture } from '../media/CameraCapture';
import { editorWsRef } from '../hooks/useWsSync';
import { useEditorStore } from '../store/editorStore';
import { useAllBehaviors, useTrackingStatuses } from '../mesh/hooks';
import {
  onLearnedPreview,
  type LearnedPreviewFrame,
} from '../learnedPreviewStore';

/**
 * Floating camera preview of a Learned Tracking behavior: what the
 * motiontracker runtime's detector sees (its mirrored 320×240 frame) and/or the
 * landmarks it found, drawn like the Media Input window's overlay. Opened from
 * the behavior's properties (editorStore.learnedPreviewBehavior).
 *
 * The runtime holds the webcam, so the frames come from it: this window
 * subscribes over /ws (`learned_preview`, backend
 * behaviors/learned_tracker/preview.ts), repeating it every few seconds so a
 * reconnect picks it up again, and unsubscribes when it closes. The runtime
 * only sends while some window watches.
 */

const RESUBSCRIBE_MS = 3000;
/** No frame for this long: show "waiting". */
const STALE_MS = 2000;
const STORAGE_KEY = 'vspark.learnedPreview';
const SIZES = [320, 480, 640] as const;

interface Prefs {
  image: boolean;
  landmarks: boolean;
  width: number;
}

function loadPrefs(): Prefs {
  const d: Prefs = { image: true, landmarks: true, width: 320 };
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as
      | Partial<Prefs>
      | undefined;
    return { ...d, ...p };
  } catch {
    return d;
  }
}

function send(behaviorId: string, image: boolean, landmarks: boolean) {
  const ws = editorWsRef.current;
  if (ws?.readyState === WebSocket.OPEN)
    ws.send(
      JSON.stringify({ kind: 'learned_preview', behaviorId, image, landmarks })
    );
}

/** The frame's landmarks in the shape CameraCapture's overlay draws. */
function asResult(
  lm: NonNullable<LearnedPreviewFrame['landmarks']>
): HolisticLandmarkerResult {
  const pts = (rows?: number[][]) =>
    rows
      ? [
          rows.map(([x, y, v]) => ({
            x,
            y,
            z: 0,
            visibility: v ?? 1,
          })),
        ]
      : [];
  return {
    faceLandmarks: pts(lm.face),
    poseLandmarks: pts(lm.pose),
    leftHandLandmarks: pts(lm.leftHand),
    rightHandLandmarks: pts(lm.rightHand),
  } as unknown as HolisticLandmarkerResult;
}

const btn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#888',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
  padding: '0 2px',
};

export function LearnedPreviewWindow({ behaviorId }: { behaviorId: string }) {
  const { t } = useTranslation('properties');
  const { t: tm } = useTranslation('media');
  const close = useEditorStore((s) => s.setLearnedPreviewBehavior);
  const behaviors = useAllBehaviors();
  const exists = behaviors.some((b) => b.id === behaviorId);
  const status = useTrackingStatuses()[behaviorId]?.runtime;
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [pos, setPos] = useState({ x: 360, y: 72 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ mx: 0, my: 0, wx: 0, wy: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [lastFrameAt, setLastFrameAt] = useState(0);
  const [now, setNow] = useState(Date.now());

  // The behavior was deleted: nothing left to show.
  const sawBehavior = useRef(false);
  useEffect(() => {
    if (exists) sawBehavior.current = true;
    else if (sawBehavior.current) close(null);
  }, [exists, close]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      /* per-viewer convenience only */
    }
  }, [prefs]);

  // Subscribe (and keep it alive across reconnects); unsubscribe on close.
  useEffect(() => {
    send(behaviorId, prefs.image, prefs.landmarks);
    const id = setInterval(() => {
      send(behaviorId, prefs.image, prefs.landmarks);
      setNow(Date.now());
    }, RESUBSCRIBE_MS);
    return () => {
      clearInterval(id);
      send(behaviorId, false, false);
    };
  }, [behaviorId, prefs.image, prefs.landmarks]);

  // Draw each frame as it arrives; frames that come in while a picture is
  // still decoding are dropped (only the newest matters).
  const legend = useRef({
    face: tm('tracking.legend.face'),
    pose: tm('tracking.legend.pose'),
    leftHand: tm('tracking.legend.leftHand'),
    rightHand: tm('tracking.legend.rightHand'),
  });
  useEffect(() => {
    let busy = false;
    let lastStamp = 0;
    return onLearnedPreview((f) => {
      if (f.behaviorId !== behaviorId || busy) return;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      busy = true;
      const draw = (img: HTMLImageElement | null) => {
        if (canvas.width !== f.width) canvas.width = f.width;
        if (canvas.height !== f.height) canvas.height = f.height;
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (img) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        if (f.landmarks)
          CameraCapture.drawLandmarksSync(
            ctx,
            asResult(f.landmarks),
            legend.current
          );
        busy = false;
        const n = Date.now();
        if (n - lastStamp > 500) {
          lastStamp = n;
          setLastFrameAt(n);
        }
      };
      if (!f.image) return draw(null);
      const img = new Image();
      img.src = `data:image/jpeg;base64,${f.image}`;
      img.decode().then(
        () => draw(img),
        () => draw(null)
      );
    });
  }, [behaviorId]);

  const onMouseDownBar = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button, select, input')) return;
      setDragging(true);
      dragStart.current = {
        mx: e.clientX,
        my: e.clientY,
        wx: pos.x,
        wy: pos.y,
      };
      e.preventDefault();
    },
    [pos]
  );
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) =>
      setPos({
        x: dragStart.current.wx + e.clientX - dragStart.current.mx,
        y: dragStart.current.wy + e.clientY - dragStart.current.my,
      });
    const onUp = () => setDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  const nothing = !prefs.image && !prefs.landmarks;
  const stale = Math.max(now, Date.now()) - lastFrameAt > STALE_MS;
  const notice = nothing
    ? t('learned.preview.nothing')
    : status?.state !== 'running'
      ? t('learned.preview.notRunning')
      : stale
        ? t('learned.preview.waiting')
        : null;

  const check = (key: 'image' | 'landmarks', label: string) => (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        className={`vs-learned-preview-${key}`}
        checked={prefs[key]}
        onChange={(e) => setPrefs((p) => ({ ...p, [key]: e.target.checked }))}
        style={{ cursor: 'pointer' }}
      />
      {label}
    </label>
  );

  return (
    <div
      className="vs-learned-preview-window"
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: prefs.width + 2,
        background: '#181818',
        border: '1px solid #333',
        borderRadius: 8,
        boxShadow: '0 4px 24px rgba(0,0,0,.6)',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 12,
        color: '#ccc',
        zIndex: 9000,
        userSelect: 'none',
      }}
    >
      <div
        onMouseDown={onMouseDownBar}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          background: '#222',
          borderRadius: '8px 8px 0 0',
          borderBottom: '1px solid #2a2a2a',
          cursor: 'grab',
        }}
      >
        <span style={{ flex: 1, fontWeight: 600, color: '#e0e0e0' }}>
          {t('learned.preview.title')}
        </span>
        <button
          className="vs-learned-preview-close"
          style={btn}
          title={t('learned.preview.close')}
          onClick={() => close(null)}
        >
          ×
        </button>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '6px 10px',
          borderBottom: '1px solid #222',
        }}
      >
        {check('image', t('learned.preview.image'))}
        {check('landmarks', t('learned.preview.landmarks'))}
        <select
          className="vs-learned-preview-size"
          value={prefs.width}
          onChange={(e) =>
            setPrefs((p) => ({ ...p, width: Number(e.target.value) }))
          }
          style={{
            marginLeft: 'auto',
            background: '#2a2a2a',
            border: '1px solid #3a3a3a',
            color: '#e0e0e0',
            borderRadius: 4,
            fontSize: 11,
          }}
        >
          {SIZES.map((w) => (
            <option key={w} value={w}>
              {w}px
            </option>
          ))}
        </select>
      </div>
      <div style={{ position: 'relative', lineHeight: 0 }}>
        <canvas
          ref={canvasRef}
          width={320}
          height={240}
          style={{
            width: prefs.width,
            height: (prefs.width * 3) / 4,
            background: '#111',
            borderRadius: '0 0 8px 8px',
          }}
        />
        {notice && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 16,
              textAlign: 'center',
              lineHeight: 1.4,
              color: '#888',
              background: 'rgba(17,17,17,0.6)',
              borderRadius: '0 0 8px 8px',
            }}
          >
            {notice}
          </div>
        )}
      </div>
    </div>
  );
}
