import { useEffect, useState } from 'react';
import type { AssetFile } from '../../api/client';
import { getModelThumb } from '../../modelThumb';

const box: React.CSSProperties = {
  width: '100%',
  height: 80,
  borderRadius: 3,
  background: '#111',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
};

/** Thumbnail for an asset card. Images render directly; models get a lazily
 *  rendered 3D snapshot (cached, with an icon fallback); animations show an
 *  icon since there's nothing meaningful to preview. */
export function AssetThumb({ asset }: { asset: AssetFile }) {
  const isModel = asset.kind === 'model';
  const ext = asset.name.split('.').pop()?.toLowerCase();
  const [thumb, setThumb] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isModel) return;
    let alive = true;
    setThumb(null);
    setFailed(false);
    getModelThumb(asset.url)
      .then((url) => {
        if (alive) setThumb(url);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [isModel, asset.url]);

  if (asset.kind === 'image') {
    return (
      <img
        src={asset.url}
        alt={asset.name}
        draggable={false}
        style={{ ...box, objectFit: 'contain' }}
      />
    );
  }

  if (asset.kind === 'animation') {
    return (
      <div style={box}>
        <span style={{ fontSize: 30, opacity: 0.7 }}>🎞️</span>
      </div>
    );
  }

  // Model
  if (thumb) {
    return (
      <img
        src={thumb}
        alt={asset.name}
        draggable={false}
        style={{ ...box, objectFit: 'contain' }}
      />
    );
  }
  return (
    <div style={box}>
      <span style={{ fontSize: 30, opacity: failed ? 0.7 : 0.4 }}>
        {failed ? (ext === 'vrm' ? '🧍' : '📦') : '⏳'}
      </span>
    </div>
  );
}
