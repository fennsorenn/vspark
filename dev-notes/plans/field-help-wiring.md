# Field-level help wiring spec (PropertiesPanel)

Goal: replace the generic per-section "Learn about X" help buttons with
**field-level** help on genuinely non-obvious controls. Each affordance shows a
real one-line explanation on hover and deep-links to that parameter in the docs.

## Mechanism (already in place)

- `SliderInput` (in `components/editor/numericInputs.tsx`) now accepts an optional
  `help={{ topic, anchor, tip }}` prop and renders a `?` next to its label. Use
  this for slider fields.
- For non-slider controls (selects, custom rows), place a `<HelpButton topic=…
  anchor=… tip={t('help.X')} size={12} />` immediately after the field's label
  text, inside the label element (so it sits inline with the label).
- Tooltips (`tip`) come from the `properties` namespace under `help.*` keys —
  add to BOTH `i18n/locales/{en,de}/properties.json`.

## Rules

- Only add help to NON-OBVIOUS controls. Skip obvious ones: Position, Rotation,
  Scale, plain Color pickers, Name, simple on/off visibility toggles, Width/Height.
- One affordance per concept. For a paired control (e.g. Metalness + Roughness)
  put ONE `?` on the group/first label, not one per slider.
- REMOVE the existing generic section-header HelpButtons in PropertiesPanel whose
  tips are "Learn about …" (avatar/camera/light/breathing/etc. section headers).
  The field-level help replaces them. (Keep the per-prop section header buttons
  ONLY where there's no obvious field to attach to, e.g. the Feed template.)
- Derive each `tip` from the matching doc section (accurate, concise, one line).
  Write a real German translation for each.

## Field → topic#anchor map

Camera (perspective/ortho):
- FOV slider → `camera#fov`
- Projection select → `camera#projection`
- Orthographic size → `camera#projection`
- Near/Far clipping → `camera#clipping`
- Environment intensity → `camera#env`

Light:
- Light type select → `lighting#type`
- Intensity slider → `lighting#intensity`
- Shadow controls (group) → `lighting#shadows`

Material editor (per material):
- Mode select (MToon/PBR/APBR) → `materials#mode`
- Metalness/Roughness (group) → `materials#metalrough`
- Emissive (color+intensity group) → `materials#emissive`
- Advanced APBR lobes (group/section) → `materials#advanced`
- Environment intensity → `materials#env`

Particles:
- Emission rate → `particles#emission`
- Lifetime → `particles#lifetime`
- Size (group) → `particles#size`
- Color & alpha (group) → `particles#color`
- Direction & speed (group) → `particles#direction`
- Emission area → `particles#origin`
- Motion / gravity (group) → `particles#motion`
- Rotation (group) → `particles#rotation`
- Rendering: blend mode / max count / depth (group) → `particles#rendering`

Props:
- Video playback (autoplay/loop/on-end/volume group) → `props#video-playback`
- Video chroma key (group) → `props#video-chroma`
- Audio type select → `props#audio`
- Audio spatial (group) → `props#audio-spatial`
- Text content/HTML/anchor (group) → `props#text`
- Feed template/css (group) → `props#feed`

Camera effects (EffectPanel header `?`): change the existing
`topic="camera-effects" anchor="what"` to the specific effect's anchor based on
the selected effect's `kind`. Mapping:
fx_tone_mapping→tonemap, fx_brightness_contrast→colorgrade,
fx_hue_saturation→hue-saturation, fx_sepia→sepia, fx_bloom→bloom,
fx_depth_of_field→dof, fx_chromatic_aberration→chromatic, fx_ssao→ssao,
fx_outline→outline, fx_vignette→vignette, fx_noise→noise, fx_scanline→scanline,
fx_pixelation→pixelate, fx_ascii→ascii, fx_dot_screen→dotscreen,
fx_glitch→glitch, fx_smaa→smaa, fx_tilt_shift→tiltshift, fx_water→water.
(Define a small `kind → anchor` record near EffectPanel.)

## Validation
- `node -e "JSON.parse(require('fs').readFileSync('<properties.json>'))"` for both locales.
- Keep en/de `help.*` keys in sync.
