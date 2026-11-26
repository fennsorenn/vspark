import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TEMPLATES,
  FFT_SIZE,
  N_MEL_FILTERS,
  N_MFCC_COEFFS,
  VOWEL_KEYS,
  VOWEL_TO_VRM,
  VisemeClassifier,
  buildMelFilters,
  computeMfcc,
  emptyVisemeWeights,
  isValidTemplates,
  powerSpectrum,
  rms,
} from '../src/visemes';

function sine(freq: number, amp: number, rate = 48000, n = FFT_SIZE) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++)
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

describe('spectrum', () => {
  it('peaks at the bin of a pure tone', () => {
    const bin = 100;
    const p = powerSpectrum(sine((bin * 48000) / FFT_SIZE, 0.5));
    expect(p.length).toBe(FFT_SIZE / 2);
    let best = 0;
    for (let k = 1; k < p.length; k++) if (p[k] > p[best]) best = k;
    expect(best).toBe(bin);
  });

  it('is zero for silence', () => {
    const p = powerSpectrum(new Float32Array(FFT_SIZE));
    expect(Math.max(...p)).toBe(0);
  });

  it('rejects a frame that is not a power of two', () => {
    expect(() => powerSpectrum(new Float32Array(1000))).toThrow(/power of two/);
    expect(() => powerSpectrum(new Float32Array(0))).toThrow();
  });

  it('measures RMS', () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms([])).toBe(0);
  });

  it('builds one filter per mel band over half the FFT', () => {
    const f = buildMelFilters(48000);
    expect(f.length).toBe(N_MEL_FILTERS);
    expect(f.every((row) => row.length === FFT_SIZE / 2)).toBe(true);
    expect(f.every((row) => Math.max(...row) > 0)).toBe(true);
  });

  it('produces an MFCC vector of the template length', () => {
    const f = buildMelFilters(48000);
    const m = computeMfcc(powerSpectrum(sine(440, 0.3)), f);
    expect(m.length).toBe(N_MFCC_COEFFS);
    expect(m.every((x) => isFinite(x))).toBe(true);
  });

  it('MFCCs ignore overall gain (log-mel DC is dropped)', () => {
    // Why the server spectrum need not match the AnalyserNode's absolute
    // scale: a constant factor only shifts log-mel, which lands in the
    // dropped DC coefficient.
    // Broadband, so no mel band sits at the log floor (a pure tone leaves
    // near-empty bands where the 1e-9 epsilon, not the signal, dominates).
    const f = buildMelFilters(48000);
    let seed = 1;
    const noise = new Float32Array(FFT_SIZE).map(() => {
      seed = (seed * 16807) % 2147483647;
      return 0.3 * (seed / 2147483647 - 0.5);
    });
    const p = powerSpectrum(noise);
    const scaled = p.map((x) => x * 100);
    const a = computeMfcc(p, f);
    const b = computeMfcc(scaled, f);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 2);
  });
});

describe('templates', () => {
  it('accepts the defaults', () => {
    expect(isValidTemplates(DEFAULT_TEMPLATES)).toBe(true);
  });

  it('rejects malformed templates', () => {
    expect(isValidTemplates(null)).toBe(false);
    expect(isValidTemplates('x')).toBe(false);
    expect(isValidTemplates({ ...DEFAULT_TEMPLATES, U: undefined })).toBe(
      false
    );
    expect(isValidTemplates({ ...DEFAULT_TEMPLATES, A: [1, 2] })).toBe(false);
    const nan = { ...DEFAULT_TEMPLATES, E: DEFAULT_TEMPLATES.E.map(() => NaN) };
    expect(isValidTemplates(nan)).toBe(false);
  });
});

describe('VisemeClassifier', () => {
  it('starts closed', () => {
    expect(new VisemeClassifier().weights()).toEqual(emptyVisemeWeights());
  });

  it('picks the vowel whose template it hears', () => {
    for (const v of VOWEL_KEYS) {
      const c = new VisemeClassifier();
      let w = c.weights();
      for (let i = 0; i < 20; i++) w = c.processMfcc(0.2, DEFAULT_TEMPLATES[v]);
      const top = VOWEL_KEYS.reduce((a, b) =>
        w[VOWEL_TO_VRM[a]] >= w[VOWEL_TO_VRM[b]] ? a : b
      );
      expect(top).toBe(v);
      expect(w.jawOpen).toBeGreaterThan(0.5);
    }
  });

  it('decays toward closed below the silence gate', () => {
    const c = new VisemeClassifier();
    for (let i = 0; i < 10; i++) c.processMfcc(0.2, DEFAULT_TEMPLATES.A);
    const open = c.weights().jawOpen;
    const w = c.processMfcc(0, DEFAULT_TEMPLATES.A);
    expect(w.jawOpen).toBeCloseTo(open * c.smoothingAlpha);
    for (let i = 0; i < 60; i++) c.processMfcc(0, DEFAULT_TEMPLATES.A);
    expect(c.weights().Fcl_MTH_A).toBeLessThan(1e-6);
  });

  it('opens the jaw from raw samples', () => {
    const c = new VisemeClassifier();
    let w = c.weights();
    for (let i = 0; i < 10; i++) w = c.processSamples(sine(300, 0.3));
    expect(w.jawOpen).toBeGreaterThan(0.5);
    const sum = VOWEL_KEYS.reduce((s, v) => s + w[VOWEL_TO_VRM[v]], 0);
    expect(sum).toBeGreaterThan(0.9);
  });

  it('swaps templates and resets', () => {
    const c = new VisemeClassifier();
    const swapped = {
      ...DEFAULT_TEMPLATES,
      A: DEFAULT_TEMPLATES.O,
      O: DEFAULT_TEMPLATES.A,
    };
    c.setTemplates(swapped);
    expect(c.getTemplates().A).toBe(DEFAULT_TEMPLATES.O);
    for (let i = 0; i < 20; i++) c.processMfcc(0.2, DEFAULT_TEMPLATES.A);
    const w = c.weights();
    expect(w.Fcl_MTH_O).toBeGreaterThan(w.Fcl_MTH_A);
    c.reset();
    expect(c.weights()).toEqual(emptyVisemeWeights());
  });

  it('rebuilds its filterbank for another sample rate', () => {
    const c = new VisemeClassifier(48000);
    const p = powerSpectrum(sine(500, 0.3));
    const before = Array.from(c.mfcc(p));
    c.setSampleRate(16000);
    const after = Array.from(c.mfcc(p));
    expect(after).not.toEqual(before);
  });

  it('returns copies, not its internal state', () => {
    const c = new VisemeClassifier();
    const w = c.weights();
    w.jawOpen = 1;
    expect(c.weights().jawOpen).toBe(0);
  });
});
