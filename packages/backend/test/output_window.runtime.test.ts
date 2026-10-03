import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDownloadedRuntime, platformAsset } from '../src/output_window/runtime.js';

const VERSION = '44.5.1';
const ZIP = `electron-v${VERSION}-win32-x64.zip`;
const BYTES = new TextEncoder().encode('pretend this is an electron zip');
const SHA = createHash('sha256').update(BYTES).digest('hex');

function fakeFetch(body = BYTES) {
  return vi.fn(async () =>
    new Response(new Blob([body]).stream(), {
      status: 200,
      headers: { 'content-length': String(body.byteLength) },
    })
  ) as unknown as typeof fetch;
}

describe('platformAsset', () => {
  it('maps platforms to the Electron release asset and executable', () => {
    expect(platformAsset(VERSION, 'win32', 'x64')).toEqual({ zipName: ZIP, exeRel: 'electron.exe' });
    expect(platformAsset(VERSION, 'linux', 'arm64')?.exeRel).toBe('electron');
    expect(platformAsset(VERSION, 'darwin', 'x64')?.exeRel).toBe('Electron.app/Contents/MacOS/Electron');
    expect(platformAsset(VERSION, 'linux', 'ia32')).toBeNull();
    expect(platformAsset(VERSION, 'aix', 'x64')).toBeNull();
  });
});

describe('ensureDownloadedRuntime', () => {
  let root: string;
  let mainScript: string;
  const base = () => ({
    version: VERSION,
    checksums: { [ZIP]: SHA },
    cacheDir: join(root, 'runtime'),
    mainScript,
    platform: 'win32' as const,
    arch: 'x64',
  });
  const extractOk = async (_zip: string, dir: string) => writeFileSync(join(dir, 'electron.exe'), 'exe');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vspark-runtime-'));
    mainScript = join(root, 'main.cjs');
    writeFileSync(mainScript, '// main');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('downloads, verifies, extracts and reports progress; later calls hit the cache', async () => {
    const fetchImpl = fakeFetch();
    const progress: number[] = [];
    const paths = await ensureDownloadedRuntime({ ...base(), fetchImpl, extract: extractOk, onProgress: (f) => progress.push(f) });
    const dir = join(root, 'runtime', `electron-v${VERSION}-win32-x64`);
    expect(paths).toEqual({ electronPath: join(dir, 'electron.exe'), mainScript });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      `https://github.com/electron/electron/releases/download/v${VERSION}/${ZIP}`
    );
    expect(progress.at(-1)).toBe(1);
    expect(readdirSync(join(root, 'runtime'))).toEqual([`electron-v${VERSION}-win32-x64`]); // no leftovers

    const again = fakeFetch();
    await ensureDownloadedRuntime({ ...base(), fetchImpl: again, extract: extractOk });
    expect(again).not.toHaveBeenCalled();
  });

  it('rejects a download whose checksum does not match and leaves nothing behind', async () => {
    await expect(
      ensureDownloadedRuntime({ ...base(), fetchImpl: fakeFetch(new TextEncoder().encode('tampered')), extract: extractOk })
    ).rejects.toThrow(/checksum mismatch/);
    expect(readdirSync(join(root, 'runtime'))).toEqual([]);
  });

  it('does not trust a partial cache without the verified marker', async () => {
    const dir = join(root, 'runtime', `electron-v${VERSION}-win32-x64`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'electron.exe'), 'half-extracted');
    const fetchImpl = fakeFetch();
    await ensureDownloadedRuntime({ ...base(), fetchImpl, extract: extractOk });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, '.vspark-verified'))).toBe(true);
  });

  it('fails clearly on HTTP errors, unpinned assets, unsupported platforms and a missing script', async () => {
    const http404 = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    await expect(ensureDownloadedRuntime({ ...base(), fetchImpl: http404 })).rejects.toThrow(/HTTP 404/);
    await expect(ensureDownloadedRuntime({ ...base(), checksums: {} })).rejects.toThrow(/no pinned checksum/);
    await expect(ensureDownloadedRuntime({ ...base(), platform: 'aix' })).rejects.toThrow(/not supported/);
    await expect(ensureDownloadedRuntime({ ...base(), mainScript: join(root, 'nope.cjs') })).rejects.toThrow(/script missing/);
  });

  it('fails when the archive lacks the executable', async () => {
    await expect(
      ensureDownloadedRuntime({ ...base(), fetchImpl: fakeFetch(), extract: async () => {} })
    ).rejects.toThrow(/did not contain electron.exe/);
  });
});
