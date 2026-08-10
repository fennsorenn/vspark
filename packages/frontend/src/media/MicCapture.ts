/**
 * MicCapture — browser microphone analyser that produces VRM viseme weights.
 *
 * This file is now only the **browser glue**: getUserMedia, AudioContext, AnalyserNode
 * and the frame loop. All the DSP and classification lives in `@vspark/shared/mfcc` so
 * server-side capture providers produce byte-identical weights. See that module's header
 * for the pipeline and the AnalyserNode-parity constraint.
 *
 * No audio leaves the browser — only the derived float weights.
 */

import {
  DEFAULT_CLASSIFIER_OPTIONS,
  DEFAULT_TEMPLATES,
  FFT_SIZE,
  buildMelFilters,
  computeMfcc,
  emptyVisemeWeights,
  prepareTemplates,
  rmsOf,
  updateVisemeWeights,
  type PreparedTemplates,
  type VisemeWeights,
  type Vowel,
  type VowelTemplates,
} from '@vspark/shared/mfcc';

export type { Vowel, VowelTemplates, VisemeWeights };

/** Assumed until the live AudioContext reports its real rate. */
const SAMPLE_RATE = 48000;

/**
 * Frame cadence. Was `requestAnimationFrame`, which is compositor-driven — it stalls in a
 * backgrounded or offscreen window, exactly the environment the server-side browser-agent
 * capture provider runs in. A timer is independent of the compositor.
 */
const FRAME_INTERVAL_MS = 16;

export class MicCapture {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private fftBuf: Float32Array<ArrayBuffer> | null = null;
  private timeBuf: Float32Array<ArrayBuffer> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private melFilters: Float32Array[];

  /** Active templates (default or user-calibrated). */
  private templates: VowelTemplates;
  /** Centred + L2-normalised view of `templates`, refreshed when templates change. */
  private prepared: PreparedTemplates;

  /** Latest smoothed weights, refreshed by the internal frame loop. */
  private latest: VisemeWeights = emptyVisemeWeights();

  /** Volume gate — below this RMS we emit silence (avoids hallucinated vowels). */
  silenceRms = DEFAULT_CLASSIFIER_OPTIONS.silenceRms;

  /** EMA smoothing for output weights. 0 = snap, 1 = frozen. */
  smoothingAlpha = DEFAULT_CLASSIFIER_OPTIONS.smoothingAlpha;

  /** Softmax temperature — higher = more decisive vowel pick. */
  softmaxTemperature = DEFAULT_CLASSIFIER_OPTIONS.softmaxTemperature;

  onLevelChange: ((rms: number) => void) | null = null;

  /** Optional callback invoked with the raw MFCC vector each frame during capture. */
  private captureCallback: ((mfcc: Float32Array, rms: number) => void) | null =
    null;

  constructor() {
    this.melFilters = buildMelFilters(SAMPLE_RATE, FFT_SIZE);
    this.templates = { ...DEFAULT_TEMPLATES };
    this.prepared = prepareTemplates(this.templates);
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

    this.timer = setInterval(() => this.processFrame(), FRAME_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
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
    this.latest = emptyVisemeWeights();
  }

  get active(): boolean {
    return this.ctx !== null;
  }

  private processFrame(): void {
    if (!this.analyser || !this.fftBuf || !this.timeBuf) return;

    // RMS from time-domain samples [-1, 1] — direct loudness measure.
    this.analyser.getFloatTimeDomainData(this.timeBuf);
    const rms = rmsOf(this.timeBuf);
    this.onLevelChange?.(rms);

    // Frequency data (dBFS) → linear power spectrum for MFCC. The server-side path
    // reconstructs this same spectrum from raw samples via `analyserPowerSpectrum`.
    this.analyser.getFloatFrequencyData(this.fftBuf);
    const power = new Float32Array(this.fftBuf.length);
    for (let i = 0; i < this.fftBuf.length; i++) {
      const lin = Math.pow(10, this.fftBuf[i] / 20);
      power[i] = lin * lin;
    }

    const mfcc = computeMfcc(power, this.melFilters);
    this.captureCallback?.(mfcc, rms);

    updateVisemeWeights(this.latest, mfcc, rms, this.prepared, {
      silenceRms: this.silenceRms,
      smoothingAlpha: this.smoothingAlpha,
      softmaxTemperature: this.softmaxTemperature,
    });
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
