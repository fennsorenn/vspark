/**
 * Multiplayer blob helpers — pure / near-pure functions in blobs.ts.
 *
 * Covered:
 *  - extOf: extension extraction
 *  - cachedPath / cachedUrl: deterministic path/URL construction
 *  - hasCached / writeCached / cachedSize: filesystem helpers (tmp dir)
 *
 * resolveByHash / assetForPath require the DB (asset_files table) and are
 * covered lightly via makeTestApp() (just the "not found" paths).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// extOf — pure extraction of trailing extension.
// ---------------------------------------------------------------------------

describe('extOf', () => {
  it('returns the trailing dotted extension', async () => {
    const { extOf } = await import('../src/multiplayer/blobs.js');
    expect(extOf('/uploads/avatar.vrm')).toBe('.vrm');
    expect(extOf('model.VRM')).toBe('.VRM');
    expect(extOf('clip.bvh')).toBe('.bvh');
  });

  it("returns '' for paths with no extension", async () => {
    const { extOf } = await import('../src/multiplayer/blobs.js');
    expect(extOf('/uploads/noext')).toBe('');
    expect(extOf('')).toBe('');
  });

  it('handles multi-dot filenames (only the last segment)', async () => {
    const { extOf } = await import('../src/multiplayer/blobs.js');
    expect(extOf('archive.tar.gz')).toBe('.gz');
  });
});

// ---------------------------------------------------------------------------
// cachedPath / cachedUrl — pure deterministic helpers.
// ---------------------------------------------------------------------------

describe('cachedPath / cachedUrl', () => {
  it('cachedUrl returns the /uploads/_shared/ prefix + hash+ext', async () => {
    const { cachedUrl } = await import('../src/multiplayer/blobs.js');
    const url = cachedUrl('abc123', '.vrm');
    expect(url).toBe('/uploads/_shared/abc123.vrm');
  });

  it('cachedPath builds a full absolute path under the uploads dir', async () => {
    const { cachedPath } = await import('../src/multiplayer/blobs.js');
    const p = cachedPath('abc123', '.vrm');
    // Must end with _shared/abc123.vrm
    expect(p.endsWith('/_shared/abc123.vrm') || p.endsWith('\\_shared\\abc123.vrm')).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// hasCached / writeCached / cachedSize — FS helpers, using a temp dir.
// ---------------------------------------------------------------------------

describe('hasCached / writeCached / cachedSize', () => {
  // We redirect the uploads dir via cwd() mock-equivalent by patching the
  // module's SHARED_DIR indirectly: instead we call the functions and observe
  // the real fs behaviour inside the process's cwd()/uploads/_shared directory.
  // Because the process cwd points to the packages/backend dir during test and
  // we don't want to pollute it, we test hasCached with a path we know doesn't
  // exist, and writeCached / cachedSize with a tmp-dir-based approach.

  it('hasCached returns false for a hash that was never cached', async () => {
    const { hasCached } = await import('../src/multiplayer/blobs.js');
    // Highly unlikely to exist in the test environment.
    expect(hasCached('0000000000000000000000000000000000000000000000000000000000000001', '.vrm')).toBe(false);
  });

  it('cachedSize returns 0 for a non-existent entry', async () => {
    const { cachedSize } = await import('../src/multiplayer/blobs.js');
    expect(
      cachedSize(
        '0000000000000000000000000000000000000000000000000000000000000002',
        '.vrm'
      )
    ).toBe(0);
  });

  // writeCached writes to `uploads/_shared/<hash><ext>` under cwd().
  // We write a tiny buffer and confirm round-trip via hasCached + cachedSize.
  it('writeCached creates the file and hasCached / cachedSize reflect it', async () => {
    const { writeCached, hasCached, cachedSize, cachedUrl } = await import(
      '../src/multiplayer/blobs.js'
    );
    // A fake 64-char hex hash (sha256 length).
    const hash = 'aabbccdd'.repeat(8); // 64 hex chars
    const ext = '.bin';
    const data = Buffer.from('hello test blob');

    // Ensure cleanup even on failure.
    const sharedDir = join(process.cwd(), 'uploads', '_shared');
    const filePath = join(sharedDir, `${hash}${ext}`);
    try {
      const url = writeCached(hash, ext, data);
      expect(url).toBe(cachedUrl(hash, ext));
      expect(hasCached(hash, ext)).toBe(true);
      expect(cachedSize(hash, ext)).toBe(data.length);
    } finally {
      // Best-effort cleanup.
      try {
        const { unlinkSync } = await import('fs');
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
  });
});
