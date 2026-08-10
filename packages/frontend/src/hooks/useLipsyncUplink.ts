import { useEffect, useRef } from 'react';
import type { MicCapture } from '../media/MicCapture';

const TARGET_FPS = 30;
const FRAME_MS = 1000 / TARGET_FPS;

/**
 * Drives mic analysis at up to 30 fps and sends viseme weights to the server
 * via the provided WebSocket ref. Using a ref avoids stale closure issues.
 *
 * Timer-driven rather than `requestAnimationFrame`: rAF is compositor-driven and stalls
 * in a backgrounded or offscreen window, which is exactly where the server-side
 * browser-agent capture provider runs this page. Same reasoning as `MicCapture`'s loop.
 */
export function useLipsyncUplink(
  wsRef: React.RefObject<WebSocket | null>,
  behaviorId: string | null,
  micRef: React.RefObject<MicCapture | null>,
  active: boolean
): void {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!active || !behaviorId) {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    function tick() {
      const mic = micRef.current;
      const ws = wsRef.current;
      if (
        !mic?.active ||
        !ws ||
        ws.readyState !== WebSocket.OPEN ||
        !behaviorId
      )
        return;

      const visemes = mic.getVisemes();
      ws.send(JSON.stringify({ kind: 'lipsync_input', behaviorId, visemes }));
    }

    timerRef.current = setInterval(tick, FRAME_MS);
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [active, behaviorId, wsRef, micRef]);
}
