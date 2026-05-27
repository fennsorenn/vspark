/**
 * MicCapture — browser microphone analyser that produces VRM viseme weights.
 *
 * Pipeline (all in-browser):
 *   AnalyserNode FFT → mel filterbank → log → DCT-II → 12-dim MFCC vector
 *   → cosine-similarity against per-vowel templates → softmax → smoothed weights
 *
 * The templates can be the textbook defaults (synthesised from Peterson-Barney
 * F1/F2 formant centres) or user-calibrated via setTemplates(). Calibration
 * captures the live MFCC vector while a known vowel is being held.
 *
 * No audio leaves the browser — only the derived float weights.
 */

const FFT_SIZE = 2048;
const SAMPLE_RATE = 48000; // assumed; AnalyserNode reads context's rate
const N_MEL_FILTERS = 26;
const N_MFCC_COEFFS = 12; // drop DC (coeff 0), keep 1..12
const MEL_F_LOW_HZ = 80;
const MEL_F_HIGH_HZ = 8000;

const VOWEL_KEYS = ['A', 'E', 'I', 'O', 'U'] as const;
export type Vowel = (typeof VOWEL_KEYS)[number];

export type VowelTemplates = Record<Vowel, number[]>;

/** VRM 1.0 Fcl_MTH_* names mapped from our vowel keys. */
const VOWEL_TO_VRM: Record<Vowel, string> = {
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

// ── MFCC implementation ─────────────────────────────────────────────────────

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}
function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

/** Build mel filterbank: returns an N_MEL_FILTERS × nBins triangular weight matrix. */
function buildMelFilters(sampleRate: number, fftSize: number): Float32Array[] {
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

/** Compute MFCC vector (length N_MFCC_COEFFS) from a power spectrum (length nBins). */
function computeMfcc(
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

// ── Default templates ───────────────────────────────────────────────────────
//
// Captured via the in-app calibration UI against a single English-speaking
// adult voice at 48 kHz. Users can override per-component via setTemplates().
// If your voice doesn't classify well against these, recalibrate.

const DEFAULT_TEMPLATES: VowelTemplates = {
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

// ── Classifier ──────────────────────────────────────────────────────────────

/** Mean of a set of MFCC vectors. */
function meanVector(vectors: ArrayLike<number>[]): number[] {
  const dim = vectors[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

/** Subtract `mean` from `v` (returns a new array). */
function subtract(v: ArrayLike<number>, mean: number[]): number[] {
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] - mean[i];
  return out;
}

/** L2 norm. */
function norm(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

/** L2-normalise `v` in place; returns the normalised array. */
function normalise(v: number[]): number[] {
  const n = norm(v);
  if (n === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Squared Euclidean distance. */
function distSq(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

/** Softmax with temperature; higher temperature = sharper one-hot. */
function softmax(x: number[], temperature = 12): number[] {
  const scaled = x.map((v) => v * temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

interface PreparedTemplates {
  /** Mean across all five vowel templates — subtracted from each before scoring. */
  mean: number[];
  /** Centred, L2-normalised template vectors, keyed by vowel. */
  centred: Record<Vowel, number[]>;
}

/** Precompute the centred+normalised representation used at classification time. */
function prepareTemplates(t: VowelTemplates): PreparedTemplates {
  const mean = meanVector(VOWEL_KEYS.map((v) => t[v]));
  const centred = {} as Record<Vowel, number[]>;
  for (const v of VOWEL_KEYS) centred[v] = normalise(subtract(t[v], mean));
  return { mean, centred };
}

// ── MicCapture ──────────────────────────────────────────────────────────────

export class MicCapture {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private fftBuf: Float32Array<ArrayBuffer> | null = null;
  private timeBuf: Float32Array<ArrayBuffer> | null = null;
  private rafId: number | null = null;
  private melFilters: Float32Array[];

  /** Active templates (default or user-calibrated). */
  private templates: VowelTemplates;
  /** Centred + L2-normalised view of `templates`, refreshed when templates change. */
  private prepared: PreparedTemplates;

  /** Latest smoothed weights, refreshed by the internal rAF loop. */
  private latest: VisemeWeights = MicCapture.emptyWeights();

  /** Volume gate — below this RMS we emit silence (avoids hallucinated vowels). */
  silenceRms = 0.012;

  /** EMA smoothing for output weights. 0 = snap, 1 = frozen. */
  smoothingAlpha = 0.6;

  /** Softmax temperature — higher = more decisive vowel pick. */
  softmaxTemperature = 12;

  onLevelChange: ((rms: number) => void) | null = null;

  /** Optional callback invoked with the raw MFCC vector each frame during capture. */
  private captureCallback: ((mfcc: Float32Array, rms: number) => void) | null =
    null;

  constructor() {
    this.melFilters = buildMelFilters(SAMPLE_RATE, FFT_SIZE);
    this.templates = { ...DEFAULT_TEMPLATES };
    this.prepared = prepareTemplates(this.templates);
  }

  private static emptyWeights(): VisemeWeights {
    return {
      jawOpen: 0,
      Fcl_MTH_A: 0,
      Fcl_MTH_E: 0,
      Fcl_MTH_I: 0,
      Fcl_MTH_O: 0,
      Fcl_MTH_U: 0,
    };
  }

  setTemplates(templates: VowelTemplates): void {
    this.templates = templates;
    this.prepared = prepareTemplates(templates);
  }

  getTemplates(): VowelTemplates {
    return { ...this.templates };
  }

  /** Capture raw MFCC + RMS for one frame (for calibration). */
  onCaptureFrame(cb: ((mfcc: Float32Array, rms: number) => void) | null): void {
    this.captureCallback = cb;
  }

  async start(deviceId?: string): Promise<void> {
    await this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId
        ? {
            deviceId: { exact: deviceId },
            echoCancellation: false,
            noiseSuppression: false,
          }
        : { echoCancellation: false, noiseSuppression: false },
    });
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.analyser);
    this.fftBuf = new Float32Array(
      this.analyser.frequencyBinCount
    ) as Float32Array<ArrayBuffer>;
    this.timeBuf = new Float32Array(
      this.analyser.fftSize
    ) as Float32Array<ArrayBuffer>;

    // Rebuild mel filters with the actual context sample rate (may differ from 48k).
    // The shipped defaults were captured at 48 kHz; at other rates classification
    // accuracy will degrade slightly until the user recalibrates.
    this.melFilters = buildMelFilters(this.ctx.sampleRate, FFT_SIZE);

    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      this.processFrame();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  async stop(): Promise<void> {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.source?.disconnect();
    await this.ctx?.close().catch(() => {});
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx =
      this.analyser =
      this.source =
      this.stream =
      this.fftBuf =
      this.timeBuf =
        null;
    this.latest = MicCapture.emptyWeights();
  }

  get active(): boolean {
    return this.ctx !== null;
  }

  private processFrame(): void {
    if (!this.analyser || !this.fftBuf || !this.timeBuf) return;

    // RMS from time-domain samples [-1, 1] — direct loudness measure.
    this.analyser.getFloatTimeDomainData(this.timeBuf);
    let sumSq = 0;
    for (let i = 0; i < this.timeBuf.length; i++)
      sumSq += this.timeBuf[i] * this.timeBuf[i];
    const rms = Math.sqrt(sumSq / this.timeBuf.length);
    this.onLevelChange?.(rms);

    // Frequency data (dBFS) → linear power spectrum for MFCC.
    this.analyser.getFloatFrequencyData(this.fftBuf);
    const power = new Float32Array(this.fftBuf.length);
    for (let i = 0; i < this.fftBuf.length; i++) {
      const lin = Math.pow(10, this.fftBuf[i] / 20);
      power[i] = lin * lin;
    }

    const mfcc = computeMfcc(power, this.melFilters);
    this.captureCallback?.(mfcc, rms);

    // Below silence floor → decay everything toward zero, no vowel match.
    const a = this.smoothingAlpha;
    if (rms < this.silenceRms) {
      for (const v of VOWEL_KEYS) {
        const next = a * this.latest[VOWEL_TO_VRM[v]];
        this.latest[VOWEL_TO_VRM[v]] = next;
      }
      this.latest.jawOpen = a * this.latest.jawOpen;
      return;
    }

    // Centre + L2-normalise the live MFCC against the same mean used for the
    // templates, then score by negative squared Euclidean distance. Removing
    // the inter-vowel mean amplifies what's *different* between similar pairs
    // (O vs U especially), and normalising puts all comparisons on a unit
    // sphere so the softmax sees consistent magnitudes.
    const liveCentred = normalise(subtract(mfcc, this.prepared.mean));
    const sims = VOWEL_KEYS.map(
      (v) => -distSq(liveCentred, this.prepared.centred[v])
    );
    const probs = softmax(sims, this.softmaxTemperature);
    for (let i = 0; i < VOWEL_KEYS.length; i++) {
      const key = VOWEL_TO_VRM[VOWEL_KEYS[i]];
      this.latest[key] = a * this.latest[key] + (1 - a) * probs[i];
    }

    // jawOpen tracks RMS so the mouth opens with volume, independent of which vowel won.
    const jawTarget = Math.min(1, (rms - this.silenceRms) * 12);
    this.latest.jawOpen = a * this.latest.jawOpen + (1 - a) * jawTarget;
  }

  getVisemes(): VisemeWeights {
    return { ...this.latest };
  }

  static async getDevices(): Promise<MediaDeviceInfo[]> {
    // Probe getUserMedia so the browser surfaces a permission prompt and the
    // subsequent enumerateDevices() call returns labelled devices. Release the
    // probe stream immediately — we only need the prompt side-effect.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch (e) {
      console.warn('[MicCapture.getDevices] mic probe failed:', e);
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }
}
