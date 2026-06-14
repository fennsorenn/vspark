# Lighting {#lighting}

A light node illuminates the scene. Select a light in the scene graph and edit its parameters in the **Properties** panel. Note that toon-style (MToon) materials largely ignore scene lights, while realistic [materials](topic:materials#mode) respond to them fully.

## Light type {#type}

Selects the physical behaviour of the light.

![Light types](/help/diagrams/light-types.svg)

*1 — point: light radiates in every direction from one position. 2 — directional: parallel rays from far away, like sunlight. 3 — spot: a cone of light aimed by rotating the node. (Ambient adds uniform fill from all directions and has no diagram.)*


- **Point** — emits light in all directions from a single position, like a bare bulb. Brightness falls off with distance. Default.
- **Directional** — casts parallel rays from an infinite distance, like sunlight. Every surface at the same angle receives the same intensity regardless of how far it is from the light's position marker. Position still matters for shadow casting because it determines the shadow-camera placement.
- **Ambient** — adds a constant base brightness to all surfaces equally, from all directions. Cannot cast shadows. Use it to prevent a scene from going completely dark.
- **Spot** — emits a cone of light from a point, like a stage spotlight. Aimed by rotating the node.

## Color {#color}

The tint of the light. Click the colour swatch to open the colour picker. Default is white (`#ffffff`). A warm orange simulates tungsten; a cool blue-white simulates overcast daylight.

## Intensity {#intensity}

How bright the light is. `0` is off; `1` is the default; values above `1` are valid and will overexpose nearby surfaces with realistic materials. Adjust in steps of `0.1`. For a neutral studio look, a directional key light around `1.0` combined with an ambient light around `0.3–0.5` is a common starting point.

## Shadows {#shadows}

Controls whether this light calculates and casts shadows onto the scene. This section is hidden for ambient lights because they have no direction and cannot produce shadows.

**Cast shadows** (checkbox) — enable shadow rendering for this light. Shadows are off by default. Shadows only appear in the output if the active camera also has its own shadow setting switched on (see Camera Properties). With shadows enabled, three sub-options appear:

- **Map size** — the resolution of the shadow texture in pixels (square). Options: 512, 1024 (default), 2048, 4096. Higher values produce sharper shadow edges at the cost of GPU memory. For most stream use cases 1024 is sufficient; use 2048 if shadow edges look blocky.
- **Bias** — a small depth offset applied during shadow lookup to reduce "shadow acne" (dark ripple artefacts on lit surfaces). Default is `-0.0005`. If you see acne, make the value slightly more negative (e.g. `-0.001`). If you see "peter-panning" (shadows detaching from objects), move it closer to zero.
- **Shadow area** (directional lights only) — the half-extent of the shadow camera's orthographic frustum in world units. Default `10`. Everything within this square centred on the directional light's target position can receive shadows. If distant objects have no shadow, increase this value; if shadow detail looks low-res, decrease it.
