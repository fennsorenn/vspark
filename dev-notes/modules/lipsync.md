# Lipsync

Status: **implemented**

End-to-end mic → vowel weights → VRM mouth blendshapes. Classification lives entirely in the frontend; the backend manager only forwards weights through a trivial signal graph.

See [component-managers.md](component-managers.md) for the `LipsyncManager` lifecycle and graph descriptor. This document covers the frontend pipeline and per-behavior calibration.

## Frontend MFCC pipeline

Implemented in [packages/frontend/src/media/MicCapture.ts](../../packages/frontend/src/media/MicCapture.ts).

All processing is in-browser, per audio frame:

1. `AudioContext` + `AnalyserNode` at FFT size 2048.
2. `getFloatTimeDomainData` → RMS volume. Used both for `jawOpen` and as a silence gate at `RMS < 0.012` (no vowel classification below this threshold).
3. `getFloatFrequencyData` → linear power spectrum.
4. **26-band mel filterbank**, 80 Hz – 8 kHz, standard `mel = 2595 * log10(1 + hz/700)` warp. Filterbank is rebuilt against the live `AudioContext.sampleRate`.
5. `log(mel energies)` → **DCT-II** → keep **12 cepstral coefficients** (drop DC, c0).
6. **Centring**: subtract the mean-across-templates from the live MFCC vector (and from each stored template at template-set time).
7. **L2-normalise** both live and template vectors.
8. Score each vowel by **negative squared Euclidean distance** to its centred+L2 template.
9. **Softmax with temperature 12** → per-vowel probability for A/E/I/O/U.
10. **EMA smooth** (α = 0.6) and write into VRM `Fcl_MTH_A` / `_E` / `_I` / `_O` / `_U`.
11. `jawOpen` is driven independently from RMS, not from vowel classification.

**Why centring + L2 + Euclidean (not raw cosine on MFCCs)**: back vowels (O and U) share a lot of low-cepstral structure; on raw MFCCs they previously co-fired. Subtracting the across-template mean removes the shared component, and L2-normalised Euclidean distance then separates them cleanly. This was the key fix during this work.

## Default templates

`DEFAULT_TEMPLATES` constant in `MicCapture.ts` holds vowel templates captured from one English-speaking adult voice at 48 kHz. Behaviors that have not been calibrated fall back to these.

## Per-behavior calibration

**Storage**: `behaviors.config.vowelTemplates: { A: number[12], E: ..., I: ..., O: ..., U: ... }` (table renamed from `node_components` in migration 022).

**UI**: `LipsyncCalibration` block in [packages/frontend/src/components/editor/PropertiesPanel.tsx](../../packages/frontend/src/components/editor/PropertiesPanel.tsx), rendered inside `LipsyncProcessorProps` below the existing sensitivity field. Hold-to-record per vowel:

- Press-and-hold spins up a temporary `MicCapture` instance with an `onCaptureFrame` callback that collects MFCC vectors.
- On release, the collected vectors are averaged into the template for that vowel and persisted to `behaviors.config`.

**Application**: `MediaInputWindow.toggleLipsync` reads the saved templates from the behavior config and calls `mic.setTemplates(templates)` before `mic.start()`. If no templates are saved, `MicCapture` keeps `DEFAULT_TEMPLATES`.

## Wire format

Unchanged by this work. The frontend sends a `lipsync_input` WS message carrying `Fcl_MTH_*`-keyed weights to the backend. Only the *source* of those weights changed (custom MFCC classifier vs. previous heuristics).

## Backend graph

Minimal — no signal-graph changes were needed for this feature:

```
lipsync_source → unpack_event → viseme_passthrough → blendshapes_broadcast
```

Defined in [packages/backend/src/node_components/lipsync/graph.ts](../../packages/backend/src/node_components/lipsync/graph.ts).

### Latent bug fixed during this work

The graph descriptor previously contained a stray edge wiring `cfg_sensitivity.value` (a `number`) into `passthrough.blendshapes` (expects `Blendshapes`). On pull paths where no event payload was available, this caused `bs.map is not a function` crashes. The edge has been removed.

### Latent issue (not fixed)

`viseme_passthrough` reads `config.sensitivity` directly, but the manager's `_getNodeConfig` only forwards `cfg.nodeConfig[nodeId]` overrides — not top-level behavior config. The sensitivity slider in the UI is therefore currently a no-op. Tracked for a separate fix.

## Extension notes

- To change the cepstral feature count, the bandcount, or the mel range, edit the constants at the top of `MicCapture.ts`. Existing stored templates are sized to 12 coefficients; changing this requires invalidating saved `vowelTemplates`.
- To add additional visemes (e.g. consonant classes), extend both the template structure in `vowelTemplates` and the classifier output mapping. The wire format already accepts arbitrary `Fcl_MTH_*` keys.
- Silence gate and EMA α are currently hardcoded; promote them to behavior config if user-tunable behaviour is needed.
