# Node: Particle

GPU-instanced billboard particle system with per-particle physics simulation, camera-aligned rendering, and dual local/world-space modes. Implemented in `Viewport.tsx` as `ParticleNode`.

## Rendering architecture

Each particle is a `PlaneGeometry(1, 1)` instance in a `THREE.InstancedMesh`. Standard Three.js instancing doesn't support per-instance alpha, so a custom `ShaderMaterial` is used with a per-instance `InstancedBufferAttribute` (`aAlpha`).

**Vertex shader** reads `instanceColor` (RGB, Three.js built-in) and `aAlpha` (custom float attribute), forwards them to the fragment shader along with UVs.

**Fragment shader** samples `uTex` (or `vec4(1.0)` if no texture), multiplies by instance color and alpha:
```glsl
gl_FragColor = vec4(vColor * texSample.rgb, vAlpha * texSample.a);
```

Per-frame updates: `mesh.setMatrixAt(i, matrix)`, `mesh.setColorAt(i, color)`, `aAlpha.array[i] = alpha` — all three buffers flushed with `needsUpdate = true`.

## Particle pool — `particleUtils.ts`

All particle state is pre-allocated as typed arrays:

| Array | Contents |
|-------|---------|
| `positions` | xyz × maxCount |
| `velocities` | xyz × maxCount |
| `ages` | seconds alive |
| `lifetimes` | max lifetime per particle |
| `colors` | rgb × maxCount |
| `alphas` | per-particle alpha |
| `sizes` | per-particle size |
| `rotations` | radians (current) |
| `angVels` | radians/sec |
| `active` | Uint8Array, 1 = alive |
| `accumulator` | fractional emission carry |

When `maxCount` changes, the pool is reallocated and the old `playing` state is preserved.

## Emission

**Continuous** (`burstMode: false`): accumulator-based. `accumulator += emissionRate × delta`; one particle spawned per whole unit, remainder carried forward. Finds first inactive slot.

**Burst** (`burstMode: true`): all particles spawned in a single tick. `burstFired` flag prevents repeat. Resets on loop.

**Spawn volume**: random offset within `originW × originH × originD` box, centered on emitter.

**Spawn direction**: normalized `(directionX, directionY, directionZ)`, defaulting to `(0, 1, 0)`. Two perpendicular axes are computed via cross product. Azimuth `θ` is uniform random in [0, 2π]; polar angle `φ` is uniform random in [0, spreadRad]. Velocity = `direction + perp1 × sin(φ)cos(θ) + perp2 × sin(φ)sin(θ)`, scaled by `speed × (1 + rand × speedRandom)`.

## Per-frame simulation (`tickParticles`)

Each active particle per frame:

1. **Age**: `ages[i] += delta`. If `ages[i] >= lifetimes[i]` → deactivate, park position at (1e9, 1e9, 1e9).
2. **Gravity**: `velocities += gravity × delta`
3. **Turbulence** (if > 0): add sin-based 3D noise scaled by `turbulence × delta × 10`
4. **Position**: `positions += velocities × delta`
5. **Color**: lerp `colorStart → colorEnd` over normalised lifetime `t ∈ [0, 1]`
6. **Alpha over lifetime**:
   - `constant` → `alpha`
   - `fade-in` → `alpha × t`
   - `fade-out` → `alpha × (1 - t)`
   - `fade-in-out` → `alpha × sin(t × π)`
7. **Size over lifetime**:
   - `constant` → `sizeX`
   - `shrink` → `sizeX × (1 - t)`
   - `grow` → `sizeX × t`
   - `pulse` → `sizeX × sin(t × π)`
8. **Rotation**: `rotations[i] += angVels[i] × delta`

## Camera billboard alignment and rotation modes

Every particle faces the camera by composing the camera's world quaternion with a per-particle Z-axis rotation:

```
finalQuat = cameraQuat × zRotation
mesh.setMatrixAt(i, compose(position, finalQuat, scale))
```

**`rotationMode: 'free'`**: Z rotation is `rotations[i]` (updated by angular velocity each frame). Initial rotation is random in `±rotationStart` degrees.

**`rotationMode: 'velocity'`**: Projects the particle's velocity onto the camera's screen plane:
```
screenX = velocity · camRight
screenY = velocity · camUp
zAngle  = atan2(-screenX, screenY)   // aligns particle +Y to velocity direction
```
The particle sprite's top edge follows its direction of travel.

## Local vs. world-space simulation

**World-space** (`simulationSpace: 'world'`): The `InstancedMesh` is added directly to the scene root. Particle positions are in world space. When spawned, the emitter's world position is added to the initial position. Particles stay in place when the emitter moves — useful for fire, sparks.

**Local-space** (`simulationSpace: 'local'`): The `InstancedMesh` is a child of the particle node's group. Each frame, particle positions are converted from world to local via `matrixWorld.invert()` before writing to the instance matrix. Particles follow the emitter — useful for auras, trails attached to a character.

When the simulation space changes, the mesh is recreated and added to the appropriate parent.

## Texture

Loaded via `THREE.TextureLoader`; `colorSpace` set to `THREE.SRGBColorSpace`. Passed to the shader as `uTex`; `uHasTex` uniform switches between textured and untextured rendering. Texture is multiplied against instance color and alpha in the fragment shader.

## Blend modes

| Config value | Three.js constant |
|-------------|-------------------|
| `'normal'` | `THREE.NormalBlending` |
| `'additive'` | `THREE.AdditiveBlending` |
| `'multiply'` | `THREE.MultiplyBlending` |

Default is `additive` (bright particles accumulate on top of each other).

## Why particles render outside the React node hierarchy

`ParticleNode` is rendered at the top level of `SceneNodes`, not nested under its parent node. If it were rendered in the hierarchy, React would unmount and remount it whenever its parent changed (reparenting, hide/show), destroying the particle pool and resetting simulation state. The world position of the emitter is read each frame via the `nodeGroupRegistry`, so spatial parenting still works correctly.

## Config reference (`ParticleConfig`)

| Field | Default | Description |
|-------|---------|-------------|
| `textureUrl` | `null` | Sprite texture path |
| `blendMode` | `'additive'` | `normal`, `additive`, `multiply` |
| `depthWrite` | `false` | Usually off for transparent particles |
| `depthTest` | `true` | |
| `maxCount` | `200` | Pool size (reallocates on change) |
| `simulationSpace` | `'world'` | `world` or `local` |
| `emissionRate` | `20` | Particles per second |
| `burstMode` | `false` | Emit all at once |
| `loop` | `true` | Restart after burst/lifetime |
| `playOnStart` | `true` | Auto-play on mount |
| `lifetime` | `2` | Seconds |
| `lifetimeRandom` | `0.2` | ± variation multiplier |
| `sizeX/Y` | `0.05` | Width/height in world units |
| `sizeRandomX/Y` | `0.2` | ± variation |
| `sizeOverLifetime` | `'shrink'` | `constant`, `shrink`, `grow`, `pulse` |
| `colorStart` | `'#ffffff'` | Start color hex |
| `colorEnd` | `'#ff6600'` | End color hex |
| `alpha` | `1` | Base opacity |
| `alphaOverLifetime` | `'fade-out'` | `constant`, `fade-in`, `fade-out`, `fade-in-out` |
| `directionX/Y/Z` | `0, 1, 0` | Emission direction |
| `spread` | `30` | Cone spread in degrees |
| `speed` | `1` | Units/sec |
| `speedRandom` | `0.3` | ± variation (0–1) |
| `originW/H/D` | `0` | Spawn volume half-extents |
| `gravityX/Y/Z` | `0, -0.5, 0` | Acceleration (units/sec²) |
| `turbulence` | `0` | Noise-based velocity perturbation |
| `rotationMode` | `'free'` | `free` or `velocity` |
| `rotationStart` | `180` | Initial rotation range ±degrees |
| `angularVelocity` | `0` | Degrees/sec |
| `angularVelocityRandom` | `0` | ± variation |

## Billboard node

`BillboardNode` is simpler: two `PlaneGeometry` meshes (front, optional back) with `MeshBasicMaterial`.

**`facing: 'screen'`**: copies `camera.quaternion` to the billboard group every frame — always faces the viewer.  
**`facing: 'world'`**: no rotation applied — billboard stands in world space.

**Backface**:
- `'none'`: single plane, no back
- `'mirror'`: back plane uses a cloned texture with `repeat.set(-1, 1)` and `offset.set(1, 0)` — horizontally flipped
- `'unmirrored'`: back plane uses the same texture unmodified

Both meshes use `depthWrite: false` to prevent z-fighting when multiple billboards overlap.

Like particles, billboards render outside the React node hierarchy for the same reason — instance stability across reparenting.
