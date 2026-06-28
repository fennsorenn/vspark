/**
 * Bridge for screenshotting the 3D viewport from outside the R3F tree.
 *
 * A component inside the <Canvas> ({@link ViewportCapture} in Viewport.tsx)
 * registers a capturer that has access to the WebGL renderer/scene/camera; the
 * WS handler (useWsSync) calls captureViewport() when the assistant's
 * screenshot_viewport tool asks this editor for an image. The capturer renders
 * a fresh frame and reads the canvas synchronously, so no `preserveDrawingBuffer`
 * (always-on memory cost) is needed.
 */
type Capturer = () => string | null;

let capturer: Capturer | null = null;

export function setViewportCapturer(fn: Capturer | null): void {
  capturer = fn;
}

/** Returns a `data:image/png;base64,…` url of the current viewport, or null if
 *  no viewport is mounted / capture failed. */
export function captureViewport(): string | null {
  if (!capturer) return null;
  try {
    return capturer();
  } catch {
    return null;
  }
}
