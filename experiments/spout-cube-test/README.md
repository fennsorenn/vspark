# spout-cube-test

A tiny standalone Electron app that renders a rotating three.js cube **offscreen**
and (optionally) pushes it to **Spout**. It exists to answer two questions on the
real Windows machine, before we invest in a viewer:

1. **Throttle:** does an *offscreen* Chromium surface keep producing frames when a
   game grabs the foreground in fullscreen? (A plain Chrome window / OBS browser
   source does **not**.)
2. **Capture:** can we get those frames into OBS GPU-direct via Spout?

It is intentionally separate from the vspark workspace (not in `packages/*`).

---

## What you'll see

- The app logs `[fps] N produced frames/s` once per second in the terminal.
- The rendered page also draws its own FPS number in the corner, so once Spout is
  working you can **see the frame rate inside OBS** — when the game grabs
  fullscreen, you'll know immediately whether it held.

---

## Phase 1 — FPS / throttle test (no Spout needed)

This works out of the box and already answers the most important question.

```bash
cd experiments/spout-cube-test
npm install
npm start
```

Then:

1. Watch the `[fps]` lines — they should sit near **60**.
2. Start your game **fullscreen** on the other monitor and focus it, exactly like
   your real streaming setup.
3. Watch the `[fps]` lines again.

**Interpretation**

- **Holds ~60** → an offscreen Electron surface *escapes* the throttle. That's the
  green light: a headless/offscreen Electron viewer + Spout is a viable path with
  full browser parity (compose layers, iframes, effects, any scene). Continue to
  Phase 2.
- **Drops to single digits** → offscreen Electron throttles like OBS's CEF. Then we
  escalate to driving frames manually via the Chrome DevTools Protocol
  `HeadlessExperimental.beginFrame` (owning the vsync clock), which is the next
  experiment. Report the number back.

> Note: the cube loads three.js from a CDN. If this machine has no network, grab
> `https://cdn.jsdelivr.net/npm/three@0.168.0/build/three.module.js`, save it as
> `three.module.js` next to `index.html`, and change the import in `index.html` to
> `./three.module.js`.

---

## Phase 2 — enable Spout output

Spout needs a native addon, `electron_spout.node`, built against **this exact
Electron version** (`30.0.1`, pinned in `package.json`). There are no prebuilt
binaries, so you build it once:

1. Clone [`reitowo/electron-spout`](https://github.com/reitowo/electron-spout).
2. Build its native module with CMake + MSVC, targeting Electron `30.0.1`
   (follow that repo's README — it documents the CMake/runtime settings).
3. Copy the resulting `electron_spout.node` into **this folder** (next to
   `main.js`).
4. `npm start` again. You should now see `[spout] sender "vspark-cube-test" ready`.

### Receive it in OBS

1. Install the OBS Spout2 plugin
   ([Off-World-Live/obs-spout2-plugin](https://github.com/Off-World-Live/obs-spout2-plugin)).
2. Add source → **Spout2 Capture** → select sender **`vspark-cube-test`**.
3. You should see the rotating cube + its FPS number. Now repeat the fullscreen-game
   test and confirm the **Spout source in OBS** stays smooth.

---

## Files

| File         | Role                                                            |
| ------------ | --------------------------------------------------------------- |
| `main.js`    | Electron main — offscreen window, frame counter, Spout bridge.  |
| `index.html` | three.js rotating cube + on-page FPS meter.                     |
| `package.json` | Pins Electron `30.0.1` (must match the `electron_spout.node` build). |

## Tuning

Edit the constants at the top of `main.js`: `WIDTH`, `HEIGHT`, `FPS`,
`SENDER_NAME`.
