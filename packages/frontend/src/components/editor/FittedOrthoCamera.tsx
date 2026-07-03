import { OrthographicCamera } from '@react-three/drei';
import { useThree } from '@react-three/fiber';

/** Orthographic camera fitted to the canvas aspect so a square-ish object stays
 *  square regardless of canvas size. `size` is the half-extent of the SHORTER
 *  viewport axis (the analogue of FOV for a perspective camera): the framed area
 *  of half-size `size` always stays fully visible, with the longer axis showing
 *  extra scene rather than zooming into a slice. This keeps a resized (e.g. tall
 *  and narrow) camera layer from collapsing the view to a vertical line. */
export function FittedOrthoCamera({
  size,
  near,
  far,
  position,
  rotation,
}: {
  size: number;
  near: number;
  far: number;
  position: [number, number, number];
  rotation: [number, number, number];
}) {
  const viewport = useThree((s) => s.size);
  // Guard degenerate dimensions (a 0-width/height canvas mid-resize) so the
  // frustum never collapses to a line.
  const aspect =
    viewport.width > 0 && viewport.height > 0
      ? viewport.width / viewport.height
      : 1;
  // `size` is the shorter axis' half-extent; the longer axis grows by aspect.
  const halfW = aspect >= 1 ? size * aspect : size;
  const halfH = aspect >= 1 ? size : size / aspect;
  return (
    <OrthographicCamera
      makeDefault
      zoom={1}
      top={halfH}
      bottom={-halfH}
      left={-halfW}
      right={halfW}
      near={near}
      far={far}
      position={position}
      rotation={rotation}
    />
  );
}
