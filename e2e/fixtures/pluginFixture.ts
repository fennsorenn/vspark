/**
 * Builds the backend's "hello" fixture plugin (packages/backend/test/fixtures)
 * into a temp folder and writes a config.json that loads it as a dev plugin,
 * so the e2e stack runs with one plugin: its Action kind, response type,
 * composite and account provider are on screen. Synchronous because the
 * Playwright config needs the paths before it starts the servers.
 *
 * The registry list points at an address that refuses connections, so the
 * suite never fetches the official registry from the internet.
 */
import { cpSync, mkdtempSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(REPO, 'packages', 'backend', 'test', 'fixtures', 'plugins', 'hello');

export function preparePluginFixture(): { configPath: string; pluginsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'vspark-e2e-plugins-'));
  const dev = join(root, 'hello');
  cpSync(SRC, dev, { recursive: true, filter: (p) => !p.includes(`${join('hello', 'src')}`) });
  const req = createRequire(join(REPO, 'packages', 'backend', 'package.json'));
  // esbuild comes from the backend package (e2e has no build tools of its own).
  const { buildSync } = req('esbuild') as {
    buildSync(opts: Record<string, unknown>): unknown;
  };
  for (const entry of ['backend', 'shared'])
    buildSync({
      entryPoints: [join(SRC, 'src', `${entry}.ts`)],
      outfile: join(dev, `${entry}.mjs`),
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      logLevel: 'silent',
    });
  const configPath = join(root, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      channel: 'stable',
      plugins: { dev: [dev], registries: [{ url: 'https://127.0.0.1:9/registry.json', trusted: false }] },
    })
  );
  return { configPath, pluginsDir: join(root, 'installed') };
}
