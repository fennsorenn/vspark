import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLASSIFIER_OPTIONS,
  DEFAULT_TEMPLATES,
  FFT_SIZE,
  N_MEL_FILTERS,
  N_MFCC_COEFFS,
  VOWEL_KEYS,
  VOWEL_TO_VRM,
  analyserPowerSpectrum,
  buildMelFilters,
  computeMfcc,
  dct2,
  distSq,
  emptyVisemeWeights,
  fftRadix2,
  hzToMel,
  melToHz,
  meanVector,
  norm,
  normalise,
  prepareTemplates,
  rmsOf,
  softmax,
  subtract,
  updateVisemeWeights,
} from '../src/mfcc';

/** Naive O(n²) DFT — the independent reference the fast path is checked against. */
function naiveDft(re: Float32Array): { re: Float32Array; im: Float32Array } {
  const n = re.length;
  const outRe = new Float32Array(n);
  const outIm = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0,
      si = 0;
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n;
      sr += re[t] * Math.cos(ang);
      si += re[t] * Math.sin(ang);
    }
    outRe[k] = sr;
    outIm[k] = si;
  }
  return { re: outRe, im: outIm };
}

describe('mel scale', () => {
  it('round-trips hz → mel → hz', () => {
    for (const hz of [80, 440, 1000, 4000, 8000]) {
      expect(melToHz(hzToMel(hz))).toBeCloseTo(hz, 3);
    }
  });

  it('is monotonic increasing', () => {
    let prev = -Infinity;
    for (let hz = 0; hz <= 8000; hz += 250) {
      const m = hzToMel(hz);
      expect(m).toBeGreaterThan(prev);
      prev = m;
    }
  });
});

describe('buildMelFilters', () => {
  const filters = buildMelFilters(48000, FFT_SIZE);

  it('produces N_MEL_FILTERS banks of nBins width', () => {
    expect(filters).toHaveLength(N_MEL_FILTERS);
    for (const f of filters) expect(f).toHaveLength(FFT_SIZE / 2);
  });

  it('has non-negative weights and each filter carries energy', () => {
    for (const f of filters) {
      let sum = 0;
      for (const v of f) {
        expect(v).toBeGreaterThanOrEqual(0);
        sum += v;
      }
      expect(sum).toBeGreaterThan(0);
    }
  });

  it('places successive filter peaks at increasing frequencies', () => {
    const peakBin = (f: Float32Array) => f.indexOf(Math.max(...f));
    let prev = -1;
    for (const f of filters) {
      const p = peakBin(f);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it('tracks the sample rate — a lower rate shifts filters to higher bins', () => {
    const at16k = buildMelFilters(16000, FFT_SIZE);
    const peak = (f: Float32Array) => f.indexOf(Math.max(...f));
    // Same mel band, fewer Hz per bin ⇒ the band lands further up the bin axis.
    expect(peak(at16k[10])).toBeGreaterThan(peak(filters[10]));
  });
});

describe('fftRadix2', () => {
  it('matches a naive DFT on a random signal', () => {
    const n = 256;
    const src = new Float32Array(n);
    // Deterministic pseudo-random so the test never flakes.
    let seed = 12345;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      src[i] = (seed / 0x7fffffff) * 2 - 1;
    }
    const ref = naiveDft(src);
    const re = Float32Array.from(src);
    const im = new Float32Array(n);
    fftRadix2(re, im);
    for (let k = 0; k < n; k++) {
      expect(re[k]).toBeCloseTo(ref.re[k], 2);
      expect(im[k]).toBeCloseTo(ref.im[k], 2);
    }
  });

  it('turns a DC signal into energy only in bin 0', () => {
    const n = 64;
    const re = new Float32Array(n).fill(1);
    const im = new Float32Array(n);
    fftRadix2(re, im);
    expect(re[0]).toBeCloseTo(n, 4);
    for (let k = 1; k < n; k++) expect(Math.hypot(re[k], im[k])).toBeLessThan(1e-3);
  });
});

describe('analyserPowerSpectrum', () => {
  it('peaks at the bin matching the input sine', () => {
    const n = FFT_SIZE;
    const sampleRate = 48000;
    const freq = (sampleRate / n) * 100; // exactly bin 100
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++)
      sig[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    const power = analyserPowerSpectrum(sig);
    expect(power).toHaveLength(n / 2);
    let peak = 0;
    for (let k = 1; k < power.length; k++) if (power[k] > power[peak]) peak = k;
    expect(peak).toBe(100);
  });

  it('returns near-zero power for silence', () => {
    const power = analyserPowerSpectrum(new Float32Array(FFT_SIZE));
    for (const v of power) expect(v).toBeLessThan(1e-12);
  });

  it('scales with amplitude (louder input ⇒ more power)', () => {
    const n = FFT_SIZE;
    const mk = (amp: number) => {
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) s[i] = amp * Math.sin((2 * Math.PI * 100 * i) / n);
      return analyserPowerSpectrum(s);
    };
    const quiet = mk(0.1);
    const loud = mk(0.5);
    const total = (a: Float32Array) => a.reduce((x, y) => x + y, 0);
    expect(total(loud)).toBeGreaterThan(total(quiet));
  });
});

describe('rmsOf', () => {
  it('is zero for silence and 1 for a full-scale square', () => {
    expect(rmsOf(new Float32Array(128))).toBe(0);
    expect(rmsOf(new Float32Array(128).fill(1))).toBeCloseTo(1, 6);
  });

  it('is ~1/√2 for a full-scale sine', () => {
    const n = 1024;
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = Math.sin((2 * Math.PI * 8 * i) / n);
    expect(rmsOf(s)).toBeCloseTo(Math.SQRT1_2, 2);
  });
});

describe('dct2 / computeMfcc', () => {
  it('drops DC and keeps the requested coefficient count', () => {
    const x = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(dct2(x, 4)).toHaveLength(4);
  });

  it('returns all-zero coefficients for a constant input (DC only)', () => {
    const x = new Float32Array(16).fill(3);
    for (const c of dct2(x, 6)) expect(Math.abs(c)).toBeLessThan(1e-4);
  });

  it('computeMfcc yields N_MFCC_COEFFS from a power spectrum', () => {
    const filters = buildMelFilters(48000, FFT_SIZE);
    const power = new Float32Array(FFT_SIZE / 2).fill(1e-3);
    const mfcc = computeMfcc(power, filters);
    expect(mfcc).toHaveLength(N_MFCC_COEFFS);
    for (const c of mfcc) expect(Number.isFinite(c)).toBe(true);
  });

  it('does not produce NaN/-Infinity on an all-zero spectrum', () => {
    const filters = buildMelFilters(48000, FFT_SIZE);
    const mfcc = computeMfcc(new Float32Array(FFT_SIZE / 2), filters);
    for (const c of mfcc) expect(Number.isFinite(c)).toBe(true);
  });
});

describe('vector helpers', () => {
  it('meanVector averages component-wise', () => {
    expect(meanVector([[0, 2], [2, 4]])).toEqual([1, 3]);
  });

  it('subtract removes the mean', () => {
    expect(subtract([3, 5], [1, 2])).toEqual([2, 3]);
  });

  it('norm and normalise agree', () => {
    expect(norm([3, 4])).toBe(5);
    const v = normalise([3, 4]);
    expect(norm(v)).toBeCloseTo(1, 6);
  });

  it('normalise leaves a zero vector alone rather than dividing by zero', () => {
    expect(normalise([0, 0])).toEqual([0, 0]);
  });

  it('distSq is zero for identical vectors', () => {
    expect(distSq([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(distSq([0, 0], [3, 4])).toBe(25);
  });

  it('softmax sums to 1 and favours the largest input', () => {
    const p = softmax([1, 0, -1]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(p[0]).toBeGreaterThan(p[1]);
    expect(p[1]).toBeGreaterThan(p[2]);
  });

  it('softmax temperature sharpens the distribution', () => {
    const soft = softmax([1, 0], 1);
    const sharp = softmax([1, 0], 20);
    expect(sharp[0]).toBeGreaterThan(soft[0]);
  });
});

describe('prepareTemplates', () => {
  it('centres and L2-normalises every vowel template', () => {
    const prepared = prepareTemplates(DEFAULT_TEMPLATES);
    expect(prepared.mean).toHaveLength(N_MFCC_COEFFS);
    for (const v of VOWEL_KEYS) {
      expect(norm(prepared.centred[v])).toBeCloseTo(1, 6);
    }
  });

  it('the centred templates sum to ~zero (the mean was removed)', () => {
    const prepared = prepareTemplates(DEFAULT_TEMPLATES);
    // Un-normalised centring sums to zero; after per-vector L2 the sum is merely small.
    for (let i = 0; i < N_MFCC_COEFFS; i++) {
      const s = VOWEL_KEYS.reduce((a, v) => a + prepared.centred[v][i], 0);
      expect(Math.abs(s)).toBeLessThan(1.5);
    }
  });
});

describe('updateVisemeWeights', () => {
  const prepared = prepareTemplates(DEFAULT_TEMPLATES);

  it('classifies each default template as its own vowel', () => {
    for (const vowel of VOWEL_KEYS) {
      const w = emptyVisemeWeights();
      // Converge past the EMA so the steady-state winner is unambiguous.
      for (let i = 0; i < 60; i++) {
        updateVisemeWeights(w, DEFAULT_TEMPLATES[vowel], 0.5, prepared);
      }
      const winner = VOWEL_KEYS.reduce((best, v) =>
        w[VOWEL_TO_VRM[v]] > w[VOWEL_TO_VRM[best]] ? v : best
      );
      expect(winner).toBe(vowel);
    }
  });

  it('decays toward silence below the RMS gate without scoring a vowel', () => {
    const w = emptyVisemeWeights();
    for (let i = 0; i < 40; i++)
      updateVisemeWeights(w, DEFAULT_TEMPLATES.A, 0.5, prepared);
    const loud = w.Fcl_MTH_A;
    expect(loud).toBeGreaterThan(0.2);

    for (let i = 0; i < 40; i++)
      updateVisemeWeights(w, DEFAULT_TEMPLATES.A, 0, prepared);
    expect(w.Fcl_MTH_A).toBeLessThan(loud * 0.01);
    expect(w.jawOpen).toBeLessThan(0.01);
  });

  it('opens the jaw with volume, independent of the vowel', () => {
    const quiet = emptyVisemeWeights();
    const loud = emptyVisemeWeights();
    for (let i = 0; i < 60; i++) {
      updateVisemeWeights(quiet, DEFAULT_TEMPLATES.A, 0.05, prepared);
      updateVisemeWeights(loud, DEFAULT_TEMPLATES.A, 0.6, prepared);
    }
    expect(loud.jawOpen).toBeGreaterThan(quiet.jawOpen);
  });

  it('respects a custom silence gate', () => {
    const w = emptyVisemeWeights();
    const opts = { ...DEFAULT_CLASSIFIER_OPTIONS, silenceRms: 0.9 };
    for (let i = 0; i < 20; i++)
      updateVisemeWeights(w, DEFAULT_TEMPLATES.A, 0.5, prepared, opts);
    // 0.5 is below the raised gate, so nothing was classified.
    expect(w.Fcl_MTH_A).toBe(0);
  });

  it('emptyVisemeWeights starts every channel at zero', () => {
    const w = emptyVisemeWeights();
    expect(w.jawOpen).toBe(0);
    for (const v of VOWEL_KEYS) expect(w[VOWEL_TO_VRM[v]]).toBe(0);
  });
});
