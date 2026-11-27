import { build } from 'esbuild';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'plugins');

/**
 * Build a fixture plugin the way a plugin repo's build does (esbuild, ESM,
 * standard decorators, nothing of vspark bundled) into a fresh temp folder,
 * and return that folder — an unpacked plugin package.
 */
export async function buildFixturePlugin(name: string, into?: string): Promise<string> {
  const src = join(FIXTURES, name);
  const out = into ?? mkdtempSync(join(tmpdir(), `vspark-plugin-${name}-`));
  cpSync(src, out, { recursive: true, filter: (p) => !p.includes(`${name}/src`) });
  for (const entry of ['backend', 'shared'])
    await build({
      entryPoints: [join(src, 'src', `${entry}.ts`)],
      outfile: join(out, `${entry}.mjs`),
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      logLevel: 'silent',
    });
  return out;
}

/** Zip a built plugin folder the way a plugin repo's `pnpm package` does;
 *  returns the zip bytes and their SHA-256. */
export async function zipPlugin(dir: string): Promise<{ zip: Buffer; sha256: string }> {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { relative } = await import('node:path');
  const { zipSync } = await import('fflate');
  const { createHash } = await import('node:crypto');
  const files: Record<string, Uint8Array> = {};
  (function walk(d: string) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(dir, p).split('\\').join('/')] = readFileSync(p);
    }
  })(dir);
  const zip = Buffer.from(zipSync(files));
  return { zip, sha256: createHash('sha256').update(zip).digest('hex') };
}
