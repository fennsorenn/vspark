/**
 * MFCC vowel classification — the shared core of the lipsync pipeline.
 *
 * Extracted from `frontend/src/media/MicCapture.ts` so the browser and any server-side
 * capture provider classify identically. Pure math — no DOM, no Web Audio, no imports.
 *
 * Pipeline (per audio frame):
 *   power spectrum → mel filterbank → log → DCT-II → 12-dim MFCC
 *   → centre against the template mean → L2-normalise → -‖·‖² vs each vowel template
 *   → softmax → EMA-smoothed Fcl_MTH_* weights
 *
 * ── AnalyserNode parity (important) ──────────────────────────────────────────────────
 * In the browser the power spectrum comes out of `AnalyserNode.getFloatFrequencyData`,
 * and every stored `vowelTemplates` calibration was captured through it. A server-side
 * FFT that differs even in windowing puts the live MFCC in a different space from the
 * saved templates, and every existing calibration silently degrades — the classifier
 * keeps "working", just worse, which is the hardest kind of regression to notice.
 *
 * `analyserPowerSpectrum()` therefore replicates AnalyserNode exactly, per the Web Audio
 * spec: Blackman window (a0=0.42, a1=0.5, a2=0.08), FFT, magnitude normalised by
 * `fftSize`. The browser path then does dB → linear → square; we skip that round-trip
 * and square the normalised magnitude directly, which is the same value.
 *
 * `smoothingTimeConstant` is 0 in `MicCapture`, so there is no time-domain smoothing to
 * replicate here.
 */

export const FFT_SIZE = 2048;
export const N_MEL_FILTERS = 26;
export const N_MFCC_COEFFS = 12; // drop DC (coeff 0), keep 1..12
export const MEL_F_LOW_HZ = 80;
export const MEL_F_HIGH_HZ = 8000;

export const VOWEL_KEYS = ['A', 'E', 'I', 'O', 'U'] as const;
export type Vowel = (typeof VOWEL_KEYS)[number];

export type VowelTemplates = Record<Vowel, number[]>;

/** VRM 1.0 Fcl_MTH_* names mapped from our vowel keys. */
export const VOWEL_TO_VRM: Record<Vowel, string> = {
  A: 'Fcl_MTH_A',
  E: 'Fcl_MTH_E',
  I: 'Fcl_MTH_I',
  O: 'Fcl_MTH_O',
  U: 'Fcl_MTH_U',
};

export interface VisemeWeights {
  jawOpen: number;
  Fcl_MTH_A: number;
  Fcl_MTH_E: number;
  Fcl_MTH_I: number;
  Fcl_MTH_O: number;
  Fcl_MTH_U: number;
  [key: string]: number;
}

export function emptyVisemeWeights(): VisemeWeights {
  return {
    jawOpen: 0,
    Fcl_MTH_A: 0,
    Fcl_MTH_E: 0,
    Fcl_MTH_I: 0,
    Fcl_MTH_O: 0,
    Fcl_MTH_U: 0,
  };
}

// ── Mel / MFCC ──────────────────────────────────────────────────────────────

export function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}
export function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

/** Build mel filterbank: returns an N_MEL_FILTERS × nBins triangular weight matrix. */
export function buildMelFilters(
  sampleRate: number,
  fftSize: number
): Float32Array[] {
  const nBins = fftSize / 2;
  const binHz = sampleRate / fftSize;
  const melLow = hzToMel(MEL_F_LOW_HZ);
  const melHigh = hzToMel(MEL_F_HIGH_HZ);
  const points: number[] = [];
  for (let i = 0; i < N_MEL_FILTERS + 2; i++) {
    const mel = melLow + (melHigh - melLow) * (i / (N_MEL_FILTERS + 1));
    points.push(melToHz(mel) / binHz); // bin index
  }
  const filters: Float32Array[] = [];
  for (let m = 1; m <= N_MEL_FILTERS; m++) {
    const f = new Float32Array(nBins);
    const lo = points[m - 1],
      ctr = points[m],
      hi = points[m + 1];
    for (let k = 0; k < nBins; k++) {
      if (k < lo || k > hi) continue;
      if (k < ctr) f[k] = (k - lo) / (ctr - lo);
      else f[k] = (hi - k) / (hi - ctr);
    }
    filters.push(f);
  }
  return filters;
}

/** DCT-II of `x` keeping only coefficients 1..N (drops DC at index 0). */
export function dct2(x: Float32Array, nKeep: number): Float32Array {
  const N = x.length;
  const out = new Float32Array(nKeep);
  for (let k = 1; k <= nKeep; k++) {
    let sum = 0;
    const fk = (Math.PI * k) / N;
    for (let n = 0; n < N; n++) sum += x[n] * Math.cos(fk * (n + 0.5));
    out[k - 1] = sum;
  }
  return out;
}

/** Compute MFCC vector (length N_MFCC_COEFFS) from a power spectrum (length nBins). */
export function computeMfcc(
  powerSpectrum: Float32Array,
  melFilters: Float32Array[]
): Float32Array {
  const melEnergies = new Float32Array(N_MEL_FILTERS);
  for (let m = 0; m < N_MEL_FILTERS; m++) {
    const f = melFilters[m];
    let sum = 0;
    for (let k = 0; k < powerSpectrum.length; k++)
      sum += powerSpectrum[k] * f[k];
    melEnergies[m] = Math.log(sum + 1e-9); // log-mel
  }
  return dct2(melEnergies, N_MFCC_COEFFS);
}

// ── FFT (server-side only; the browser gets its spectrum from AnalyserNode) ──

/** In-place iterative radix-2 complex FFT. `re`/`im` must be the same power-of-two length. */
export function fftRadix2(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang),
      wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1,
        ci = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k],
          ui = im[i + k];
        const xr = re[i + k + half],
          xi = im[i + k + half];
        const vr = xr * cr - xi * ci;
        const vi = xr * ci + xi * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * AnalyserNode-equivalent linear power spectrum from time-domain samples.
 *
 * Replicates the Web Audio spec's Blackman window and `|X[k]| / fftSize` normalisation
 * so server-side MFCCs land in the same space as browser-captured `vowelTemplates`.
 * Returns `fftSize / 2` bins.
 */
export function analyserPowerSpectrum(timeDomain: Float32Array): Float32Array {
  const n = timeDomain.length;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  // Blackman window, per the Web Audio spec's AnalyserNode definition.
  const a0 = 0.42,
    a1 = 0.5,
    a2 = 0.08;
  for (let i = 0; i < n; i++) {
    const w =
      a0 -
      a1 * Math.cos((2 * Math.PI * i) / n) +
      a2 * Math.cos((4 * Math.PI * i) / n);
    re[i] = timeDomain[i] * w;
  }
  fftRadix2(re, im);
  const bins = n >> 1;
  const power = new Float32Array(bins);
  for (let k = 0; k < bins; k++) {
    // AnalyserNode reports 20*log10(|X[k]|/N) dB; MicCapture inverts that to a linear
    // magnitude and squares it. Squaring the normalised magnitude directly is the same
    // value without the dB round-trip.
    const mag = Math.hypot(re[k], im[k]) / n;
    power[k] = mag * mag;
  }
  return power;
}

/** RMS of time-domain samples in [-1, 1]. */
export function rmsOf(timeDomain: ArrayLike<number>): number {
  let sumSq = 0;
  for (let i = 0; i < timeDomain.length; i++)
    sumSq += timeDomain[i] * timeDomain[i];
  return Math.sqrt(sumSq / timeDomain.length);
}

// ── Classifier ──────────────────────────────────────────────────────────────

/** Mean of a set of MFCC vectors. */
export function meanVector(vectors: ArrayLike<number>[]): number[] {
  const dim = vectors[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

/** Subtract `mean` from `v` (returns a new array). */
export function subtract(v: ArrayLike<number>, mean: number[]): number[] {
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] - mean[i];
  return out;
}

/** L2 norm. */
export function norm(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

/** L2-normalise `v` in place; returns the normalised array. */
export function normalise(v: number[]): number[] {
  const n = norm(v);
  if (n === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Squared Euclidean distance. */
export function distSq(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

/** Softmax with temperature; higher temperature = sharper one-hot. */
export function softmax(x: number[], temperature = 12): number[] {
  const scaled = x.map((v) => v * temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export interface PreparedTemplates {
  /** Mean across all five vowel templates — subtracted from each before scoring. */
  mean: number[];
  /** Centred, L2-normalised template vectors, keyed by vowel. */
  centred: Record<Vowel, number[]>;
}

/** Precompute the centred+normalised representation used at classification time. */
export function prepareTemplates(t: VowelTemplates): PreparedTemplates {
  const mean = meanVector(VOWEL_KEYS.map((v) => t[v]));
  const centred = {} as Record<Vowel, number[]>;
  for (const v of VOWEL_KEYS) centred[v] = normalise(subtract(t[v], mean));
  return { mean, centred };
}

export interface VisemeClassifierOptions {
  /** Below this RMS we emit silence (avoids hallucinated vowels). */
  silenceRms: number;
  /** EMA smoothing for output weights. 0 = snap, 1 = frozen. */
  smoothingAlpha: number;
  /** Softmax temperature — higher = more decisive vowel pick. */
  softmaxTemperature: number;
}

export const DEFAULT_CLASSIFIER_OPTIONS: VisemeClassifierOptions = {
  silenceRms: 0.012,
  smoothingAlpha: 0.6,
  softmaxTemperature: 12,
};

/**
 * Fold one frame into `latest` (mutated in place).
 *
 * Below the silence floor every weight decays toward zero and no vowel is scored;
 * otherwise the live MFCC is centred against the same mean used for the templates and
 * scored by negative squared Euclidean distance. Removing the inter-vowel mean amplifies
 * what's *different* between similar pairs (O vs U especially), and normalising puts all
 * comparisons on a unit sphere so the softmax sees consistent magnitudes.
 *
 * `jawOpen` tracks RMS so the mouth opens with volume, independent of which vowel won.
 */
export function updateVisemeWeights(
  latest: VisemeWeights,
  mfcc: ArrayLike<number>,
  rms: number,
  prepared: PreparedTemplates,
  opts: VisemeClassifierOptions = DEFAULT_CLASSIFIER_OPTIONS
): void {
  const a = opts.smoothingAlpha;
  if (rms < opts.silenceRms) {
    for (const v of VOWEL_KEYS) latest[VOWEL_TO_VRM[v]] *= a;
    latest.jawOpen *= a;
    return;
  }
  const liveCentred = normalise(subtract(mfcc, prepared.mean));
  const sims = VOWEL_KEYS.map((v) => -distSq(liveCentred, prepared.centred[v]));
  const probs = softmax(sims, opts.softmaxTemperature);
  for (let i = 0; i < VOWEL_KEYS.length; i++) {
    const key = VOWEL_TO_VRM[VOWEL_KEYS[i]];
    latest[key] = a * latest[key] + (1 - a) * probs[i];
  }
  const jawTarget = Math.min(1, (rms - opts.silenceRms) * 12);
  latest.jawOpen = a * latest.jawOpen + (1 - a) * jawTarget;
}

// ── Default templates ───────────────────────────────────────────────────────
//
// Captured via the in-app calibration UI against a single English-speaking
// adult voice at 48 kHz. Users can override per-behavior via setTemplates().
// If your voice doesn't classify well against these, recalibrate.

export const DEFAULT_TEMPLATES: VowelTemplates = {
  A: [
    56.88148746934048, 8.695429225300636, 6.055128915365353,
    -7.0817173430804425, -2.4147463974564563, 18.69047922866289,
    -6.545224977094073, 2.184106258350576, 2.4409438615101675, 5.2020612844201,
    1.2209744369177924, -2.498881573940425,
  ],
  E: [
    39.74647612798782, 15.735643356565447, 28.36104753282335, 9.959775394863552,
    -6.779232064882913, 1.4534635009273653, -8.736671840387677,
    5.256605760918723, -7.1868654621972015, -5.931885159204877,
    4.916308163177395, -5.3345912955109975,
  ],
  I: [
    33.45545895894369, 25.71246419129548, 39.46388550746588, 12.783014215069052,
    -9.384085984141738, 9.684172247662957, -2.8081909190334473,
    -1.1757180645234053, -9.031330964447545, -5.764947701383521,
    3.138291744492299, -4.9273853375587855,
  ],
  O: [
    60.7946743103395, 32.01150223146002, 14.062001366213144, -8.337574378553644,
    -7.2142427111246485, 7.663210330239261, 1.4449080648910568,
    0.1353482171300174, -0.3008058024626476, -5.26569019922291,
    -1.6022887387458853, -0.6465266349175559,
  ],
  U: [
    56.83788716634115, 29.782737172444662, 17.373394711812338,
    0.05835628069471639, -1.2168972878654782, 3.374967514673869,
    -2.1147060124203563, 0.7931957999678951, 0.6637996393690463,
    -4.304805822372438, -0.9514333840211285, -1.0953661604908524,
  ],
};
