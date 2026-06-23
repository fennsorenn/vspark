/**
 * BlobManager — transport-framing and protocol logic.
 *
 * BlobManager is injected with a MeshTransport fake, so the full
 * request/begin/chunk/end/error and meta/meta_ok protocol can be exercised
 * without any live WebSocket, DB, or file I/O (the `writeCached` side is
 * stubbed by intercepting the hash-mismatch / success paths through
 * carefully crafted payloads that pass/fail the sha256 check).
 *
 * Notes on infra-bound behaviour:
 *  - `serve()` reads real files (`resolveByHash` + `readBlob`); those paths
 *    are not exercised here. The REQUEST dispatch is tested to the extent that
 *    a closed transport (sendEnvelope → false) triggers the error path.
 *  - writeCached (receiver side) writes to disk; we verify the hash-mismatch
 *    rejection path without touching the fs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SyncEnvelope } from '@vspark/shared/sync';

// ---------------------------------------------------------------------------
// Fake MeshTransport.
// ---------------------------------------------------------------------------

type EnvelopeCall = { participant: string; env: SyncEnvelope };

function makeTransport(sendResult = true) {
  const sent: EnvelopeCall[] = [];
  const streams: { participant: string; frame: Record<string, unknown> }[] = [];
  const transport = {
    sendEnvelope(participant: string, env: SyncEnvelope): boolean {
      sent.push({ participant, env });
      return sendResult;
    },
    sendStream(participant: string, frame: Record<string, unknown>): void {
      streams.push({ participant, frame });
    },
  };
  return { transport, sent, streams };
}

// ---------------------------------------------------------------------------
// Import helper (avoids ESM caching issues by using dynamic import here).
// ---------------------------------------------------------------------------

async function makeBlobManager(sendResult = true) {
  const { BlobManager } = await import('../src/multiplayer/blobTransfer.js');
  const { transport, sent, streams } = makeTransport(sendResult);
  const mgr = new BlobManager(transport);
  return { mgr, sent, streams };
}

// ---------------------------------------------------------------------------
// BLOB_RTYPES export.
// ---------------------------------------------------------------------------

describe('BLOB_RTYPES', () => {
  it('contains all expected protocol rtypes', async () => {
    const { BLOB_RTYPES } = await import('../src/multiplayer/blobTransfer.js');
    for (const r of [
      '_blob_request',
      '_blob_begin',
      '_blob_chunk',
      '_blob_end',
      '_blob_error',
      '_blob_meta',
      '_blob_meta_ok',
    ]) {
      expect(BLOB_RTYPES.has(r)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// ensure() — receiver side, transport closed (sendEnvelope → false).
// ---------------------------------------------------------------------------

describe('BlobManager.ensure (transport closed)', () => {
  it('rejects immediately when the channel is not open', async () => {
    const { mgr } = await makeBlobManager(false /* sendResult */);
    await expect(
      mgr.ensure('peer1', { hash: 'deadbeef', ext: '.vrm', mime: 'model/gltf-binary', size: 100 })
    ).rejects.toThrow('mesh channel not open');
  });
});

// ---------------------------------------------------------------------------
// ensure() — deduplication: concurrent requests for the same hash share one
//             in-flight promise.
// ---------------------------------------------------------------------------

describe('BlobManager.ensure — deduplication', () => {
  it('two concurrent ensure() calls for the same hash resolve from the same promise', async () => {
    const { mgr, sent } = await makeBlobManager(true);
    const meta = {
      hash: 'a'.repeat(64),
      ext: '.vrm',
      mime: 'model/gltf-binary',
      size: 10,
    };

    // Kick off two concurrent fetches — neither resolves yet.
    const p1 = mgr.ensure('peer1', meta);
    const p2 = mgr.ensure('peer1', meta);

    // Only one _blob_request should have been sent (deduped in-flight).
    const requests = sent.filter((s) => s.env.rtype === '_blob_request');
    expect(requests.length).toBe(1);

    // Simulate the blob transfer: begin → chunk → end.
    const buf = Buffer.from('fake vrm data');
    // We need the correct sha256 to pass the hash check — use crypto.
    const { createHash } = await import('crypto');
    const correctHash = createHash('sha256').update(buf).digest('hex');

    // Re-run with the correct hash so the file write path is invoked.
    // For this test, we only check that p1 === p2 in terms of promise identity
    // (or at least that they both settle the same way, which means deduplication
    // happened). We settle them with a failure to avoid touching the fs.
    mgr.handleEnvelope('peer1', {
      rtype: '_blob_error',
      op: 'event',
      key: meta.hash,
      data: { hash: meta.hash, message: 'not found' },
    });

    await expect(p1).rejects.toThrow('not found');
    await expect(p2).rejects.toThrow('not found');
  });
});

// ---------------------------------------------------------------------------
// handleEnvelope — BEGIN with oversized blob triggers a fail.
// ---------------------------------------------------------------------------

describe('BlobManager.handleEnvelope BEGIN — oversized blob', () => {
  it('rejects the in-flight promise when size exceeds the cap', async () => {
    const { mgr, sent } = await makeBlobManager(true);
    const meta = {
      hash: 'b'.repeat(64),
      ext: '.vrm',
      mime: 'model/gltf-binary',
      size: 1,
    };

    const p = mgr.ensure('peer1', meta);

    // Simulate a BEGIN that reports a size exceeding 256 MB.
    mgr.handleEnvelope('peer1', {
      rtype: '_blob_begin',
      op: 'event',
      key: meta.hash,
      data: { hash: meta.hash, size: 300 * 1024 * 1024, ext: '.vrm', chunks: 1 },
    });

    await expect(p).rejects.toThrow(/size cap/i);
  });
});

// ---------------------------------------------------------------------------
// handleEnvelope — ERROR terminates with the remote message.
// ---------------------------------------------------------------------------

describe('BlobManager.handleEnvelope ERROR', () => {
  it('rejects with the message from the remote error payload', async () => {
    const { mgr } = await makeBlobManager(true);
    const meta = {
      hash: 'c'.repeat(64),
      ext: '.vrm',
      mime: 'model/gltf-binary',
      size: 1,
    };

    const p = mgr.ensure('peer1', meta);

    mgr.handleEnvelope('peer1', {
      rtype: '_blob_error',
      op: 'event',
      key: meta.hash,
      data: { hash: meta.hash, message: 'asset not found' },
    });

    await expect(p).rejects.toThrow('asset not found');
  });
});

// ---------------------------------------------------------------------------
// handleEnvelope — END with hash mismatch rejects.
// ---------------------------------------------------------------------------

describe('BlobManager.handleEnvelope END — hash mismatch', () => {
  it('rejects when the reassembled bytes do not match the declared hash', async () => {
    const { mgr } = await makeBlobManager(true);
    const hash = 'd'.repeat(64); // sha256 hex hash that won't match our chunk
    const meta = { hash, ext: '.bin', mime: 'application/octet-stream', size: 5 };

    const p = mgr.ensure('peer1', meta);

    // Begin (valid size).
    mgr.handleEnvelope('peer1', {
      rtype: '_blob_begin',
      op: 'event',
      key: hash,
      data: { hash, size: 5, ext: '.bin', chunks: 1 },
    });

    // Send a chunk.
    const chunk = Buffer.from('hello').toString('base64');
    mgr.handleEnvelope('peer1', {
      rtype: '_blob_chunk',
      op: 'event',
      key: hash,
      data: { hash, seq: 0, b64: chunk },
    });

    // End — the hash 'd'.repeat(64) won't match sha256('hello').
    mgr.handleEnvelope('peer1', {
      rtype: '_blob_end',
      op: 'event',
      key: hash,
      data: { hash },
    });

    await expect(p).rejects.toThrow(/hash mismatch/i);
  });
});

// ---------------------------------------------------------------------------
// handleEnvelope — META_OK resolves the pending meta request.
// ---------------------------------------------------------------------------

describe('BlobManager.handleEnvelope META + META_OK', () => {
  it('metaForPath sends a _blob_meta and resolves when META_OK arrives', async () => {
    const { mgr, sent } = await makeBlobManager(true);
    const filePath = '/uploads/avatar.vrm';
    const peerId = 'peer-A';

    const metaPromise = mgr.metaForPath(peerId, filePath);

    // Check that a _blob_meta envelope was sent.
    const metaEnv = sent.find((s) => s.env.rtype === '_blob_meta');
    expect(metaEnv).toBeDefined();
    expect(metaEnv?.participant).toBe(peerId);

    const fakeMeta = {
      hash: 'e'.repeat(64),
      ext: '.vrm',
      mime: 'model/gltf-binary',
      size: 1024,
    };

    // Simulate owner responding with META_OK.
    mgr.handleEnvelope(peerId, {
      rtype: '_blob_meta_ok',
      op: 'event',
      key: filePath,
      data: { path: filePath, meta: fakeMeta },
    });

    const result = await metaPromise;
    expect(result).toEqual(fakeMeta);
  });

  it('metaForPath resolves null when META_OK carries null meta', async () => {
    const { mgr } = await makeBlobManager(true);
    const filePath = '/uploads/missing.vrm';
    const peerId = 'peer-B';

    const metaPromise = mgr.metaForPath(peerId, filePath);

    mgr.handleEnvelope(peerId, {
      rtype: '_blob_meta_ok',
      op: 'event',
      key: filePath,
      data: { path: filePath, meta: null },
    });

    const result = await metaPromise;
    expect(result).toBeNull();
  });

  it('metaForPath rejects immediately when the channel is closed', async () => {
    const { mgr } = await makeBlobManager(false /* sendResult */);
    await expect(mgr.metaForPath('peer-C', '/file.vrm')).rejects.toThrow(
      'mesh channel not open'
    );
  });
});
