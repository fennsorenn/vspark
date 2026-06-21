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

const W = 460;
const H = 345;
const HIT_RADIUS = 9;

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
  const screenPosRef = useRef<{ x: number; y: number }[]>([]);
  const trackersRef = useRef<Map<string, MinMaxTracker>>(new Map());
  const liveMetricRef = useRef<Record<string, number>>({});
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

  // ── Per-frame: metrics + overlay ──────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const pts = ptsRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      ctx.clearRect(0, 0, W, H);

      const cam = camRef.current;
      const align = frontAlignRef.current;
      // Background: mirrored video (markers are in mirrored-frame space), or black for align.
      if (!align && cam?.video && cam.video.readyState >= 2) {
        ctx.save();
        ctx.translate(W, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(cam.video, 0, 0, W, H);
        ctx.restore();
      } else {
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, W, H);
      }

      if (!pts || pts.length < 478) {
        screenPosRef.current = [];
        return;
      }

      // Screen positions for every landmark (used for drawing + hit testing).
      const sp: { x: number; y: number }[] = new Array(pts.length);
      if (align) {
        const basis = faceBasis2D(pts);
        const S = H / 3.2;
        for (let i = 0; i < pts.length; i++) {
          const c = projectCanonical(pts[i], basis);
          sp[i] = { x: W / 2 + c.x * S, y: H * 0.32 + c.y * S };
        }
      } else {
        for (let i = 0; i < pts.length; i++)
          sp[i] = { x: pts[i].x * W, y: pts[i].y * H };
      }
      screenPosRef.current = sp;

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

      // Draw all landmarks faintly; highlight the focused shape's markers + edges.
      ctx.fillStyle = 'rgba(120,180,255,0.35)';
      for (let i = 0; i < sp.length; i++) {
        ctx.beginPath();
        ctx.arc(sp[i].x, sp[i].y, 1.1, 0, 7);
        ctx.fill();
      }
      const fShape = focusedRef.current;
      const fcfg = fShape ? cfg[fShape] : undefined;
      if (fcfg) {
        ctx.strokeStyle = 'rgba(74,222,128,0.7)';
        ctx.lineWidth = 1;
        for (let i = 0; i < fcfg.markers.length; i++)
          for (let j = i + 1; j < fcfg.markers.length; j++) {
            const a = sp[fcfg.markers[i]];
            const b = sp[fcfg.markers[j]];
            if (!a || !b) continue;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        ctx.fillStyle = '#4ade80';
        for (const idx of fcfg.markers) {
          const p = sp[idx];
          if (!p) continue;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3.5, 0, 7);
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

  const onCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const shape = focusedRef.current;
      if (!shape) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width) * W;
      const my = ((e.clientY - rect.top) / rect.height) * H;
      const sp = screenPosRef.current;
      let best = -1;
      let bestD = HIT_RADIUS * HIT_RADIUS;
      for (let i = 0; i < sp.length; i++) {
        const dx = sp[i].x - mx;
        const dy = sp[i].y - my;
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
        const has = sc.markers.includes(best);
        sc.markers = has
          ? sc.markers.filter((m) => m !== best)
          : [...sc.markers, best];
        next[shape] = sc;
        return next;
      });
      tracker(shape).reset(); // marker set changed → re-learn range
    },
    []
  );

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
      <div style={{ display: 'flex', gap: 8, padding: 8 }}>
        {/* Left: preview + focused-shape editor */}
        <div style={{ width: W }}>
          <canvas
            ref={canvasRef}
            width={W}
            height={H}
            onClick={onCanvasClick}
            style={S.canvas}
          />
          <label style={S.check}>
            <input
              type="checkbox"
              checked={frontAlign}
              onChange={(e) => setFrontAlign(e.target.checked)}
            />
            front-align preview (overlay only)
          </label>

          {focused && fcfg && (
            <div style={S.editor}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{focused}</div>
              <div style={{ marginBottom: 4 }}>
                markers (click handles to toggle):{' '}
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
                  <i style={{ color: '#888' }}>none</i>
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
        <div style={{ flex: 1, minWidth: 230 }}>
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
    top: 40,
    left: 40,
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
  } as React.CSSProperties,
  iconBtn: {
    background: 'none',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    fontSize: 14,
  } as React.CSSProperties,
  canvas: {
    width: W,
    height: H,
    background: '#111',
    borderRadius: 4,
    cursor: 'crosshair',
    display: 'block',
  } as React.CSSProperties,
  check: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
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
  } as React.CSSProperties,
  tableBody: {
    height: 250,
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
