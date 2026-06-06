import { useEffect } from 'react';
import type { CameraCapture, TrackingResult } from '../media/CameraCapture';

/**
 * Wires CameraCapture result callbacks to send tracking_input messages over WS.
 * Rate-limited naturally by MediaPipe's own output cadence (~30fps).
 */
export function useTrackingUplink(
  ws: WebSocket | null,
  behaviorId: string | null,
  camera: CameraCapture | null,
  active: boolean
): void {
  useEffect(() => {
    if (!active || !behaviorId || !camera || !ws) return;

    camera.onResult = (result: TrackingResult) => {
      if (!ws || ws.readyState !== WebSocket.OPEN || !behaviorId) return;
      ws.send(
        JSON.stringify({ kind: 'tracking_input', behaviorId, ...result })
      );
    };

    return () => {
      camera.onResult = null;
    };
  }, [active, behaviorId, camera, ws]);
}
