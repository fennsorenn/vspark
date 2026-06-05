# headless-test

The **fallback** experiment: does a *headless* Chromium surface escape the
fullscreen-game throttle? Only relevant if `vspark-viewer`'s offscreen mode turns
out to be throttled.

It launches **headless Microsoft Edge** (always present on Windows — no bundled
Chromium needed), renders a rotating cube, and measures real produced frames/sec
via the DevTools Protocol screencast for 10 seconds. Headless has no on-screen
window for Windows to deprioritize, so if it holds ~60 fps the headless path
escapes the throttle.

## Run it

- **Packaged** (recommended for the test machine): build via the CI workflow (see
  `../vspark-viewer/ci/build-windows.yml`) or `npm install && npm run dist` on a
  Windows machine, then double-click `headless-test-<version>.exe`.
- **Dev**: `npm install && npm start`.

Requires Microsoft Edge installed (default on Windows 10/11).

## Procedure

1. Click **Run test (10s)**.
2. Immediately bring your game to the foreground in **fullscreen**.
3. Read the result:
   - **HOLDS (~60 fps)** → headless escapes the throttle; owning the frame clock
     is the path forward.
   - **DROPPED** → headless is throttled too, which would mean only a native,
     non-Chromium renderer escapes.

## Files

| File          | Role                                                          |
| ------------- | ------------------------------------------------------------ |
| `main.js`     | Electron main — drives headless Edge + screencast FPS count. |
| `result.html` | Tiny UI: Run button + result.                                |
| `cube.html`   | three.js rotating cube rendered inside headless Edge.        |
