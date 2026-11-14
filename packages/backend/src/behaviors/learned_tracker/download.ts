import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import extractZip from 'extract-zip';
import { getInstallDir } from '../../routes/update.js';

/**
 * The Learned Tracking runtime as a download: the motiontracker release this
 * vspark version was tested with, pinned here (version + SHA-256) and updated
 * together with vspark. The release asset holds the runtime's source (`core/`,
 * `service/`) and its models; `uv` still builds the Python environment on first
 * start. It is cached next to the install (`runtime/`, like the output windows'
 * Electron), where in-app updates leave it alone.
 */
export const MOTIONTRACKER_RUNTIME = {
  version: 'v0.1.0',
  asset: 'motiontracker-runtime-v0.1.0.zip',
  sha256: 'c6b33c080937e1921cdafe30a5c0d7be3884adee2cf8caa344dfc98dcf6e0a1e',
  /** Download size, for the UI before the download starts. */
  bytes: 18254834,
  /** Top-level folder inside the zip. */
  folder: 'motiontracker-v0.1.0',
  repo: 'fennsorenn/motiontracker',
} as const;

export type PinnedRuntime = {
  version: string;
  asset: string;
  sha256: string;
  bytes: number;
  folder: string;
  repo: string;
};

/** Written into the runtime dir only after a verified, complete extraction. */
const VERIFIED_MARKER = '.vspark-verified';

export function runtimeCacheDir(): string {
  return process.env.VSPARK_RUNTIME_DIR ?? join(getInstallDir(), 'runtime');
}

/** Where the pinned runtime lives once downloaded (whether or not it is yet). */
export function downloadedRuntimeDir(
  pin: PinnedRuntime = MOTIONTRACKER_RUNTIME,
  cacheDir = runtimeCacheDir()
): string {
  return join(cacheDir, pin.folder);
}

export function isDownloaded(
  pin: PinnedRuntime = MOTIONTRACKER_RUNTIME,
  cacheDir = runtimeCacheDir()
): boolean {
  const dir = downloadedRuntimeDir(pin, cacheDir);
  return (
    existsSync(join(dir, VERIFIED_MARKER)) &&
    existsSync(join(dir, 'service', 'pyproject.toml'))
  );
}

export interface DownloadOptions {
  pin?: PinnedRuntime;
  cacheDir?: string;
  onProgress?: (fraction: number) => void;
  fetchImpl?: typeof fetch;
  extract?: (zipPath: string, targetDir: string) => Promise<void>;
}

/** Download, verify and unpack the pinned runtime (no-op when it is already
 *  there). Returns its directory. */
export async function ensureLearnedRuntime(
  opts: DownloadOptions = {}
): Promise<string> {
  const pin = opts.pin ?? MOTIONTRACKER_RUNTIME;
  const cacheDir = opts.cacheDir ?? runtimeCacheDir();
  const dir = downloadedRuntimeDir(pin, cacheDir);
  if (isDownloaded(pin, cacheDir)) return dir;

  mkdirSync(cacheDir, { recursive: true });
  const zipPath = join(cacheDir, `${pin.asset}.download`);
  const staging = `${dir}.staging`;
  try {
    const url = `https://github.com/${pin.repo}/releases/download/${pin.version}/${pin.asset}`;
    const res = await (opts.fetchImpl ?? fetch)(url, { redirect: 'follow' });
    if (!res.ok || !res.body)
      throw new Error(`download failed: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || pin.bytes;
    const hash = createHash('sha256');
    const out = createWriteStream(zipPath);
    let received = 0;
    let lastReport = -1;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      received += chunk.byteLength;
      if (!out.write(chunk))
        await new Promise<void>((r) => out.once('drain', () => r()));
      const pct = Math.min(100, Math.floor((received / total) * 100));
      if (pct !== lastReport) {
        lastReport = pct;
        opts.onProgress?.(Math.min(1, received / total));
      }
    }
    await new Promise<void>((resolve, reject) =>
      out.end((e?: Error | null) => (e ? reject(e) : resolve()))
    );
    const actual = hash.digest('hex');
    if (actual !== pin.sha256)
      throw new Error(
        `checksum mismatch for ${pin.asset} (expected ${pin.sha256}, got ${actual})`
      );

    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    await (opts.extract ?? ((zip, target) => extractZip(zip, { dir: target })))(
      zipPath,
      staging
    );
    const unpacked = join(staging, pin.folder);
    if (!existsSync(join(unpacked, 'service', 'pyproject.toml')))
      throw new Error(`runtime archive did not contain ${pin.folder}/service`);
    writeFileSync(
      join(unpacked, VERIFIED_MARKER),
      `${pin.asset} ${pin.sha256}\n`
    );
    rmSync(dir, { recursive: true, force: true });
    renameSync(unpacked, dir);
    return dir;
  } finally {
    rmSync(zipPath, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

// ─── download state (one download at a time, shared by all behaviors) ─────────

export type DownloadState = 'idle' | 'downloading' | 'error';

export interface DownloadStatus {
  state: DownloadState;
  /** 0..1 while downloading. */
  progress?: number;
  message?: string;
}

let _status: DownloadStatus = { state: 'idle' };
let _running: Promise<string> | null = null;
const _installedListeners: Array<() => void> = [];

export function downloadStatus(): DownloadStatus {
  return _status;
}

/** Called after a download completes (e.g. restart the runtimes on it). */
export function onRuntimeInstalled(fn: () => void): void {
  _installedListeners.push(fn);
}

/** Start the download in the background (joins a running one). */
export function startRuntimeDownload(
  opts: DownloadOptions = {}
): Promise<string> {
  if (_running) return _running;
  _status = { state: 'downloading', progress: 0 };
  _running = ensureLearnedRuntime({
    ...opts,
    onProgress: (f) => {
      _status = { state: 'downloading', progress: f };
      opts.onProgress?.(f);
    },
  })
    .then((dir) => {
      _status = { state: 'idle' };
      for (const fn of _installedListeners) fn();
      return dir;
    })
    .catch((e: unknown) => {
      _status = {
        state: 'error',
        message: e instanceof Error ? e.message : String(e),
      };
      throw e;
    })
    .finally(() => {
      _running = null;
    });
  return _running;
}

/** Tests: forget state and listeners. */
export function _resetDownloadState(): void {
  _status = { state: 'idle' };
  _running = null;
  _installedListeners.length = 0;
}
