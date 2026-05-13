import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'

interface AvatarProps {
  vrmPath: string
  animPath: string | null
}

export function Avatar({ vrmPath, animPath }: AvatarProps) {
  const groupRef = useRef<THREE.Group>(null)
  const mixerRef = useRef<THREE.AnimationMixer | null>(null)
  const clockRef = useRef(new THREE.Clock())

  useEffect(() => {
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))

    loader.load(vrmPath, (gltf) => {
      const vrm = gltf.userData.vrm
      const vrmScene = gltf.scene

      if (!groupRef.current) return
      groupRef.current.clear()
      groupRef.current.add(vrmScene)

      vrm.scene.rotation.y = Math.PI

      mixerRef.current?.stopAllAction()
      mixerRef.current = null

      if (animPath) {
        const animLoader = new GLTFLoader()
        animLoader.load(animPath, (animGltf) => {
          const clip = animGltf.animations[0]
          if (!clip) return
          const mixer = new THREE.AnimationMixer(vrmScene)
          mixerRef.current = mixer
          const action = mixer.clipAction(clip, vrmScene)
          action.reset()
          action.play()
        })
      }
    })
  }, [vrmPath, animPath])

  useFrame(() => {
    const delta = clockRef.current.getDelta()
    mixerRef.current?.update(delta)
  })

  return <group ref={groupRef} />
}
