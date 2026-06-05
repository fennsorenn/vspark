import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Lazily-rendered thumbnails for model/avatar assets (.glb/.gltf/.vrm). The
// asset cards only have a URL, so we load the glTF once on a shared offscreen
// renderer, frame its bounding box, snapshot a single frame to a data URL, and
// cache the promise per URL. VRM (MToon) materials fall back to standard
// shading here — good enough for a recognisable thumbnail.

const SIZE = 160;
const cache = new Map<string, Promise<string>>();

let renderer: THREE.WebGLRenderer | null = null;
function getRenderer(): THREE.WebGLRenderer {
  if (renderer) return renderer;
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(SIZE, SIZE);
  renderer.setClearColor(0x000000, 0);
  return renderer;
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = (mesh as THREE.Mesh).material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) (mat as THREE.Material).dispose();
  });
}

async function render(url: string): Promise<string> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const model = gltf.scene;

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const dir = new THREE.DirectionalLight(0xffffff, 1.8);
  dir.position.set(1, 2, 3);
  scene.add(dir);
  scene.add(model);

  // Frame the bounding box from a slightly raised 3/4 angle.
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, maxDim * 100);
  const dist = (maxDim / (2 * Math.tan((35 * Math.PI) / 360))) * 1.5;
  camera.position.set(
    center.x + dist * 0.5,
    center.y + dist * 0.35,
    center.z + dist
  );
  camera.lookAt(center);

  const r = getRenderer();
  r.render(scene, camera);
  const dataUrl = r.domElement.toDataURL('image/png');

  disposeObject(model);
  return dataUrl;
}

/** Get (and cache) a thumbnail data URL for a model asset URL. Rejects if the
 *  model can't be loaded; callers should fall back to an icon. */
export function getModelThumb(url: string): Promise<string> {
  let p = cache.get(url);
  if (!p) {
    p = render(url).catch((e) => {
      // Drop the failed entry so a later retry can re-attempt.
      cache.delete(url);
      throw e;
    });
    cache.set(url, p);
  }
  return p;
}
