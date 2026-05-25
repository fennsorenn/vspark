import { OrthographicCamera } from '@react-three/drei'
import { useThree } from '@react-three/fiber'

/** Orthographic camera that scales its left/right frame by the canvas aspect
 *  so a square-ish object stays square regardless of canvas size. `size` is the
 *  half-height of the view volume (the analogue of FOV for a perspective camera). */
export function FittedOrthoCamera({ size, near, far, position, rotation }: {
  size: number
  near: number
  far: number
  position: [number, number, number]
  rotation: [number, number, number]
}) {
  const viewport = useThree((s) => s.size)
  const aspect = viewport.height > 0 ? viewport.width / viewport.height : 1
  const halfW = size * aspect
  return (
    <OrthographicCamera
      makeDefault
      zoom={1}
      top={size}
      bottom={-size}
      left={-halfW}
      right={halfW}
      near={near}
      far={far}
      position={position}
      rotation={rotation}
    />
  )
}
