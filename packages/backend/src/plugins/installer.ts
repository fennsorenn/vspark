/**
 * Downloads, verifies and unpacks plugin release zips into the plugins dir.
 * The zip's SHA-256 must equal the registry's before anything is unpacked,
 * and its plugin.json must name the expected id and version.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import extract from 'extract-zip';
import { parseManifest } from './manifest.js';
import { pluginVersionDir, pluginsDir } from './paths.js';
import type { RegistryVersion } from './registry.js';

const MAX_ZIP_BYTES = 50 * 1024 * 1024;

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

/** Download `v` for plugin `id` and unpack it to `<plugins>/<id>/<version>/`.
 *  Returns that folder. An existing folder for the same version is replaced. */
export async function downloadAndUnpack(
  id: string,
  v: RegistryVersion,
  fetchImpl: typeof fetch = fetch,
  onProgress?: (received: number, total: number | null) => void
): Promise<string> {
  const res = await fetchImpl(v.url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new InstallError(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || null;
  if (total && total > MAX_ZIP_BYTES) throw new InstallError('the plugin package is too large');
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    received += chunk.byteLength;
    if (received > MAX_ZIP_BYTES) throw new InstallError('the plugin package is too large');
    chunks.push(Buffer.from(chunk));
    onProgress?.(received, total);
  }
  const zip = Buffer.concat(chunks);
  const sha = createHash('sha256').update(zip).digest('hex');
  if (sha !== v.sha256.toLowerCase())
    throw new InstallError(`checksum mismatch (expected ${v.sha256}, got ${sha}) — the package was not installed`);

  mkdirSync(pluginsDir(), { recursive: true });
  const tmp = mkdtempSync(join(pluginsDir(), `.tmp-${id}-`));
  try {
    const zipPath = join(tmp, 'package.zip');
    writeFileSync(zipPath, zip);
    const out = join(tmp, 'pkg');
    await extract(zipPath, { dir: out });
    const manifest = parseManifest(JSON.parse(readFileSync(join(out, 'plugin.json'), 'utf8')));
    if (manifest.id !== id || manifest.version !== v.version)
      throw new InstallError(
        `the package is ${manifest.id} ${manifest.version}, expected ${id} ${v.version}`
      );
    const dest = pluginVersionDir(id, v.version);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(join(dest, '..'), { recursive: true });
    renameSync(out, dest);
    return dest;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Remove one installed version folder (or the whole plugin, data included,
 *  when `version` is omitted). */
export function removeInstalled(id: string, version?: string): void {
  const dir = version ? pluginVersionDir(id, version) : join(pluginsDir(), id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
