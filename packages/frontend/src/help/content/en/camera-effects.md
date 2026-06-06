# Camera Effects {#camera-effects}

**Camera effects** are visual filters applied on top of what a camera sees —
like Instagram filters for your 3D scene. They run as a post-processing stack,
meaning they process the finished render before it reaches your stream.

## What are camera effects? {#what}

Each effect is a separate layer that transforms the image in one step. Because
they **stack**, the order matters: colour adjustments happen before bloom, bloom
before blur, and so on. You can have multiple effects on the same camera at
once, each enabled or disabled independently.

Effects only apply to cameras that have the ✦ preview icon active in the scene
tree. You can turn them all off at once by deselecting that camera.

## A tour of common effects {#common}

### Glow and colour

- **Bloom** — makes bright areas bleed a soft glow outward. Great for neon
  lights, magic effects, or just a dreamy look.
- **Tone Mapping** — controls the overall brightness curve of the render, from
  a flat "linear" look to filmic styles like ACES that lift shadows and add
  contrast.
- **Brightness / Contrast** — nudges the whole image brighter or darker, and
  adjusts how punchy the difference between light and dark areas feels.
- **Hue / Saturation** — shifts all colours at once (hue) or pumps up / fades
  down colour intensity (saturation).
- **Sepia** — blends the image toward warm brown tones for a vintage look.

### Depth and focus

- **Depth of Field** — blurs the parts of the scene that are in front of or
  behind the focus point, like a real camera lens. An autofocus option lets
  vspark pick the focal distance automatically.
- **Tilt Shift** — blurs a horizontal or diagonal band of the image, leaving a
  sharp strip in the middle. Makes scenes look like tiny models.

### Atmosphere and texture

- **Vignette** — darkens the corners of the frame, drawing the eye inward.
- **Ambient Occlusion (SSAO)** — adds soft contact shadows where surfaces meet,
  giving the scene more depth and weight.
- **Outline** — draws coloured lines along surface edges, for a toon / cel
  animation look.
- **God Rays** — shafts of light emanating from a bright point (requires a
  "God Ray Caster" node placed in your scene as the light source).

### Stylised and artistic

- **Chromatic Aberration** — splits colours apart at the edges, mimicking a
  cheap lens or a glitchy camera.
- **Noise** — overlays a subtle grain for a film-like texture.
- **Scanlines** — horizontal lines across the frame for a retro CRT look.
- **Pixelation** — reduces resolution in blocks for a lo-fi pixel-art style.
- **ASCII** — renders the scene as ASCII characters.
- **Dot Screen** — halftone dot pattern, like old newsprint.
- **Glitch** — randomly distorts the image in slices, for a broken-signal
  effect.
- **Water** — ripples the image as though it were seen through water.

## Adding, removing, and reordering effects {#adding}

Effects are managed in the **scene tree** (the panel on the left), not in
Properties. Select your camera node, then look for the effects section below
the node row. From there you can:

- **Add** an effect by clicking the **+** button and picking a type from the
  list.
- **Enable / disable** an effect with the toggle switch — it stays saved but
  stops rendering until you re-enable it.
- **Remove** an effect with the trash icon.
- **Edit** an effect's parameters by clicking on it — this opens the focused
  effect settings in the Properties panel on the right.

The rendering order is fixed (colour grading → bloom → depth effects → edges
→ distortion → god rays → tone mapping), so the only ordering that matters for
your stream is which effects you choose to enable.
