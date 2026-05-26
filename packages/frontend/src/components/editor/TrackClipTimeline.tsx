import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditorStore } from '../../store/editorStore'
import { api, ApiError } from '../../api/client'
import type {
  TrackClipRecord, TrackClipLaneRecord, TrackClipKeyframeRecord,
  TrackClipTargetKind, TrackClipMode, TrackClipEasing,
} from '../../api/client'

const LANE_HEIGHT = 56                  // tall enough to visualise the envelope shape
const LANE_LABEL_WIDTH = 200
const KF_RADIUS = 5
const HANDLE_RADIUS = 4

const SCENE_NODE_PARAMS = [
  { group: 'position', axes: ['x', 'y', 'z'] as const },
  { group: 'rotation', axes: ['x', 'y', 'z'] as const },
  { group: 'scale',    axes: ['x', 'y', 'z'] as const },
]
const COMPOSE_LAYER_PARAMS = ['x', 'y', 'rotation'] as const

export function TrackClipTimeline() {
  const trackClips           = useEditorStore((s) => s.trackClips)
  const selectedTrackClipId  = useEditorStore((s) => s.selectedTrackClipId)
  const selectTrackClip      = useEditorStore((s) => s.selectTrackClip)
  const activeSceneId        = useEditorStore((s) => s.activeSceneId)
  const addTrackClip         = useEditorStore((s) => s.addTrackClip)
  const updateTrackClipLocal = useEditorStore((s) => s.updateTrackClipLocal)
  const removeTrackClip      = useEditorStore((s) => s.removeTrackClip)
  const playback             = useEditorStore((s) => s.trackClipPlayback)

  const sceneClips = useMemo(
    () => trackClips.filter((c) => c.sceneId === activeSceneId),
    [trackClips, activeSceneId],
  )
  const selectedClip = sceneClips.find((c) => c.id === selectedTrackClipId) ?? null

  const handleCreate = async () => {
    if (!activeSceneId) return
    const clip = await api.createTrackClip(activeSceneId, { name: 'Clip', duration: 2, loop: false, mode: 'override', autoplay: false })
    addTrackClip(clip)
    selectTrackClip(clip.id)
  }

  const handleDelete = async (id: string) => {
    await api.deleteTrackClip(id)
    removeTrackClip(id)
  }

  if (!activeSceneId) {
    return <div style={{ color: '#555', fontSize: 12, padding: 12 }}>Select a scene first.</div>
  }

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {/* Clip list */}
      <div style={{
        width: 220, flexShrink: 0, borderRight: '1px solid #2a2a2a',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: 8, borderBottom: '1px solid #2a2a2a' }}>
          <button onClick={handleCreate} style={btnPrimary}>+ New Clip</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {sceneClips.length === 0 && (
            <div style={{ color: '#555', fontSize: 11, padding: 12, textAlign: 'center' }}>
              No clips. Click + New Clip to start.
            </div>
          )}
          {sceneClips.map((clip) => {
            const playing = !!playback[clip.id]
            return (
              <div
                key={clip.id}
                onClick={() => selectTrackClip(clip.id)}
                style={{
                  padding: '6px 8px',
                  borderBottom: '1px solid #1f1f1f',
                  cursor: 'pointer',
                  background: clip.id === selectedTrackClipId ? '#2a3a4a' : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}
              >
                <span style={{ color: '#ddd', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {playing ? '▶ ' : ''}{clip.name}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(clip.id) }}
                  style={btnDanger}
                  title="Delete clip"
                >×</button>
              </div>
            )
          })}
        </div>
      </div>

      {/* Timeline editor */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {selectedClip ? (
          <TimelineEditor key={selectedClip.id} clip={selectedClip} onUpdate={updateTrackClipLocal} />
        ) : (
          <div style={{ color: '#555', fontSize: 12, padding: 12 }}>
            Select a clip from the list, or create a new one.
          </div>
        )}
      </div>
    </div>
  )
}

/** {laneId, keyframeId} for the currently-edited keyframe. */
interface SelectedKey { laneId: string; keyframeId: string }

function TimelineEditor({
  clip, onUpdate,
}: {
  clip: TrackClipRecord
  onUpdate: (clip: TrackClipRecord) => void
}) {
  const selectedNodeId       = useEditorStore((s) => s.selectedNodeId)
  const selectedComposeId    = useEditorStore((s) => s.selectedComposeLayerId)
  const nodes                = useEditorStore((s) => s.nodes)
  const composeLayers        = useEditorStore((s) => s.composeLayers)
  const playback             = useEditorStore((s) => s.trackClipPlayback)
  const addTrackClipLane     = useEditorStore((s) => s.addTrackClipLane)
  const removeTrackClipLaneStore = useEditorStore((s) => s.removeTrackClipLane)
  const replaceTrackClipLaneKeyframes = useEditorStore((s) => s.replaceTrackClipLaneKeyframes)

  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<SelectedKey | null>(null)

  // Drop the selection if the underlying keyframe no longer exists (deleted, lane removed).
  useEffect(() => {
    if (!selected) return
    const lane = clip.lanes.find((l) => l.id === selected.laneId)
    if (!lane || !lane.keyframes.some((k) => k.id === selected.keyframeId)) {
      setSelected(null)
    }
  }, [clip, selected])

  const handlePatchClip = async (patch: Partial<Pick<TrackClipRecord, 'name' | 'duration' | 'loop' | 'mode' | 'autoplay'>>) => {
    const updated = await api.updateTrackClip(clip.id, patch)
    onUpdate(updated)
  }

  const handlePlay   = () => api.triggerTrackClip(clip.id).catch(() => {})
  const handleStop   = () => api.stopTrackClip(clip.id).catch(() => {})
  const handlePause  = () => api.pauseTrackClip(clip.id).catch(() => {})
  const handleResume = () => api.resumeTrackClip(clip.id).catch(() => {})
  const handleSeek   = (t: number) => api.seekTrackClip(clip.id, t).catch(() => {})

  const handleAddLane = async (kind: TrackClipTargetKind, targetId: string, paramPath: string, defaultValue: number) => {
    const lane = await api.createTrackClipLane(clip.id, { targetKind: kind, targetId, paramPath, defaultValue })
    addTrackClipLane(clip.id, lane)
    setAdding(false)
  }

  const handleDeleteLane = async (laneId: string) => {
    await api.deleteTrackClipLane(laneId)
    removeTrackClipLaneStore(laneId, clip.id)
  }

  const handleReplaceKeyframes = async (laneId: string, keyframes: TrackClipKeyframeRecord[]) => {
    replaceTrackClipLaneKeyframes(laneId, keyframes)
    try {
      await api.replaceTrackClipKeyframes(laneId, keyframes.map((k) => ({
        id: k.id, t: k.t, value: k.value, easing: k.easing,
        inHandleTFraction:  k.inHandleTFraction,  inHandleVFraction:  k.inHandleVFraction,
        outHandleTFraction: k.outHandleTFraction, outHandleVFraction: k.outHandleVFraction,
      })))
    } catch (e) {
      // 404 means the lane no longer exists on the backend (e.g. the DB was
      // wiped or the lane was removed by another client). Drop it locally so
      // we don't keep retrying on every drag tick.
      if (e instanceof ApiError && e.status === 404) {
        removeTrackClipLaneStore(laneId, clip.id)
      }
    }
  }

  const activePlayback = playback[clip.id]
  const selectedLane = selected ? clip.lanes.find((l) => l.id === selected.laneId) ?? null : null
  const selectedKeyframe = selectedLane?.keyframes.find((k) => k.id === selected!.keyframeId) ?? null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, borderBottom: '1px solid #2a2a2a', flexShrink: 0 }}>
        <input
          value={clip.name}
          onChange={(e) => handlePatchClip({ name: e.target.value })}
          style={inputStyle}
        />
        <label style={{ color: '#888', fontSize: 11 }}>dur</label>
        <input
          type="number" step={0.1} min={0.1}
          value={clip.duration}
          onChange={(e) => handlePatchClip({ duration: Number(e.target.value) || clip.duration })}
          style={{ ...inputStyle, width: 60 }}
        />
        <label style={{ color: '#888', fontSize: 11 }}>
          <input type="checkbox" checked={clip.loop} onChange={(e) => handlePatchClip({ loop: e.target.checked })} /> loop
        </label>
        <label style={{ color: '#888', fontSize: 11 }} title={clip.loop ? 'Resume on backend boot' : 'Enable loop first'}>
          <input
            type="checkbox"
            disabled={!clip.loop}
            checked={clip.autoplay}
            onChange={(e) => handlePatchClip({ autoplay: e.target.checked })}
          /> autoplay
        </label>
        <select
          value={clip.mode}
          onChange={(e) => handlePatchClip({ mode: e.target.value as TrackClipMode })}
          style={inputStyle}
        >
          <option value="override">override</option>
          <option value="relative">relative</option>
        </select>
        <div style={{ flex: 1 }} />
        {activePlayback?.kind === 'playing' ? (
          <>
            <button onClick={handlePause} style={btnNeutral}>❚❚ Pause</button>
            <button onClick={handleStop} style={btnStop}>■ Stop</button>
          </>
        ) : activePlayback?.kind === 'paused' ? (
          <>
            <button onClick={handleResume} style={btnPlay}>▶ Resume</button>
            <button onClick={handleStop} style={btnStop}>■ Stop</button>
          </>
        ) : (
          <button onClick={handlePlay} style={btnPlay}>▶ Play</button>
        )}
      </div>

      {/* Scrub ruler — drag to seek; also shows the current playhead time */}
      <ScrubRuler clip={clip} playback={activePlayback ?? null} onSeek={handleSeek} />

      {/* Selected-keyframe properties bar */}
      {selectedLane && selectedKeyframe ? (
        <KeyframeProperties
          lane={selectedLane}
          kf={selectedKeyframe}
          onChange={(updated) => {
            const next = selectedLane.keyframes
              .map((k) => k.id === updated.id ? updated : k)
              .sort((a, b) => a.t - b.t)
            handleReplaceKeyframes(selectedLane.id, next)
          }}
          onDelete={() => {
            handleReplaceKeyframes(selectedLane.id, selectedLane.keyframes.filter((k) => k.id !== selectedKeyframe.id))
            setSelected(null)
          }}
        />
      ) : (
        <div style={{ padding: '4px 8px', color: '#555', fontSize: 11, borderBottom: '1px solid #2a2a2a' }}>
          Click a keyframe to edit its easing, value, and bezier handles.
        </div>
      )}

      {/* Lanes */}
      <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        {clip.lanes.length === 0 && !adding && (
          <div style={{ color: '#555', fontSize: 11, padding: 12 }}>
            No lanes yet. Click <b>+ Add Lane</b> below.
          </div>
        )}
        {clip.lanes.map((lane) => (
          <LaneRow
            key={lane.id}
            clip={clip}
            lane={lane}
            selected={selected && selected.laneId === lane.id ? selected : null}
            onSelectKey={(keyframeId) => setSelected({ laneId: lane.id, keyframeId })}
            onClearSelection={() => { if (selected?.laneId === lane.id) setSelected(null) }}
            onDeleteLane={() => handleDeleteLane(lane.id)}
            onReplaceKeyframes={(kfs) => handleReplaceKeyframes(lane.id, kfs)}
          />
        ))}
      </div>

      {/* Footer: add lane */}
      <div style={{ borderTop: '1px solid #2a2a2a', padding: 8, flexShrink: 0 }}>
        {adding ? (
          <AddLanePicker
            nodes={nodes}
            composeLayers={composeLayers}
            selectedNodeId={selectedNodeId}
            selectedComposeLayerId={selectedComposeId}
            onCancel={() => setAdding(false)}
            onConfirm={handleAddLane}
          />
        ) : (
          <button onClick={() => setAdding(true)} style={btnPrimary}>+ Add Lane</button>
        )}
      </div>
    </div>
  )
}

function KeyframeProperties({
  lane, kf, onChange, onDelete,
}: {
  lane: TrackClipLaneRecord
  kf: TrackClipKeyframeRecord
  onChange: (kf: TrackClipKeyframeRecord) => void
  onDelete: () => void
}) {
  const setEasing = (easing: TrackClipEasing) => {
    if (easing === 'bezier') {
      onChange({ ...kf, easing, ...defaultBezierHandles(kf) })
      return
    }
    onChange({ ...kf, easing, inHandleTFraction: null, inHandleVFraction: null, outHandleTFraction: null, outHandleVFraction: null })
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderBottom: '1px solid #2a2a2a', background: '#181818', fontSize: 11, color: '#bbb' }}>
      <span style={{ color: '#888' }}>{lane.paramPath}</span>
      <span style={{ color: '#555' }}>•</span>
      <label>t</label>
      <input
        type="number" step={0.05}
        value={Number(kf.t.toFixed(3))}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange({ ...kf, t: Math.max(0, v) })
        }}
        style={{ ...inputStyle, width: 70 }}
      />
      <label>v</label>
      <input
        type="number" step={0.1}
        value={kf.value}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange({ ...kf, value: v })
        }}
        style={{ ...inputStyle, width: 80 }}
      />
      <label>easing</label>
      <select value={kf.easing} onChange={(e) => setEasing(e.target.value as TrackClipEasing)} style={inputStyle}>
        <option value="linear">linear</option>
        <option value="step">step</option>
        <option value="bezier">bezier</option>
      </select>
      {kf.easing === 'bezier' && (
        <span style={{ color: '#666' }}>
          in (Δt%={fmtPct(kf.inHandleTFraction)}, Δv%={fmtPct(kf.inHandleVFraction)})
          &nbsp;·&nbsp; out (Δt%={fmtPct(kf.outHandleTFraction)}, Δv%={fmtPct(kf.outHandleVFraction)})
        </span>
      )}
      <div style={{ flex: 1 }} />
      <button onClick={onDelete} style={btnDanger}>Delete keyframe</button>
    </div>
  )
}

function fmtPct(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(0)}%`
}

/** Fraction of the adjoining segment length used as the default bezier handle Δt. */
export const DEFAULT_HANDLE_T_FRACTION = 0.5

/** Seed default bezier handle fractions for a keyframe. Δt fraction defaults
 *  to 0.5, Δv fraction to 0 (flat tangents). Both sides are always seeded,
 *  even when a neighbour is currently missing — the value is dormant until a
 *  neighbour appears, at which point the curve picks it up automatically.
 *  Existing handle values are preserved. */
export function defaultBezierHandles(
  kf: TrackClipKeyframeRecord,
  fraction: number = DEFAULT_HANDLE_T_FRACTION,
): Pick<TrackClipKeyframeRecord, 'inHandleTFraction' | 'inHandleVFraction' | 'outHandleTFraction' | 'outHandleVFraction'> {
  return {
    outHandleTFraction: kf.outHandleTFraction ?? fraction,
    outHandleVFraction: kf.outHandleVFraction ?? 0,
    inHandleTFraction:  kf.inHandleTFraction  ?? fraction,
    inHandleVFraction:  kf.inHandleVFraction  ?? 0,
  }
}

/** Resolved (absolute) handle endpoints for a keyframe, given its time-adjacent
 *  siblings. Used by the timeline UI to draw + hit-test handles. Returns null
 *  for a handle whose neighbour is missing or whose fraction isn't set. */
function resolveHandleEndpoints(
  prev: TrackClipKeyframeRecord | null,
  kf:   TrackClipKeyframeRecord,
  next: TrackClipKeyframeRecord | null,
): {
  out: { t: number; value: number } | null
  in:  { t: number; value: number } | null
} {
  let out: { t: number; value: number } | null = null
  if (next && kf.outHandleTFraction != null && kf.outHandleVFraction != null) {
    out = {
      t:     kf.t     + (next.t     - kf.t)     * kf.outHandleTFraction,
      value: kf.value + (next.value - kf.value) * kf.outHandleVFraction,
    }
  }
  let inEp: { t: number; value: number } | null = null
  if (prev && kf.inHandleTFraction != null && kf.inHandleVFraction != null) {
    inEp = {
      t:     kf.t     - (kf.t     - prev.t)     * kf.inHandleTFraction,
      value: kf.value - (kf.value - prev.value) * kf.inHandleVFraction,
    }
  }
  return { out, in: inEp }
}

function siblings(
  lane: TrackClipLaneRecord, kf: TrackClipKeyframeRecord,
): { prev: TrackClipKeyframeRecord | null; next: TrackClipKeyframeRecord | null } {
  const idx = lane.keyframes.findIndex((k) => k.id === kf.id)
  if (idx < 0) {
    const sortedByT = [...lane.keyframes].sort((a, b) => a.t - b.t)
    return {
      prev: [...sortedByT].reverse().find((k) => k.t < kf.t) ?? null,
      next: sortedByT.find((k) => k.t > kf.t) ?? null,
    }
  }
  return {
    prev: idx > 0 ? lane.keyframes[idx - 1] : null,
    next: idx < lane.keyframes.length - 1 ? lane.keyframes[idx + 1] : null,
  }
}

function AddLanePicker({
  nodes, composeLayers, selectedNodeId, selectedComposeLayerId, onCancel, onConfirm,
}: {
  nodes: { id: string; name: string }[]
  composeLayers: { id: string; name: string }[]
  selectedNodeId: string | null
  selectedComposeLayerId: string | null
  onCancel: () => void
  onConfirm: (kind: TrackClipTargetKind, targetId: string, paramPath: string, defaultValue: number) => void
}) {
  const initialKind: TrackClipTargetKind = selectedComposeLayerId ? 'compose_layer' : 'scene_node'
  const [kind, setKind] = useState<TrackClipTargetKind>(initialKind)
  const [targetId, setTargetId] = useState<string>(
    initialKind === 'compose_layer' ? (selectedComposeLayerId ?? '') : (selectedNodeId ?? ''),
  )
  const [paramPath, setParamPath] = useState<string>(initialKind === 'compose_layer' ? 'x' : 'position.x')

  const targets = kind === 'scene_node' ? nodes : composeLayers
  const paramOptions = kind === 'scene_node'
    ? SCENE_NODE_PARAMS.flatMap((g) => g.axes.map((a) => `${g.group}.${a}`))
    : COMPOSE_LAYER_PARAMS as readonly string[]

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <select value={kind} onChange={(e) => {
        const k = e.target.value as TrackClipTargetKind
        setKind(k)
        setTargetId(k === 'scene_node' ? (selectedNodeId ?? '') : (selectedComposeLayerId ?? ''))
        setParamPath(k === 'scene_node' ? 'position.x' : 'x')
      }} style={inputStyle}>
        <option value="scene_node">Scene node</option>
        <option value="compose_layer">Compose layer</option>
      </select>
      <select value={targetId} onChange={(e) => setTargetId(e.target.value)} style={inputStyle}>
        <option value="">— select target —</option>
        {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <select value={paramPath} onChange={(e) => setParamPath(e.target.value)} style={inputStyle}>
        {paramOptions.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      <button
        disabled={!targetId}
        onClick={() => onConfirm(kind, targetId, paramPath, 0)}
        style={btnPrimary}
      >Add</button>
      <button onClick={onCancel} style={btnDanger}>Cancel</button>
    </div>
  )
}

/** Compute the current playhead time (seconds) for a playback entry, handling
 *  both live playback (advances with wall clock) and paused (frozen). */
function computePlayheadT(
  playback: import('../../store/editorStore').TrackClipPlayback | null,
  duration: number,
): number | null {
  if (!playback) return null
  if (duration <= 0) return 0
  if (playback.kind === 'paused') return playback.pausedAtT
  const tRaw = ((Date.now() + playback.clockOffsetMs) - playback.startedAt) / 1000
  if (playback.loop) {
    const w = tRaw % duration
    return w < 0 ? w + duration : w
  }
  return Math.max(0, Math.min(duration, tRaw))
}

/** Top ruler row: shows tick marks + a draggable playhead. Pointer-drag seeks
 *  the backend playhead, which broadcasts back via `track_clip_started/paused`. */
function ScrubRuler({
  clip, playback, onSeek,
}: {
  clip: TrackClipRecord
  playback: import('../../store/editorStore').TrackClipPlayback | null
  onSeek: (t: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [, forceTick] = useState(0)
  // Re-render the playhead each frame while playing (so the indicator advances live).
  useEffect(() => {
    if (playback?.kind !== 'playing') return
    let raf = 0
    const tick = () => { forceTick((n) => (n + 1) % 1_000_000); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playback?.kind])

  const t = computePlayheadT(playback, clip.duration) ?? 0
  const pct = (t / Math.max(0.0001, clip.duration)) * 100

  const xToT = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return 0
    const x = clientX - rect.left
    return Math.max(0, Math.min(clip.duration, (x / rect.width) * clip.duration))
  }

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    onSeek(xToT(e.clientX))
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.buttons & 1) === 0) return
    onSeek(xToT(e.clientX))
  }

  // Tick marks every 0.5s (or scale up if the clip is very long).
  const tickStep = clip.duration > 30 ? 5 : clip.duration > 10 ? 1 : 0.5
  const ticks: number[] = []
  for (let tt = 0; tt <= clip.duration + 1e-9; tt += tickStep) ticks.push(tt)

  return (
    <div style={{ display: 'flex', borderBottom: '1px solid #2a2a2a', height: 22, background: '#181818' }}>
      <div style={{ width: LANE_LABEL_WIDTH, flexShrink: 0, fontSize: 11, color: '#888', padding: '0 8px', display: 'flex', alignItems: 'center', borderRight: '1px solid #2a2a2a' }}>
        playhead: {t.toFixed(2)}s
      </div>
      <div
        ref={ref}
        onPointerDown={onDown}
        onPointerMove={onMove}
        style={{ flex: 1, position: 'relative', cursor: 'ew-resize', userSelect: 'none' }}
        title="Drag to scrub"
      >
        {ticks.map((tt) => (
          <div
            key={tt}
            style={{
              position: 'absolute', top: 0, bottom: 0,
              left: `${(tt / Math.max(0.0001, clip.duration)) * 100}%`,
              borderLeft: '1px solid #2a2a2a',
              paddingLeft: 3, fontSize: 9, color: '#555', lineHeight: '22px',
              pointerEvents: 'none',
            }}
          >{tt.toFixed(tickStep < 1 ? 1 : 0)}s</div>
        ))}
        {/* Playhead handle */}
        <div style={{
          position: 'absolute', top: 0, bottom: 0,
          left: `${pct}%`,
          width: 2, marginLeft: -1,
          background: '#ff5050', pointerEvents: 'none',
        }} />
        <div style={{
          position: 'absolute', top: 2,
          left: `calc(${pct}% - 5px)`,
          width: 10, height: 10, background: '#ff5050',
          clipPath: 'polygon(0 0, 100% 0, 50% 100%)',
          pointerEvents: 'none',
        }} />
      </div>
    </div>
  )
}

/** Compute the visible value range for a lane so we can map values to lane-relative Y.
 *  Pads slightly so points don't sit exactly on the edge. Always includes lane.defaultValue
 *  so an empty lane still renders at a sensible vertical position. */
function laneValueRange(lane: TrackClipLaneRecord): { min: number; max: number } {
  let min = lane.defaultValue
  let max = lane.defaultValue
  for (const k of lane.keyframes) {
    if (k.value < min) min = k.value
    if (k.value > max) max = k.value
    // Include resolved handle endpoints so they don't escape the visible area.
    const { prev, next } = siblings(lane, k)
    const { in: inEp, out: outEp } = resolveHandleEndpoints(prev, k, next)
    if (outEp) { if (outEp.value < min) min = outEp.value; if (outEp.value > max) max = outEp.value }
    if (inEp)  { if (inEp.value  < min) min = inEp.value;  if (inEp.value  > max) max = inEp.value  }
  }
  if (max === min) { max += 1; min -= 1 }
  const pad = (max - min) * 0.1
  return { min: min - pad, max: max + pad }
}

function LaneRow({
  clip, lane, selected, onSelectKey, onClearSelection, onDeleteLane, onReplaceKeyframes,
}: {
  clip: TrackClipRecord
  lane: TrackClipLaneRecord
  selected: SelectedKey | null
  onSelectKey: (keyframeId: string) => void
  onClearSelection: () => void
  onDeleteLane: () => void
  onReplaceKeyframes: (kfs: TrackClipKeyframeRecord[]) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const playback = useEditorStore((s) => s.trackClipPlayback[clip.id])
  const [, forceTick] = useState(0)
  // Local size so SVG can render in pixel coordinates instead of percentages
  // (we need pixel-accurate handle math).
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: LANE_HEIGHT })

  // Keep the playhead repainting while the clip is playing. (Not while paused —
  // the playhead doesn't move; a single render off the store update is enough.)
  useEffect(() => {
    if (playback?.kind !== 'playing') return
    let raf = 0
    const tick = () => { forceTick((n) => (n + 1) % 1_000_000); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playback?.kind])

  // Track lane width with ResizeObserver so the SVG scales with the bottom dock.
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const range = useMemo(() => laneValueRange(lane), [lane])

  const tToX = (t: number) => (t / Math.max(0.0001, clip.duration)) * size.w
  const xToT = (x: number) => (x / Math.max(1, size.w)) * clip.duration
  const vToY = (v: number) => {
    const span = range.max - range.min
    if (span <= 0) return size.h / 2
    return size.h - ((v - range.min) / span) * size.h
  }
  const yToV = (y: number) => {
    const span = range.max - range.min
    if (span <= 0) return range.min
    return range.min + ((size.h - y) / size.h) * span
  }

  const playheadT = computePlayheadT(playback ?? null, clip.duration)

  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only respond to plain clicks on empty area — keyframe / handle nodes call stopPropagation.
    if (e.button !== 0) return
    if (!trackRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    const t = xToT(e.clientX - rect.left)
    const v = yToV(e.clientY - rect.top)
    const draft: TrackClipKeyframeRecord = {
      id: cryptoId(),
      t: Math.max(0, Math.min(clip.duration, t)),
      value: v,
      easing: 'bezier',
      inHandleTFraction: null, inHandleVFraction: null,
      outHandleTFraction: null, outHandleVFraction: null,
    }
    // Seed bezier handles from the segments around this insertion point so the
    // user sees a smooth curve immediately.
    const next: TrackClipKeyframeRecord = { ...draft, ...defaultBezierHandles(draft) }
    const merged = [...lane.keyframes, next].sort((a, b) => a.t - b.t)
    onReplaceKeyframes(merged)
    onSelectKey(next.id)
  }

  // Segment curves: each pair of consecutive keyframes produces an SVG path
  // (linear segment / step segment / cubic bezier with handles).
  const segments = useMemo(() => {
    const out: string[] = []
    for (let i = 0; i < lane.keyframes.length - 1; i++) {
      const a = lane.keyframes[i]
      const b = lane.keyframes[i + 1]
      out.push(segmentPath(a, b, tToX, vToY))
    }
    return out
    // tToX / vToY are unstable functions; size is the actual dep that drives layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lane.keyframes, size.w, size.h, range.min, range.max, clip.duration])

  return (
    <div style={{ display: 'flex', borderBottom: '1px solid #1f1f1f', height: LANE_HEIGHT }}>
      <div style={{
        width: LANE_LABEL_WIDTH, flexShrink: 0, padding: '0 6px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderRight: '1px solid #2a2a2a', background: '#181818',
      }}>
        <span style={{ color: '#bbb', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {lane.paramPath}
          <span style={{ color: '#555', marginLeft: 6 }}>
            [{range.min.toFixed(2)}, {range.max.toFixed(2)}]
          </span>
        </span>
        <button onClick={onDeleteLane} style={btnDanger} title="Remove lane">×</button>
      </div>
      <div
        ref={trackRef}
        onPointerDown={handleTrackPointerDown}
        style={{
          flex: 1, position: 'relative', cursor: 'crosshair',
          background: 'repeating-linear-gradient(to right, #161616 0 1px, transparent 1px 50px)',
        }}
      >
        {/* Curve overlay — non-interactive */}
        {size.w > 0 && (
          <svg
            width={size.w} height={size.h}
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          >
            {/* Default-value horizontal guide */}
            <line
              x1={0} x2={size.w}
              y1={vToY(lane.defaultValue)} y2={vToY(lane.defaultValue)}
              stroke="#2c2c2c" strokeDasharray="3 3"
            />
            {segments.map((d, i) => (
              <path key={i} d={d} fill="none" stroke="#6a8aa8" strokeWidth={1.5} />
            ))}
            {/* Handle visualisation for the selected keyframe (only) */}
            {selected && lane.keyframes.map((kf) => {
              if (kf.id !== selected.keyframeId || kf.easing !== 'bezier') return null
              const { prev, next } = siblings(lane, kf)
              const { in: inEp, out: outEp } = resolveHandleEndpoints(prev, kf, next)
              const kx = tToX(kf.t)
              const ky = vToY(kf.value)
              return (
                <g key={`hg-${kf.id}`}>
                  {inEp && (
                    <line
                      x1={kx} y1={ky}
                      x2={tToX(inEp.t)} y2={vToY(inEp.value)}
                      stroke="#557799" strokeDasharray="2 2"
                    />
                  )}
                  {outEp && (
                    <line
                      x1={kx} y1={ky}
                      x2={tToX(outEp.t)} y2={vToY(outEp.value)}
                      stroke="#557799" strokeDasharray="2 2"
                    />
                  )}
                </g>
              )
            })}
          </svg>
        )}

        {/* Keyframe dots + (when selected & bezier) handle dots — interactive layer */}
        {lane.keyframes.map((kf) => {
          const isSelected = selected?.keyframeId === kf.id
          const { prev, next } = siblings(lane, kf)
          return (
            <KeyframeDot
              key={kf.id}
              kf={kf}
              prev={prev}
              next={next}
              selected={isSelected}
              duration={clip.duration}
              trackRef={trackRef}
              size={size}
              range={range}
              onSelect={() => onSelectKey(kf.id)}
              onChange={(updated) => {
                const nextList = lane.keyframes
                  .map((k) => k.id === updated.id ? updated : k)
                  .sort((a, b) => a.t - b.t)
                onReplaceKeyframes(nextList)
              }}
              onDelete={() => {
                onReplaceKeyframes(lane.keyframes.filter((k) => k.id !== kf.id))
                if (isSelected) onClearSelection()
              }}
            />
          )
        })}

        {playheadT != null && size.w > 0 && (
          <div style={{
            position: 'absolute', top: 0, bottom: 0,
            left: tToX(playheadT),
            width: 1, background: '#ff5050', pointerEvents: 'none',
          }} />
        )}
        <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 1, background: '#2a2a2a' }} />
      </div>
    </div>
  )
}

function segmentPath(
  a: TrackClipKeyframeRecord,
  b: TrackClipKeyframeRecord,
  tToX: (t: number) => number,
  vToY: (v: number) => number,
): string {
  const ax = tToX(a.t), ay = vToY(a.value)
  const bx = tToX(b.t), by = vToY(b.value)
  if (a.easing === 'step') {
    // Hold a's value until b's time, then jump.
    return `M ${ax} ${ay} L ${bx} ${ay} L ${bx} ${by}`
  }
  if (
    a.easing === 'bezier' &&
    a.outHandleTFraction != null && a.outHandleVFraction != null &&
    b.inHandleTFraction  != null && b.inHandleVFraction  != null
  ) {
    // Handles are fractions of THIS segment's (Δt, Δv); resolve in pixel space.
    const dt = b.t     - a.t
    const dv = b.value - a.value
    const c1x = tToX(a.t     + dt * a.outHandleTFraction)
    const c1y = vToY(a.value + dv * a.outHandleVFraction)
    const c2x = tToX(b.t     - dt * b.inHandleTFraction)
    const c2y = vToY(b.value - dv * b.inHandleVFraction)
    return `M ${ax} ${ay} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${bx} ${by}`
  }
  return `M ${ax} ${ay} L ${bx} ${by}`
}

function KeyframeDot({
  kf, prev, next, selected, duration, trackRef, size, range, onSelect, onChange, onDelete,
}: {
  kf: TrackClipKeyframeRecord
  prev: TrackClipKeyframeRecord | null
  next: TrackClipKeyframeRecord | null
  selected: boolean
  duration: number
  trackRef: React.RefObject<HTMLDivElement | null>
  size: { w: number; h: number }
  range: { min: number; max: number }
  onSelect: () => void
  onChange: (kf: TrackClipKeyframeRecord) => void
  onDelete: () => void
}) {
  const dragKindRef = useRef<'kf' | 'in' | 'out' | null>(null)

  const xToT = (x: number) => (x / Math.max(1, size.w)) * duration
  const yToV = (y: number) => {
    const span = range.max - range.min
    if (span <= 0) return range.min
    return range.min + ((size.h - y) / size.h) * span
  }
  const tToX = (t: number) => (t / Math.max(0.0001, duration)) * size.w
  const vToY = (v: number) => {
    const span = range.max - range.min
    if (span <= 0) return size.h / 2
    return size.h - ((v - range.min) / span) * size.h
  }

  const handleDotDown = (kind: 'kf' | 'in' | 'out') => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (e.button === 2 && kind === 'kf') { onDelete(); return }
    onSelect()
    dragKindRef.current = kind
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragKindRef.current || !trackRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    const tAbs = xToT(e.clientX - rect.left)
    const vAbs = yToV(e.clientY - rect.top)
    if (dragKindRef.current === 'kf') {
      onChange({ ...kf, t: Math.max(0, Math.min(duration, tAbs)), value: vAbs })
      return
    }
    // Handle drags update fractions relative to the adjoining segment. Δt is
    // clamped to [0, 1] so the handle can't pass the neighbour keyframe; Δv is
    // free (unbounded above and below).
    if (dragKindRef.current === 'out' && next) {
      const dt = next.t     - kf.t
      const dv = next.value - kf.value
      const fracT = dt > 0 ? Math.max(0, Math.min(1, (tAbs - kf.t) / dt)) : 0
      const fracV = dv !== 0 ? (vAbs - kf.value) / dv : 0
      onChange({ ...kf, outHandleTFraction: fracT, outHandleVFraction: fracV })
      return
    }
    if (dragKindRef.current === 'in' && prev) {
      const dt = kf.t     - prev.t
      const dv = kf.value - prev.value
      const fracT = dt > 0 ? Math.max(0, Math.min(1, (kf.t - tAbs) / dt)) : 0
      const fracV = dv !== 0 ? (kf.value - vAbs) / dv : 0
      onChange({ ...kf, inHandleTFraction: fracT, inHandleVFraction: fracV })
      return
    }
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragKindRef.current = null
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }
  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    onDelete()
  }

  const kx = tToX(kf.t)
  const ky = vToY(kf.value)
  const color = kf.easing === 'step' ? '#aaa' : kf.easing === 'bezier' ? '#8af' : '#fb7'

  // Only show a handle dot when (a) its fraction is set AND (b) the corresponding
  // neighbour exists. Without a neighbour there's no segment for the fraction
  // to be a fraction of, so the curve on that side is flat and the handle is
  // meaningless.
  const showOut = selected && kf.easing === 'bezier'
    && kf.outHandleTFraction != null && kf.outHandleVFraction != null && next != null
  const showIn  = selected && kf.easing === 'bezier'
    && kf.inHandleTFraction  != null && kf.inHandleVFraction  != null && prev != null

  const outEpAbs = showOut ? {
    t:     kf.t     + (next!.t     - kf.t)     * kf.outHandleTFraction!,
    value: kf.value + (next!.value - kf.value) * kf.outHandleVFraction!,
  } : null
  const inEpAbs = showIn ? {
    t:     kf.t     - (kf.t     - prev!.t)     * kf.inHandleTFraction!,
    value: kf.value - (kf.value - prev!.value) * kf.inHandleVFraction!,
  } : null

  return (
    <>
      <div
        onPointerDown={handleDotDown('kf')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu}
        title={`t=${kf.t.toFixed(2)}s  v=${kf.value.toFixed(3)}  (${kf.easing})\nright-click to delete`}
        style={{
          position: 'absolute',
          left: kx - KF_RADIUS,
          top:  ky - KF_RADIUS,
          width: KF_RADIUS * 2, height: KF_RADIUS * 2,
          borderRadius: 2,
          background: color,
          border: selected ? '1px solid #fff' : '1px solid #000',
          boxShadow: selected ? '0 0 0 1px #fff8' : undefined,
          cursor: 'move',
        }}
      />
      {outEpAbs && (
        <div
          onPointerDown={handleDotDown('out')}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          title="out handle"
          style={{
            position: 'absolute',
            left: tToX(outEpAbs.t) - HANDLE_RADIUS,
            top:  vToY(outEpAbs.value) - HANDLE_RADIUS,
            width: HANDLE_RADIUS * 2, height: HANDLE_RADIUS * 2,
            borderRadius: '50%',
            background: '#8af',
            border: '1px solid #fff',
            cursor: 'crosshair',
          }}
        />
      )}
      {inEpAbs && (
        <div
          onPointerDown={handleDotDown('in')}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          title="in handle"
          style={{
            position: 'absolute',
            left: tToX(inEpAbs.t) - HANDLE_RADIUS,
            top:  vToY(inEpAbs.value) - HANDLE_RADIUS,
            width: HANDLE_RADIUS * 2, height: HANDLE_RADIUS * 2,
            borderRadius: '50%',
            background: '#8af',
            border: '1px solid #fff',
            cursor: 'crosshair',
          }}
        />
      )}
    </>
  )
}

function cryptoId(): string {
  const c: { randomUUID?: () => string } = (globalThis.crypto ?? {}) as { randomUUID?: () => string }
  return c.randomUUID ? c.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8))
}

// --- styles ---

const inputStyle: React.CSSProperties = {
  background: '#1a1a1a', color: '#ddd', border: '1px solid #333', borderRadius: 3,
  fontSize: 11, padding: '2px 6px',
}
const btnPrimary: React.CSSProperties = {
  background: '#2a4a6a', color: '#fff', border: '1px solid #3a5a8a', borderRadius: 3,
  fontSize: 11, padding: '3px 10px', cursor: 'pointer',
}
const btnDanger: React.CSSProperties = {
  background: 'transparent', color: '#a55', border: '1px solid transparent', borderRadius: 3,
  fontSize: 11, padding: '0 6px', cursor: 'pointer',
}
const btnPlay: React.CSSProperties = {
  background: '#2a6a2a', color: '#fff', border: '1px solid #3a8a3a', borderRadius: 3,
  fontSize: 11, padding: '3px 10px', cursor: 'pointer',
}
const btnStop: React.CSSProperties = {
  background: '#6a2a2a', color: '#fff', border: '1px solid #8a3a3a', borderRadius: 3,
  fontSize: 11, padding: '3px 10px', cursor: 'pointer',
}
const btnNeutral: React.CSSProperties = {
  background: '#3a3a3a', color: '#ddd', border: '1px solid #555', borderRadius: 3,
  fontSize: 11, padding: '3px 10px', cursor: 'pointer',
}
