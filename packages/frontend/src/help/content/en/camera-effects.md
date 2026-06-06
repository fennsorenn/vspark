# Camera effects {#camera-effects}

Camera effects are post-processing filters applied to a camera's rendered image before it reaches your stream or preview. They do not change the 3D scene itself — they transform the final picture, like colour grading or a lens filter applied in a darkroom after the photo is taken. Multiple effects stack in a fixed pipeline order, so the result of one feeds into the next.

## What camera effects are {#what}

Each effect runs as a step in the post-processing pipeline. Because they run in sequence, the combined result depends on which effects are active together — for example, Bloom applied after colour grading will glow with the graded colours, not the originals. The pipeline order is fixed (colour adjustments run first, tone mapping last), so you control the look by choosing which effects to enable and how you configure them.

Effects are only active for the camera that has the **✦** icon lit in the scene tree. Deselecting that icon turns off all effects at once, which is useful when you need full rendering performance.

## Adding and ordering effects {#adding}

Effects are managed in the **scene tree** on the left, not in the Properties panel. Select a camera node, then use the effects section that appears beneath it:

- Click **+** to add a new effect and choose its type from the list.
- Use the **toggle** next to an effect to enable or disable it without removing it.
- Click the **trash** icon to remove an effect permanently.
- Click an effect's name to open its parameter controls in the Properties panel on the right.

The rendering order is fixed by the pipeline (colour grading → bloom → depth/atmosphere → edge → distortion → tone mapping). You cannot manually reorder effects, but the order they run in is consistent and predictable.

---

## Tone Mapping {#tonemap}

Tone mapping converts the internal high-dynamic-range (HDR) values of the render into the limited range a display can show. The choice of **Mode** changes the overall look of the entire image: ACES Filmic gives rich contrast with lifted shadows and subtle colour shift (a common film look); Neutral is accurate and unaltered; Reinhard compresses highlights softly; Linear applies no curve at all, which looks flat but is useful when colour grading manually with other effects. Tone Mapping always runs last in the pipeline, so it affects the combined result of everything above it.

## Brightness / Contrast {#colorgrade}

Adjusts the overall exposure and punch of the image. **Brightness** shifts the whole image lighter (positive) or darker (negative) within the range −1 to 1. **Contrast** makes bright areas brighter and dark areas darker (positive values) or compresses everything toward grey (negative values). Both controls are additive and intended for fine-tuning, not large swings.

## Hue / Saturation {#hue-saturation}

Shifts colours across the spectrum and controls how vivid they appear. **Hue** rotates all colours simultaneously — a small value such as 0.1 gives a warm or cool tint; larger values produce visible colour-shift effects. **Saturation** in the range −1 to 1 scales colour intensity: 0 is unchanged, −1 produces greyscale, and positive values make colours more vivid.

## Sepia {#sepia}

Blends the image toward warm brownish tones, reminiscent of old photographs. The single **Intensity** slider (0–1) controls how far toward full sepia the image shifts; at 0 it is invisible, at 1 the image is fully tinted.

## Bloom {#bloom}

Makes bright areas emit a soft glow that bleeds into surrounding pixels. The effect is visible on highlights, neon-style lighting, and any surface that is noticeably brighter than its surroundings.

- **Intensity** — how bright the glow is overall. Values around 1–2 are subtle; higher values produce a strong halo.
- **Luminance Threshold** — only pixels brighter than this value contribute to the glow. A value of 0.9 means only near-white areas glow; 0.5 starts affecting mid-tones.
- **Luminance Smoothing** — blends the edge of the threshold so the cut-off is not abrupt. Small values (0.01–0.05) give a clean threshold; larger values create a gradual ramp.

## Depth of Field {#dof}

Blurs the parts of the scene that are in front of or behind the focus distance, mimicking the shallow-focus look of a real camera lens. The blurred areas use a bokeh (disc-shaped) blur.

**Manual focus** parameters:
- **Focus Distance** — how far from the camera the sharp zone is centred, in world units (e.g. 3 = three metres).
- **Focus Range** — how wide the sharp zone is. A range of 2 means roughly ±1 metre around the focus distance stays sharp.
- **Bokeh Scale** — the size of the blur discs in out-of-focus areas. Higher values produce more pronounced blur.

**Autofocus**, when enabled, samples scene geometry to find the focus distance automatically:
- **AF Mode — Point** samples the scene at a specific screen position (X/Y, 0–1 from the top-left). Use this to keep a specific subject sharp.
- **AF Mode — Percentile** uses a statistical sample of visible depths and focuses at the chosen percentile (e.g. 15 = closer distances). Useful for keeping the nearest object sharp without targeting a fixed screen point.
- **Speed** controls how quickly the focus distance converges; **Delay** adds a pause before it begins moving (simulating an AF lag).

## Chromatic Aberration {#chromatic}

Splits the red, green, and blue colour channels apart by a small offset, producing coloured fringing on high-contrast edges — the look of a cheap or imperfect lens. **Offset X** and **Offset Y** set the horizontal and vertical separation in screen fractions (e.g. 0.002). Higher values make the fringing more visible; values above 0.01 become quite pronounced.

## Ambient Occlusion (SSAO) {#ssao}

Adds soft contact shadows in crevices and corners where surfaces are close together. This gives the scene more physical weight and depth without adding actual light sources.

- **Intensity** — how dark the shadowed areas become. Values of 1–2 are subtle; higher values produce strongly darkened crevices.
- **Radius** — how wide an area around each surface point is sampled. Larger values spread the shadow further from edges; smaller values produce tighter, sharper contact shadows.
- **Bias** — a small offset that prevents surfaces from incorrectly shadowing themselves. Increase it slightly if you see dark speckles on flat surfaces.

## Edge Outline {#outline}

Draws lines along depth and surface-normal edges in the scene, producing a toon / cel-shading look.

- **Color** — the colour of the outlines (colour picker).
- **Thickness** — how many pixels wide each line is. Values of 1–2 give a fine line; 4+ produces thick cartoon outlines.
- **Alpha** — the opacity of the outline lines, 0 (invisible) to 1 (fully opaque).
- **Threshold** — how sharp a depth difference must be before an outline is drawn. Lower values draw more outlines; very low values may outline every surface variation.

## Vignette {#vignette}

Darkens the edges and corners of the frame, drawing the viewer's eye toward the centre. Commonly used for a cinematic or focused feel.

- **Offset** — how far the dark border extends inward (0–1). Low values produce a narrow border; high values encroach on the centre.
- **Darkness** — how dark the border gets (0–1). A value of 0.5 gives a moderate dimming; 1.0 makes the corners nearly black.

## Noise {#noise}

Overlays a fine grain across the entire image, similar to film grain or sensor noise. The single **Opacity** slider (0–1) controls how visible the grain is. At low values (0.05–0.15) it adds subtle texture; at higher values the grain becomes prominent.

## Scanline {#scanline}

Overlays evenly spaced horizontal lines across the image, mimicking the horizontal scan pattern of a CRT monitor.

- **Density** — how many lines there are per screen height. Higher values produce finer, more tightly packed lines.
- **Opacity** — how visible the lines are (0–1). Low values add a subtle texture; high values produce strongly visible stripes.

## Pixelation {#pixelate}

Reduces the image to large square blocks, giving it a retro pixel-art or lo-fi look. The single **Granularity** parameter sets the block size in pixels — a value of 8 gives a mildly blocky look; 32 or more produces very coarse pixelation.

## ASCII {#ascii}

Renders the entire scene as a grid of ASCII text characters, with brightness mapped to different characters. The result looks like classic computer-terminal art.

- **Cell Size** — the size of each character cell in pixels. Smaller values produce finer detail (more characters on screen); larger values are coarser.
- **Font Size** — the size of the characters within each cell.
- **Color** — the colour of the characters (colour picker).
- **Characters** — the character palette, ordered from lightest to darkest (e.g. ` .:-+*=%@#`). Characters at the start of the string appear in bright areas; characters at the end appear in dark areas.

## Dot Screen {#dotscreen}

Overlays a halftone dot pattern across the image, evoking the look of offset-printed newsprint or vintage pop art.

- **Scale** — the size of the dots. Larger values produce bigger, more visible dots; smaller values give a fine-grained pattern.
- **Angle** — the rotation of the dot grid in radians. Different angles can reduce moiré interference with other patterns.

## Glitch {#glitch}

Randomly slices and offsets horizontal strips of the image at intervals, producing a digital-corruption or broken-signal look.

- **Delay (min / max)** — the range of wait times between glitch events, in seconds. For example, min 1.5 and max 3.5 means a glitch occurs roughly every 1.5–3.5 seconds.
- **Strength (min / max)** — the range of how far the slices are displaced. Low values (0.1–0.3) are subtle; high values (0.7–1.0) produce large offsets.

## SMAA {#smaa}

Subpixel Morphological Anti-Aliasing. Smooths jagged edges on geometry by blending pixels along diagonal lines. This effect has no configurable parameters — it is either on or off. It is most useful on cameras that render at lower resolution or with sharp-edged outlines.

## Tilt Shift {#tiltshift}

Blurs a horizontal (or rotated) band of the image, leaving a narrow strip in focus. The result makes the scene look like a miniature model photographed with a tilt-shift lens.

- **Focus Area** — the width of the sharp strip as a fraction of the image height (0–1). A value of 0.4 keeps a moderate band in focus; smaller values create a very narrow strip.
- **Feather** — how softly the blur blends at the edges of the focus band (0–1). Low values give a hard edge between sharp and blurred; high values give a smooth gradient.
- **Offset** — moves the focus strip up or down the image (−1 to 1), so you can place the sharp area on a subject that is not at the centre.
- **Rotation** — tilts the focus band at an angle (in radians).

## Water {#water}

Distorts the image with a ripple pattern, as though the scene were seen through the surface of water. The single **Factor** slider controls the intensity of the distortion. Low values (0.2–0.5) give a subtle shimmering effect; higher values produce strong wave distortion.
