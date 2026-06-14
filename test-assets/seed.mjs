#!/usr/bin/env node
// Test-asset seeder. Downloads a small set of avatar + animation fixtures (kept
// OUT of git — see README.md) and optionally drops them into a project's uploads
// folder so the backend auto-discovers them.
//
//   node test-assets/seed.mjs                       # download into .cache/
//   node test-assets/seed.mjs --project <projectId> # + copy into the backend's
//                                                    #   uploads/<projectId>/…
//   node test-assets/seed.mjs --into <dir>          # + copy into an arbitrary dir
//
// Sources & licenses are documented in test-assets/README.md.

import { createWriteStream } from 'node:fs';
import { mkdir, copyFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:https';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '.cache');
const REPO_ROOT = join(HERE, '..');

// subfolder → matches the backend's SUBFOLDER_BY_EXT (.vrm → avatars, .fbx → animations)
const ASSETS = [
  {
    sub: 'avatars',
    file: 'AvatarSample_A.vrm',
    url: 'https://raw.githubusercontent.com/madjin/vrm-samples/master/vroid/stable/AvatarSample_A.vrm',
  },
  {
    sub: 'avatars',
    file: 'AvatarSample_B.vrm',
    url: 'https://raw.githubusercontent.com/madjin/vrm-samples/master/vroid/stable/AvatarSample_B.vrm',
  },
  {
    sub: 'avatars',
    file: 'AvatarSample_C.vrm',
    url: 'https://raw.githubusercontent.com/madjin/vrm-samples/master/vroid/stable/AvatarSample_C.vrm',
  },
  {
    // Mixamo-rigged (mixamorig:* bones) → compatible with the FBX→VRM retargeter.
    sub: 'animations',
    file: 'SambaDancing.fbx',
    url: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/fbx/Samba%20Dancing.fbx',
  },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { 'User-Agent': 'vspark-seed' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function exists(p) {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const projectId = arg('--project');
  const into = arg('--into');
  const targets = [];
  if (projectId)
    targets.push(join(REPO_ROOT, 'packages/backend/uploads', projectId));
  if (into) targets.push(into);

  for (const a of ASSETS) {
    const cacheDir = join(CACHE, a.sub);
    await mkdir(cacheDir, { recursive: true });
    const cached = join(cacheDir, a.file);
    if (await exists(cached)) {
      console.log(`✓ cached   ${a.sub}/${a.file}`);
    } else {
      process.stdout.write(`↓ download ${a.sub}/${a.file} … `);
      await download(a.url, cached);
      const { size } = await stat(cached);
      console.log(`${(size / 1048576).toFixed(1)} MB`);
    }
    for (const t of targets) {
      const destDir = join(t, a.sub);
      await mkdir(destDir, { recursive: true });
      await copyFile(cached, join(destDir, a.file));
      console.log(`  → ${join(destDir, a.file)}`);
    }
  }
  console.log('\nDone. Open the project in the editor; assets are auto-discovered.');
}

main().catch((e) => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
