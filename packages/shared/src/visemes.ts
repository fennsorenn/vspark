/**
 * Viseme classifier — audio frame → VRM mouth weights (`Fcl_MTH_A/E/I/O/U` + `jawOpen`).
 *
 * Shared so the two lipsync inputs agree: the browser's `MicCapture` (spectrum
 * from an `AnalyserNode`) and the backend's PipeWire capture (spectrum from
 * {@link powerSpectrum}, which reproduces the AnalyserNode's Blackman-window
 * FFT). Everything after the spectrum — mel filterbank, MFCC, template scoring,
 * smoothing — is this one implementation.
 *
 * Pipeline: power spectrum → 26-band mel filterbank → log → DCT-II → 12 MFCCs
 * → centre + L2-normalise → negative squared distance to each vowel template
 * → softmax → EMA. `jawOpen` follows RMS, independent of the vowel pick.
 */

export const FFT_SIZE = 2048;
/** The rate the default templates were captured at. */
export const DEFAULT_SAMPLE_RATE = 48000;
export const N_MEL_FILTERS = 26;
/** Coefficients kept: 1..12 (the DC coefficient is dropped). */
export const N_MFCC_COEFFS = 12;
export const MEL_F_LOW_HZ = 80;
export const MEL_F_HIGH_HZ = 8000;

export const VOWEL_KEYS = ['A', 'E', 'I', 'O', 'U'] as const;
export type Vowel = (typeof VOWEL_KEYS)[number];
export type VowelTemplates = Record<Vowel, number[]>;

/** VRM `Fcl_MTH_*` blendshape names for each vowel. */
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

// ── Spectrum ────────────────────────────────────────────────────────────────

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}
function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

/** Mel filterbank: N_MEL_FILTERS triangular weight rows over `fftSize / 2` bins. */
export function buildMelFilters(
  sampleRate: number,
  fftSize: number = FFT_SIZE
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

const blackmanCache = new Map<number, Float32Array>();

/** The Web Audio AnalyserNode's window (Blackman, alpha 0.16). */
function blackman(n: number): Float32Array {
  let w = blackmanCache.get(n);
  if (w) return w;
  w = new Float32Array(n);
  const a0 = 0.42,
    a1 = 0.5,
    a2 = 0.08;
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / n;
    w[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x);
  }
  blackmanCache.set(n, w);
  return w;
}

/** In-place iterative radix-2 FFT. `re.length` must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang),
      wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1,
        ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k,
          b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Linear power spectrum (`fftSize / 2` bins) of a time-domain frame, matching
 * what `MicCapture` derives from `AnalyserNode.getFloatFrequencyData` with
 * `smoothingTimeConstant = 0`: Blackman window, FFT, `(|X| / N)²`.
 */
export function powerSpectrum(samples: ArrayLike<number>): Float32Array {
  const n = samples.length;
  if (n === 0 || (n & (n - 1)) !== 0)
    throw new Error(`powerSpectrum: frame length ${n} is not a power of two`);
  const w = blackman(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = samples[i] * w[i];
  fft(re, im);
  const out = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    const mag = Math.hypot(re[k], im[k]) / n;
    out[k] = mag * mag;
  }
  return out;
}

/** Root-mean-square level of a time-domain frame in [-1, 1]. */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
  return Math.sqrt(sumSq / samples.length);
}

/** DCT-II of `x`, keeping coefficients 1..nKeep (drops DC at index 0). */
function dct2(x: Float32Array, nKeep: number): Float32Array {
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

/** MFCC vector (length N_MFCC_COEFFS) from a linear power spectrum. */
export function computeMfcc(
  power: Float32Array,
  melFilters: Float32Array[]
): Float32Array {
  const melEnergies = new Float32Array(N_MEL_FILTERS);
  for (let m = 0; m < N_MEL_FILTERS; m++) {
    const f = melFilters[m];
    let sum = 0;
    for (let k = 0; k < power.length; k++) sum += power[k] * f[k];
    melEnergies[m] = Math.log(sum + 1e-9); // log-mel
  }
  return dct2(melEnergies, N_MFCC_COEFFS);
}

// ── Default templates ───────────────────────────────────────────────────────
//
// Captured via the in-app calibration UI against a single English-speaking
// adult voice at 48 kHz. A behavior's `vowelTemplates` config overrides them.

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

/** True when `t` has all five vowels, each a vector of N_MFCC_COEFFS numbers. */
export function isValidTemplates(t: unknown): t is VowelTemplates {
  if (!t || typeof t !== 'object') return false;
  const rec = t as Record<string, unknown>;
  return VOWEL_KEYS.every(
    (v) =>
      Array.isArray(rec[v]) &&
      (rec[v] as unknown[]).length === N_MFCC_COEFFS &&
      (rec[v] as unknown[]).every((x) => typeof x === 'number' && isFinite(x))
  );
}

// ── Classifier ──────────────────────────────────────────────────────────────

function meanVector(vectors: ArrayLike<number>[]): number[] {
  const dim = vectors[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

function subtract(v: ArrayLike<number>, mean: number[]): number[] {
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] - mean[i];
  return out;
}

function normalise(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  if (n === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function distSq(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

/** Softmax with temperature; higher temperature = sharper one-hot. */
function softmax(x: number[], temperature: number): number[] {
  const scaled = x.map((v) => v * temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

interface PreparedTemplates {
  /** Mean across the five templates — subtracted from each before scoring. */
  mean: number[];
  /** Centred, L2-normalised templates. */
  centred: Record<Vowel, number[]>;
}

function prepareTemplates(t: VowelTemplates): PreparedTemplates {
  const mean = meanVector(VOWEL_KEYS.map((v) => t[v]));
  const centred = {} as Record<Vowel, number[]>;
  for (const v of VOWEL_KEYS) centred[v] = normalise(subtract(t[v], mean));
  return { mean, centred };
}

/**
 * Stateful frame → weights classifier (the EMA is the state).
 *
 * Centring against the across-template mean before scoring is what separates
 * the back vowels: O and U share most of their low-cepstral structure and
 * co-fired on raw MFCCs. L2 normalising puts every comparison on the unit
 * sphere so the softmax sees consistent magnitudes.
 */
export class VisemeClassifier {
  /** Volume gate — below this RMS the weights decay (avoids hallucinated vowels). */
  silenceRms = 0.012;
  /** EMA smoothing for output weights. 0 = snap, 1 = frozen. */
  smoothingAlpha = 0.6;
  /** Softmax temperature — higher = more decisive vowel pick. */
  softmaxTemperature = 12;

  private melFilters: Float32Array[];
  private templates: VowelTemplates;
  private prepared: PreparedTemplates;
  private latest: VisemeWeights = emptyVisemeWeights();

  constructor(
    sampleRate: number = DEFAULT_SAMPLE_RATE,
    templates: VowelTemplates = DEFAULT_TEMPLATES
  ) {
    this.melFilters = buildMelFilters(sampleRate, FFT_SIZE);
    this.templates = { ...templates };
    this.prepared = prepareTemplates(this.templates);
  }

  /** Rebuild the filterbank for a different input rate. */
  setSampleRate(sampleRate: number): void {
    this.melFilters = buildMelFilters(sampleRate, FFT_SIZE);
  }

  setTemplates(templates: VowelTemplates): void {
    this.templates = templates;
    this.prepared = prepareTemplates(templates);
  }

  getTemplates(): VowelTemplates {
    return { ...this.templates };
  }

  /** MFCC of a power spectrum against this classifier's filterbank. */
  mfcc(power: Float32Array): Float32Array {
    return computeMfcc(power, this.melFilters);
  }

  /** Advance one frame from an RMS level and a linear power spectrum. */
  processSpectrum(level: number, power: Float32Array): VisemeWeights {
    return this.processMfcc(level, this.mfcc(power));
  }

  /** Advance one frame from an RMS level and a precomputed MFCC vector. */
  processMfcc(level: number, mfcc: ArrayLike<number>): VisemeWeights {
    const a = this.smoothingAlpha;
    if (level < this.silenceRms) {
      for (const v of VOWEL_KEYS) this.latest[VOWEL_TO_VRM[v]] *= a;
      this.latest.jawOpen *= a;
      return this.weights();
    }
    const live = normalise(subtract(mfcc, this.prepared.mean));
    const sims = VOWEL_KEYS.map((v) => -distSq(live, this.prepared.centred[v]));
    const probs = softmax(sims, this.softmaxTemperature);
    for (let i = 0; i < VOWEL_KEYS.length; i++) {
      const key = VOWEL_TO_VRM[VOWEL_KEYS[i]];
      this.latest[key] = a * this.latest[key] + (1 - a) * probs[i];
    }
    const jawTarget = Math.min(1, (level - this.silenceRms) * 12);
    this.latest.jawOpen = a * this.latest.jawOpen + (1 - a) * jawTarget;
    return this.weights();
  }

  /** Advance one frame from raw time-domain samples (length FFT_SIZE). */
  processSamples(samples: ArrayLike<number>): VisemeWeights {
    return this.processSpectrum(rms(samples), powerSpectrum(samples));
  }

  /** Latest weights (a copy). */
  weights(): VisemeWeights {
    return { ...this.latest };
  }

  reset(): void {
    this.latest = emptyVisemeWeights();
  }
}
