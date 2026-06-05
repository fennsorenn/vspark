import { useEffect, useRef, useState } from 'react';
import type { AssetFile } from '../../api/client';
import { getModelThumb } from '../../modelThumb';
import {
  getAnimThumb,
  playAnimPreview,
  stopAnimPreview,
  stopAnimPreviewFor,
} from '../../animPreview';
import { cachedThumb } from '../../thumbCache';

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

/** Animation thumbnail: a cached mid-frame skeleton render (persisted to the
 *  backend), which plays the clip on hover via the shared overlay canvas. The
 *  static frame is hidden while hovering so it doesn't show through the moving
 *  skeleton. */
function AnimThumb({ asset }: { asset: AssetFile }) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    let alive = true;
    setThumb(null);
    setFailed(false);
    cachedThumb(asset, () => getAnimThumb(asset.url))
      .then((u) => alive && setThumb(u))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      stopAnimPreviewFor(asset.url);
    };
  }, [asset.id, asset.url]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={ref}
      style={box}
      onMouseEnter={() => {
        const el = ref.current;
        if (el) {
          setHovering(true);
          void playAnimPreview(asset.url, el.getBoundingClientRect());
        }
      }}
      onMouseLeave={() => {
        setHovering(false);
        stopAnimPreview();
      }}
    >
      {thumb ? (
        <img
          src={thumb}
          alt={asset.name}
          draggable={false}
          style={{
            ...box,
            objectFit: 'contain',
            // Hidden during hover so the static frame doesn't overlap the
            // animated overlay canvas.
            visibility: hovering ? 'hidden' : 'visible',
          }}
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
 *  skeleton mid-frame that plays on hover. Model/animation thumbnails are
 *  persisted to the backend (see thumbCache) so they're generated once. */
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
    cachedThumb(asset, () => getModelThumb(asset.url))
      .then((url) => {
        if (alive) setThumb(url);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [isModel, asset.id, asset.url]); // eslint-disable-line react-hooks/exhaustive-deps

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
    return <AnimThumb asset={asset} />;
  }

  if (asset.kind === 'video') {
    // A muted, metadata-preloaded <video> renders its first frame as a poster.
    return (
      <video
        src={asset.url}
        muted
        playsInline
        preload="metadata"
        draggable={false}
        style={{ ...box, objectFit: 'contain' }}
      />
    );
  }

  if (asset.kind === 'audio') {
    return (
      <div style={box}>
        <span style={{ fontSize: 30, opacity: 0.5 }}>🔊</span>
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
