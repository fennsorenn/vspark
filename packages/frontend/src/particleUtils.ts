import * as THREE from 'three'

export interface ParticleConfig {
  // Texture
  textureUrl: string | null
  // Rendering
  blendMode: 'normal' | 'additive' | 'multiply'
  depthWrite: boolean
  depthTest: boolean
  maxCount: number
  simulationSpace: 'world' | 'local'
  // Emission
  emissionRate: number
  burstMode: boolean
  loop: boolean
  playOnStart: boolean
  // Lifetime
  lifetime: number
  lifetimeRandom: number
  // Size
  sizeX: number
  sizeY: number
  sizeRandomX: number
  sizeRandomY: number
  sizeOverLifetime: 'constant' | 'shrink' | 'grow' | 'pulse'
  // Color & alpha
  colorStart: string
  colorEnd: string
  alpha: number
  alphaOverLifetime: 'constant' | 'fade-in' | 'fade-out' | 'fade-in-out'
  emissiveIntensity: number
  // Direction & speed
  directionX: number
  directionY: number
  directionZ: number
  spread: number
  speed: number
  speedRandom: number
  // Origin area (box half-extents)
  originW: number
  originH: number
  originD: number
  // Motion
  gravityX: number
  gravityY: number
  gravityZ: number
  turbulence: number
  // Rotation
  rotationMode: 'free' | 'velocity'
  rotationStart: number
  angularVelocity: number
  angularVelocityRandom: number
}

export const PARTICLE_DEFAULTS: ParticleConfig = {
  textureUrl: null,
  blendMode: 'additive',
  depthWrite: false,
  depthTest: true,
  maxCount: 200,
  simulationSpace: 'world',
  emissionRate: 20,
  burstMode: false,
  loop: true,
  playOnStart: true,
  lifetime: 2,
  lifetimeRandom: 0.2,
  sizeX: 0.05,
  sizeY: 0.05,
  sizeRandomX: 0.2,
  sizeRandomY: 0.2,
  sizeOverLifetime: 'shrink',
  colorStart: '#ffffff',
  colorEnd: '#ff6600',
  alpha: 1,
  alphaOverLifetime: 'fade-out',
  emissiveIntensity: 1,
  directionX: 0,
  directionY: 1,
  directionZ: 0,
  spread: 30,
  speed: 1,
  speedRandom: 0.3,
  originW: 0,
  originH: 0,
  originD: 0,
  gravityX: 0,
  gravityY: -0.5,
  gravityZ: 0,
  turbulence: 0,
  rotationMode: 'free',
  rotationStart: 180,
  angularVelocity: 0,
  angularVelocityRandom: 0,
}

export function mergeParticleConfig(raw: Record<string, unknown>): ParticleConfig {
  return { ...PARTICLE_DEFAULTS, ...raw } as ParticleConfig
}

export interface ParticlePool {
  // Per-particle flat arrays
  positions: Float32Array    // x,y,z * maxCount
  velocities: Float32Array   // x,y,z * maxCount
  ages: Float32Array         // age in seconds
  lifetimes: Float32Array    // max lifetime
  colors: Float32Array       // r,g,b * maxCount  (raw, not premultiplied)
  alphas: Float32Array       // alpha per particle
  sizes: Float32Array        // size per particle
  rotations: Float32Array    // current rotation in radians
  angVels: Float32Array      // angular velocity rad/s
  active: Uint8Array         // 1 = alive
  maxCount: number
  // Emission accumulator
  accumulator: number
  playing: boolean
  burstFired: boolean
}

export function createParticlePool(maxCount: number): ParticlePool {
  return {
    positions: new Float32Array(maxCount * 3),
    velocities: new Float32Array(maxCount * 3),
    ages: new Float32Array(maxCount),
    lifetimes: new Float32Array(maxCount),
    colors: new Float32Array(maxCount * 3).fill(1),
    alphas: new Float32Array(maxCount).fill(1),
    sizes: new Float32Array(maxCount).fill(0.05),
    rotations: new Float32Array(maxCount),
    angVels: new Float32Array(maxCount),
    active: new Uint8Array(maxCount),
    maxCount,
    accumulator: 0,
    playing: false,
    burstFired: false,
  }
}

// Cheap sin-based noise for turbulence
function noise3(x: number, y: number, z: number): [number, number, number] {
  return [
    Math.sin(x * 1.3 + y * 0.7 + z * 2.1) * 0.5,
    Math.sin(x * 2.2 + y * 1.4 + z * 0.6) * 0.5,
    Math.sin(x * 0.9 + y * 2.5 + z * 1.7) * 0.5,
  ]
}

const _cs = new THREE.Color()
const _ce = new THREE.Color()
const _dir = new THREE.Vector3()
const _perp1 = new THREE.Vector3()
const _perp2 = new THREE.Vector3()
const _spread = new THREE.Vector3()

function rand(range: number): number {
  return (Math.random() - 0.5) * 2 * range
}

function spawnParticle(i: number, pool: ParticlePool, pc: ParticleConfig): void {
  const b = i * 3

  // Origin
  pool.positions[b]     = rand(pc.originW)
  pool.positions[b + 1] = rand(pc.originH)
  pool.positions[b + 2] = rand(pc.originD)

  // Direction with spread
  _dir.set(pc.directionX, pc.directionY, pc.directionZ)
  if (_dir.lengthSq() < 0.0001) _dir.set(0, 1, 0)
  _dir.normalize()

  // Build perpendicular plane
  _perp1.set(1, 0, 0)
  if (Math.abs(_dir.dot(_perp1)) > 0.9) _perp1.set(0, 1, 0)
  _perp1.crossVectors(_dir, _perp1).normalize()
  _perp2.crossVectors(_dir, _perp1)

  const spreadRad = (pc.spread * Math.PI) / 180
  const theta = Math.random() * Math.PI * 2
  const phi = Math.random() * spreadRad
  _spread.copy(_dir)
    .addScaledVector(_perp1, Math.sin(phi) * Math.cos(theta))
    .addScaledVector(_perp2, Math.sin(phi) * Math.sin(theta))
    .normalize()

  const spd = pc.speed * (1 + rand(pc.speedRandom))
  pool.velocities[b]     = _spread.x * spd
  pool.velocities[b + 1] = _spread.y * spd
  pool.velocities[b + 2] = _spread.z * spd

  pool.lifetimes[i] = pc.lifetime * (1 + rand(pc.lifetimeRandom))
  pool.ages[i] = 0
  pool.active[i] = 1

  const rotRange = (pc.rotationStart * Math.PI) / 180
  pool.rotations[i] = rand(rotRange)

  const avBase = (pc.angularVelocity * Math.PI) / 180
  const avRand = (pc.angularVelocityRandom * Math.PI) / 180
  pool.angVels[i] = avBase + rand(avRand)
}

export function tickParticles(
  pool: ParticlePool,
  pc: ParticleConfig,
  delta: number,
  emitterWorldPos: THREE.Vector3,
  suppressEmission = false,
): void {
  if (!pool.playing) return

  _cs.set(pc.colorStart)
  _ce.set(pc.colorEnd)

  const gravity = new THREE.Vector3(pc.gravityX, pc.gravityY, pc.gravityZ)

  // Advance existing particles
  for (let i = 0; i < pool.maxCount; i++) {
    if (!pool.active[i]) continue
    pool.ages[i] += delta
    if (pool.ages[i] >= pool.lifetimes[i]) {
      pool.active[i] = 0
      // park it off-screen
      const b = i * 3
      pool.positions[b] = pool.positions[b + 1] = pool.positions[b + 2] = 1e9
      continue
    }

    const t = pool.ages[i] / pool.lifetimes[i]  // 0..1

    // Integrate velocity
    const b = i * 3
    pool.velocities[b]     += gravity.x * delta
    pool.velocities[b + 1] += gravity.y * delta
    pool.velocities[b + 2] += gravity.z * delta

    if (pc.turbulence > 0) {
      const [nx, ny, nz] = noise3(
        pool.positions[b] + pool.ages[i] * 1.7,
        pool.positions[b + 1] + pool.ages[i] * 2.1,
        pool.positions[b + 2] + pool.ages[i] * 1.3,
      )
      pool.velocities[b]     += nx * pc.turbulence * delta * 10
      pool.velocities[b + 1] += ny * pc.turbulence * delta * 10
      pool.velocities[b + 2] += nz * pc.turbulence * delta * 10
    }

    pool.positions[b]     += pool.velocities[b]     * delta
    pool.positions[b + 1] += pool.velocities[b + 1] * delta
    pool.positions[b + 2] += pool.velocities[b + 2] * delta

    // If world-space, positions are already in world space — subtract emitter pos for GPU
    // (handled in the component by setting pointsMaterial.worldMatrix or group offset)

    // Color lerp (raw RGB, not premultiplied)
    const col = _cs.clone().lerp(_ce, t)
    pool.colors[b]     = col.r
    pool.colors[b + 1] = col.g
    pool.colors[b + 2] = col.b
    // Alpha separate
    let alpha = pc.alpha
    switch (pc.alphaOverLifetime) {
      case 'fade-in':     alpha *= t; break
      case 'fade-out':    alpha *= 1 - t; break
      case 'fade-in-out': alpha *= Math.sin(t * Math.PI); break
    }
    pool.alphas[i] = alpha

    // Size over lifetime (stored in sizes, applied via custom shader or ignored for pointsMaterial)
    let sScale = 1
    switch (pc.sizeOverLifetime) {
      case 'shrink': sScale = 1 - t; break
      case 'grow':   sScale = t; break
      case 'pulse':  sScale = Math.sin(t * Math.PI); break
    }
    pool.sizes[i] = pc.sizeX * Math.max(0.001, sScale * (1 + rand(pc.sizeRandomX)))

    pool.rotations[i] += pool.angVels[i] * delta
  }

  // Emission
  if (suppressEmission) return
  if (pc.burstMode && !pool.burstFired) {
    for (let i = 0; i < pool.maxCount; i++) spawnParticle(i, pool, pc)
    pool.burstFired = true
    if (!pc.loop) pool.playing = false
    return
  }

  if (!pc.burstMode) {
    pool.accumulator += pc.emissionRate * delta
    while (pool.accumulator >= 1) {
      pool.accumulator -= 1
      // find a dead slot
      for (let i = 0; i < pool.maxCount; i++) {
        if (!pool.active[i]) {
          if (pc.simulationSpace === 'world') {
            spawnParticle(i, pool, pc)
            // offset spawn to world coords
            pool.positions[i * 3]     += emitterWorldPos.x
            pool.positions[i * 3 + 1] += emitterWorldPos.y
            pool.positions[i * 3 + 2] += emitterWorldPos.z
          } else {
            spawnParticle(i, pool, pc)
          }
          break
        }
      }
    }
  }
}
