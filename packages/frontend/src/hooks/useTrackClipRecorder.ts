import { useCallback } from 'react'
import { useEditorStore } from '../store/editorStore'
import { api } from '../api/client'
import type {
  TrackClipKeyframeRecord, TrackClipLaneRecord, TrackClipTargetKind,
} from '../api/client'
import { defaultBezierHandles } from '../components/editor/TrackClipTimeline'

const KF_TIME_EPSILON = 1e-3

interface RecordOpts {
  targetKind: TrackClipTargetKind
  targetId: string
  paramPath: string
  value: number
}

/** Hook: emits keyframe-recording actions targeted at the currently-selected track clip,
 *  at the clip's current playhead (live playback time, or 0 when stopped).
 *  `canRecord` is true only when the bottom dock is on the Clips tab AND a clip is selected. */
export function useTrackClipRecorder(): {
  canRecord: boolean
  recordKeyframe: (opts: RecordOpts) => Promise<void>
  recordKeyframes: (entries: RecordOpts[]) => Promise<void>
} {
  const bottomTab            = useEditorStore((s) => s.bottomTab)
  const selectedClipId       = useEditorStore((s) => s.selectedTrackClipId)
  const trackClips           = useEditorStore((s) => s.trackClips)
  const playback             = useEditorStore((s) => s.trackClipPlayback)
  const addTrackClipLane     = useEditorStore((s) => s.addTrackClipLane)
  const replaceTrackClipLaneKeyframes = useEditorStore((s) => s.replaceTrackClipLaneKeyframes)

  const selectedClip = trackClips.find((c) => c.id === selectedClipId) ?? null
  const canRecord = bottomTab === 'clips' && selectedClip != null

  const currentPlayhead = useCallback((): number => {
    if (!selectedClip) return 0
    const entry = playback[selectedClip.id]
    if (!entry) return 0
    if (entry.kind === 'paused') return entry.pausedAtT
    if (selectedClip.duration <= 0) return 0
    const tRaw = ((Date.now() + entry.clockOffsetMs) - entry.startedAt) / 1000
    if (entry.loop) {
      const w = tRaw % selectedClip.duration
      return w < 0 ? w + selectedClip.duration : w
    }
    return Math.max(0, Math.min(selectedClip.duration, tRaw))
  }, [selectedClip, playback])

  /** Find an existing lane for (targetKind, targetId, paramPath), or create it. */
  const ensureLane = useCallback(
    async (clipId: string, opts: { targetKind: TrackClipTargetKind; targetId: string; paramPath: string; defaultValue: number }): Promise<TrackClipLaneRecord> => {
      // Re-read from store each time so we don't stale-cache between calls within one frame.
      const clip = useEditorStore.getState().trackClips.find((c) => c.id === clipId)
      const existing = clip?.lanes.find(
        (l) => l.targetKind === opts.targetKind && l.targetId === opts.targetId && l.paramPath === opts.paramPath,
      )
      if (existing) return existing
      const lane = await api.createTrackClipLane(clipId, {
        targetKind: opts.targetKind,
        targetId: opts.targetId,
        paramPath: opts.paramPath,
        defaultValue: opts.defaultValue,
      })
      addTrackClipLane(clipId, lane)
      return lane
    },
    [addTrackClipLane],
  )

  /** Insert (or update at same t) a keyframe on the given lane and persist.
   *  New keyframes default to bezier easing with handle offsets seeded from the
   *  surrounding segments (Δt = 0.5 of the segment length, Δv = 0). */
  const upsertKeyframe = useCallback(
    async (lane: TrackClipLaneRecord, t: number, value: number): Promise<void> => {
      const existing = lane.keyframes.find((k) => Math.abs(k.t - t) <= KF_TIME_EPSILON)
      let next: TrackClipKeyframeRecord
      if (existing) {
        next = { ...existing, value }
      } else {
        const draft: TrackClipKeyframeRecord = {
          id: cryptoId(),
          t, value,
          easing: 'bezier',
          inHandleTFraction: null, inHandleVFraction: null,
          outHandleTFraction: null, outHandleVFraction: null,
        }
        next = { ...draft, ...defaultBezierHandles(draft) }
      }
      const merged = existing
        ? lane.keyframes.map((k) => (k.id === existing.id ? next : k))
        : [...lane.keyframes, next].sort((a, b) => a.t - b.t)
      replaceTrackClipLaneKeyframes(lane.id, merged)
      await api.replaceTrackClipKeyframes(lane.id, merged.map((k) => ({
        id: k.id, t: k.t, value: k.value, easing: k.easing,
        inHandleTFraction:  k.inHandleTFraction,  inHandleVFraction:  k.inHandleVFraction,
        outHandleTFraction: k.outHandleTFraction, outHandleVFraction: k.outHandleVFraction,
      }))).catch(() => {})
    },
    [replaceTrackClipLaneKeyframes],
  )

  const recordKeyframe = useCallback(
    async (opts: RecordOpts) => {
      if (!selectedClip) return
      const t = currentPlayhead()
      const lane = await ensureLane(selectedClip.id, {
        targetKind: opts.targetKind, targetId: opts.targetId,
        paramPath: opts.paramPath, defaultValue: opts.value,
      })
      // Re-fetch the lane from the store after possible creation, so we have the latest keyframes.
      const liveLane = useEditorStore.getState().trackClips
        .find((c) => c.id === selectedClip.id)?.lanes
        .find((l) => l.id === lane.id) ?? lane
      await upsertKeyframe(liveLane, t, opts.value)
    },
    [selectedClip, currentPlayhead, ensureLane, upsertKeyframe],
  )

  const recordKeyframes = useCallback(
    async (entries: RecordOpts[]) => {
      // Sequential to avoid races on ensureLane reads from the store snapshot.
      for (const e of entries) await recordKeyframe(e)
    },
    [recordKeyframe],
  )

  return { canRecord, recordKeyframe, recordKeyframes }
}

function cryptoId(): string {
  const c: { randomUUID?: () => string } = (globalThis.crypto ?? {}) as { randomUUID?: () => string }
  return c.randomUUID ? c.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8))
}
