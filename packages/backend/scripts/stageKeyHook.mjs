#!/usr/bin/env node
/**
 * Stage the global keyboard hook into a release directory.
 *
 *   node packages/backend/scripts/stageKeyHook.mjs <releaseDir> <platform>
 *
 * `node-global-key-listener` cannot be inlined into bundle.cjs (it spawns a
 * per-platform key-server binary resolved relative to its own package dir), so
 * bundle.mjs marks it external and the HotkeyManager loads it with a guarded
 * `import()`. Node resolves that import from bundle.cjs's directory, so the
 * package has to sit in `<releaseDir>/node_modules/` — without it, `system_hotkey`
 * nodes silently never fire in a packaged release.
 *
 * Copies the package and its one dependency (`sudo-prompt`), keeps only the key
 * server for `<platform>` (`win-*`, `linux-*`, `darwin-*`), and marks it
 * executable: the library only falls back to a sudo prompt to `chmod +x` the
 * binary when spawning it fails, so shipping it executable means no prompt.
 */
import { chmodSync, cpSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_FOR = { win: 'WinKeyServer.exe', linux: 'X11KeyServer', darwin: 'MacKeyServer' };

const [releaseDir, platform] = process.argv.slice(2);
const os = platform?.split('-')[0];
if (!releaseDir || !(os in SERVER_FOR)) {
  console.error(
    'usage: stageKeyHook.mjs <releaseDir> <platform>  (platform: win-*, linux-*, darwin-*)'
  );
  process.exit(2);
}

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = (name, from) =>
  dirname(createRequire(join(from, 'package.json')).resolve(`${name}/package.json`));

const hookSrc = pkgDir('node-global-key-listener', backendDir);
const sudoSrc = pkgDir('sudo-prompt', hookSrc);
const modules = join(resolve(releaseDir), 'node_modules');

for (const [name, src] of [
  ['node-global-key-listener', hookSrc],
  ['sudo-prompt', sudoSrc],
]) {
  const dest = join(modules, name);
  rmSync(dest, { recursive: true, force: true });
  // pnpm links packages out of its store — copy the real files, not the links.
  cpSync(src, dest, { recursive: true, dereference: true });
}

const binDir = join(modules, 'node-global-key-listener', 'bin');
const keep = SERVER_FOR[os];
for (const f of readdirSync(binDir)) if (f !== keep) rmSync(join(binDir, f));
const server = join(binDir, keep);
if (os !== 'win') chmodSync(server, 0o755);

console.log(
  `[stageKeyHook] ${platform}: node-global-key-listener + sudo-prompt → ${modules} ` +
    `(${keep}, ${(statSync(server).size / 1e6).toFixed(1)} MB)`
);
