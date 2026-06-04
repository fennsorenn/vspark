import { useEffect, useRef, useState } from 'react';
import type { AssetFile } from '../../api/client';
import { getModelThumb } from '../../modelThumb';
import {
  getAnimThumb,
  playAnimPreview,
  stopAnimPreview,
  stopAnimPreviewFor,
} from '../../animPreview';

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

/** Animation thumbnail: a cached mid-frame skeleton render, which plays the
 *  clip on hover via the shared overlay canvas. */
function AnimThumb({ url, name }: { url: string; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setThumb(null);
    setFailed(false);
    getAnimThumb(url)
      .then((u) => alive && setThumb(u))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      stopAnimPreviewFor(url);
    };
  }, [url]);

  return (
    <div
      ref={ref}
      style={box}
      onMouseEnter={() => {
        const el = ref.current;
        if (el) void playAnimPreview(url, el.getBoundingClientRect());
      }}
      onMouseLeave={() => stopAnimPreview()}
    >
      {thumb ? (
        <img
          src={thumb}
          alt={name}
          draggable={false}
          style={{ ...box, objectFit: 'contain' }}
        />
      ) : (
        <span style={{ fontSize: 30, opacity: failed ? 0.7 : 0.4 }}>
          {failed ? '🎞️' : '⏳'}
        </span>
      )}
    </div>
  );
}

/** Thumbnail for an asset card. Images render directly; models get a lazily
 *  rendered 3D snapshot (cached, with an icon fallback); animations render a
 *  skeleton mid-frame that plays on hover. */
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
    return <AnimThumb url={asset.url} name={asset.name} />;
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
