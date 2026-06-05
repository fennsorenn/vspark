import type { AssetFile } from './api/client';

// Backend-persisted thumbnail cache. Generation (WebGL) is expensive and was
// re-run every session; now we first check for a stored thumbnail at
// /uploads/<projectId>/thumbnails/<assetId>.png and only generate (then upload)
// when one doesn't exist yet. Keyed per asset id so each is resolved once per
// session.

const mem = new Map<string, Promise<string>>();

function remoteUrl(asset: AssetFile): string {
  return `/uploads/${asset.projectId}/thumbnails/${asset.id}.png`;
}

async function uploadThumb(id: string, dataUrl: string): Promise<void> {
  const base64 = dataUrl.split(',')[1] ?? '';
  if (!base64) return;
  await fetch(`/api/assets/${id}/thumbnail`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: base64 }),
  });
}

async function resolve(
  asset: AssetFile,
  generate: () => Promise<string>
): Promise<string> {
  const url = remoteUrl(asset);
  // Cheap existence check — if the backend already has it, skip WebGL entirely.
  try {
    if ((await fetch(url, { method: 'HEAD' })).ok) return url;
  } catch {
    /* fall through to generate */
  }
  const dataUrl = await generate();
  // Persist for next session; use the freshly generated data URL now.
  void uploadThumb(asset.id, dataUrl).catch(() => {});
  return dataUrl;
}

/** Return a thumbnail URL for `asset`, preferring a backend-cached PNG and
 *  generating + persisting one (via `generate`) only on a miss. */
export function cachedThumb(
  asset: AssetFile,
  generate: () => Promise<string>
): Promise<string> {
  let p = mem.get(asset.id);
  if (!p) {
    p = resolve(asset, generate).catch((e) => {
      mem.delete(asset.id);
      throw e;
    });
    mem.set(asset.id, p);
  }
  return p;
}
