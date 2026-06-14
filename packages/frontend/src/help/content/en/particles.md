# Particles {#particles}

A particle emitter spawns a pool of small textured sprites and simulates their movement each frame. Every parameter below is live — you can adjust it while the emitter is playing and see the change immediately.

## Emission rate {#emission}

**Emission rate** — how many new particles spawn per second. Default: 20. At 1 the emitter trickles one particle per second; at 100 you get a dense continuous stream. Raising this fills the scene with particles faster; if you also raise Max count (see Rendering) you can sustain a larger cloud.

**Burst mode** — when enabled, all `Max count` particles are fired at once in a single tick instead of over time. Useful for explosions or a one-shot confetti pop. The emitter stops after the burst; enable Loop to repeat it.

**Loop** — when enabled the emitter restarts automatically after each burst, or runs continuously in normal mode. Default: on.

**Play on start** — when enabled the emitter begins playing as soon as the node loads. Default: on. Disable if you want to trigger playback from a Logic automation.

## Lifetime {#lifetime}

![Particle lifetime](/help/diagrams/particle-lifetime.svg)

*Over its lifetime a particle is born, can grow and change colour, then fades out and disappears.*

**Lifetime** — how long each particle lives, in seconds, before it disappears. Default: 2 s. Short lifetimes (0.1 – 0.5 s) keep the cloud tight and near the emitter. Long lifetimes (5 – 10 s) let particles drift far before fading.

**Lifetime random** — adds randomness to each particle's lifetime. A value of 0 means all particles live exactly the set duration. At 0.5 each particle's actual lifetime varies by up to ±50 % of the base value. Default: 0.2. Increasing this avoids the "all particles vanish at once" look.

## Size {#size}

**Width / Height** — the base size of each particle sprite in world units. Default: 0.05 × 0.05. One world unit is roughly the height of an average avatar, so 0.05 is about a finger-width. Double these for larger, more visible particles; reduce to 0.01 for a fine dust effect.

**Width random / Height random** — per-particle size variation, as a fraction of the base size (0 – 1). At 0 every particle is the same size. At 0.5 individual particles vary by up to ±50 %. Default: 0.2 each. Higher values give an organic, uneven look.

**Size over lifetime** — how each particle's size changes as it ages:

- `constant` — size stays fixed throughout the particle's life.
- `shrink` — starts at full size, shrinks to zero before dying. Default. Good for fire or sparks that fade out naturally.
- `grow` — starts invisible and expands to full size. Good for smoke puffs that billow outward.
- `pulse` — grows then shrinks in a smooth arc (a full sine wave over the lifetime). Good for glows or bubbles.

## Color & alpha {#color}

**Color start / Color end** — the color each particle has at birth and at death. Between those two points the color is linearly interpolated. Defaults: white → orange-red. For smoke, try white → dark grey. For a cool energy effect, try cyan → transparent (using alpha over lifetime).

**Alpha** — the base opacity of each particle, 0 (invisible) to 1 (fully opaque). Default: 1. Lowering this makes the entire system more transparent without changing the fade curve.

**Alpha over lifetime** — how each particle's opacity changes as it ages:

- `constant` — opacity stays at the base Alpha value throughout life.
- `fade-in` — starts transparent and reaches full Alpha at end of life.
- `fade-out` — starts at full Alpha and fades to zero. Default. The most natural look for fire, smoke, and dust.
- `fade-in-out` — fades in during the first half of the particle's life and out during the second half. Good for sparkling effects.

**Emissive intensity** — multiplier applied on top of the particle color in the shader. Default: 1. Values above 1 make particles appear brighter than their raw color, which is useful with additive blending to simulate glowing embers or light-emitting sparks. Has no visible effect with normal blending.

## Direction & speed {#direction}

**Direction X / Y / Z** — the primary axis particles travel along when spawned. Default: (0, 1, 0) — straight up. Change Y to −1 for falling rain or snow. Use (1, 0, 0) for a horizontal stream shooting sideways. The vector does not need to be normalized; it is normalized automatically.

**Spread** — how wide the cone of emission is, in degrees (0 – 180). Default: 30°. At 0° all particles fly in exactly the direction vector — a tight beam. At 90° particles fan out in a hemisphere. At 180° particles can go in any direction (a sphere). Increasing this makes effects like fire and smoke look fuller and more natural.

**Speed** — how fast each particle travels in world units per second. Default: 1. For slow drifting fog try 0.2; for fast sparks try 3 – 5.

**Speed random** — per-particle speed variation (0 – 1). At 0 all particles move at exactly the set speed. At 0.5 each particle's speed varies by up to ±50 % of the base. Default: 0.3. Increases the natural variation in a cloud.

## Emission area {#origin}

These three values define a box, centered on the emitter, from which particles are randomly spawned. Each value is the half-extent (radius) in world units along that axis. All default to 0, meaning all particles spawn from the exact emitter position (a point emitter).

**Origin width (X)** — spread along the X axis. At 0.5 particles can spawn anywhere in a 1-unit-wide band. Use this for a line emitter along X.

**Origin height (Y)** — spread along the Y axis. Useful for a vertical column or a tall source area.

**Origin depth (Z)** — spread along the Z axis. Combine all three to create a volumetric spawn region — for example a 1 × 1 × 1 cube origin for a campfire with visible embers rising from the whole fire bed.

## Motion (gravity / forces) {#motion}

**Gravity X / Y / Z** — constant acceleration applied to every active particle each frame, in world units per second squared. Default: (0, −0.5, 0) — a mild downward pull. Set Y to 0 to get floating, weightless particles. Increase the magnitude to −2 or −3 for dramatic falling sparks. Set Y positive for rising bubbles. X and Z can create wind effects.

**Turbulence** — adds a continuous, noise-based random perturbation to each particle's velocity each frame. Default: 0 (off). At 0.1 particles wobble slightly, good for smoke. At 0.5 paths become noticeably chaotic. Very high values make particles jitter erratically.

## Rotation {#rotation}

**Rotation mode** — controls how each particle sprite is rotated around its center:

- `free` — each particle starts with a random initial rotation and spins at a fixed angular velocity. Use for tumbling debris, leaves, or snowflakes.
- `velocity` — the sprite's top edge is always aligned with the direction the particle is currently traveling on screen. Use for directional sparks, rain streaks, or speed lines where the shape should point forward.

**Rotation start** — in `free` mode, each particle's starting rotation is chosen randomly in the range ±this value (degrees). Default: 180°. At 180° particles begin at any possible angle. At 0° all particles start upright. Has no effect in `velocity` mode.

**Angular velocity** — in `free` mode, how many degrees per second each particle spins. Default: 0 (no spin). Positive values spin clockwise when viewed from the front; negative counterclockwise. Try 90° – 360° for visible tumbling.

**Angular velocity random** — in `free` mode, per-particle variation around the base angular velocity (degrees/s). At 0 every particle spins at the same rate. Increasing this makes some particles spin faster and some slower, adding variety.

## Rendering (blend mode, max count, depth) {#rendering}

**Blend mode** — how each particle's color is combined with what is behind it:

- `additive` — the particle's color is added to the scene behind it. Default. Bright overlapping particles accumulate to create a glowing effect. Black areas of the sprite become fully transparent. Best for fire, sparks, glows, lasers.
- `normal` — standard alpha compositing. The particle's alpha controls how much it covers what is behind. Correct for opaque or semi-transparent sprites like smoke puffs or bubbles.
- `multiply` — the particle's color is multiplied against the scene behind it. Darkens what is behind; white becomes transparent. Useful for shadow-like overlays.

**Simulation space** — whether the particle pool is simulated in world space or local space:

- `world` — particle positions are tracked in world space. When the emitter moves, previously spawned particles stay where they are. Use for fire, sparks, or anything that leaves a trail in space.
- `local` — particle positions follow the emitter. If you move the emitter node, the whole cloud moves with it. Use for auras, forcefields, or effects attached to a character.

**Max count** — the total number of particles that can be alive at once. Default: 200. The pool is pre-allocated; changing this reallocates memory. Raise to 500 – 2000 for dense effects (at some GPU cost). Lower to 50 – 100 for subtle accents that don't need a large cloud.

**Depth write** — when enabled, particles write to the depth buffer, which can cause them to clip other particles or scene geometry. Default: off. Leave off for normal transparent particles. Turn on only if you need particles to occlude specific geometry and z-fighting is not a problem.

**Depth test** — when enabled, particles are hidden behind solid geometry. Default: on. Turn off only if you want particles to always appear in front of everything regardless of depth, which is rarely desired.
