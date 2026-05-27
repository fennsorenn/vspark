import { useEffect } from 'react';
import type { CameraCapture, TrackingResult } from '../media/CameraCapture';

/**
 * Wires CameraCapture result callbacks to send tracking_input messages over WS.
 * Rate-limited naturally by MediaPipe's own output cadence (~30fps).
 */
export function useTrackingUplink(
  ws: WebSocket | null,
  componentId: string | null,
  camera: CameraCapture | null,
  active: boolean
): void {
  useEffect(() => {
    if (!active || !componentId || !camera || !ws) return;

    camera.onResult = (result: TrackingResult) => {
      if (!ws || ws.readyState !== WebSocket.OPEN || !componentId) return;
      ws.send(
        JSON.stringify({ kind: 'tracking_input', componentId, ...result })
      );
    };

    return () => {
      camera.onResult = null;
    };
  }, [active, componentId, camera, ws]);
}
