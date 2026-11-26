/**
 * MicCapture — browser microphone analyser that produces VRM viseme weights.
 *
 * The browser half of lipsync: it owns the `getUserMedia` stream and the
 * `AnalyserNode`, and hands each frame's RMS + power spectrum to the shared
 * {@link VisemeClassifier} (`@vspark/shared/visemes`). The backend's PipeWire
 * capture uses the same classifier, so both inputs classify identically.
 *
 * No audio leaves the browser — only the derived float weights.
 */

import {
  FFT_SIZE,
  VisemeClassifier,
  type VisemeWeights,
  type VowelTemplates,
} from '@vspark/shared/visemes';

export type {
  Vowel,
  VisemeWeights,
  VowelTemplates,
} from '@vspark/shared/visemes';

export class MicCapture {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private fftBuf: Float32Array<ArrayBuffer> | null = null;
  private timeBuf: Float32Array<ArrayBuffer> | null = null;
  private rafId: number | null = null;

  private readonly classifier = new VisemeClassifier();

  /** Volume gate — below this RMS we emit silence (avoids hallucinated vowels). */
  get silenceRms(): number {
    return this.classifier.silenceRms;
  }
  set silenceRms(v: number) {
    this.classifier.silenceRms = v;
  }

  /** EMA smoothing for output weights. 0 = snap, 1 = frozen. */
  get smoothingAlpha(): number {
    return this.classifier.smoothingAlpha;
  }
  set smoothingAlpha(v: number) {
    this.classifier.smoothingAlpha = v;
  }

  /** Softmax temperature — higher = more decisive vowel pick. */
  get softmaxTemperature(): number {
    return this.classifier.softmaxTemperature;
  }
  set softmaxTemperature(v: number) {
    this.classifier.softmaxTemperature = v;
  }

  onLevelChange: ((rms: number) => void) | null = null;

  /** Optional callback invoked with the raw MFCC vector each frame during capture. */
  private captureCallback: ((mfcc: Float32Array, rms: number) => void) | null =
    null;

  setTemplates(templates: VowelTemplates): void {
    this.classifier.setTemplates(templates);
  }

  getTemplates(): VowelTemplates {
    return this.classifier.getTemplates();
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
    this.classifier.setSampleRate(this.ctx.sampleRate);

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
    this.classifier.reset();
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

    const mfcc = this.classifier.mfcc(power);
    this.captureCallback?.(mfcc, rms);
    this.classifier.processMfcc(rms, mfcc);
  }

  getVisemes(): VisemeWeights {
    return this.classifier.weights();
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
