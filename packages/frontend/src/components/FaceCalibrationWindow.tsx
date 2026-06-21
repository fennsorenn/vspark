/**
 * Dev-facing face-heuristic calibration tool. Open from the browser console with
 * `dev_facecal()`. NOT user-facing — no i18n/help/persistence (see
 * dev-notes/plans/face-calibration.md).
 *
 * Owns its own camera with HQ face on, so it can show the heuristic (editable config)
 * and the native FaceLandmarker reference side by side. Click landmark handles in the
 * preview to toggle them into the focused shape; tune min/max via live-auto / keep /
 * capture / manual; copy the resulting config JSON out and paste it back into
 * arkitHeuristic.ts as DEFAULT_ARKIT_CONFIG.
 *
 * Preview: resizable window (drag bottom-right), mousewheel zooms toward the cursor,
 * drag pans; a plain click (no drag) toggles the nearest landmark.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ARKIT_SHAPES } from '@vspark/shared/arkit';
import { CameraCapture } from '../media/CameraCapture';
import {
  DEFAULT_ARKIT_CONFIG,
  sumPairwiseDistance,
  referenceDistance,
  shapeWeight,
  type ArkitHeuristicConfig,
  type ArkitShapeConfig,
  type LandmarkPoint,
} from '../media/arkitHeuristic';
import {
  MinMaxTracker,
  faceBasis2D,
  projectCanonical,
  serializeConfig,
  parseConfig,
} from '../media/faceCalibration';

const ASPECT = 3 / 4; // camera is 4:3 → height = width * 3/4
const HIT_RADIUS = 9; // screen px tolerance for clicking a landmark
const DRAG_SLOP = 4; // px of movement before a press counts as a pan, not a click

interface View {
  scale: number;
  ox: number;
  oy: number;
}

const clone = (c: ArkitHeuristicConfig): ArkitHeuristicConfig =>
  JSON.parse(JSON.stringify(c));

function FaceCalibrationWindow({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<ArkitHeuristicConfig>(() =>
    clone(DEFAULT_ARKIT_CONFIG)
  );
  const [focused, setFocused] = useState<string | null>('jawOpen');
  const [frontAlign, setFrontAlign] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState('');
  // Display snapshots, refreshed ~10fps from the per-frame refs.
  const [heur, setHeur] = useState<Record<string, number>>({});
  const [native, setNative] = useState<Record<string, number>>({});
  const [liveRange, setLiveRange] = useState<{
    min: number;
    max: number;
  } | null>(null);

  const camRef = useRef<CameraCapture | null>(null);
  const ptsRef = useRef<LandmarkPoint[] | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // Base (pre-view-transform) landmark positions in canvas buffer coords, for hit testing.
  const basePosRef = useRef<{ x: number; y: number }[]>([]);
  const trackersRef = useRef<Map<string, MinMaxTracker>>(new Map());
  const liveMetricRef = useRef<Record<string, number>>({});
  const sizeRef = useRef({ w: 540, h: 540 * ASPECT });
  const viewRef = useRef<View>({ scale: 1, ox: 0, oy: 0 });
  const dragRef = useRef({
    down: false,
    moved: false,
    x: 0,
    y: 0,
  });

  const configRef = useRef(config);
  const focusedRef = useRef(focused);
  const frontAlignRef = useRef(frontAlign);
  configRef.current = config;
  focusedRef.current = focused;
  frontAlignRef.current = frontAlign;

  const tracker = (shape: string): MinMaxTracker => {
    let t = trackersRef.current.get(shape);
    if (!t) {
      t = new MinMaxTracker();
      trackersRef.current.set(shape, t);
    }
    return t;
  };

  // ── Camera lifecycle ──────────────────────────────────────────────────────
  useEffect(() => {
    const cam = new CameraCapture();
    camRef.current = cam;
    cam.onRawResult = (r) => {
      ptsRef.current = (r.faceLandmarks?.[0] as LandmarkPoint[]) ?? null;
    };
    cam.onError = (e) => console.error('[facecal] camera', e);
    cam
      .start(undefined, {
        enableFace: true,
        enablePose: false,
        enableHands: false,
        enableNativeFace: true,
      })
      .catch((e) => console.error('[facecal] start', e));
    return () => {
      void cam.stop();
      camRef.current = null;
    };
  }, []);

  // ── Track preview size → canvas buffer size (keeps the camera aspect) ──────
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.max(160, el.clientWidth);
      sizeRef.current = { w, h: Math.round(w * ASPECT) };
      const cv = canvasRef.current;
      if (cv) {
        cv.width = sizeRef.current.w;
        cv.height = sizeRef.current.h;
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Wheel zoom (non-passive so we can preventDefault) ──────────────────────
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      const { w, h } = sizeRef.current;
      const bx = ((e.clientX - rect.left) / rect.width) * w;
      const by = ((e.clientY - rect.top) / rect.height) * h;
      const v = viewRef.current;
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const ns = Math.max(0.5, Math.min(40, v.scale * f));
      v.ox = bx - (bx - v.ox) * (ns / v.scale);
      v.oy = by - (by - v.oy) * (ns / v.scale);
      v.scale = ns;
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  }, []);

  // ── Per-frame: metrics + overlay ──────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const pts = ptsRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      const { w: cw, h: ch } = sizeRef.current;
      const v = viewRef.current;
      ctx.clearRect(0, 0, cw, ch);
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, cw, ch);

      const cam = camRef.current;
      const align = frontAlignRef.current;
      // Background: mirrored video (markers live in mirrored-frame space). Skipped in
      // front-align mode, which shows an uprighted mesh on black for easier targeting.
      if (!align && cam?.video && cam.video.readyState >= 2) {
        ctx.save();
        ctx.translate(v.ox, v.oy);
        ctx.scale(v.scale, v.scale);
        ctx.translate(cw, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(cam.video, 0, 0, cw, ch);
        ctx.restore();
      }

      if (!pts || pts.length < 478) {
        basePosRef.current = [];
        return;
      }

      // Base positions in canvas buffer coords (before the pan/zoom view transform).
      const bp: { x: number; y: number }[] = new Array(pts.length);
      if (align) {
        const basis = faceBasis2D(pts);
        const S = ch / 3.2;
        for (let i = 0; i < pts.length; i++) {
          const c = projectCanonical(pts[i], basis);
          bp[i] = { x: cw / 2 + c.x * S, y: ch * 0.32 + c.y * S };
        }
      } else {
        for (let i = 0; i < pts.length; i++)
          bp[i] = { x: pts[i].x * cw, y: pts[i].y * ch };
      }
      basePosRef.current = bp;

      // Metrics + min/max tracking for every configured shape.
      const cfg = configRef.current;
      const ref = referenceDistance(pts);
      for (const shape in cfg) {
        const sc = cfg[shape];
        if (sc.markers.length < 2 || ref < 1e-6) continue;
        const m = sumPairwiseDistance(pts, sc.markers) / ref;
        liveMetricRef.current[shape] = m;
        tracker(shape).observe(m);
      }

      // Screen position helper (apply view transform); handles draw at constant size.
      const sx = (p: { x: number; y: number }) => v.ox + p.x * v.scale;
      const sy = (p: { x: number; y: number }) => v.oy + p.y * v.scale;

      ctx.fillStyle = 'rgba(120,180,255,0.35)';
      for (let i = 0; i < bp.length; i++) {
        ctx.beginPath();
        ctx.arc(sx(bp[i]), sy(bp[i]), 1.3, 0, 7);
        ctx.fill();
      }
      const fShape = focusedRef.current;
      const fcfg = fShape ? cfg[fShape] : undefined;
      if (fcfg) {
        ctx.strokeStyle = 'rgba(74,222,128,0.7)';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < fcfg.markers.length; i++)
          for (let j = i + 1; j < fcfg.markers.length; j++) {
            const a = bp[fcfg.markers[i]];
            const b = bp[fcfg.markers[j]];
            if (!a || !b) continue;
            ctx.beginPath();
            ctx.moveTo(sx(a), sy(a));
            ctx.lineTo(sx(b), sy(b));
            ctx.stroke();
          }
        ctx.fillStyle = '#4ade80';
        for (const idx of fcfg.markers) {
          const p = bp[idx];
          if (!p) continue;
          ctx.beginPath();
          ctx.arc(sx(p), sy(p), 4, 0, 7);
          ctx.fill();
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── ~10fps snapshot for the table + focused range readout ─────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const pts = ptsRef.current;
      const cfg = configRef.current;
      if (pts && pts.length >= 478) {
        const ref = referenceDistance(pts);
        const h: Record<string, number> = {};
        for (const shape in cfg) {
          const sc = cfg[shape];
          if (sc.markers.length < 2 || ref < 1e-6) continue;
          h[shape] = shapeWeight(
            sumPairwiseDistance(pts, sc.markers) / ref,
            sc
          );
        }
        setHeur(h);
      }
      setNative({ ...(camRef.current?.nativeBlendshapes ?? {}) });
      const f = focusedRef.current;
      const t = f ? trackersRef.current.get(f) : undefined;
      setLiveRange(t && t.valid ? { min: t.min, max: t.max } : null);
    }, 100);
    return () => clearInterval(id);
  }, []);

  // Keep the JSON textarea in sync when config changes via the UI.
  useEffect(() => {
    setJsonText(serializeConfig(config));
  }, [config]);

  // ── Mutations ─────────────────────────────────────────────────────────────
  const patchShape = useCallback(
    (shape: string, patch: Partial<ArkitShapeConfig>) => {
      setConfig((c) => {
        const next = clone(c);
        next[shape] = {
          ...(next[shape] ?? { markers: [], min: 0, max: 1 }),
          ...patch,
        };
        return next;
      });
    },
    []
  );

  const toggleNearest = useCallback((clientX: number, clientY: number) => {
    const shape = focusedRef.current;
    const cv = canvasRef.current;
    if (!shape || !cv) return;
    const rect = cv.getBoundingClientRect();
    const { w, h } = sizeRef.current;
    const mx = ((clientX - rect.left) / rect.width) * w;
    const my = ((clientY - rect.top) / rect.height) * h;
    const v = viewRef.current;
    const bp = basePosRef.current;
    let best = -1;
    let bestD = HIT_RADIUS * HIT_RADIUS;
    for (let i = 0; i < bp.length; i++) {
      const dx = v.ox + bp[i].x * v.scale - mx;
      const dy = v.oy + bp[i].y * v.scale - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return;
    setConfig((c) => {
      const next = clone(c);
      const sc = next[shape] ?? { markers: [], min: 0, max: 1 };
      sc.markers = sc.markers.includes(best)
        ? sc.markers.filter((m) => m !== best)
        : [...sc.markers, best];
      next[shape] = sc;
      return next;
    });
    tracker(shape).reset(); // marker set changed → re-learn range
  }, []);

  // Press = potential click; movement past slop = pan.
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragRef.current = { down: true, moved: false, x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.down) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    d.moved = true;
    const cv = canvasRef.current;
    const rect = cv?.getBoundingClientRect();
    const { w } = sizeRef.current;
    const px = rect ? w / rect.width : 1; // CSS px → buffer px
    viewRef.current.ox += dx * px;
    viewRef.current.oy += dy * px;
    d.x = e.clientX;
    d.y = e.clientY;
  }, []);
  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      d.down = false;
      if (!d.moved) toggleNearest(e.clientX, e.clientY);
    },
    [toggleNearest]
  );

  const resetView = useCallback(() => {
    viewRef.current = { scale: 1, ox: 0, oy: 0 };
  }, []);

  const applyJson = useCallback(() => {
    const { config: c, error } = parseConfig(jsonText);
    if (error || !c) {
      setJsonErr(error ?? 'parse error');
      return;
    }
    setJsonErr('');
    setConfig(c);
    trackersRef.current.clear();
  }, [jsonText]);

  const fcfg = focused ? config[focused] : undefined;
  const liveMetric = focused ? liveMetricRef.current[focused] : undefined;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={S.win}>
      <div style={S.titlebar}>
        <span style={{ flex: 1, fontWeight: 600 }}>
          Face heuristic calibration
        </span>
        <button style={S.iconBtn} onClick={onClose}>
          ✕
        </button>
      </div>
      <div style={S.body}>
        {/* Left: preview + focused-shape editor */}
        <div style={S.leftCol}>
          <div ref={previewRef} style={S.previewWrap}>
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              style={S.canvas}
            />
          </div>
          <div style={S.toolbar}>
            <label style={S.check}>
              <input
                type="checkbox"
                checked={frontAlign}
                onChange={(e) => setFrontAlign(e.target.checked)}
              />
              front-align
            </label>
            <button style={S.smBtn} onClick={resetView}>
              reset view
            </button>
            <span style={{ color: '#666', fontSize: 10 }}>
              wheel = zoom · drag = pan · click = toggle marker
            </span>
          </div>

          {focused && fcfg && (
            <div style={S.editor}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{focused}</div>
              <div style={{ marginBottom: 4 }}>
                markers:{' '}
                {fcfg.markers.length ? (
                  fcfg.markers.map((m) => (
                    <span key={m} style={S.chip}>
                      {m}
                      <span
                        style={S.chipX}
                        onClick={() =>
                          patchShape(focused, {
                            markers: fcfg.markers.filter((x) => x !== m),
                          })
                        }
                      >
                        ×
                      </span>
                    </span>
                  ))
                ) : (
                  <i style={{ color: '#888' }}>none — click handles</i>
                )}
              </div>
              <label style={S.check}>
                <input
                  type="checkbox"
                  checked={!!fcfg.invert}
                  onChange={(e) =>
                    patchShape(focused, { invert: e.target.checked })
                  }
                />
                invert
              </label>
              <div style={{ fontSize: 11, color: '#aaa', margin: '4px 0' }}>
                metric: {liveMetric != null ? liveMetric.toFixed(4) : '—'} ·
                live auto:{' '}
                {liveRange
                  ? `${liveRange.min.toFixed(4)} … ${liveRange.max.toFixed(4)}`
                  : '—'}
              </div>
              {(['min', 'max'] as const).map((k) => (
                <div key={k} style={S.rangeRow}>
                  <span style={{ width: 26 }}>{k}</span>
                  <input
                    type="number"
                    step={0.005}
                    value={fcfg[k]}
                    onChange={(e) =>
                      patchShape(focused, { [k]: Number(e.target.value) })
                    }
                    style={S.num}
                  />
                  <button
                    style={S.smBtn}
                    title="copy live auto into this field"
                    onClick={() =>
                      liveRange && patchShape(focused, { [k]: liveRange[k] })
                    }
                  >
                    keep
                  </button>
                  <button
                    style={S.smBtn}
                    title="set from current frame's metric"
                    onClick={() =>
                      liveMetric != null &&
                      patchShape(focused, { [k]: liveMetric })
                    }
                  >
                    capture
                  </button>
                </div>
              ))}
              <button
                style={{ ...S.smBtn, marginTop: 4 }}
                onClick={() => tracker(focused).reset()}
              >
                reset auto range
              </button>
            </div>
          )}
        </div>

        {/* Right: shape table + JSON */}
        <div style={S.rightCol}>
          <div style={S.tableHead}>
            <span style={{ flex: 1 }}>shape</span>
            <span style={{ width: 60, textAlign: 'right' }}>heur</span>
            <span style={{ width: 60, textAlign: 'right' }}>native</span>
          </div>
          <div style={S.tableBody}>
            {(ARKIT_SHAPES as readonly string[]).map((shape) => {
              const configured = (config[shape]?.markers.length ?? 0) >= 2;
              const hv = heur[shape] ?? 0;
              const nv = native[shape] ?? 0;
              return (
                <div
                  key={shape}
                  onClick={() => setFocused(shape)}
                  style={{
                    ...S.tableRow,
                    background: focused === shape ? '#243' : 'transparent',
                    color: configured ? '#ddd' : '#777',
                  }}
                >
                  <span style={{ flex: 1 }}>{shape}</span>
                  <span style={S.cell}>
                    <span style={S.bar(hv, '#4ade80')} />
                    {hv.toFixed(2)}
                  </span>
                  <span style={S.cell}>
                    <span style={S.bar(nv, '#60a5fa')} />
                    {nv.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            spellCheck={false}
            style={S.json}
          />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button style={S.smBtn} onClick={applyJson}>
              apply JSON
            </button>
            <button
              style={S.smBtn}
              onClick={() => navigator.clipboard?.writeText(jsonText)}
            >
              copy
            </button>
            {jsonErr && (
              <span style={{ color: '#f87171', fontSize: 11 }}>{jsonErr}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────
const S = {
  win: {
    position: 'fixed',
    top: 32,
    left: 32,
    width: 880,
    height: 620,
    minWidth: 560,
    minHeight: 420,
    display: 'flex',
    flexDirection: 'column',
    resize: 'both',
    overflow: 'hidden',
    background: '#1b1b1b',
    border: '1px solid #333',
    borderRadius: 8,
    boxShadow: '0 8px 40px rgba(0,0,0,.7)',
    color: '#ddd',
    font: '12px system-ui, sans-serif',
    zIndex: 99999,
  } as React.CSSProperties,
  titlebar: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 10px',
    background: '#222',
    borderRadius: '8px 8px 0 0',
    flex: '0 0 auto',
  } as React.CSSProperties,
  iconBtn: {
    background: 'none',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    fontSize: 14,
  } as React.CSSProperties,
  body: {
    display: 'flex',
    gap: 8,
    padding: 8,
    flex: 1,
    minHeight: 0,
  } as React.CSSProperties,
  leftCol: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  } as React.CSSProperties,
  previewWrap: { width: '100%' } as React.CSSProperties,
  canvas: {
    width: '100%',
    display: 'block',
    background: '#111',
    borderRadius: 4,
    cursor: 'crosshair',
    touchAction: 'none',
  } as React.CSSProperties,
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  } as React.CSSProperties,
  rightCol: {
    width: 300,
    flex: '0 0 auto',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  } as React.CSSProperties,
  check: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    color: '#aaa',
    cursor: 'pointer',
  } as React.CSSProperties,
  editor: {
    marginTop: 6,
    padding: 8,
    background: '#222',
    borderRadius: 4,
  } as React.CSSProperties,
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    background: '#2f4',
    color: '#062',
    borderRadius: 3,
    padding: '0 4px',
    margin: 2,
    fontWeight: 600,
  } as React.CSSProperties,
  chipX: { cursor: 'pointer', fontWeight: 700 } as React.CSSProperties,
  rangeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    marginTop: 3,
  } as React.CSSProperties,
  num: {
    width: 70,
    background: '#2a2a2a',
    border: '1px solid #3a3a3a',
    color: '#eee',
    borderRadius: 3,
    padding: '1px 4px',
  } as React.CSSProperties,
  smBtn: {
    background: '#333',
    border: '1px solid #444',
    color: '#ccc',
    borderRadius: 3,
    padding: '1px 6px',
    cursor: 'pointer',
    fontSize: 11,
  } as React.CSSProperties,
  tableHead: {
    display: 'flex',
    padding: '2px 4px',
    color: '#888',
    borderBottom: '1px solid #333',
    flex: '0 0 auto',
  } as React.CSSProperties,
  tableBody: {
    flex: 1,
    minHeight: 80,
    overflowY: 'auto',
    fontSize: 11,
  } as React.CSSProperties,
  tableRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '1px 4px',
    cursor: 'pointer',
  } as React.CSSProperties,
  cell: {
    width: 60,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 3,
  } as React.CSSProperties,
  bar: (v: number, color: string): React.CSSProperties => ({
    width: 22 * Math.max(0, Math.min(1, v)),
    height: 6,
    background: color,
    borderRadius: 2,
  }),
  json: {
    width: '100%',
    height: 120,
    marginTop: 6,
    background: '#111',
    color: '#9c9',
    border: '1px solid #333',
    borderRadius: 4,
    font: '10px monospace',
    resize: 'vertical',
    flex: '0 0 auto',
  } as React.CSSProperties,
};

// ── Console-mounted singleton ─────────────────────────────────────────────────
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function unmount(): void {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
}

export function mountFaceCal(): void {
  if (host) return; // already open
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<FaceCalibrationWindow onClose={unmount} />);
}

declare global {
  interface Window {
    dev_facecal?: () => void;
  }
}
if (typeof window !== 'undefined') window.dev_facecal = mountFaceCal;
