// Electron runtime for the OBS output windows.
//
// From source, Electron comes from node_modules (@vspark/output-window).
// The packaged release does not ship it (~100 MB): the first time a compose scene
// enables OBS window capture, the backend downloads the exact Electron build the
// bundle was made with from Electron's GitHub release, verifies its SHA-256
// against the checksums pinned at build time, and caches it next to the install
// (`runtime/`), where in-app updates leave it alone.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import extractZip from 'extract-zip';

export interface RuntimePaths {
  electronPath: string;
  mainScript: string;
}

/** Electron from node_modules when running from source; null in the packaged release. */
export function sourceRuntime(): RuntimePaths | null {
  try {
    const require = createRequire(import.meta.url);
    return require('@vspark/output-window') as RuntimePaths;
  } catch {
    return null;
  }
}

/** Directory holding bundle.cjs (the install dir) when bundled. */
export const installDir = dirname(fileURLToPath(import.meta.url));

export function platformAsset(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): { zipName: string; exeRel: string } | null {
  if (arch !== 'x64' && arch !== 'arm64') return null;
  const zipName = `electron-v${version}-${platform}-${arch}.zip`;
  if (platform === 'win32') return { zipName, exeRel: 'electron.exe' };
  if (platform === 'linux') return { zipName, exeRel: 'electron' };
  if (platform === 'darwin')
    return { zipName, exeRel: 'Electron.app/Contents/MacOS/Electron' };
  return null;
}

/** Written into the runtime dir only after a verified, complete extraction. */
const VERIFIED_MARKER = '.vspark-verified';

export interface DownloadOptions {
  version: string;
  checksums: Record<string, string>;
  /** Parent dir for cached runtimes (e.g. `<install>/runtime`). */
  cacheDir: string;
  /** The output-window Electron main script shipped with the release. */
  mainScript: string;
  onProgress?: (fraction: number) => void;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  extract?: (zipPath: string, targetDir: string) => Promise<void>;
}

export async function ensureDownloadedRuntime(
  opts: DownloadOptions
): Promise<RuntimePaths> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const asset = platformAsset(opts.version, platform, arch);
  if (!asset) throw new Error(`OBS window capture is not supported on ${platform}-${arch}`);
  if (!existsSync(opts.mainScript))
    throw new Error(`output-window script missing: ${opts.mainScript}`);

  const dir = join(opts.cacheDir, `electron-v${opts.version}-${platform}-${arch}`);
  const electronPath = join(dir, asset.exeRel);
  if (existsSync(join(dir, VERIFIED_MARKER)) && existsSync(electronPath)) {
    return { electronPath, mainScript: opts.mainScript };
  }

  const expected = opts.checksums[asset.zipName];
  if (!expected) throw new Error(`no pinned checksum for ${asset.zipName}`);

  mkdirSync(opts.cacheDir, { recursive: true });
  const zipPath = join(opts.cacheDir, `${asset.zipName}.download`);
  const staging = `${dir}.staging`;
  try {
    const url = `https://github.com/electron/electron/releases/download/v${opts.version}/${asset.zipName}`;
    const res = await (opts.fetchImpl ?? fetch)(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = createHash('sha256');
    const out = createWriteStream(zipPath);
    let received = 0;
    let lastReport = -1;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      received += chunk.byteLength;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      if (total > 0) {
        const pct = Math.floor((received / total) * 100);
        if (pct !== lastReport) {
          lastReport = pct;
          opts.onProgress?.(received / total);
        }
      }
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    const actual = hash.digest('hex');
    if (actual !== expected) {
      throw new Error(`checksum mismatch for ${asset.zipName} (expected ${expected}, got ${actual})`);
    }

    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    await (opts.extract ?? ((zip, target) => extractZip(zip, { dir: target })))(zipPath, staging);
    if (!existsSync(join(staging, asset.exeRel)))
      throw new Error(`runtime archive did not contain ${asset.exeRel}`);
    writeFileSync(join(staging, VERIFIED_MARKER), `${asset.zipName} ${expected}\n`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
    return { electronPath, mainScript: opts.mainScript };
  } finally {
    rmSync(zipPath, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}
