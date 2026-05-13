import { Environment, ContactShadows } from '@react-three/drei'

export function Scene() {
  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 10, 7]} intensity={1.2} castShadow />
      <directionalLight position={[-5, 5, -5]} intensity={0.3} />
      <pointLight position={[0, 8, 0]} intensity={0.5} />
      <Environment preset="city" />
      <ContactShadows
        position={[0, -1, 0]}
        opacity={0.6}
        scale={10}
        blur={1.5}
        far={4}
      />
      <gridHelper args={[10, 10, 0x444444, 0x333333]} position={[0, -0.99, 0]} />
    </>
  )
}
