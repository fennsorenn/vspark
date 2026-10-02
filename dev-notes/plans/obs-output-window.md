# Plan: vspark output window (OBS Window Capture path)

> Branch: `feature/obs-output-window` · Status: slice 1 implemented (per-scene output windows, dev runs); release packaging open
> Investigation done 2026-10-01/02 on the user's machine (Windows 11, RTX 3090, OBS 32.2.1).

## Goal

vspark output stutters in OBS on Windows while a fullscreen game is running —
"tanking framerate", fixed instantly by tabbing out of the game. Give streamers a
delivery path into OBS that keeps full frame rate under that condition, without
losing transparency.

## What the investigation found

Measured as **distinct frames OBS actually receives per second** from the source
(polling `GetSourceScreenshot` over obs-websocket and hashing; OBS canvas = 30 fps,
so 30 is the ceiling), 40 s under a synthetic **uncapped fullscreen GPU hog**, each
configuration isolated in its own scene, 2–3 shuffled rounds.

- **Cause:** a fullscreen app that renders *uncapped* and saturates the GPU. The same
  hog capped to the refresh rate (still 95–98 % GPU) causes nothing; a GPU hog in a
  normal window causes nothing; CPU load causes nothing.
- **Not vspark's rendering cost.** ~4 ms CPU / ~0.8 ms GPU per frame on a 3090
  (183 draws, 82 k tris). A plain CSS box browser source degrades the same way.
- **It is the browser-source pile-up.** All OBS browser sources share one Chromium
  GPU process and Chromium's *offscreen* (OSR) frame hand-off. Under the hog every
  page's hand-off queues, so delivered fps falls with the **number of browser sources
  rendering at once** — not with the size of the measured one:

  | Measured source (fps into OBS under hog) | Browser source | Window Capture of an Electron window |
  |---|---|---|
  | 1080p, alone | 29.8 / 29.6 | 27.6 / 28.5 |
  | 1080p, +4 other browser sources | **23.7 / 23.9** | 29.4 / 28.0 |
  | 4K, alone | 29.6 / 29.7 | 28.6 / 28.0 |
  | 4K, +4 other browser sources (weak-GPU emulation) | **19.6 / 19.9** | 28.0 / 28.5 |

  Two important qualifiers (same harness, 2 rounds each):

  | Variation | Browser source | Window Capture |
  |---|---|---|
  | 1080p + the user's real Gaming overlays (chat corner, gradient, Fugi), coarse hog | 29.8 / 29.8 | 29.4 / 29.0 |
  | 1080p + 4 vspark pages, **game-like "tiled" hog** (1 600 small draws/frame, same total work) | 29.0 / 29.3 | 29.3 / 28.6 |

  So the starvation needs **both** a hog that submits long, coarse GPU work *and* several
  heavy, constantly-animating browser pages. Light overlays barely load the shared
  hand-off; fine-grained GPU work leaves gaps the hand-offs slip into. On a weaker GPU a
  real game's draws take longer (more "coarse"), which is consistent with the user seeing
  it on other systems but never on this RTX 3090. The Window Capture path stayed at
  28–29.5 fps in every configuration.
- Browser sources in **non-active scenes keep rendering** unless "Shutdown source when
  not visible" is ticked, so they count toward the pile-up. (In the user's collection,
  `vSpark Smoll` in the *Coding* scene has it off, so it renders during every game.)
- **Caveat:** the slowdown could not be reproduced with a *real* game on this RTX 3090
  (Valorant never saturates it); all numbers above use a synthetic WebGL hog. The
  mechanism matches the user's reports from weaker systems, but a confirmation run on
  such a machine (e.g. with the 4060 as display GPU) is still outstanding.
- **Ruled out:** Chromium occlusion/timer throttling, OBS custom-fps setting, OBS
  "Browser Source Hardware Acceleration" (user tested: no change), raising the CEF
  GPU process to HIGH GPU priority (`D3DKMTSetProcessSchedulingPriorityClass`, no
  change), Chromium OSR outside OBS (Electron OSR stalls *worse*, ~13 fps — so an
  Electron-OSR → Spout → custom OBS plugin route inherits the problem).
- **Transparency:** OBS *Window Capture* keeps the alpha of a transparent
  (`transparent: true`, frameless) Electron window — verified visually by the user.
  *Game Capture* refuses Chromium windows. A packed colour|silhouette layout recombined
  with OBS Multiply + Additive blend modes also works (built-in only) and stays as a
  fallback if transparency capture ever regresses.
- **Transparent costs nothing:** opaque vs transparent window under the hog, alone and
  with 4 extra vspark browser sources, 2 rounds each: all 28–29.6 fps (earlier ~17 fps
  readings came from a Chromium-based capture meter amid background browser sources).
- **vspark as compositor (overlays as iframe layers instead of OBS sources):** for one
  stage + any single overlay (static, complex DOM, CSS/JS animation, GPU-heavy, CPU-heavy,
  the user's Fugi) placement made no measurable difference (±0.5 fps). Only 8 small
  animated overlays showed a hint in favour of embedding (avatar 29.5 vs 28.3, 1 round).
  **Several camera views in one page hurt** (avg 16–22 fps with stalls to 4–11 fps vs a
  steady 23.8 as separate pages): each view is its own WebGL canvas gating the shared
  frame — another argument for the planned single shared renderer in `CameraCanvas`.
- **Window placement:** a frameless Electron window may be larger than the screen
  (`enableLargerThanScreen`) and parked fully off-screen; Windows capture still
  delivers every frame at full size. Size it on-screen first, then move it — sizing
  while off any monitor mis-measures (+16/+8 px). Minimized windows cannot be captured.

## Constraints

- Keep the OBS browser-source path working — it remains the zero-setup default and is
  fine on its own; the output window is an opt-in for streamers who hit the problem.
- The window renders the existing `ViewerPage` (compose route) unchanged — no second
  renderer. Chromium flags required: `disable-features=CalculateNativeWinOcclusion`,
  `disable-backgrounding-occluded-windows`, `disable-renderer-backgrounding`, and
  `backgroundThrottling: false`.
- The viewer paints a black backdrop outside OBS (`ViewerPage` `inOBS` check); the
  output window needs a transparent document background.
- Windows-first (the problem is Windows-specific).

## Files in scope

- `packages/frontend/src/components/editor/ComposeLayerStack.tsx` — browser layers get
  `allow="autoplay"` (done on this branch) so embedded alert overlays can play sound.
- `packages/frontend/src/pages/ViewerPage.tsx` — a way to request a transparent
  backdrop outside OBS (e.g. `?backdrop=transparent` or detect the output window).
- New `packages/output-window/` (Electron main process) — frameless transparent window,
  flags above, size = compose-scene resolution, park off-screen, stable window title
  (`vspark output — <compose scene name>`) so OBS keeps finding it.
- `packages/backend/src/routes/…` + editor UI — "Open output window" per compose scene
  (backend spawns/stops the Electron process; one window per compose scene).
- Release packaging (`.github/workflows/release.yml`, start scripts) — ship or fetch
  the Electron runtime.
- Help content `packages/frontend/src/help/content/{en,de}/` — OBS troubleshooting:
  cap game FPS; tick "Shutdown source when not visible"; fewer browser sources; when to
  use the output window + Window Capture setup steps. i18n EN/DE for any UI.

## Out of scope

- A custom OBS plugin / Spout / NDI (not needed — Window Capture carries alpha).
- Native (non-browser) renderer.
- Changing GPU/process priorities of games (anti-cheat risk) or of OBS.

## Open questions (user decisions)

1. **Electron delivery:** bundle in the release zip (+~100 MB) vs. download on first use.
2. **Window lifetime:** backend-managed child process vs. user-launched shortcut.
3. **Scope of the first slice:** help-docs-only quick win first, then the window?

## Approach

1. Help/docs quick win (no code risk): troubleshooting section + `HelpButton` near
   the viewer/OBS link.
2. Transparent-backdrop option in `ViewerPage`.
3. Electron output-window package (prototype exists in the investigation scratchpad:
   `output-window.js`, ~40 lines).
4. Backend launch/stop + editor button; packaging.
5. Optional: in-viewer starvation detector (inside OBS, sustained fps ≪ target while
   frame cost is low → editor notice pointing at the help section).

## Acceptance / verification

- `pnpm lint` + relevant Vitest suites pass.
- With an uncapped fullscreen GPU hog and ≥4 other browser sources active, the output
  window's Window Capture delivers ≥ 27 fps into a 30 fps OBS canvas (harness: OBS
  `GetSourceScreenshot` hashing, as in the investigation).
- Transparency preserved (soft hair edges, no fringe) in OBS.

## Output

Open a PR into `dev` when done.
