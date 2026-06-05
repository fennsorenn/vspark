import { Router } from 'express';
import https from 'https';
import http from 'http';
import { createWriteStream, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import type { WSSync } from '../ws/index.js';
import type { UpdateStatus, UpdateChannel } from '@vspark/shared';

const GITHUB_REPO = 'fennsorenn/vspark';

/**
 * Exit code that signals the supervising start script (start.sh / start.bat)
 * to apply the downloaded update and relaunch in the same console, instead of
 * shutting down. Any other exit code is treated as a normal stop. Must match
 * the start scripts generated in .github/workflows/release.yml.
 */
const UPDATE_EXIT_CODE = 42;

let _status: UpdateStatus = {
  updateAvailable: false,
  downloadReady: false,
  downloadedBytes: null,
  totalBytes: null,
  currentVersion: 'dev',
  latestVersion: null,
  releaseNotes: null,
  channel: 'stable',
};
let _downloadPath: string | null = null;
let _latestAssetUrl: string | null = null;
let _wsSync: WSSync | null = null;
let _installDir: string = process.cwd();

/**
 * Where the update zip is downloaded. Sits next to the install dir (i.e. in the
 * parent that contains the `vspark/` folder) so the start script can find it at
 * a predictable path without having to agree with Node on the OS temp dir.
 */
function downloadZipPath(): string {
  return join(dirname(_installDir), 'vspark-update.zip');
}

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

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

  const target = downloadZipPath();
  _status.downloadReady = false;
  _status.downloadedBytes = 0;
  _status.totalBytes = null;

  // Stream download in background (follows redirects — GitHub asset URLs redirect to S3)
  httpsGet(_latestAssetUrl, {
    'User-Agent': `vspark/${_status.currentVersion}`,
  })
    .then((fileRes) => {
      const total = Number(fileRes.headers['content-length']) || null;
      _status.totalBytes = total;

      let received = 0;
      let lastLoggedPct = -1;
      fileRes.on('data', (chunk: Buffer) => {
        received += chunk.length;
        _status.downloadedBytes = received;
        // Throttle console output to whole-percent steps (or per-MB if size unknown).
        if (total) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastLoggedPct) {
            lastLoggedPct = pct;
            console.log(
              `[update] downloading ${pct}% (${formatMB(received)} / ${formatMB(total)})`
            );
          }
        } else {
          const mb = Math.floor(received / (1024 * 1024));
          if (mb !== lastLoggedPct) {
            lastLoggedPct = mb;
            console.log(`[update] downloading ${formatMB(received)}`);
          }
        }
      });

      const dest = createWriteStream(target);
      fileRes.pipe(dest);
      dest.on('finish', () => {
        _downloadPath = target;
        _status.downloadReady = true;
        console.log(`[update] download complete: ${target}`);
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

  // Hand control back to the supervising start script: exit with the sentinel
  // code so it applies the downloaded zip and relaunches us in the same
  // console. The zip is already at downloadZipPath(), which the script reads.
  // Small delay so the HTTP response and WS broadcast flush before we exit.
  setTimeout(() => {
    console.log('[update] applying update and relaunching…');
    process.exit(UPDATE_EXIT_CODE);
  }, 500);
});
