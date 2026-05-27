import { Router } from 'express';
import https from 'https';
import http from 'http';
import { createWriteStream, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import type { WSSync } from '../ws/index.js';
import type { UpdateStatus, UpdateChannel } from '@vspark/shared';

const GITHUB_REPO = 'fennsorenn/vspark';
const DOWNLOAD_PATH = join(tmpdir(), 'vspark-update.zip');

let _status: UpdateStatus = {
  updateAvailable: false,
  downloadReady: false,
  currentVersion: 'dev',
  latestVersion: null,
  releaseNotes: null,
  channel: 'stable',
};
let _downloadPath: string | null = null;
let _latestAssetUrl: string | null = null;
let _wsSync: WSSync | null = null;
let _installDir: string = process.cwd();

// ─── helpers ────────────────────────────────────────────────────────────────

export function getInstallDir(): string {
  const execDir = dirname(process.execPath);
  return existsSync(join(execDir, 'version.json')) ? execDir : process.cwd();
}

async function readVersionJson(
  installDir: string
): Promise<{ version: string; channel: UpdateChannel }> {
  try {
    const raw = await readFile(join(installDir, 'version.json'), 'utf-8');
    return JSON.parse(raw) as { version: string; channel: UpdateChannel };
  } catch {
    return { version: 'dev', channel: 'stable' };
  }
}

function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/, '').split('-');
    const [major, minor, patch] = (main ?? '0').split('.').map(Number);
    return {
      major: major ?? 0,
      minor: minor ?? 0,
      patch: patch ?? 0,
      pre: pre ?? null,
    };
  };
  const pa = parse(a),
    pb = parse(b);
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  // no pre-release > has pre-release (stable > beta)
  if (pa.pre === null && pb.pre !== null) return 1;
  if (pa.pre !== null && pb.pre === null) return -1;
  if (pa.pre !== null && pb.pre !== null) return pa.pre > pb.pre ? 1 : -1;
  return 0;
}

function httpsGet(
  url: string,
  headers: Record<string, string>
): Promise<import('http').IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod
      .get(url, { headers }, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          resolve(httpsGet(res.headers.location, headers));
        } else {
          resolve(res);
        }
      })
      .on('error', reject);
  });
}

function fetchJson(url: string, userAgent: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    httpsGet(url, {
      'User-Agent': userAgent,
      Accept: 'application/vnd.github+json',
    })
      .then((res) => {
        let data = '';
        res.on('data', (c: Buffer) => {
          data += c.toString();
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .catch(reject);
  });
}

type GhRelease = {
  tag_name: string;
  prerelease: boolean;
  body: string;
  published_at: string;
  assets: { name: string; browser_download_url: string }[];
};

function pickRelease(
  releases: GhRelease[],
  channel: UpdateChannel
): GhRelease | null {
  if (channel === 'stable') {
    return (
      releases.find(
        (r) => !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name)
      ) ?? null
    );
  }
  if (channel === 'recent') {
    const beta = releases.find(
      (r) => r.prerelease && /^v\d+\.\d+\.\d+-beta\.\d+$/.test(r.tag_name)
    );
    if (beta) return beta;
    return (
      releases.find(
        (r) => !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name)
      ) ?? null
    );
  }
  // experimental — latest by published_at (releases are already sorted newest-first from GitHub)
  return releases[0] ?? null;
}

export async function checkForUpdates(): Promise<void> {
  try {
    const config = await readVersionJson(_installDir);
    const channel = config.channel;
    _status.currentVersion = config.version;
    _status.channel = channel;

    const releases = (await fetchJson(
      `https://api.github.com/repos/${GITHUB_REPO}/releases`,
      `vspark/${config.version}`
    )) as GhRelease[];

    if (!Array.isArray(releases)) return;

    const candidate = pickRelease(releases, channel);
    if (!candidate) return;

    const candidateVersion = candidate.tag_name.replace(/^v/, '');
    const isNewer = compareSemver(candidateVersion, config.version) > 0;

    const platform = process.platform === 'win32' ? 'win-x64' : 'linux-x64';
    const asset = candidate.assets.find(
      (a) => a.name === `vspark-${platform}.zip`
    );

    _status.updateAvailable = isNewer;
    _status.latestVersion = candidateVersion;
    _status.releaseNotes = candidate.body ?? null;
    _latestAssetUrl = asset?.browser_download_url ?? null;
  } catch (err) {
    console.error('[update] check failed:', err);
  }
}

// ─── init ────────────────────────────────────────────────────────────────────

export function initUpdateChecker(installDir: string, wsSync: WSSync): void {
  _installDir = installDir;
  _wsSync = wsSync;
  void checkForUpdates();
}

// ─── routes ──────────────────────────────────────────────────────────────────

export const updateRoutes = Router();

updateRoutes.get('/update-status', (_req, res) => {
  res.json({ ok: true, data: _status });
});

updateRoutes.post('/update/download', (_req, res) => {
  if (!_status.updateAvailable) {
    res
      .status(400)
      .json({ ok: false, error: { message: 'No update available' } });
    return;
  }
  if (!_latestAssetUrl) {
    res
      .status(400)
      .json({
        ok: false,
        error: { message: 'No asset URL for this platform' },
      });
    return;
  }

  res.json({ ok: true, data: { started: true } });

  // Stream download in background (follows redirects — GitHub asset URLs redirect to S3)
  httpsGet(_latestAssetUrl, {
    'User-Agent': `vspark/${_status.currentVersion}`,
  })
    .then((fileRes) => {
      const dest = createWriteStream(DOWNLOAD_PATH);
      fileRes.pipe(dest);
      dest.on('finish', () => {
        _downloadPath = DOWNLOAD_PATH;
        _status.downloadReady = true;
      });
      dest.on('error', (e) =>
        console.error('[update] download write error:', e)
      );
    })
    .catch((e) => console.error('[update] download fetch error:', e));
});

updateRoutes.post('/update/apply', (_req, res) => {
  if (!_downloadPath || !_status.downloadReady) {
    res
      .status(400)
      .json({ ok: false, error: { message: 'Download not ready' } });
    return;
  }

  _wsSync?.broadcast('server_update', { reloadOnReconnect: true });
  res.json({ ok: true, data: { ok: true } });

  const isWin = process.platform === 'win32';
  const updaterName = isWin ? 'updater.bat' : 'updater.sh';
  const updaterPath = join(_installDir, updaterName);
  const parentDir = dirname(_installDir);

  setTimeout(() => {
    const child = spawn(
      updaterPath,
      [String(process.pid), _downloadPath!, parentDir],
      {
        detached: true,
        stdio: 'ignore',
        shell: isWin,
      }
    );
    child.unref();
    process.exit(0);
  }, 500);
});
