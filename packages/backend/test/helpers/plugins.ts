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
