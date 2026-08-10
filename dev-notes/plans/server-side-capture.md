# Plan: Server-side MediaPipe tracking + audio lipsync

> Branch: `claude/server-mediapipe-lipsync-jbao2r` · Status: draft
> Two capture providers are built deliberately, side by side, so they can be
> A/B'd on the target machine under real load. The winner is chosen from
> measurements, not from this document.

## Goal

Move MediaPipe tracking and mic lipsync off the user's browser tab and onto the
server, so capture starts with the server, survives closing the editor tab, and
needs no per-session camera/mic permission grant. Browser capture stays fully
supported as a fallback.

### Why (the real driver)

Comfort was the stated motivation, but the operational one is stronger:
tracking currently runs in a browser tab, and on Windows 11 an unfocused tab is
demoted by **EcoQoS** (lower priority, lower clocks, parked on E-cores). That
demotion happens precisely while gaming — i.e. exactly when tracking is on
stream. There is direct precedent in the same stack:
[obsproject/obs-studio#12982](https://github.com/obsproject/obs-studio/issues/12982)
— OBS browser sources lose ~80% performance when OBS loses focus, because
Windows applies Efficiency Mode to `obs-browser-page.exe` and OBS's "High"
priority setting does not reach its browser children.

So this is a reliability fix, not only a convenience feature. The open question
is *which* server-side provider survives that scheduling environment best, which
is why two are being built.

## Research findings that constrain the design

Established by direct experiment, not from documentation:

1. **`@mediapipe/tasks-vision` cannot run in pure Node.** It gets remarkably
   close — with three shims (`self`, a no-op `importScripts`, and a pre-set
   `ModuleFactory`) the WASM loads, Emscripten auto-detects Node and reads the
   `.wasm` off disk, and the MediaPipe C++ graph **starts successfully with
   XNNPACK CPU inference**. It then fails at frame input: the web build's only
   image-input path is `_addBoundTextureAsImageToStream`, i.e. every frame must
   be uploaded as a **WebGL texture**. `delegate: 'CPU'` selects where inference
   runs, not how frames get in. A Node WebGL2 implementation does not exist
   (`headless-gl`/`@kmamal/gl` are WebGL1, native-addon, and need system GL/X11).
   - Gotcha for anyone retrying: the package is `"type": "module"`, so
     `require()`ing the `.js` Emscripten glue silently returns `{}`. Copy it to
     `.cjs` first. This is almost certainly the cause of the "ModuleFactory not
     set" reports in the wild.
2. **The ecosystem agrees.** Every "MediaPipe in Node" solution is (a) jsdom —
   fails at exactly the point above, (b) a headless browser
   ([`mediapipe-nodejs`](https://github.com/beenotung/mediapipe-nodejs) is
   Playwright + Express), or (c) a Python sidecar. No WASM-only path, no native
   binding, from Google or anyone.
3. **`@vladmandic/human` + `@tensorflow/tfjs-node` works in Node.** Verified on
   a real portrait: 478 face-mesh points (same FaceMesh topology Holistic emits,
   so `arkitHeuristic.ts` indices transfer), BlazePose with 3D positions, 21-point
   hands. Installs with prebuilt binaries, no build tools. Models ship inside the
   npm package — no CDN dependency.
4. **It is CPU-only in practice.** Human's own typings mark `webgl`/`humangl`/
   `webgpu` as browser backends; Node gets `tensorflow`/`wasm`/`cpu`. The only
   GPU route is `tfjs-node-gpu` (CUDA 11.2 + cuDNN 8, NVIDIA-only, node-gyp +
   Python on Windows, last published ~2 years ago) — not shippable to end users.
5. **The Node workload is ~1 core and thread-cappable.** Measured on 4 vCPU
   Xeon @2.8GHz, 320×240, lean config (mesh+iris, blazepose-lite, hands):
   `TF_NUM_INTRAOP_THREADS=1` → 178 ms; `=2` → 158 ms; `=4` → 158 ms. Capping to
   a single thread costs ~11%. Resolution barely matters (247 ms at 1024×820 vs
   257 ms at 320×240) because the models resize internally — so the current
   320×240 optimisation buys nothing on this path, and a larger frame improves
   hand/face detection for free.
6. **`os.setPriority()` works**, so the backend can raise its own priority.
   Chromium cannot be fixed the same way: it *self-demotes* its renderers, and
   `--disable-features=UseEcoQoSForBackgroundProcess` has been removed/ignored in
   recent versions.

## Constraints

- **The seam already exists — use it.** `trackingManager.fireLandmarks()` and
  `lipsyncManager.fireVisemes()` are source-agnostic. Everything downstream
  (signal graphs, `arkit_vrm_mapper` trio, `pose_merge`, calibration,
  `broadcastBus`, viewport) must not change. `index.ts:261-270` is the only
  browser coupling.
- **Browser capture must keep working unchanged.** It is the fallback and the
  no-extra-dependency path.
- **`tfjs-node` must not burden the default build.** ~830 MB installed, and it
  breaks the single-`bundle.cjs` release model. It goes in as an
  `optionalDependency` behind a lazy `require`, so a normal install/build/release
  is unaffected while the A/B runs. Productionising it (per-platform release
  artifacts) is deferred until it wins.
- **No new *required* runtime dependency for Provider A.** The page connects back
  over the existing WebSocket, so plain `child_process.spawn` is enough — no
  puppeteer, no Playwright, no bundled Chromium.
- Cross-cutting repo rules still apply to any user-facing UI added: i18n EN+DE,
  a `HelpButton` + help section, `vs-` handles + `controls.mjs bless`, tests.

## Files in scope

**Shared**
- `packages/shared/src/arkit_heuristic.ts` — moved from
  `packages/frontend/src/media/arkitHeuristic.ts` (pure math, zero imports).
- `packages/shared/src/mfcc.ts` — mel filterbank, DCT-II, template prep/scoring
  lifted out of `MicCapture.ts`.

**Backend**
- `packages/backend/src/capture/` — new module: `CaptureProvider` interface,
  registry, `browser_agent/`, `node_inference/`, `metrics.ts`.
- `packages/backend/src/behaviors/mediapipe_tracker/manager.ts` — source gating.
- `packages/backend/src/behaviors/lipsync/manager.ts` — source gating.
- `packages/backend/src/index.ts` — WS dispatch respects the per-behaviour source.
- `packages/backend/src/routes/capture.ts` — device list, provider switch, metrics.

**Frontend**
- `packages/frontend/src/media/MicCapture.ts`, `arkitHeuristic.ts` — re-point at
  the shared modules; keep only the browser glue.
- `packages/frontend/src/pages/MediaInputPage.tsx` — agent-mode autostart params.
- `packages/frontend/src/media/MicCapture.ts` + `hooks/useLipsyncUplink.ts` —
  swap `requestAnimationFrame` loops for `setInterval` (rAF is compositor-
  dependent and unreliable in an offscreen/agent window).

## Out of scope

- Choosing a winner. That is a measurement outcome.
- Per-platform release packaging for `tfjs-node` (only if it wins).
- Preview relay for server capture (v2 — useful for aiming a camera, not needed
  to measure).
- Vendoring MediaPipe WASM/models locally. Worth doing regardless (removes a
  startup CDN dependency for the browser path) but separable.
- The Python/native MediaPipe sidecar (option C). Kept as the escape hatch if
  both providers disappoint.

## Approach

1. **Shared extraction.** Move the heuristic and MFCC core; frontend keeps the
   `AudioContext`/camera glue. Golden-vector parity test: the browser path feeds
   MFCCs through `AnalyserNode` (Blackman window, magnitude normalised by
   `fftSize`, dB conversion) and the stored `vowelTemplates` were captured that
   way — any server-side FFT must replicate it exactly or every existing
   calibration silently degrades.
2. **Seam.** `source: 'browser' | 'server'` + `provider` + `deviceId` on both
   behaviour configs. When `source === 'server'`, the manager ignores WS input
   for that behaviourId and the UI disables the browser Start button — otherwise
   two producers fight over one `behaviorId` slot on the broadcast bus.
3. **Provider A — offscreen-headed browser agent.** Discover an installed
   Chromium-family browser; spawn it at `/media-input/:projectId` with autostart
   params, a persistent profile (so permissions stick forever),
   `--use-fake-ui-for-media-stream`, and **not** `--headless`: a real window at
   `--window-position=-32000,-32000` plus
   `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
   --disable-background-timer-throttling`. A never-backgrounded window is a
   different scheduling class from OBS's `obs-browser-page.exe`. Raise priority
   on the process tree. Watchdog + restart + kill-on-shutdown.
4. **Provider B — in-process Node inference.** Lazy-loaded Human + tfjs-node,
   thread-capped, `os.setPriority`. Map Human's output onto the existing
   `TrackingResult` shape and feed the same `fireLandmarks`.
5. **Harness.** See below.

### Verified headless-browser capabilities (Provider A groundwork)

Probed directly in headless Chromium over an `http://localhost` origin:
WebGL2 ✅ (SwiftShader), `OffscreenCanvas` ✅, `createImageBitmap` ✅,
`requestAnimationFrame` 64 fps ✅, `getUserMedia` video+audio ✅,
`AudioContext` ✅, `enumerateDevices` returns **labelled** devices with
`--use-fake-ui-for-media-stream` ✅ — no permission dance.

Not yet measured: Holistic inference fps under SwiftShader, and whether an
offscreen-headed window gets real GPU instead. That is part of the A/B.

## Measurement (the actual deliverable of this branch)

Measure at `TrackingManager.fireLandmarks` — the landmark-frame **arrival rate**
and **inter-frame gap**, reported as median and **p95**, not mean. The failure
mode being hunted is a multi-hundred-millisecond freeze during gameplay; mean fps
hides exactly that.

Conditions, per provider: idle → OBS running → OBS + fullscreen game.

Providers switch at runtime via REST so A/B/A/B alternation is possible **inside
one game session** — scheduling contention is noisy and non-reproducible across
sessions, so cross-session comparison would not be trustworthy.

Known constraint: Windows often gives exclusive access to a capture device, so
truly concurrent A+B needs two webcams. The design allows it; alternation is the
fallback.

## Acceptance / verification

- `pnpm lint` passes; `pnpm test` passes.
- Browser capture behaves exactly as before when `source: 'browser'`.
- Each provider drives the avatar end-to-end with `source: 'server'`.
- The harness emits a CSV with median/p95 inter-frame gap per provider per
  condition.
- A default install/build/release is unaffected by `tfjs-node` being absent.

## Output

No PR until a provider is chosen — this branch is for measurement.
