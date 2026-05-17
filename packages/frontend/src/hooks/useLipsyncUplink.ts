import { useEffect, useRef } from 'react'
import type { MicCapture } from '../media/MicCapture'

const TARGET_FPS = 30
const FRAME_MS   = 1000 / TARGET_FPS

/**
 * Drives mic analysis at up to 30 fps and sends viseme weights to the server
 * via the provided WebSocket. Safe to call whether or not the mic is active.
 */
export function useLipsyncUplink(
  ws:          WebSocket | null,
  componentId: string | null,
  micRef:      React.RefObject<MicCapture | null>,
  active:      boolean,
): void {
  const lastSentRef = useRef<number>(0)
  const rafRef      = useRef<number | null>(null)

  useEffect(() => {
    if (!active || !componentId || !ws || ws.readyState !== WebSocket.OPEN) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      return
    }

    function loop() {
      rafRef.current = requestAnimationFrame(loop)
      const now = performance.now()
      if (now - lastSentRef.current < FRAME_MS) return
      lastSentRef.current = now

      const mic = micRef.current
      if (!mic?.active || !ws || ws.readyState !== WebSocket.OPEN || !componentId) return

      const visemes = mic.getVisemes()
      ws.send(JSON.stringify({ kind: 'lipsync_input', componentId, visemes }))
    }

    rafRef.current = requestAnimationFrame(loop)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [active, componentId, ws, micRef])
}
