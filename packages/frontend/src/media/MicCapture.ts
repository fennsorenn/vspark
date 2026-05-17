/**
 * MicCapture — browser microphone analyser that produces viseme weights.
 *
 * Uses the Web Audio API AnalyserNode + FFT frequency data to estimate
 * vowel shapes and jaw openness via formant-band energy ratios.
 * No audio leaves the browser; only the derived float weights are sent.
 */

// FFT frequency bin boundaries for 48 kHz, 2048-point FFT → bin width ≈ 23.4 Hz.
// We target 44.1 kHz / 48 kHz; choose conservative bin indices for portability.
const FFT_SIZE    = 2048
const SAMPLE_RATE = 48000
const BIN_HZ      = SAMPLE_RATE / FFT_SIZE  // ≈ 23.4 Hz per bin

function freqToBin(hz: number): number {
  return Math.round(hz / BIN_HZ)
}

// Formant band definitions (approximate mid-values for vowels in adult speech).
const BANDS = {
  // F0 / fundamental: 80–300 Hz — overall voicing presence
  voicing: { lo: freqToBin(80),  hi: freqToBin(300)  },
  // F1 low: 300–800 Hz — open vowels (A, O)
  f1Low:   { lo: freqToBin(300), hi: freqToBin(800)   },
  // F1 high / F2 low: 800–1500 Hz — mid vowels (E)
  f1High:  { lo: freqToBin(800), hi: freqToBin(1500)  },
  // F2 mid: 1500–2500 Hz — front vowels (I, E)
  f2Mid:   { lo: freqToBin(1500),hi: freqToBin(2500)  },
  // Sibilant: 3000–8000 Hz — fricatives (S, SH)
  sibilant:{ lo: freqToBin(3000),hi: freqToBin(8000)  },
}

function bandEnergy(data: Uint8Array, lo: number, hi: number): number {
  let sum = 0
  const n = Math.min(hi, data.length - 1)
  for (let i = lo; i <= n; i++) sum += data[i]
  return sum / Math.max(1, n - lo + 1) / 255
}

export interface VisemeWeights {
  jawOpen:    number
  Fcl_MTH_A: number
  Fcl_MTH_E: number
  Fcl_MTH_I: number
  Fcl_MTH_O: number
  Fcl_MTH_U: number
  [key: string]: number
}

export class MicCapture {
  private ctx:      AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source:   MediaStreamAudioSourceNode | null = null
  private stream:   MediaStream | null = null
  private buf:      Uint8Array<ArrayBuffer> | null = null

  // Exponential moving average state for smoothing
  private smoothed: VisemeWeights = {
    jawOpen: 0, Fcl_MTH_A: 0, Fcl_MTH_E: 0, Fcl_MTH_I: 0, Fcl_MTH_O: 0, Fcl_MTH_U: 0,
  }

  /** Smoothing factor: 0 = no smoothing, 1 = frozen. ~0.6 feels natural at 30fps. */
  smoothingAlpha = 0.6

  onLevelChange: ((rms: number) => void) | null = null

  async start(deviceId?: string): Promise<void> {
    await this.stop()
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId
        ? { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false }
        : { echoCancellation: false, noiseSuppression: false },
    })
    this.ctx      = new AudioContext()
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize           = FFT_SIZE
    this.analyser.smoothingTimeConstant = 0
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.source.connect(this.analyser)
    this.buf = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>
  }

  async stop(): Promise<void> {
    this.source?.disconnect()
    await this.ctx?.close()
    this.stream?.getTracks().forEach(t => t.stop())
    this.ctx = this.analyser = this.source = this.stream = this.buf = null
    this.smoothed = { jawOpen: 0, Fcl_MTH_A: 0, Fcl_MTH_E: 0, Fcl_MTH_I: 0, Fcl_MTH_O: 0, Fcl_MTH_U: 0 }
  }

  get active(): boolean { return this.ctx !== null }

  getVisemes(): VisemeWeights {
    if (!this.analyser || !this.buf) return { ...this.smoothed }
    this.analyser.getByteFrequencyData(this.buf)

    const voicing  = bandEnergy(this.buf, BANDS.voicing.lo,  BANDS.voicing.hi)
    const f1Low    = bandEnergy(this.buf, BANDS.f1Low.lo,    BANDS.f1Low.hi)
    const f1High   = bandEnergy(this.buf, BANDS.f1High.lo,   BANDS.f1High.hi)
    const f2Mid    = bandEnergy(this.buf, BANDS.f2Mid.lo,    BANDS.f2Mid.hi)

    // Overall RMS (wideband) for jaw
    const sliceLen = freqToBin(8000)
    let sqSum = 0
    for (let i = 0; i < sliceLen && i < this.buf.length; i++) {
      sqSum += (this.buf[i] / 255) ** 2
    }
    const rms = Math.sqrt(sqSum / sliceLen)

    this.onLevelChange?.(rms)

    // Gate: suppress output below noise floor
    const gate = voicing > 0.05 ? 1 : 0

    const clamp = (v: number) => Math.max(0, Math.min(1, v))

    const raw: VisemeWeights = {
      jawOpen:    clamp(rms * 2.5) * gate,
      // A: strong F1-low, moderate total energy
      Fcl_MTH_A: clamp(f1Low * 2.0 * gate),
      // E: mid F1-high, moderate F2
      Fcl_MTH_E: clamp((f1High * 1.5 + f2Mid * 0.5) * gate * (1 - f1Low * 0.8)),
      // I: high F2, low F1-low
      Fcl_MTH_I: clamp((f2Mid * 2.0) * gate * (1 - f1Low * 1.2)),
      // O: strong F1-low, suppressed F2
      Fcl_MTH_O: clamp(f1Low * 1.8 * (1 - f2Mid * 0.6) * gate),
      // U: low overall energy, narrow bandwidth → low-energy non-A, non-I
      Fcl_MTH_U: clamp((voicing - f1Low - f2Mid) * 1.5 * gate),
    }

    // EMA smoothing
    const α = this.smoothingAlpha
    for (const k of Object.keys(raw) as (keyof VisemeWeights)[]) {
      this.smoothed[k] = α * (this.smoothed[k] ?? 0) + (1 - α) * raw[k]
    }

    return { ...this.smoothed }
  }

  static async getDevices(): Promise<MediaDeviceInfo[]> {
    await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null)
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter(d => d.kind === 'audioinput')
  }
}
