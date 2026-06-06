import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MicCapture, type VowelTemplates } from '../media/MicCapture';
import { CameraCapture } from '../media/CameraCapture';
import { useLipsyncUplink } from '../hooks/useLipsyncUplink';
import { editorWsRef } from '../hooks/useWsSync';
import { useEditorStore } from '../store/editorStore';
import { HelpButton } from '../help/HelpButton';

// ── Styles ───────────────────────────────────────────────────────────────────

const S = {
  window: (x: number, y: number): React.CSSProperties => ({
    position: 'fixed',
    left: x,
    top: y,
    width: 320,
    background: '#181818',
    border: '1px solid #333',
    borderRadius: 8,
    boxShadow: '0 4px 24px rgba(0,0,0,.6)',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 12,
    color: '#ccc',
    zIndex: 9000,
    userSelect: 'none',
  }),
  titleBar: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 10px',
    background: '#222',
    borderRadius: '8px 8px 0 0',
    cursor: 'grab',
    borderBottom: '1px solid #2a2a2a',
    gap: 8,
  } as React.CSSProperties,
  title: {
    flex: 1,
    fontWeight: 600,
    fontSize: 12,
    color: '#e0e0e0',
  } as React.CSSProperties,
  iconBtn: {
    background: 'none',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    padding: '0 2px',
  } as React.CSSProperties,
  section: {
    padding: '8px 10px',
    borderBottom: '1px solid #222',
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: 10,
    fontWeight: 700,
    color: '#666',
    letterSpacing: 1,
    marginBottom: 6,
  } as React.CSSProperties,
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  } as React.CSSProperties,
  label: { color: '#888', minWidth: 44 } as React.CSSProperties,
  select: {
    flex: 1,
    background: '#2a2a2a',
    border: '1px solid #3a3a3a',
    color: '#e0e0e0',
    borderRadius: 4,
    padding: '2px 6px',
    fontSize: 11,
    cursor: 'pointer',
    outline: 'none',
  } as React.CSSProperties,
  btn: (active: boolean): React.CSSProperties => ({
    padding: '3px 10px',
    borderRadius: 4,
    border: '1px solid ' + (active ? '#ef4444' : '#3a3a3a'),
    background: active ? '#7f1d1d' : '#2a2a2a',
    color: active ? '#fca5a5' : '#ccc',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
  }),
  dot: (active: boolean): React.CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: active ? '#4ade80' : '#555',
    flexShrink: 0,
  }),
  levelBar: {
    flex: 1,
    height: 6,
    background: '#2a2a2a',
    borderRadius: 3,
    overflow: 'hidden',
    cursor: 'default',
  } as React.CSSProperties,
  visemeRow: {
    display: 'flex',
    gap: 4,
    flexWrap: 'wrap' as const,
    marginTop: 4,
  },
  visemeChip: (v: number): React.CSSProperties => ({
    background: `rgba(74,222,128,${v * 0.6 + 0.05})`,
    borderRadius: 3,
    padding: '1px 5px',
    fontSize: 10,
    color: v > 0.1 ? '#4ade80' : '#555',
    transition: 'all 0.1s',
    minWidth: 40,
    textAlign: 'center',
  }),
  canvas: {
    width: '100%',
    height: 180,
    display: 'block',
    background: '#111',
    borderRadius: 4,
  } as React.CSSProperties,
  checkRow: {
    display: 'flex',
    gap: 10,
    marginTop: 4,
    color: '#888',
    fontSize: 11,
  } as React.CSSProperties,
};

// ── Level bar drawn on canvas ─────────────────────────────────────────────────

function LevelBar({ rmsRef }: { rmsRef: React.RefObject<number> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let id: number;
    function draw() {
      id = requestAnimationFrame(draw);
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      const w = c.offsetWidth * devicePixelRatio;
      const h = c.offsetHeight * devicePixelRatio;
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      ctx.clearRect(0, 0, w, h);
      const rms = rmsRef.current ?? 0;
      const fill = Math.min(1, rms * 3);
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#4ade80');
      grad.addColorStop(0.7, '#fbbf24');
      grad.addColorStop(1, '#ef4444');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w * fill, h);
    }
    id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, [rmsRef]);
  return <canvas ref={canvasRef} style={{ ...S.levelBar, display: 'block' }} />;
}

// ── Viseme display refreshed by rAF ──────────────────────────────────────────

const VISEME_KEYS = [
  'jawOpen',
  'Fcl_MTH_A',
  'Fcl_MTH_E',
  'Fcl_MTH_I',
  'Fcl_MTH_O',
  'Fcl_MTH_U',
] as const;
const VISEME_LABELS: Record<string, string> = {
  jawOpen: 'jaw',
  Fcl_MTH_A: 'A',
  Fcl_MTH_E: 'E',
  Fcl_MTH_I: 'I',
  Fcl_MTH_O: 'O',
  Fcl_MTH_U: 'U',
};

function VisemeDisplay({
  micRef,
  active,
}: {
  micRef: React.RefObject<MicCapture | null>;
  active: boolean;
}) {
  const [weights, setWeights] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!active) {
      setWeights({});
      return;
    }
    let id: number;
    function poll() {
      id = requestAnimationFrame(poll);
      const mic = micRef.current;
      if (mic?.active) setWeights(mic.getVisemes());
    }
    id = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(id);
  }, [active, micRef]);
  return (
    <div style={S.visemeRow}>
      {VISEME_KEYS.map((k) => (
        <span key={k} style={S.visemeChip(weights[k] ?? 0)}>
          {VISEME_LABELS[k]} {(((weights[k] ?? 0) * 10) | 0) / 10}
        </span>
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  /** If provided, restricts to a specific component; otherwise finds first active one. */
  lipsyncBehaviorId?: string | null;
  trackingBehaviorId?: string | null;
  /** If true, window cannot be minimised (standalone page mode). */
  alwaysExpanded?: boolean;
  /** Provide a WS if this component manages its own connection (standalone mode). */
  ws?: WebSocket | null;
  /** When false, hide the window via CSS without unmounting — keeps active mic/cam streams alive. */
  visible?: boolean;
}

export function MediaInputWindow({
  lipsyncBehaviorId,
  trackingBehaviorId,
  alwaysExpanded = false,
  ws: externalWs,
  visible = true,
}: Props) {
  const { t } = useTranslation('media');

  // ── State ──────────────────────────────────────────────────────────────────
  const [expanded, setExpanded] = useState(true);
  const [pos, setPos] = useState({ x: 24, y: 72 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ mx: 0, my: 0, wx: 0, wy: 0 });

  // Lipsync
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState<string | undefined>();
  const [lipsyncActive, setLipsyncActive] = useState(false);
  const micRef = useRef<MicCapture | null>(null);
  const rmsRef = useRef<number>(0);

  // Tracking
  const [camDevices, setCamDevices] = useState<MediaDeviceInfo[]>([]);
  const [camDeviceId, setCamDeviceId] = useState<string | undefined>();
  const [trackingActive, setTrackingActive] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [enableFace, setEnableFace] = useState(true);
  const [enablePose, setEnablePose] = useState(true);
  const [enableHands, setEnableHands] = useState(true);
  const cameraRef = useRef<CameraCapture | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  // WS connection — use prop if provided (standalone page), else use the shared editor socket

  // Resolve component IDs from store if not provided as props
  const behaviors = useEditorStore((s) => s.behaviors);
  const resolvedLipsyncId =
    lipsyncBehaviorId ??
    behaviors.find((c) => c.kind === 'lipsync_processor' && c.enabled)
      ?.id ??
    null;
  const resolvedTrackingId =
    trackingBehaviorId ??
    behaviors.find((c) => c.kind === 'mediapipe_tracker' && c.enabled)
      ?.id ??
    null;

  // ── WS: point wsRef at the shared editor socket (or provided standalone socket) ──
  useEffect(() => {
    if (externalWs) {
      wsRef.current = externalWs;
      return;
    }
    // Use the module-level ref from useWsSync — already open, no new connection needed
    wsRef.current = editorWsRef.current;
    // Keep it fresh on each render tick (the editor socket reconnects automatically)
    const id = setInterval(() => {
      wsRef.current = editorWsRef.current;
    }, 1000);
    return () => clearInterval(id);
  }, [externalWs]);

  // ── Enumerate devices ──────────────────────────────────────────────────────
  // Sequenced (not parallel) so both permission prompts surface — Chromium
  // collapses concurrent getUserMedia prompts and only one ends up shown.
  useEffect(() => {
    void (async () => {
      try {
        setCamDevices(await CameraCapture.getDevices());
      } catch {}
      try {
        setMicDevices(await MicCapture.getDevices());
      } catch {}
    })();
  }, []);

  // ── Lipsync activate/deactivate ────────────────────────────────────────────
  const toggleLipsync = useCallback(async () => {
    if (lipsyncActive) {
      await micRef.current?.stop();
      setLipsyncActive(false);
    } else {
      const mic = new MicCapture();
      mic.onLevelChange = (rms) => {
        rmsRef.current = rms;
      };
      // Apply calibrated vowel templates from the lipsync component config, if any.
      const lipsyncComp = behaviors.find(
        (c) => c.id === resolvedLipsyncId
      );
      const cfg = lipsyncComp?.config as
        | { vowelTemplates?: Record<string, number[]> }
        | undefined;
      const tpl = cfg?.vowelTemplates;
      if (tpl && tpl.A && tpl.E && tpl.I && tpl.O && tpl.U) {
        mic.setTemplates(tpl as VowelTemplates);
      }
      try {
        await mic.start(micDeviceId);
        micRef.current = mic;
        setLipsyncActive(true);
      } catch (e) {
        alert(t('errors.micError', { message: (e as Error).message }));
      }
    }
  }, [lipsyncActive, micDeviceId, behaviors, resolvedLipsyncId]);

  // Refs so onResult closure always reads the latest values without going stale
  const wsRef = useRef<WebSocket | null>(null);
  const trackingCompIdRef = useRef<string | null>(null);
  const showPreviewRef = useRef(showPreview);
  useEffect(() => {
    trackingCompIdRef.current = resolvedTrackingId;
  }, [resolvedTrackingId]);
  useEffect(() => {
    showPreviewRef.current = showPreview;
  }, [showPreview]);

  // ── Tracking activate/deactivate ───────────────────────────────────────────
  const toggleTracking = useCallback(async () => {
    if (trackingActive) {
      await cameraRef.current?.stop();
      cameraRef.current = null;
      setTrackingActive(false);
    } else {
      const cam = new CameraCapture();
      cam.onError = (e) => {
        console.error('[CameraCapture]', e);
        setTrackingActive(false);
      };
      // WS uplink via onResult (receives the filtered TrackingResult)
      cam.onResult = (result) => {
        const socket = wsRef.current;
        const compId = trackingCompIdRef.current;
        if (socket && socket.readyState === WebSocket.OPEN && compId) {
          socket.send(
            JSON.stringify({
              kind: 'tracking_input',
              behaviorId: compId,
              ...result,
            })
          );
        }
      };
      // Preview via onRawResult (receives the live HolisticLandmarkerResult in-frame)
      cam.onRawResult = (raw) => {
        if (!showPreviewRef.current) return;
        const canvas = previewCanvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const video = cam.video;
        if (video && video.readyState >= 2) {
          const w = video.videoWidth || 640;
          const h = video.videoHeight || 480;
          if (canvas.width !== w) canvas.width = w;
          if (canvas.height !== h) canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          CameraCapture.drawLandmarksSync(ctx, raw);
        }
      };
      try {
        await cam.start(camDeviceId, { enableFace, enablePose, enableHands });
        cameraRef.current = cam;
        setTrackingActive(true);
      } catch (e) {
        alert(t('errors.cameraError', { message: (e as Error).message }));
      }
    }
  }, [trackingActive, camDeviceId, enableFace, enablePose, enableHands]);

  // ── Uplink hooks ───────────────────────────────────────────────────────────
  useLipsyncUplink(wsRef, resolvedLipsyncId, micRef, lipsyncActive);

  // ── Drag handling ─────────────────────────────────────────────────────────
  const onMouseDownBar = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
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
    const onMove = (e: MouseEvent) => {
      setPos({
        x: dragStart.current.wx + e.clientX - dragStart.current.mx,
        y: dragStart.current.wy + e.clientY - dragStart.current.my,
      });
    };
    const onUp = () => setDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(
    () => () => {
      micRef.current?.stop();
      cameraRef.current?.stop();
    },
    []
  );

  // ── Lipsync status indicator for title bar ────────────────────────────────
  const lipsyncStatus = lipsyncActive
    ? resolvedLipsyncId
      ? 'active'
      : 'no-component'
    : 'idle';

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        ...S.window(pos.x, pos.y),
        display: visible ? undefined : 'none',
      }}
    >
      {/* Title bar */}
      <div style={S.titleBar} onMouseDown={onMouseDownBar}>
        <div style={S.dot(lipsyncActive || trackingActive)} />
        <span style={S.title}>{t('window.title')}</span>
        {lipsyncStatus === 'active' && (
          <span style={{ fontSize: 10, color: '#4ade80' }}>{t('status.lipsync')}</span>
        )}
        {lipsyncStatus === 'no-component' && (
          <span style={{ fontSize: 10, color: '#fbbf24' }}>{t('status.noComponent')}</span>
        )}
        {trackingActive && (
          <span style={{ fontSize: 10, color: '#60a5fa' }}>{t('status.tracking')}</span>
        )}
        {!alwaysExpanded && (
          <button
            style={S.iconBtn}
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? t('titleBar.collapse') : t('titleBar.expand')}
          >
            {expanded ? '−' : '+'}
          </button>
        )}
      </div>

      {expanded && (
        <>
          {/* ── LIPSYNC SECTION ── */}
          <div style={S.section}>
            <div style={{ ...S.sectionTitle, display: 'flex', alignItems: 'center', gap: 4 }}>
              {t('lipsync.sectionTitle')}
              <HelpButton topic="behaviors" anchor="lipsync" tip={t('help.lipsync')} size={12} />
            </div>
            <div style={S.row}>
              <span style={S.label}>{t('lipsync.deviceLabel')}</span>
              <select
                style={S.select}
                value={micDeviceId ?? ''}
                onChange={(e) => setMicDeviceId(e.target.value || undefined)}
                disabled={lipsyncActive}
              >
                <option value="">{t('lipsync.defaultMic')}</option>
                {micDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || t('lipsync.micFallback', { id: d.deviceId.slice(0, 8) })}
                  </option>
                ))}
              </select>
            </div>
            <div style={S.row}>
              <button style={S.btn(lipsyncActive)} onClick={toggleLipsync}>
                {lipsyncActive ? t('lipsync.stopBtn') : t('lipsync.startBtn')}
              </button>
              <LevelBar rmsRef={rmsRef} />
            </div>
            {!resolvedLipsyncId && (
              <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 2 }}>
                {t('lipsync.noComponent')}
              </div>
            )}
            <VisemeDisplay micRef={micRef} active={lipsyncActive} />
          </div>

          {/* ── TRACKING SECTION ── */}
          <div style={{ ...S.section, borderBottom: 'none' }}>
            <div style={{ ...S.sectionTitle, display: 'flex', alignItems: 'center', gap: 4 }}>
              {t('tracking.sectionTitle')}
              <HelpButton topic="behaviors" anchor="tracking" tip={t('help.tracking')} size={12} />
            </div>
            <div style={S.row}>
              <span style={S.label}>{t('tracking.deviceLabel')}</span>
              <select
                style={S.select}
                value={camDeviceId ?? ''}
                onChange={(e) => setCamDeviceId(e.target.value || undefined)}
                disabled={trackingActive}
              >
                <option value="">{t('tracking.defaultCam')}</option>
                {camDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || t('tracking.camFallback', { id: d.deviceId.slice(0, 8) })}
                  </option>
                ))}
              </select>
            </div>
            <div style={S.row}>
              <button style={S.btn(trackingActive)} onClick={toggleTracking}>
                {trackingActive ? t('tracking.stopBtn') : t('tracking.startBtn')}
              </button>
              <label
                style={{
                  fontSize: 11,
                  color: '#888',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <input
                  type="checkbox"
                  checked={showPreview}
                  onChange={(e) => setShowPreview(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                {t('tracking.previewLabel')}
              </label>
            </div>
            <div style={S.checkRow}>
              {(
                [
                  [t('tracking.faceLabel'), enableFace, setEnableFace],
                  [t('tracking.poseLabel'), enablePose, setEnablePose],
                  [t('tracking.handsLabel'), enableHands, setEnableHands],
                ] as [string, boolean, (v: boolean) => void][]
              ).map(([label, val, setter]) => (
                <label
                  key={label}
                  style={{
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={val}
                    disabled={trackingActive}
                    onChange={(e) => setter(e.target.checked)}
                    style={{ cursor: 'pointer' }}
                  />
                  {label}
                </label>
              ))}
            </div>
            {trackingActive && showPreview && (
              <canvas
                ref={previewCanvasRef}
                style={{ ...S.canvas, marginTop: 6, transform: 'scaleX(-1)' }}
                width={300}
                height={180}
              />
            )}
            {!resolvedTrackingId && (
              <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 4 }}>
                {t('tracking.noComponent')}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
