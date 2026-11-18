# Lipsync

Status: **implemented**

End-to-end voice → vowel weights → VRM mouth blendshapes. Two input modes (behavior config `inputMode`):

- **`browser`** (default) — a browser tab captures a mic and classifies it; the backend manager only forwards weights through a trivial signal graph.
- **`pipewire`** — the backend captures a PipeWire/PulseAudio source itself and classifies it server-side. No browser step, so an external program (e.g. an AI character's TTS playing into a null-sink) drives the mouth as soon as vSpark is running. See [PipeWire input](#pipewire-input-server-side).

Both modes use one classifier, `VisemeClassifier` in [packages/shared/src/visemes.ts](../../packages/shared/src/visemes.ts) (`@vspark/shared/visemes`).

See [component-managers.md](component-managers.md) for the `LipsyncManager` lifecycle and graph descriptor. This document covers the frontend pipeline and per-behavior calibration.

## MFCC pipeline

The classifier (steps 4–11) is `VisemeClassifier` in `@vspark/shared/visemes`. The browser's [MicCapture.ts](../../packages/frontend/src/media/MicCapture.ts) supplies steps 1–3 from an `AnalyserNode`; the server supplies them from `powerSpectrum()`, which reproduces the AnalyserNode's Blackman-window FFT (`(|X|/N)²`, smoothing 0). Absolute spectrum scale does not matter: a constant gain only shifts log-mel, which lands in the dropped DC coefficient (asserted in `shared/test/visemes.test.ts`).

Per audio frame:

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

`DEFAULT_TEMPLATES` in `@vspark/shared/visemes` holds vowel templates captured from one English-speaking adult voice at 48 kHz. Behaviors that have not been calibrated fall back to these.

## Per-behavior calibration

**Storage**: `behaviors.config.vowelTemplates: { A: number[12], E: ..., I: ..., O: ..., U: ... }` (table renamed from `node_components` in migration 022).

**UI**: `LipsyncCalibration` block in [packages/frontend/src/components/editor/PropertiesPanel.tsx](../../packages/frontend/src/components/editor/PropertiesPanel.tsx), rendered inside `LipsyncProcessorProps` below the existing sensitivity field. Hold-to-record per vowel:

- Press-and-hold spins up a temporary `MicCapture` instance with an `onCaptureFrame` callback that collects MFCC vectors.
- On release, the collected vectors are averaged into the template for that vowel and persisted to `behaviors.config`.

**Application**: `MediaInputWindow.toggleLipsync` reads the saved templates from the behavior config and calls `mic.setTemplates(templates)` before `mic.start()`. If no templates are saved, `MicCapture` keeps `DEFAULT_TEMPLATES`.

## PipeWire input (server-side)

[packages/backend/src/behaviors/lipsync/pipewireCapture.ts](../../packages/backend/src/behaviors/lipsync/pipewireCapture.ts) — `PipeWireLipsyncCapture`, owned by `LipsyncManager` per behavior.

**Config**: `inputMode: 'pipewire'` + `pipewireSource: '<source name>'` (blank source = no capture). A sink's `.monitor` source follows everything played into that sink. Saved `vowelTemplates` apply here too.

**Capture**: spawns `parec --device=<source> --format=float32le --rate=48000 --channels=1 --latency-msec=20 --raw` and keeps a ring of the latest `FFT_SIZE` (2048) samples. A frame is classified every `rate / 30` samples (30 fps, the browser uplink's rate), so pacing comes from the audio itself.

**Behavior worth knowing**:

- Silence after silence is not re-sent: the first closed frame goes out, then nothing until there is sound again.
- A suspended null-sink's monitor delivers **no samples at all**; a watchdog (150 ms) closes the mouth when data stops, rather than leaving it frozen mid-vowel.
- `parec` exiting, failing to spawn, or missing (ENOENT) restarts it with exponential backoff (1 s doubling to 30 s, reset once data arrives). `parec` stderr is logged.
- While a behavior is in `pipewire` mode, `lipsync_input` from a browser is ignored for it, so a media-input tab left open cannot fight the capture.
- Captures are reconciled on every `syncBehaviors`; a change to the source or to valid templates restarts the capture, other settings do not.

**Platform**: Linux with PipeWire (pipewire-pulse) or PulseAudio — it needs `parec` on `PATH`.

**Sync**: pointing OBS at the same source as the lipsync puts mouth and stream audio on one clock. This was the reason for capturing a source rather than taking PCM pushed over the network (decided by the user, 2026-11-18, for the ai_tuber AI-character integration).

## Wire format

Unchanged by this work. The frontend sends a `lipsync_input` WS message carrying `Fcl_MTH_*`-keyed weights to the backend. Only the *source* of those weights changed (custom MFCC classifier vs. previous heuristics).

## Backend graph

Minimal — no signal-graph changes were needed for this feature:

```
lipsync_source → unpack_event → viseme_passthrough → blendshapes_broadcast
```

Defined in [packages/backend/src/behaviors/lipsync/graph.ts](../../packages/backend/src/behaviors/lipsync/graph.ts).

### Latent bug fixed during this work

The graph descriptor previously contained a stray edge wiring `cfg_sensitivity.value` (a `number`) into `passthrough.blendshapes` (expects `Blendshapes`). On pull paths where no event payload was available, this caused `bs.map is not a function` crashes. The edge has been removed.

### Sensitivity (fixed)

The sensitivity slider used to be a no-op: `viseme_passthrough` read `config.sensitivity`, the `cfg_sensitivity` settings node was not wired, and the manager never injected `_settings`. Now `viseme_passthrough` has a `sensitivity` value input (falling back to `config.sensitivity`), the template wires `cfg_sensitivity` into it, and the manager injects the behavior's config into settings nodes. See [component-managers.md](component-managers.md).

## Extension notes

- To change the cepstral feature count, the bandcount, or the mel range, edit the constants at the top of `MicCapture.ts`. Existing stored templates are sized to 12 coefficients; changing this requires invalidating saved `vowelTemplates`.
- To add additional visemes (e.g. consonant classes), extend both the template structure in `vowelTemplates` and the classifier output mapping. The wire format already accepts arbitrary `Fcl_MTH_*` keys.
- Silence gate and EMA α are currently hardcoded (`VisemeClassifier` fields); promote them to behavior config if user-tunable behaviour is needed.
- A different capture backend (e.g. Windows/WASAPI) would sit beside `PipeWireLipsyncCapture` and feed `VisemeClassifier.processSamples()` the same way.
