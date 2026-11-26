/**
 * learned_tracker.download.test.ts
 *
 * The pinned Learned Tracking runtime download (behaviors/learned_tracker/download.ts), its place
 * in the runtime lookup order (runtime.ts learnedRuntimeLocation) and the routes that expose it.
 * Fetch and unzip are faked; the cache dir is a temp dir via VSPARK_RUNTIME_DIR.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import {
  MOTIONTRACKER_RUNTIME,
  _resetDownloadState,
  downloadStatus,
  ensureLearnedRuntime,
  isDownloaded,
  onRuntimeInstalled,
  startRuntimeDownload,
  type PinnedRuntime,
} from '../src/behaviors/learned_tracker/download.js';
import { learnedRuntimeLocation } from '../src/behaviors/learned_tracker/runtime.js';
import { makeTestApp } from './helpers/testApp.js';

const BYTES = new TextEncoder().encode('pretend this is the runtime zip');
const PIN: PinnedRuntime = {
  version: 'v9.9.9',
  asset: 'motiontracker-runtime-v9.9.9.zip',
  sha256: createHash('sha256').update(BYTES).digest('hex'),
  bytes: BYTES.byteLength,
  folder: 'motiontracker-v9.9.9',
  repo: 'someone/motiontracker',
};

function fakeFetch(body = BYTES, status = 200) {
  return vi.fn(
    async () =>
      new Response(new Blob([body]).stream(), {
        status,
        headers: { 'content-length': String(body.byteLength) },
      })
  ) as unknown as typeof fetch;
}

/** Unzip stand-in: lays out what the release zip holds. */
const extractOk =
  (folder = PIN.folder) =>
  async (_zip: string, dir: string) => {
    mkdirSync(join(dir, folder, 'service'), { recursive: true });
    writeFileSync(
      join(dir, folder, 'service', 'pyproject.toml'),
      '[project]\n'
    );
  };

describe('ensureLearnedRuntime', () => {
  let cache: string;
  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), 'vspark-learned-'));
  });
  afterEach(() => rmSync(cache, { recursive: true, force: true }));

  it('downloads the pinned asset, verifies, unpacks and reports progress; later calls hit the cache', async () => {
    const fetchImpl = fakeFetch();
    const progress: number[] = [];
    const dir = await ensureLearnedRuntime({
      pin: PIN,
      cacheDir: cache,
      fetchImpl,
      extract: extractOk(),
      onProgress: (f) => progress.push(f),
    });
    expect(dir).toBe(join(cache, PIN.folder));
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
    ).toBe(
      'https://github.com/someone/motiontracker/releases/download/v9.9.9/motiontracker-runtime-v9.9.9.zip'
    );
    expect(progress.at(-1)).toBe(1);
    expect(isDownloaded(PIN, cache)).toBe(true);
    expect(readdirSync(cache)).toEqual([PIN.folder]); // no zip or staging left behind

    const again = fakeFetch();
    await ensureLearnedRuntime({
      pin: PIN,
      cacheDir: cache,
      fetchImpl: again,
      extract: extractOk(),
    });
    expect(again).not.toHaveBeenCalled();
  });

  it('rejects a checksum mismatch and leaves nothing behind', async () => {
    await expect(
      ensureLearnedRuntime({
        pin: PIN,
        cacheDir: cache,
        fetchImpl: fakeFetch(new TextEncoder().encode('tampered')),
        extract: extractOk(),
      })
    ).rejects.toThrow(/checksum mismatch/);
    expect(isDownloaded(PIN, cache)).toBe(false);
    expect(readdirSync(cache)).toEqual([]);
  });

  it('rejects an HTTP error and an archive without the runtime', async () => {
    await expect(
      ensureLearnedRuntime({
        pin: PIN,
        cacheDir: cache,
        fetchImpl: fakeFetch(BYTES, 404),
        extract: extractOk(),
      })
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      ensureLearnedRuntime({
        pin: PIN,
        cacheDir: cache,
        fetchImpl: fakeFetch(),
        extract: extractOk('other'),
      })
    ).rejects.toThrow(/did not contain/);
    expect(isDownloaded(PIN, cache)).toBe(false);
  });
});

describe('startRuntimeDownload', () => {
  let cache: string;
  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), 'vspark-learned-'));
    _resetDownloadState();
  });
  afterEach(() => {
    _resetDownloadState();
    rmSync(cache, { recursive: true, force: true });
  });

  it('tracks state, joins a running download and notifies when installed', async () => {
    const installed = vi.fn();
    onRuntimeInstalled(installed);
    const fetchImpl = fakeFetch();
    const a = startRuntimeDownload({
      pin: PIN,
      cacheDir: cache,
      fetchImpl,
      extract: extractOk(),
    });
    const b = startRuntimeDownload({
      pin: PIN,
      cacheDir: cache,
      fetchImpl,
      extract: extractOk(),
    });
    expect(b).toBe(a);
    expect(downloadStatus().state).toBe('downloading');
    await a;
    expect(downloadStatus()).toEqual({ state: 'idle' });
    expect(installed).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a failure', async () => {
    await expect(
      startRuntimeDownload({
        pin: PIN,
        cacheDir: cache,
        fetchImpl: fakeFetch(BYTES, 500),
        extract: extractOk(),
      })
    ).rejects.toThrow();
    expect(downloadStatus().state).toBe('error');
    expect(downloadStatus().message).toMatch(/HTTP 500/);
  });
});

describe('runtime location', () => {
  let cache: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'VSPARK_MOTIONTRACKER_PATH',
    'VSPARK_RUNTIME_DIR',
    'VSPARK_CONFIG_PATH',
  ];
  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), 'vspark-learned-'));
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.VSPARK_MOTIONTRACKER_PATH;
    process.env.VSPARK_RUNTIME_DIR = cache;
    process.env.VSPARK_CONFIG_PATH = join(cache, 'no-config.json');
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(cache, { recursive: true, force: true });
  });

  it('uses the downloaded pinned runtime once it is there, ahead of a sibling checkout', () => {
    const before = learnedRuntimeLocation();
    expect(['checkout', 'missing']).toContain(before.source);
    const dir = join(cache, MOTIONTRACKER_RUNTIME.folder);
    // what a verified download leaves (the real pin's checksum can't match fake bytes)
    mkdirSync(join(dir, 'service'), { recursive: true });
    writeFileSync(join(dir, 'service', 'pyproject.toml'), '');
    writeFileSync(join(dir, '.vspark-verified'), 'test\n');
    expect(learnedRuntimeLocation()).toEqual({ dir, source: 'download' });
  });

  it('prefers an explicit path', () => {
    process.env.VSPARK_MOTIONTRACKER_PATH = cache;
    expect(learnedRuntimeLocation()).toEqual({ dir: cache, source: 'env' });
  });

  it('GET /api/learned-tracker/runtime reports the pinned version and source', async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get('/api/learned-tracker/runtime');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      version: MOTIONTRACKER_RUNTIME.version,
      bytes: MOTIONTRACKER_RUNTIME.bytes,
      downloaded: false,
      download: { state: 'idle' },
    });
    expect(['checkout', 'missing']).toContain(res.body.data.source);
    expect(existsSync(cache)).toBe(true);
  });
});
