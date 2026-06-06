# Materials {#materials}

A material controls how a surface looks: its colour, shininess, transparency, and how it reacts to scene lights. Each material on a loaded VRM avatar can be configured independently in the **Material** section of the Properties panel.

## Material mode {#mode}

The **shader** toggle (MToon / PBR / APBR) sets the rendering model for one material.

- **MToon** — toon/anime shading. Ignores most scene lights and environment reflections; instead uses a built-in shade colour so the avatar's backside never goes fully black. This is the default for VRM files. Use it when you want a drawn, illustrative look that doesn't change with your lighting rig.
- **PBR** — physically based rendering (`MeshStandardMaterial`). Responds to scene lights and environment intensity. A surface facing away from your key light will darken accordingly. Use it when you want realistic light falloff, shadows, and reflections. Note: with no in-range lights the avatar will appear very dark.
- **APBR** — advanced physical rendering (`MeshPhysicalMaterial`). A strict superset of PBR. Renders identically to PBR at its defaults and only differs when you dial up one of its extra lobes (clearcoat, sheen, transmission, iridescence, anisotropy). Use it when PBR is not enough — glass, fabric, metallic-flake paint, and similar effects.

The MToon button is disabled for materials that were not originally authored as MToon (native PBR/standard materials cannot be converted to toon shading).

## Base color {#basecolor}

The main surface colour. Click the swatch to open the colour picker. Applies in all three shader modes. In MToon this is the lit-side colour; in PBR/APBR it is the albedo fed into the physically based calculation. If the VRM includes a colour texture, the base colour acts as a tint multiplied on top of it — white leaves the texture unchanged.

## Metalness & roughness {#metalrough}

Available in **PBR and APBR** modes.

- **Roughness** (0–1, default `0.9`) — controls how blurry or sharp surface reflections are. `0` is a mirror-smooth surface; `1` is fully diffuse with no visible specular highlight. Most anime-style VRM models look best between `0.7` and `1.0`. Lower values make the surface visibly shiny.
- **Metalness** (0–1, default `0`) — controls whether the surface behaves as a conductor (metal) or an insulator (most organic materials). At `0` the surface is non-metallic: it reflects with a white tint and retains its base colour as diffuse. At `1` the surface is fully metallic: it reflects with the base colour tint and has no diffuse component. Intermediate values are generally not physically accurate; use `0` or `1` in most cases.

## Emissive {#emissive}

Available in **all three modes**.

- **Emissive colour** — the colour the surface glows with. Black (default) means no glow. Set a colour to make the surface appear self-illuminated regardless of how lights are placed.
- **Emissive intensity** (0–5, default `0`) — multiplies the emissive colour. At `0` the emissive colour has no effect. Values above `1` produce a bright, blown-out glow when bloom effects are enabled on the camera.

## Advanced (APBR) lobes {#advanced}

These controls are only available when the shader is set to **APBR**. They are grouped under a collapsible **Advanced** disclosure. Each lobe defaults to zero (off) and renders identically to PBR until raised.

- **Specular intensity** (0–1) — strength of a non-metallic specular highlight layer, independent of metalness. At the default `1` this matches standard Fresnel behaviour; lower values suppress the specular.
- **Specular tint** — colour of that specular layer. Default white. Tinting it shifts the colour of reflections on non-metallic surfaces.
- **Clearcoat** (0–1) — adds a second transparent lacquer layer on top of the base surface, like nail polish or car paint. `0` is off; `1` is a full gloss coat.
- **Clearcoat roughness** (0–1) — roughness of the clearcoat layer specifically, independent of the base roughness below it.
- **Sheen** (0–1) — a soft retroreflective glow at glancing angles, used for fabric and velvet. `0` is off.
- **Sheen roughness** (0–1) — spread of the sheen highlight. High values give a broader, softer fabric look.
- **Sheen color** — tint of the sheen highlight. Default white.
- **Transmission** (0–1) — how much light passes through the surface, making it look like glass or clear plastic. `0` is fully opaque; `1` is fully transmissive. Pair with the IOR parameter for accurate refraction.
- **Thickness** (0–5) — approximate depth of the transmissive volume in world units. Affects how attenuation and refraction accumulate through the material. Has no visible effect without transmission above zero.
- **IOR** (1–2.333) — index of refraction, controlling how much light bends when entering the transmissive material. Water is approximately `1.33`; glass is approximately `1.5`; diamond is approximately `2.4`. Default is the three.js neutral value.
- **Attenuation color** — the colour that the material absorbs as light travels through its volume. Default white (no absorption). A red attenuation tints transmitted light red.
- **Attenuation distance** (0–5) — how far (in world units) light travels before reaching the attenuation colour. `0` disables volume attenuation. Larger values mean the colour builds up more slowly across a thick object.
- **Iridescence** (0–1) — thin-film interference producing rainbow-like colour shifts that change with viewing angle, like soap bubbles or oil slicks. `0` is off.
- **Iridescence IOR** (1–2.333) — index of refraction for the thin iridescent film. Affects which hues appear and at which angles.
- **Anisotropy** (0–1) — stretches specular highlights in the surface's tangent direction, giving brushed-metal or hair-like streaks. `0` is isotropic (round highlights).

## Environment intensity {#env}

Available in **PBR and APBR** modes.

**Env intensity** (0–3, default `1`) — a per-material multiplier on the environment map (HDRI) contribution. The scene-level environment intensity is set per camera; this control scales it further for this individual material. At `1` the material receives the full scene environment. At `0` it ignores the environment entirely and relies solely on placed scene lights. Values above `1` brighten reflections beyond the scene-level setting.
