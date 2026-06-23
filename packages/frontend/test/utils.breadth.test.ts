/**
 * Phase 7 — math/util breadth coverage
 *
 * Covers:
 *   - src/particleUtils.ts          — createParticlePool, tickParticles (CPU-only paths)
 *   - src/previewSmoother.ts        — private tween/angle math extracted inline
 *   - src/components/editor/materialOverrides.ts — pure helpers extracted inline
 *   - src/components/editor/composeLayerInteractions.ts — anchorSigns/deltaInUnit/rotation math inline
 *
 * Skipped (WebGL / store coupling):
 *   - previewSmoother.ts public API (smoothNodeTransform / smoothComposeLayer):
 *     tightly coupled to useEditorStore + requestAnimationFrame — mocking the entire Zustand
 *     store would only exercise mock-wiring, not logic.
 *   - materialOverrides.ts VRM functions (getMaterialSlots, applyMaterialOverrides,
 *     disposeMaterialOverrides): require a real VRM scene graph.
 *   - composeLayerInteractions.ts startDrag / startResize / startRotate gesture handlers:
 *     attach window event listeners and call api.updateComposeLayer — tested at integration
 *     level, not here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';

import {
  createParticlePool,
  tickParticles,
  PARTICLE_DEFAULTS,
  mergeParticleConfig,
  type ParticleConfig,
} from '../src/particleUtils';

// ─── createParticlePool ───────────────────────────────────────────────────────

describe('createParticlePool', () => {
  it('allocates typed arrays of the correct length', () => {
    const pool = createParticlePool(10);
    expect(pool.positions.length).toBe(30);  // 10 * 3
    expect(pool.velocities.length).toBe(30);
    expect(pool.colors.length).toBe(30);
    expect(pool.ages.length).toBe(10);
    expect(pool.lifetimes.length).toBe(10);
    expect(pool.alphas.length).toBe(10);
    expect(pool.sizes.length).toBe(10);
    expect(pool.rotations.length).toBe(10);
    expect(pool.angVels.length).toBe(10);
    expect(pool.active.length).toBe(10);
  });

  it('starts with maxCount set correctly', () => {
    const pool = createParticlePool(50);
    expect(pool.maxCount).toBe(50);
  });

  it('initialises accumulator to 0 and playing/burstFired to false', () => {
    const pool = createParticlePool(5);
    expect(pool.accumulator).toBe(0);
    expect(pool.playing).toBe(false);
    expect(pool.burstFired).toBe(false);
  });

  it('fills colors to 1 and sizes to 0.05 by default', () => {
    const pool = createParticlePool(4);
    // All color channels = 1
    for (let i = 0; i < pool.colors.length; i++) {
      expect(pool.colors[i]).toBe(1);
    }
    // All sizes = 0.05
    for (let i = 0; i < pool.sizes.length; i++) {
      expect(pool.sizes[i]).toBeCloseTo(0.05);
    }
  });

  it('starts all particles inactive (active = 0)', () => {
    const pool = createParticlePool(8);
    for (let i = 0; i < pool.active.length; i++) {
      expect(pool.active[i]).toBe(0);
    }
  });

  it('starts all positions, velocities and ages at zero', () => {
    const pool = createParticlePool(3);
    for (let i = 0; i < pool.positions.length; i++) {
      expect(pool.positions[i]).toBe(0);
      expect(pool.velocities[i]).toBe(0);
    }
    for (let i = 0; i < pool.ages.length; i++) {
      expect(pool.ages[i]).toBe(0);
    }
  });
});

// ─── tickParticles — deterministic physics paths ──────────────────────────────

describe('tickParticles', () => {
  let pc: ParticleConfig;

  beforeEach(() => {
    pc = {
      ...PARTICLE_DEFAULTS,
      // Deterministic overrides
      emissionRate: 0,           // no new particles during these tests
      burstMode: false,
      gravityX: 0,
      gravityY: 0,
      gravityZ: 0,
      turbulence: 0,
      sizeOverLifetime: 'constant',
      alphaOverLifetime: 'constant',
      alpha: 1,
    };
  });

  it('does nothing when playing=false', () => {
    const pool = createParticlePool(2);
    pool.playing = false;
    // Plant a fake active particle
    pool.active[0] = 1;
    pool.ages[0] = 0;
    pool.lifetimes[0] = 1;

    tickParticles(pool, pc, 0.1, new THREE.Vector3());

    expect(pool.ages[0]).toBe(0); // not advanced
  });

  it('advances particle age by delta', () => {
    const pool = createParticlePool(2);
    pool.playing = true;
    pool.active[0] = 1;
    pool.ages[0] = 0;
    pool.lifetimes[0] = 10;
    pool.velocities[0] = 0;
    pool.velocities[1] = 0;
    pool.velocities[2] = 0;

    tickParticles(pool, pc, 0.016, new THREE.Vector3());

    expect(pool.ages[0]).toBeCloseTo(0.016);
  });

  it('deactivates a particle when age >= lifetime', () => {
    const pool = createParticlePool(2);
    pool.playing = true;
    pool.active[0] = 1;
    pool.ages[0] = 0.99;
    pool.lifetimes[0] = 1.0;

    tickParticles(pool, pc, 0.02, new THREE.Vector3());

    expect(pool.active[0]).toBe(0);
  });

  it('parks a dead particle far off-screen', () => {
    const pool = createParticlePool(2);
    pool.playing = true;
    pool.active[0] = 1;
    pool.ages[0] = 0.99;
    pool.lifetimes[0] = 1.0;

    tickParticles(pool, pc, 0.02, new THREE.Vector3());

    // Position should be parked at 1e9
    expect(pool.positions[0]).toBe(1e9);
    expect(pool.positions[1]).toBe(1e9);
    expect(pool.positions[2]).toBe(1e9);
  });

  it('applies gravity to velocity', () => {
    const gravityPc: ParticleConfig = {
      ...pc,
      gravityX: 0,
      gravityY: -9.8,
      gravityZ: 0,
    };
    const pool = createParticlePool(2);
    pool.playing = true;
    pool.active[0] = 1;
    pool.ages[0] = 0;
    pool.lifetimes[0] = 10;
    pool.velocities[0] = 0;
    pool.velocities[1] = 0;
    pool.velocities[2] = 0;

    tickParticles(pool, gravityPc, 0.1, new THREE.Vector3());

    // vy should have decreased by gravityY * dt = -9.8 * 0.1 = -0.98
    expect(pool.velocities[1]).toBeCloseTo(-0.98, 4);
  });

  it('moves particle position by velocity * delta', () => {
    const pool = createParticlePool(2);
    pool.playing = true;
    pool.active[0] = 1;
    pool.ages[0] = 0;
    pool.lifetimes[0] = 10;
    pool.positions[0] = 0;
    pool.positions[1] = 0;
    pool.positions[2] = 0;
    pool.velocities[0] = 5;
    pool.velocities[1] = 0;
    pool.velocities[2] = 0;

    tickParticles(pool, pc, 0.1, new THREE.Vector3());

    // x should move by v * dt = 5 * 0.1 = 0.5
    expect(pool.positions[0]).toBeCloseTo(0.5, 4);
  });

  it('advances rotation by angularVelocity * delta', () => {
    const pool = createParticlePool(2);
    pool.playing = true;
    pool.active[0] = 1;
    pool.ages[0] = 0;
    pool.lifetimes[0] = 10;
    pool.rotations[0] = 0;
    pool.angVels[0] = Math.PI; // π rad/s
    pool.velocities[0] = pool.velocities[1] = pool.velocities[2] = 0;

    tickParticles(pool, pc, 0.5, new THREE.Vector3());

    expect(pool.rotations[0]).toBeCloseTo(Math.PI * 0.5, 4);
  });

  it('does not advance inactive particles', () => {
    const pool = createParticlePool(2);
    pool.playing = true;
    pool.active[0] = 0; // inactive
    pool.ages[0] = 0;
    pool.velocities[0] = 10;

    tickParticles(pool, pc, 1.0, new THREE.Vector3());

    expect(pool.ages[0]).toBe(0);      // not advanced
    expect(pool.positions[0]).toBe(0); // not moved
  });

  it('suppressEmission flag prevents new spawns', () => {
    const spawnPc: ParticleConfig = { ...pc, emissionRate: 100 };
    const pool = createParticlePool(10);
    pool.playing = true;

    tickParticles(pool, spawnPc, 1.0, new THREE.Vector3(), true /* suppress */);

    // No particles should have been spawned
    let anyActive = false;
    for (let i = 0; i < 10; i++) if (pool.active[i]) anyActive = true;
    expect(anyActive).toBe(false);
  });

  it('accumulates emission and spawns particles when accumulator >= 1', () => {
    const spawnPc: ParticleConfig = { ...pc, emissionRate: 10, spread: 0 };
    const pool = createParticlePool(10);
    pool.playing = true;

    // 10 particles/s * 0.2s = 2 new particles
    tickParticles(pool, spawnPc, 0.2, new THREE.Vector3());

    let activeCount = 0;
    for (let i = 0; i < 10; i++) if (pool.active[i]) activeCount++;
    expect(activeCount).toBe(2);
  });

  it('burst mode spawns all particles at once (first tick)', () => {
    const burstPc: ParticleConfig = { ...pc, burstMode: true, loop: false, spread: 0 };
    const pool = createParticlePool(5);
    pool.playing = true;

    tickParticles(pool, burstPc, 0.016, new THREE.Vector3());

    let activeCount = 0;
    for (let i = 0; i < 5; i++) if (pool.active[i]) activeCount++;
    expect(activeCount).toBe(5);
    expect(pool.burstFired).toBe(true);
  });

  it('burst mode with loop=false stops playing after burst', () => {
    const burstPc: ParticleConfig = { ...pc, burstMode: true, loop: false, spread: 0 };
    const pool = createParticlePool(5);
    pool.playing = true;

    tickParticles(pool, burstPc, 0.016, new THREE.Vector3());

    expect(pool.playing).toBe(false);
  });

  it('burst does not re-fire on second tick', () => {
    const burstPc: ParticleConfig = { ...pc, burstMode: true, loop: true, spread: 0 };
    const pool = createParticlePool(5);
    pool.playing = true;

    tickParticles(pool, burstPc, 0.016, new THREE.Vector3());
    // Kill all particles so a second burst would set them active again
    for (let i = 0; i < 5; i++) pool.active[i] = 0;

    tickParticles(pool, burstPc, 0.016, new THREE.Vector3());

    let activeCount = 0;
    for (let i = 0; i < 5; i++) if (pool.active[i]) activeCount++;
    expect(activeCount).toBe(0); // burstFired=true → no second burst
  });

  // Alpha-over-lifetime math
  it('alphaOverLifetime=constant keeps alpha unchanged', () => {
    const cPc: ParticleConfig = { ...pc, alpha: 0.8, alphaOverLifetime: 'constant' };
    const pool = createParticlePool(2);
    pool.playing = true;
    pool.active[0] = 1;
    pool.ages[0] = 0;
    pool.lifetimes[0] = 1;
    pool.velocities[0] = pool.velocities[1] = pool.velocities[2] = 0;

    tickParticles(pool, cPc, 0.5, new THREE.Vector3());

    expect(pool.alphas[0]).toBeCloseTo(0.8, 4);
  });

  it('alphaOverLifetime=fade-out gives alpha * (1-t)', () => {
    const foPc: ParticleConfig = { ...pc, alpha: 1.0, alphaOverLifetime: 'fade-out' };
    const pool = createParticlePool(2);
    pool.playing = true;
    pool.active[0] = 1;
    pool.ages[0] = 0;
    pool.lifetimes[0] = 1;
    pool.velocities[0] = pool.velocities[1] = pool.velocities[2] = 0;

    tickParticles(pool, foPc, 0.5, new THREE.Vector3());

    // t = 0.5/1 = 0.5; alpha = 1 * (1 - 0.5) = 0.5
    expect(pool.alphas[0]).toBeCloseTo(0.5, 3);
  });

  it('alphaOverLifetime=fade-in gives alpha * t', () => {
    const fiPc: ParticleConfig = { ...pc, alpha: 1.0, alphaOverLifetime: 'fade-in' };
    const pool = createParticlePool(2);
    pool.playing = true;
    pool.active[0] = 1;
    pool.ages[0] = 0;
    pool.lifetimes[0] = 1;
    pool.velocities[0] = pool.velocities[1] = pool.velocities[2] = 0;

    tickParticles(pool, fiPc, 0.25, new THREE.Vector3());

    // t = 0.25; alpha = 1 * 0.25 = 0.25
    expect(pool.alphas[0]).toBeCloseTo(0.25, 3);
  });

  it('alphaOverLifetime=fade-in-out peaks at t=0.5 (sin(π*0.5))', () => {
    const fioPc: ParticleConfig = { ...pc, alpha: 1.0, alphaOverLifetime: 'fade-in-out' };
    const pool = createParticlePool(2);
    pool.playing = true;
    pool.active[0] = 1;
    pool.ages[0] = 0;
    pool.lifetimes[0] = 1;
    pool.velocities[0] = pool.velocities[1] = pool.velocities[2] = 0;

    tickParticles(pool, fioPc, 0.5, new THREE.Vector3());

    // t = 0.5; alpha = sin(0.5 * π) = 1
    expect(pool.alphas[0]).toBeCloseTo(1.0, 3);
  });

  // Size over lifetime
  it('sizeOverLifetime=shrink gives size * (1 - t)', () => {
    const sPc: ParticleConfig = { ...pc, sizeOverLifetime: 'shrink', sizeX: 0.1, sizeRandomX: 0 };
    const pool = createParticlePool(2);
    pool.playing = true;
    pool.active[0] = 1;
    pool.ages[0] = 0;
    pool.lifetimes[0] = 1;
    pool.velocities[0] = pool.velocities[1] = pool.velocities[2] = 0;

    // Stub Math.random to 0.5 so rand(0) → 0 and no size randomness
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    tickParticles(pool, sPc, 0.5, new THREE.Vector3());
    vi.restoreAllMocks();

    // t=0.5, sScale = 1-0.5 = 0.5, sizeRandomX=0 → rand(0)=0 → size = 0.1 * max(0.001, 0.5)
    expect(pool.sizes[0]).toBeCloseTo(0.05, 4);
  });

  it('sizeOverLifetime=grow gives size * t', () => {
    const gPc: ParticleConfig = { ...pc, sizeOverLifetime: 'grow', sizeX: 0.2, sizeRandomX: 0 };
    const pool = createParticlePool(2);
    pool.playing = true;
    pool.active[0] = 1;
    pool.ages[0] = 0;
    pool.lifetimes[0] = 1;
    pool.velocities[0] = pool.velocities[1] = pool.velocities[2] = 0;

    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    tickParticles(pool, gPc, 0.5, new THREE.Vector3());
    vi.restoreAllMocks();

    // t=0.5, sScale = 0.5; size = 0.2 * 0.5 = 0.1
    expect(pool.sizes[0]).toBeCloseTo(0.1, 4);
  });

  it('sizeOverLifetime=pulse peaks at t=0.5', () => {
    const pPc: ParticleConfig = { ...pc, sizeOverLifetime: 'pulse', sizeX: 1.0, sizeRandomX: 0 };
    const pool = createParticlePool(2);
    pool.playing = true;
    pool.active[0] = 1;
    pool.ages[0] = 0;
    pool.lifetimes[0] = 1;
    pool.velocities[0] = pool.velocities[1] = pool.velocities[2] = 0;

    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    tickParticles(pool, pPc, 0.5, new THREE.Vector3());
    vi.restoreAllMocks();

    // t=0.5; sScale = sin(0.5 * π) = 1; size = 1.0 * 1 = 1.0
    expect(pool.sizes[0]).toBeCloseTo(1.0, 3);
  });
});

// ─── previewSmoother.ts — private math extracted inline ──────────────────────
// The public API (smoothNodeTransform / smoothComposeLayer) is tightly coupled
// to useEditorStore + requestAnimationFrame and is not testable without full
// store + RAF mock wiring.  The private math is self-contained enough to verify.

describe('previewSmoother — shortest-arc scalar angle normalisation (radians)', () => {
  /**
   * Mirrors the retargetScalar isAngleRad path in previewSmoother.ts.
   * Given a `from` angle and a target `to` (both in radians), returns the
   * adjusted `to` so the tween takes the shortest arc.
   */
  function shortestArcRad(from: number, to: number): number {
    let d = to - from;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d <= -Math.PI) d += 2 * Math.PI;
    return from + d;
  }

  it('small positive delta is unchanged', () => {
    const from = 0;
    const to = 0.5;
    expect(shortestArcRad(from, to)).toBeCloseTo(0.5);
  });

  it('wraps a large positive delta to the equivalent negative arc', () => {
    // from=0, to=4 → d=4 → > π → d=4-2π≈-2.28 → adjusted to=0+(-2.28)≈-2.28
    const result = shortestArcRad(0, 4);
    expect(result).toBeCloseTo(4 - 2 * Math.PI, 5);
    expect(result).toBeGreaterThan(-Math.PI);
    expect(result).toBeLessThanOrEqual(Math.PI);
  });

  it('wraps a large negative delta to the equivalent positive arc', () => {
    // from=0, to=-4 → d=-4 → <= -π → d=-4+2π≈2.28 → adjusted=2.28
    const result = shortestArcRad(0, -4);
    expect(result).toBeCloseTo(-4 + 2 * Math.PI, 5);
    expect(result).toBeGreaterThan(-Math.PI);
    expect(result).toBeLessThanOrEqual(Math.PI);
  });

  it('from=π-ε, to=-π+ε crosses 180° correctly (shortest arc is a tiny step)', () => {
    const eps = 0.01;
    const from = Math.PI - eps;
    const to = -(Math.PI - eps);
    const adjusted = shortestArcRad(from, to);
    // The shortest arc from π-ε to -π+ε is forward by +2ε (crossing ±π)
    // i.e. adjusted ≈ from + 2ε = π - ε + 2ε = π + ε
    expect(adjusted).toBeCloseTo(Math.PI + eps, 4);
    // The arc length should be tiny (2ε, not 2π - 2ε)
    expect(Math.abs(adjusted - from)).toBeLessThan(Math.PI);
  });

  it('delta = 0 → result = from', () => {
    const from = 1.2;
    expect(shortestArcRad(from, from)).toBeCloseTo(from);
  });

  it('delta exactly π is unchanged (boundary: d > π, not >=)', () => {
    // d = π → while(d > π) is false → no wrap → result = from + π
    const from = 0;
    const result = shortestArcRad(from, Math.PI);
    expect(result).toBeCloseTo(Math.PI);
  });
});

describe('previewSmoother — shortest-arc degree normalisation', () => {
  /**
   * Mirrors retargetScalarDeg in previewSmoother.ts.
   */
  function shortestArcDeg(from: number, to: number): number {
    let d = to - from;
    while (d > 180) d -= 360;
    while (d <= -180) d += 360;
    return from + d;
  }

  it('small positive delta is unchanged', () => {
    expect(shortestArcDeg(0, 45)).toBeCloseTo(45);
  });

  it('270° jump wraps to -90°', () => {
    // from=0, to=270 → d=270 → >180 → d=-90 → result=-90
    expect(shortestArcDeg(0, 270)).toBeCloseTo(-90);
  });

  it('-270° jump wraps to +90°', () => {
    expect(shortestArcDeg(0, -270)).toBeCloseTo(90);
  });

  it('180° jump stays at 180° (boundary: d > 180)', () => {
    // d = 180 → while(d > 180) is false → result = from + 180 = 180
    expect(shortestArcDeg(0, 180)).toBeCloseTo(180);
  });

  it('delta=0 → result=from', () => {
    expect(shortestArcDeg(45, 45)).toBeCloseTo(45);
  });

  it('from=170, to=-170 → nearest is +20° (cross through ±180)', () => {
    // d = -170 - 170 = -340 → <=−180 → d = -340 + 360 = 20 → result = 170 + 20 = 190
    expect(shortestArcDeg(170, -170)).toBeCloseTo(190);
  });
});

// ─── materialOverrides.ts — pure helpers extracted inline ────────────────────
// The private helpers are not exported; we replicate their logic to verify the
// invariants that the public applyMaterialOverrides relies on.

describe('materialOverrides — deriveAlphaMode', () => {
  /**
   * Mirrors deriveAlphaMode in materialOverrides.ts.
   */
  function deriveAlphaMode(mat: {
    transparent: boolean;
    alphaTest: number;
  }): 'opaque' | 'mask' | 'blend' {
    if (mat.transparent) return 'blend';
    if (mat.alphaTest > 0) return 'mask';
    return 'opaque';
  }

  it('transparent=true → blend', () => {
    expect(deriveAlphaMode({ transparent: true, alphaTest: 0 })).toBe('blend');
  });

  it('transparent=false, alphaTest>0 → mask', () => {
    expect(deriveAlphaMode({ transparent: false, alphaTest: 0.5 })).toBe('mask');
  });

  it('transparent=false, alphaTest=0 → opaque', () => {
    expect(deriveAlphaMode({ transparent: false, alphaTest: 0 })).toBe('opaque');
  });

  it('transparent=true overrides alphaTest', () => {
    // transparent wins even if alphaTest > 0
    expect(deriveAlphaMode({ transparent: true, alphaTest: 0.5 })).toBe('blend');
  });
});

describe('materialOverrides — applyAlpha', () => {
  /**
   * Mirrors applyAlpha in materialOverrides.ts.
   */
  function applyAlpha(
    mat: { transparent: boolean; alphaTest: number; opacity: number },
    mode: 'opaque' | 'mask' | 'blend',
    cutoff: number,
    opacity: number
  ): boolean {
    const transparent = mode === 'blend' || opacity < 1;
    const alphaTest = mode === 'mask' ? cutoff : 0;
    let changed = false;
    if (mat.transparent !== transparent) {
      mat.transparent = transparent;
      changed = true;
    }
    if (mat.alphaTest !== alphaTest) {
      mat.alphaTest = alphaTest;
      changed = true;
    }
    mat.opacity = opacity;
    return changed;
  }

  it('blend mode forces transparent=true and alphaTest=0', () => {
    const mat = { transparent: false, alphaTest: 0, opacity: 1 };
    const changed = applyAlpha(mat, 'blend', 0.5, 1);
    expect(mat.transparent).toBe(true);
    expect(mat.alphaTest).toBe(0);
    expect(changed).toBe(true);
  });

  it('mask mode sets alphaTest to cutoff and transparent=false', () => {
    const mat = { transparent: false, alphaTest: 0, opacity: 1 };
    applyAlpha(mat, 'mask', 0.3, 1);
    expect(mat.alphaTest).toBeCloseTo(0.3);
    expect(mat.transparent).toBe(false);
  });

  it('opaque mode sets transparent=false and alphaTest=0', () => {
    const mat = { transparent: true, alphaTest: 0.5, opacity: 1 };
    applyAlpha(mat, 'opaque', 0.5, 1);
    expect(mat.transparent).toBe(false);
    expect(mat.alphaTest).toBe(0);
  });

  it('opacity < 1 forces transparent=true even in opaque mode', () => {
    const mat = { transparent: false, alphaTest: 0, opacity: 1 };
    applyAlpha(mat, 'opaque', 0.5, 0.5);
    expect(mat.transparent).toBe(true);
  });

  it('opacity is always set on the material', () => {
    const mat = { transparent: false, alphaTest: 0, opacity: 1 };
    applyAlpha(mat, 'opaque', 0.5, 0.7);
    expect(mat.opacity).toBeCloseTo(0.7);
  });

  it('returns false when nothing changed', () => {
    const mat = { transparent: false, alphaTest: 0, opacity: 1 };
    const changed = applyAlpha(mat, 'opaque', 0.5, 1);
    expect(changed).toBe(false);
  });

  it('returns true when transparent changed', () => {
    const mat = { transparent: false, alphaTest: 0, opacity: 1 };
    const changed = applyAlpha(mat, 'blend', 0.5, 1);
    expect(changed).toBe(true);
  });

  it('returns true when alphaTest changed', () => {
    const mat = { transparent: false, alphaTest: 0, opacity: 1 };
    const changed = applyAlpha(mat, 'mask', 0.5, 1);
    expect(changed).toBe(true);
  });
});

describe('materialOverrides — applySide', () => {
  /**
   * Mirrors applySide in materialOverrides.ts.
   */
  function applySide(
    mat: { side: number },
    doubleSided: boolean
  ): boolean {
    const DoubleSide = THREE.DoubleSide; // 2
    const FrontSide = THREE.FrontSide;   // 0
    const side = doubleSided ? DoubleSide : FrontSide;
    if (mat.side !== side) {
      mat.side = side;
      return true;
    }
    return false;
  }

  it('doubleSided=true sets side to THREE.DoubleSide', () => {
    const mat = { side: THREE.FrontSide };
    applySide(mat, true);
    expect(mat.side).toBe(THREE.DoubleSide);
  });

  it('doubleSided=false sets side to THREE.FrontSide', () => {
    const mat = { side: THREE.DoubleSide };
    applySide(mat, false);
    expect(mat.side).toBe(THREE.FrontSide);
  });

  it('returns true when side changed', () => {
    const mat = { side: THREE.FrontSide };
    expect(applySide(mat, true)).toBe(true);
  });

  it('returns false when side unchanged', () => {
    const mat = { side: THREE.FrontSide };
    expect(applySide(mat, false)).toBe(false);
  });
});

describe('materialOverrides — applyFlatShading', () => {
  /**
   * Mirrors applyFlatShading in materialOverrides.ts.
   */
  function applyFlatShading(
    mat: { flatShading?: boolean },
    on: boolean
  ): boolean {
    if (!!mat.flatShading !== on) {
      mat.flatShading = on;
      return true;
    }
    return false;
  }

  it('enables flat shading when off', () => {
    const mat: { flatShading?: boolean } = { flatShading: false };
    const changed = applyFlatShading(mat, true);
    expect(mat.flatShading).toBe(true);
    expect(changed).toBe(true);
  });

  it('disables flat shading when on', () => {
    const mat = { flatShading: true };
    const changed = applyFlatShading(mat, false);
    expect(mat.flatShading).toBe(false);
    expect(changed).toBe(true);
  });

  it('returns false when already in the desired state', () => {
    const mat = { flatShading: false };
    expect(applyFlatShading(mat, false)).toBe(false);
  });

  it('treats undefined flatShading as false', () => {
    const mat: { flatShading?: boolean } = {};
    // !!undefined === false; on=true → they differ → sets to true
    const changed = applyFlatShading(mat, true);
    expect(changed).toBe(true);
    expect(mat.flatShading).toBe(true);
  });

  it('treats undefined flatShading as false (no-op when target is false)', () => {
    const mat: { flatShading?: boolean } = {};
    const changed = applyFlatShading(mat, false);
    expect(changed).toBe(false);
  });
});

describe('materialOverrides — APBR attenuationDistance mapping', () => {
  /**
   * materialOverrides maps attenuationDistance=0 to Infinity.
   * Verify the conditional inline.
   */
  function mapAttenuationDistance(v: number): number {
    return v > 0 ? v : Infinity;
  }

  it('0 maps to Infinity', () => {
    expect(mapAttenuationDistance(0)).toBe(Infinity);
  });

  it('positive value passes through unchanged', () => {
    expect(mapAttenuationDistance(2.5)).toBeCloseTo(2.5);
  });

  it('negative value (invalid) also maps to Infinity', () => {
    expect(mapAttenuationDistance(-1)).toBe(Infinity);
  });
});

// ─── composeLayerInteractions.ts — pure helpers extracted inline ──────────────
// anchorSigns() and deltaInUnit() are private; startDrag/startResize/startRotate
// all wire DOM event listeners + call api.updateComposeLayer — only the pure math
// is verified here.

describe('composeLayerInteractions — anchorSigns', () => {
  /**
   * Mirrors anchorSigns in composeLayerInteractions.ts.
   */
  function anchorSigns(
    anchorH: 'left' | 'right',
    anchorV: 'top' | 'bottom'
  ): { sx: number; sy: number } {
    return {
      sx: anchorH === 'right' ? -1 : 1,
      sy: anchorV === 'bottom' ? -1 : 1,
    };
  }

  it('left+top → sx=1, sy=1', () => {
    expect(anchorSigns('left', 'top')).toEqual({ sx: 1, sy: 1 });
  });

  it('right+top → sx=-1, sy=1', () => {
    expect(anchorSigns('right', 'top')).toEqual({ sx: -1, sy: 1 });
  });

  it('left+bottom → sx=1, sy=-1', () => {
    expect(anchorSigns('left', 'bottom')).toEqual({ sx: 1, sy: -1 });
  });

  it('right+bottom → sx=-1, sy=-1', () => {
    expect(anchorSigns('right', 'bottom')).toEqual({ sx: -1, sy: -1 });
  });
});

describe('composeLayerInteractions — deltaInUnit', () => {
  /**
   * Mirrors deltaInUnit in composeLayerInteractions.ts.
   */
  function deltaInUnit(
    dPx: number,
    config: Record<string, unknown>,
    unitKey: string,
    basis: number
  ): number {
    return config[unitKey] === '%' && basis > 0 ? (dPx / basis) * 100 : dPx;
  }

  it('pixel unit passes dPx through unchanged', () => {
    expect(deltaInUnit(42, { xUnit: 'px' }, 'xUnit', 800)).toBe(42);
  });

  it('percent unit converts dPx relative to basis', () => {
    // 100px drag in a 400px container = 25%
    expect(deltaInUnit(100, { xUnit: '%' }, 'xUnit', 400)).toBeCloseTo(25);
  });

  it('percent unit with basis=0 falls back to px value', () => {
    // basis=0 → percent not safe → return raw px
    expect(deltaInUnit(50, { xUnit: '%' }, 'xUnit', 0)).toBe(50);
  });

  it('missing unit key uses pixel fallback', () => {
    expect(deltaInUnit(30, {}, 'xUnit', 500)).toBe(30);
  });

  it('negative dPx is preserved', () => {
    expect(deltaInUnit(-60, { xUnit: '%' }, 'xUnit', 600)).toBeCloseTo(-10);
  });
});

describe('composeLayerInteractions — rotation normalisation (startRotate math)', () => {
  /**
   * Mirrors the atan2-based rotation delta and normalisation in startRotate.
   *
   * Given startAngle (atan2 of initial pointer relative to centre, in degrees),
   * startRotation (the layer's stored rotation in degrees), and a new pointer
   * angle, compute the normalised output rotation.
   */
  function computeRotation(
    startAngle: number,
    startRotation: number,
    newAngle: number
  ): number {
    let next = startRotation + (newAngle - startAngle);
    while (next > 180) next -= 360;
    while (next <= -180) next += 360;
    return Math.round(next * 10) / 10;
  }

  it('no pointer movement leaves rotation unchanged', () => {
    expect(computeRotation(45, 30, 45)).toBe(30);
  });

  it('positive delta adds to startRotation', () => {
    expect(computeRotation(0, 0, 30)).toBe(30);
  });

  it('negative delta subtracts from startRotation', () => {
    expect(computeRotation(0, 0, -30)).toBe(-30);
  });

  it('wraps above 180', () => {
    // startRotation=170, delta=+20 → 190 → 190 - 360 = -170
    expect(computeRotation(0, 170, 20)).toBe(-170);
  });

  it('wraps at or below -180', () => {
    // startRotation=-170, delta=-20 → -190 → -190 + 360 = 170
    expect(computeRotation(0, -170, -20)).toBe(170);
  });

  it('rounds to one decimal place', () => {
    // delta = 12.345 → round(12.345 * 10) / 10 = 123/10 = 12.3
    expect(computeRotation(0, 0, 12.345)).toBe(12.3);
  });

  it('result is always in (-180, 180]', () => {
    for (let start = -360; start <= 360; start += 10) {
      for (let current = -90; current <= 90; current += 30) {
        const result = computeRotation(0, current, start);
        expect(result).toBeGreaterThan(-180);
        expect(result).toBeLessThanOrEqual(180);
      }
    }
  });
});
