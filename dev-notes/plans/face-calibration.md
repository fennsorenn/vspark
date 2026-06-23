# Plan: Face-heuristic calibration tool (dev-facing)

> Branch: `claude/mediapipe-vmc-tracking-align-bfbdak` · Status: draft
> Dev-facing tuning tool. NOT end-user UI — no i18n, no help docs, no persistence/sync.

## Goal

Make the landmark → ARKit blendshape heuristic (`arkitHeuristic.ts`) **config-driven**, and
build a dev-only calibration window to tune that config live against the high-quality
(native `FaceLandmarker`) values. The tool's output is a JSON blob the developer copies
out and pastes back into the repo as the new shipped default. This replaces hand-editing
26 per-shape code blocks with interactive, data-driven tuning.

## Background (decided in discussion)

- The heuristic produces ARKit-named weights from Holistic's face landmarks and feeds the
  same backend mapper pipeline as the native path (see `dev-notes/modules/mediapipe-tracker.md`).
- **Metric model (final):** for each ARKit shape,
  `value = signed Σ edge lengths` (each edge a landmark pair contributing ±its 3D distance),
  `÷ referenceDistance` (outer eye-corners `33↔263`, expression-stable → scale-invariant),
  then auto-ranged `[min,max] → [0,1]`. Config shape: `{ edges: {a,b,negate?}[], min, max }`.
- 3D distances are **inherently rotation-invariant**, so NO per-frame canonical/Procrustes
  normalization is needed for the metric (rotating a rigid point set doesn't change distances,
  and wouldn't fix noisy z either). z noise is second-order for short intra-region edges.
- **Per-edge `negate`** subsumes both direction and shape-level invert: a *difference* of
  distances (e.g. lip-corner angle = outer-lip→ref minus inner-lip→ref) needs one positive and
  one negated edge; a falling aperture (blink) is a single negated edge with a negative `[min,max]`.
  (`negate` edge + `[-max,-min]` ≡ the old `invert` + `[min,max]`.)
- Edges are built by clicking two handles; each edge has its own negate toggle. The earlier
  "marker set + sum of all pairwise" model was replaced because it couldn't express signed
  differences (e.g. frown).
- Canonical normalization IS wanted, but **only as a preview aid** (front-align the displayed
  overlay so markers are easier to see/target on a turned head). It must not affect the metric.

## Constraints

- Dev-facing only. Do not wire i18n keys, help pages, persistence, behavior-config, or sync.
- The runtime heuristic must stay cheap: only evaluate configured shapes; one division for scale.
- Backend is untouched — both sources still emit ARKit `faceBlendshapes` into the same pipeline.
- Preserve current behavior: the shipped default config must reproduce today's expressions
  closely enough that nothing regresses for users who never open the tool.
- Keep the heuristic's existing public signature `estimateArkitBlendshapes(pts) → Record<string,number>`
  so `CameraCapture._dispatch` needs no change.

## Files in scope

- `packages/frontend/src/media/arkitHeuristic.ts` — refactor to a config-driven evaluator.
  - New `ArkitShapeConfig = { markers: number[]; invert?: boolean; min: number; max: number }`.
  - New `ArkitHeuristicConfig = Record<string /*ARKit shape*/, ArkitShapeConfig>`.
  - `const DEFAULT_ARKIT_CONFIG: ArkitHeuristicConfig` — derived from current hand-tuned shapes
    (port each into {markers, min, max, invert}; best-effort first pass).
  - `estimateArkitBlendshapes(pts, config = DEFAULT_ARKIT_CONFIG)` — evaluator:
    `ref = dist(pts[33], pts[263]); for each shape: m = sumPairwise(markers)/ref; w = clamp01((m-min)/(max-min)); if invert w = 1-w`.
  - Export `sumPairwiseDistance(pts, markers)` and `referenceDistance(pts)` for the tool to reuse.
- `packages/frontend/src/media/faceCalibration.ts` (new) — pure helpers usable headless:
  - live min/max tracker per shape (continuous, resettable),
  - canonical-preview transform (compute a face basis from stable points; for overlay only),
  - config serialize/parse.
- `packages/frontend/src/components/FaceCalibrationWindow.tsx` (new) — the dev tool (see below).
- A dev-only mount point: render `FaceCalibrationWindow` behind a dev gate (e.g. a query param
  like `?facecal=1` or a hidden button in `MediaInputWindow`). Decide at build time; keep it
  out of the normal user flow.

## Calibration window — interaction model

Runs the camera with **HQ face forced on** while open, so both columns are live:
the heuristic (config-driven, editable) and the native `FaceLandmarker` reference.

1. **Large webcam preview** with all 478 face landmarks drawn as small clickable handles.
   - Optional **"front-align preview"** toggle → applies the canonical transform to the drawn
     points only (overlay legibility), never to the metric.
   - The focused shape's active markers are highlighted; clicking a handle toggles it in/out of
     the focused shape's `markers`.
2. **Shape table** (all ARKit shapes): columns `shape | heuristic | native` with live values.
   - Clicking a row focuses that shape (drives the overlay highlight + the editor panel).
3. **Focused-shape editor:**
   - marker chips (remove individually),
   - `invert` toggle,
   - `min` and `max` rows, each showing the **live auto value** plus `[keep]` (freeze live→override),
     `[capture]` (set from current frame's raw metric), and a manual number field,
   - a live weight bar for the resulting `[0,1]`.
   - Switching the marker set resets that shape's live auto min/max.
4. **JSON field** — the full `ArkitHeuristicConfig`, copy-out (and paste-in to load a config).

## Approach (build order)

1. Refactor `arkitHeuristic.ts` to config-driven + `DEFAULT_ARKIT_CONFIG`; verify parity with
   current output on a few expressions (`pnpm lint`, eyeball in app). Commit.
2. Add `faceCalibration.ts` helpers (min/max tracker, canonical preview transform, (de)serialize).
3. Build `FaceCalibrationWindow.tsx`: preview + overlay + table + focused editor + JSON field,
   with HQ forced on and the editable config held in component state.
4. Wire the dev gate to mount it.
5. Tune the real defaults using the tool; paste the result back as `DEFAULT_ARKIT_CONFIG`.

## Out of scope

- Persistence, localStorage, behavior-config, WS sync, multi-user.
- i18n and help content (dev tool).
- Exposing the tool in the normal end-user UI.
- Backend changes; the mapper/calibration layer is unchanged.
- Explicit edge-list selection and signed-axis metrics (marker-set + invert covers our cases;
  revisit only if a specific shape proves non-monotonic).

## Acceptance / verification

- `pnpm lint` passes.
- With the tool closed, default behavior is unchanged (heuristic still drives expressions).
- With the tool open: both columns update live; clicking handles edits the focused shape and its
  weight responds; keep/capture/manual all affect min/max; JSON reflects edits and re-parses.
- Pasting the exported JSON back as `DEFAULT_ARKIT_CONFIG` reproduces the tuned behavior.

## Output

Commit to the working branch. No PR / no cloud handoff unless requested.
