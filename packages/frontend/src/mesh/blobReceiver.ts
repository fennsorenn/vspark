/**
 * Browser-side mirror of the backend {@link BlobManager} receiver: fetches a
 * content-addressed asset over the direct WebRTC edge from its owner and caches
 * it as an in-memory object URL. It speaks the *identical* `_blob_*` protocol
 * (REQUEST, then BEGIN / CHUNK… / END) so the owner serves a browser exactly as
 * it serves another backend (asset transfer is a symmetric mesh capability). The
 * only difference is the sink: a backend writes to its disk cache, a browser
 * assembles a Blob → `URL.createObjectURL`.
 *
 * Transfers are deduped per hash and verified end-to-end (sha256 via Web
 * Crypto). See dev-notes/plans/permissioned-sync-mesh.md.
 */
import { clientMesh } from './clientMesh';
import type { SyncEnvelope } from '@vspark/shared/sync';

const REQUEST = '_blob_request';
const BEGIN = '_blob_begin';
const CHUNK = '_blob_chunk';
const END = '_blob_end';
const ERROR = '_blob_error';

/** Asset descriptor carried in a shared-object snapshot. */
export interface BlobMeta {
  hash: string;
  ext: string;
  mime: string;
  size: number;
}

const FETCH_TIMEOUT_MS = 60_000;
const MAX_BLOB_BYTES = 256 * 1024 * 1024;

interface Incoming {
  mime: string;
  chunks: string[];
  resolve: (url: string) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** hash → object URL (the browser's content-addressed cache). */
const urlByHash = new Map<string, string>();
const incoming = new Map<string, Incoming>();
const pending = new Map<string, Promise<string>>();

/** The cached object URL for a hash, if already fetched. */
export function cachedBlobUrl(hash: string): string | undefined {
  return urlByHash.get(hash);
}

/** Ensure `meta.hash` is cached locally, fetching from `owner` over the mesh if
 *  needed. Resolves to an object URL. Deduped per hash. */
export function ensureBlob(owner: string, meta: BlobMeta): Promise<string> {
  const have = urlByHash.get(meta.hash);
  if (have) return Promise.resolve(have);
  const existing = pending.get(meta.hash);
  if (existing) return existing;

  const p = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      incoming.delete(meta.hash);
      reject(new Error(`blob fetch timed out: ${meta.hash}`));
    }, FETCH_TIMEOUT_MS);
    incoming.set(meta.hash, {
      mime: meta.mime,
      chunks: [],
      resolve,
      reject,
      timer,
    });
    const ok = clientMesh.sendEnvelope(owner, {
      rtype: REQUEST,
      op: 'event',
      key: meta.hash,
      data: { hash: meta.hash },
    });
    if (!ok) {
      clearTimeout(timer);
      incoming.delete(meta.hash);
      reject(new Error('mesh channel not open'));
    }
  }).finally(() => pending.delete(meta.hash));

  pending.set(meta.hash, p);
  return p;
}

/** Feed an inbound `_blob_*` envelope (routed by the mesh dispatcher). */
export function handleBlobEnvelope(env: SyncEnvelope): void {
  const data = (env.data ?? {}) as Record<string, unknown>;
  const hash = data.hash as string;
  switch (env.rtype) {
    case BEGIN: {
      const inc = incoming.get(hash);
      if (inc && (data.size as number) > MAX_BLOB_BYTES)
        fail(hash, 'blob exceeds size cap');
      break;
    }
    case CHUNK: {
      const inc = incoming.get(hash);
      if (inc) inc.chunks[data.seq as number] = data.b64 as string;
      break;
    }
    case END:
      void finish(hash);
      break;
    case ERROR:
      fail(hash, (data.message as string) ?? 'remote error');
      break;
  }
}

async function finish(hash: string): Promise<void> {
  const inc = incoming.get(hash);
  if (!inc) return;
  incoming.delete(hash);
  clearTimeout(inc.timer);
  try {
    const bytes = concatBase64(inc.chunks);
    const digest = await sha256Hex(bytes);
    if (digest !== hash) {
      inc.reject(new Error(`hash mismatch (${digest} != ${hash})`));
      return;
    }
    const blob = new Blob([bytes], {
      type: inc.mime || 'application/octet-stream',
    });
    const url = URL.createObjectURL(blob);
    urlByHash.set(hash, url);
    inc.resolve(url);
  } catch (e) {
    inc.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

function fail(hash: string, message: string): void {
  const inc = incoming.get(hash);
  if (!inc) return;
  incoming.delete(hash);
  clearTimeout(inc.timer);
  inc.reject(new Error(message));
}

function concatBase64(chunks: string[]): Uint8Array<ArrayBuffer> {
  const parts = chunks.map((b64) => {
    const bin = atob(b64 ?? '');
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  });
  const total = parts.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let off = 0;
  for (const a of parts) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
