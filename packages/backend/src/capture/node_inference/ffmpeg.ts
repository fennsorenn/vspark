/**
 * Raw device capture via an ffmpeg subprocess.
 *
 * The Node inference provider needs pixels and PCM without a browser. ffmpeg is used
 * rather than a native npm capture addon on purpose: it adds no dependency to the
 * single-`bundle.cjs` release, and it is the one capture path that works the same way on
 * Windows (dshow), Linux (v4l2) and macOS (avfoundation).
 *
 * Device identifiers here are **platform-native**, not browser deviceIds. Browser device
 * ids are origin-and-profile salted and meaningless outside the browser, so the two
 * providers necessarily name devices differently — see `listDevices()` on each.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

export function ffmpegBinary(): string {
  return process.env.VSPARK_FFMPEG || 'ffmpeg';
}

function videoInputArgs(deviceId?: string): string[] {
  switch (process.platform) {
    case 'win32':
      return ['-f', 'dshow', '-i', `video=${deviceId ?? 'default'}`];
    case 'darwin':
      return ['-f', 'avfoundation', '-framerate', '30', '-i', `${deviceId ?? '0'}:none`];
    default:
      return ['-f', 'v4l2', '-i', deviceId ?? '/dev/video0'];
  }
}

function audioInputArgs(deviceId?: string): string[] {
  switch (process.platform) {
    case 'win32':
      return ['-f', 'dshow', '-i', `audio=${deviceId ?? 'default'}`];
    case 'darwin':
      return ['-f', 'avfoundation', '-i', `none:${deviceId ?? '0'}`];
    default:
      return ['-f', 'alsa', '-i', deviceId ?? 'default'];
  }
}

export interface VideoStreamOptions {
  width: number;
  height: number;
  fps: number;
  deviceId?: string;
}

/**
 * Emits tightly-packed RGB24 frames of exactly `width * height * 3` bytes.
 *
 * ffmpeg's stdout arrives in arbitrary chunks, so frames are reassembled here rather than
 * assuming one chunk per frame — that assumption is the classic source of frames that
 * "work" at low resolution and tear at high.
 */
export function openVideoStream(
  opts: VideoStreamOptions,
  onFrame: (rgb: Buffer) => void,
  onError: (err: Error) => void
): { close: () => void; process: ChildProcessWithoutNullStreams } {
  const frameBytes = opts.width * opts.height * 3;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    ...videoInputArgs(opts.deviceId),
    '-vf',
    // The selfie mirror the whole downstream pipeline assumes — MediaPipe's handedness
    // classifier, the pose left/right convention and the head frame are all written for
    // it, matching CameraCapture._drawMirror in the browser path.
    `hflip,scale=${opts.width}:${opts.height},fps=${opts.fps}`,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  ];

  const proc = spawn(ffmpegBinary(), args);
  let buf: Buffer = Buffer.alloc(0);

  proc.stdout.on('data', (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    while (buf.length >= frameBytes) {
      onFrame(buf.subarray(0, frameBytes));
      buf = buf.subarray(frameBytes);
    }
  });

  let stderr = '';
  proc.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  proc.on('error', (e) =>
    onError(new Error(`ffmpeg (video) failed to start: ${e.message}`))
  );
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null)
      onError(new Error(`ffmpeg (video) exited ${code}: ${stderr.trim()}`));
  });

  return {
    close: () => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
    process: proc,
  };
}

export interface AudioStreamOptions {
  sampleRate: number;
  /** Samples per analysis frame — must match the MFCC fftSize. */
  frameSize: number;
  deviceId?: string;
}

/** Emits mono float32 analysis frames of exactly `frameSize` samples. */
export function openAudioStream(
  opts: AudioStreamOptions,
  onFrame: (samples: Float32Array) => void,
  onError: (err: Error) => void
): { close: () => void; process: ChildProcessWithoutNullStreams } {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    ...audioInputArgs(opts.deviceId),
    '-ac',
    '1',
    '-ar',
    String(opts.sampleRate),
    '-f',
    'f32le',
    '-',
  ];

  const proc = spawn(ffmpegBinary(), args);
  const frameBytes = opts.frameSize * 4;
  let buf: Buffer = Buffer.alloc(0);

  proc.stdout.on('data', (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    while (buf.length >= frameBytes) {
      const slice = buf.subarray(0, frameBytes);
      // Copy: the Float32Array must not alias a Buffer we're about to discard, and the
      // consumer holds onto it past this tick.
      const samples = new Float32Array(opts.frameSize);
      for (let i = 0; i < opts.frameSize; i++) samples[i] = slice.readFloatLE(i * 4);
      onFrame(samples);
      buf = buf.subarray(frameBytes);
    }
  });

  let stderr = '';
  proc.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  proc.on('error', (e) =>
    onError(new Error(`ffmpeg (audio) failed to start: ${e.message}`))
  );
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null)
      onError(new Error(`ffmpeg (audio) exited ${code}: ${stderr.trim()}`));
  });

  return {
    close: () => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
    process: proc,
  };
}

/** True if the configured ffmpeg binary can be executed. */
export async function probeFfmpeg(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegBinary(), ['-hide_banner', '-version']);
    let out = '';
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.on('error', (e) =>
      resolve({
        ok: false,
        detail: `ffmpeg not runnable (${e.message}); set VSPARK_FFMPEG to its path`,
      })
    );
    proc.on('exit', (code) =>
      resolve(
        code === 0
          ? { ok: true, detail: out.split('\n')[0] ?? 'ffmpeg' }
          : { ok: false, detail: `ffmpeg -version exited ${code}` }
      )
    );
  });
}
