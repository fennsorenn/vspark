/**
 * Content-addressed blob transfer over the ServerMesh (asset-transfer slice).
 *
 * The owner serves an asset by sha256 hash (chunked, base64 over the reliable
 * `doc` channel); the receiver reassembles, verifies the hash, and writes it to
 * its shared cache. Transfers are deduped per hash and verified end-to-end, so
 * fetching from any peer is safe. A dedicated binary channel + backpressure are
 * a refinement; v1 paces base64 chunks on the existing channel.
 *
 * Routed by reserved `_blob_*` rtypes. See dev-notes/plans/live-mesh.md.
 */
import { createHash } from 'crypto';
import type { ServerMesh } from './mesh.js';
import type { SyncEnvelope } from '@vspark/shared/sync';
import {
  resolveByHash,
  readBlob,
  writeCached,
  cachedUrl,
  hasCached,
  type AssetMeta,
} from './blobs.js';

const REQUEST = '_blob_request';
const BEGIN = '_blob_begin';
const CHUNK = '_blob_chunk';
const END = '_blob_end';
const ERROR = '_blob_error';

export const BLOB_RTYPES = new Set([REQUEST, BEGIN, CHUNK, END, ERROR]);

/** Raw bytes per chunk (base64-encoded on the wire). */
const CHUNK_BYTES = 48 * 1024;
/** Pause every N chunks to let the channel drain (crude backpressure). */
const PACE_EVERY = 16;
const PACE_MS = 8;
/** Give up on a stalled fetch. */
const FETCH_TIMEOUT_MS = 60_000;
/** Refuse absurd transfers. */
const MAX_BLOB_BYTES = 256 * 1024 * 1024;

interface Incoming {
  ext: string;
  chunks: string[];
  resolve: (url: string) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BlobManager {
  /** hash → in-flight receive state (we're the receiver). */
  private readonly incoming = new Map<string, Incoming>();
  /** hash → in-flight fetch promise (dedupe concurrent requests). */
  private readonly pending = new Map<string, Promise<string>>();

  constructor(private readonly mesh: ServerMesh) {}

  /** Receiver: ensure `meta.hash` is cached locally, fetching from `peerId` if
   *  needed. Resolves to the public `/uploads/_shared/...` URL. */
  ensure(peerId: string, meta: AssetMeta): Promise<string> {
    if (hasCached(meta.hash, meta.ext))
      return Promise.resolve(cachedUrl(meta.hash, meta.ext));
    const existing = this.pending.get(meta.hash);
    if (existing) return existing;

    const p = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.incoming.delete(meta.hash);
        this.pending.delete(meta.hash);
        reject(new Error(`blob fetch timed out: ${meta.hash}`));
      }, FETCH_TIMEOUT_MS);
      this.incoming.set(meta.hash, {
        ext: meta.ext,
        chunks: [],
        resolve,
        reject,
        timer,
      });
      const ok = this.mesh.sendEnvelope(peerId, {
        rtype: REQUEST,
        op: 'event',
        key: meta.hash,
        data: { hash: meta.hash },
      });
      if (!ok) {
        clearTimeout(timer);
        this.incoming.delete(meta.hash);
        reject(new Error('mesh channel not open'));
      }
    }).finally(() => this.pending.delete(meta.hash));

    this.pending.set(meta.hash, p);
    return p;
  }

  /** Dispatch a `_blob_*` envelope. */
  handleEnvelope(from: string, env: SyncEnvelope): void {
    const data = (env.data ?? {}) as Record<string, unknown>;
    switch (env.rtype) {
      case REQUEST:
        void this.serve(from, data.hash as string);
        break;
      case BEGIN: {
        const inc = this.incoming.get(data.hash as string);
        if (!inc) return;
        if ((data.size as number) > MAX_BLOB_BYTES) {
          this.fail(data.hash as string, 'blob exceeds size cap');
        }
        break;
      }
      case CHUNK: {
        const inc = this.incoming.get(data.hash as string);
        if (inc) inc.chunks[data.seq as number] = data.b64 as string;
        break;
      }
      case END:
        this.finish(data.hash as string);
        break;
      case ERROR:
        this.fail(data.hash as string, (data.message as string) ?? 'remote error');
        break;
    }
  }

  // --- owner side ----------------------------------------------------------

  private async serve(peerId: string, hash: string): Promise<void> {
    const found = resolveByHash(hash);
    if (!found) {
      this.mesh.sendEnvelope(peerId, {
        rtype: ERROR,
        op: 'event',
        key: hash,
        data: { hash, message: 'asset not found' },
      });
      return;
    }
    const buf = readBlob(found.absPath);
    const total = Math.ceil(buf.length / CHUNK_BYTES) || 1;
    this.mesh.sendEnvelope(peerId, {
      rtype: BEGIN,
      op: 'event',
      key: hash,
      data: { hash, size: buf.length, ext: found.meta.ext, chunks: total },
    });
    for (let seq = 0; seq < total; seq++) {
      const slice = buf.subarray(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES);
      this.mesh.sendEnvelope(peerId, {
        rtype: CHUNK,
        op: 'event',
        key: hash,
        data: { hash, seq, b64: slice.toString('base64') },
      });
      if (seq % PACE_EVERY === PACE_EVERY - 1) await delay(PACE_MS);
    }
    this.mesh.sendEnvelope(peerId, {
      rtype: END,
      op: 'event',
      key: hash,
      data: { hash },
    });
  }

  // --- receiver side -------------------------------------------------------

  private finish(hash: string): void {
    const inc = this.incoming.get(hash);
    if (!inc) return;
    this.incoming.delete(hash);
    clearTimeout(inc.timer);
    try {
      const buf = Buffer.concat(
        inc.chunks.map((b64) => Buffer.from(b64 ?? '', 'base64'))
      );
      const digest = createHash('sha256').update(buf).digest('hex');
      if (digest !== hash) {
        inc.reject(new Error(`hash mismatch (${digest} != ${hash})`));
        return;
      }
      const url = writeCached(hash, inc.ext, buf);
      inc.resolve(url);
    } catch (e) {
      inc.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private fail(hash: string, message: string): void {
    const inc = this.incoming.get(hash);
    if (!inc) return;
    this.incoming.delete(hash);
    clearTimeout(inc.timer);
    inc.reject(new Error(message));
  }
}
