# vspark-viewer

A standalone Electron app that **launches vspark's real viewer route** in its own
window — full parity with the in-browser viewer (compose layers, effects, any
scene). It also doubles as the **Electron-OSR throttle test**.

It renders two ways:

- **Windowed** — a normal visible viewer window. Everyday use.
- **Offscreen + FPS** — renders offscreen (no visible window) and reports
  produced frames/sec back to the launcher. This is the throttle test: start a
  game fullscreen and watch whether the FPS holds.

> v1 has **no Spout output yet** — that's v2, once we've confirmed offscreen
> escapes the throttle (and it's when the native-addon build step becomes worth
> it). v1 already answers the throttle question and is a usable viewer.

## Prerequisite

The vspark backend must be running and reachable (default `http://localhost:3001`),
serving the built frontend. The viewer connects to its WebSocket automatically.

## Easy way to run it (no toolchain on the test machine)

A ready-made CI workflow lives at [`ci/build-windows.yml`](./ci/build-windows.yml).
It couldn't be committed under `.github/workflows/` directly (the push
credentials lack GitHub's `workflow` scope), so enable it once:

1. Copy `experiments/vspark-viewer/ci/build-windows.yml` to
   `.github/workflows/build-windows.yml` (via the GitHub web UI **Add file**, or
   a commit from an account with `workflow` scope).
2. On GitHub: **Actions → "build viewer experiments (Windows)" → Run workflow.**
3. Download the **`vspark-viewer-portable`** artifact, unzip it.
4. Double-click `vspark-viewer-<version>.exe` on the test machine. That's it.

(Or, on any Windows machine with Node: `npm install && npm run dist` produces the
same portable `.exe` under `dist/`.)

## Dev way to run it (on a machine with Node)

```bash
cd experiments/vspark-viewer
npm install
npm start
```

## Using it

1. Enter the **Server URL** (default `http://localhost:3001`) and click **Connect**.
2. Pick a **Project**, then a **Target** (a camera node or a compose scene).
3. Choose a **Render mode**:
   - **Windowed** to just watch the viewer, or
   - **Offscreen + FPS** to run the throttle test.
4. Click **Open viewer**.

### Throttle test procedure

1. Open the viewer in **Offscreen + FPS** mode — the launcher shows
   `FPS (offscreen produced): ~60`.
2. Start your game **fullscreen** on the other monitor and focus it (your real
   streaming setup).
3. Watch the FPS number.
   - **Holds ~60** → offscreen Electron escapes the throttle. Green light for
     building this out (and adding Spout in v2).
   - **Drops to single digits** → offscreen Electron throttles like OBS's CEF;
     we escalate to the headless `beginFrame` test (owning the frame clock).

## Files

| File            | Role                                                        |
| --------------- | ----------------------------------------------------------- |
| `main.js`       | Electron main — launcher + viewer windows, FPS reporting.   |
| `launcher.html` | Tiny UI: connect, pick project/target, choose mode.         |
| `package.json`  | Pins Electron `30.0.1`; `electron-builder` portable target. |
