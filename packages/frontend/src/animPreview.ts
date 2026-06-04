import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';

// Animation asset previews. The static thumbnail renders the clip's skeleton
// (via THREE.SkeletonHelper, meshes hidden) at duration/2 on a shared offscreen
// renderer, cached as a data URL. Hover playback drives one shared overlay
// canvas positioned over the hovered card, so we only ever hold a couple of
// WebGL contexts regardless of how many animations are listed.

const HELPER_COLOR = 0x7fd4ff;

// ── shared fetch cache ──────────────────────────────────────────────────────
const bufCache = new Map<string, Promise<ArrayBuffer>>();
function fetchBuf(url: string): Promise<ArrayBuffer> {
  let p = bufCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`fetch ${r.status}`);
        return r.arrayBuffer();
      })
      .catch((e) => {
        bufCache.delete(url);
        throw e;
      });
    bufCache.set(url, p);
  }
  return p;
}

interface Loaded {
  root: THREE.Object3D;
  clip: THREE.AnimationClip;
}

async function parseAnim(url: string): Promise<Loaded> {
  const buf = await fetchBuf(url);
  const path = url.toLowerCase().split('?')[0];
  if (path.endsWith('.bvh')) {
    const res = new BVHLoader().parse(new TextDecoder().decode(buf));
    return { root: res.skeleton.bones[0], clip: res.clip };
  }
  const obj = new FBXLoader().parse(buf, '');
  const clip = obj.animations[0];
  if (!clip) throw new Error('no animation clip in file');
  return { root: obj, clip };
}

interface Built {
  scene: THREE.Scene;
  helper: THREE.SkeletonHelper;
  mixer: THREE.AnimationMixer;
  root: THREE.Object3D;
}

function build(loaded: Loaded): Built {
  const scene = new THREE.Scene();
  // Hide any skinned meshes — we only want the skeleton lines.
  loaded.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.visible = false;
  });
  scene.add(loaded.root);
  const helper = new THREE.SkeletonHelper(loaded.root);
  (helper.material as THREE.LineBasicMaterial).color.set(HELPER_COLOR);
  scene.add(helper);
  const mixer = new THREE.AnimationMixer(loaded.root);
  mixer.clipAction(loaded.clip).play();
  return { scene, helper, mixer, root: loaded.root };
}

function frameCamera(root: THREE.Object3D, aspect: number): THREE.Camera {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  root.traverse((o) => {
    o.getWorldPosition(p);
    box.expandByPoint(p);
  });
  if (box.isEmpty())
    box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const cam = new THREE.PerspectiveCamera(
    35,
    aspect,
    maxDim * 0.01,
    maxDim * 100
  );
  const dist = (maxDim / (2 * Math.tan((35 * Math.PI) / 360))) * 1.3;
  cam.position.set(
    center.x + dist * 0.25,
    center.y + size.y * 0.05,
    center.z + dist
  );
  cam.lookAt(center);
  return cam;
}

function dispose(b: Built): void {
  b.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = (m as THREE.Mesh).material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) (mat as THREE.Material).dispose();
  });
  b.helper.geometry.dispose();
  (b.helper.material as THREE.Material).dispose();
}

// ── static thumbnail (cached data URL) ──────────────────────────────────────
const THUMB = 160;
let staticRenderer: THREE.WebGLRenderer | null = null;
function getStaticRenderer(): THREE.WebGLRenderer {
  if (staticRenderer) return staticRenderer;
  staticRenderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  staticRenderer.setSize(THUMB, THUMB);
  staticRenderer.setClearColor(0x000000, 0);
  return staticRenderer;
}

const thumbCache = new Map<string, Promise<string>>();
async function renderThumb(url: string): Promise<string> {
  const loaded = await parseAnim(url);
  const built = build(loaded);
  built.mixer.setTime((loaded.clip.duration || 0) / 2);
  built.root.updateWorldMatrix(true, true);
  built.helper.updateMatrixWorld(true);
  const cam = frameCamera(built.root, 1);
  const r = getStaticRenderer();
  r.render(built.scene, cam);
  const dataUrl = r.domElement.toDataURL('image/png');
  dispose(built);
  return dataUrl;
}

/** Cached skeleton thumbnail (mid-frame) for an animation asset URL. */
export function getAnimThumb(url: string): Promise<string> {
  let p = thumbCache.get(url);
  if (!p) {
    p = renderThumb(url).catch((e) => {
      thumbCache.delete(url);
      throw e;
    });
    thumbCache.set(url, p);
  }
  return p;
}

// ── hover playback (single shared overlay canvas) ───────────────────────────
let overlayRenderer: THREE.WebGLRenderer | null = null;
function getOverlay(): THREE.WebGLRenderer {
  if (overlayRenderer) return overlayRenderer;
  overlayRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  overlayRenderer.setPixelRatio(window.devicePixelRatio || 1);
  const c = overlayRenderer.domElement;
  c.style.position = 'fixed';
  c.style.pointerEvents = 'none';
  c.style.zIndex = '9999';
  c.style.borderRadius = '3px';
  c.style.display = 'none';
  document.body.appendChild(c);
  return overlayRenderer;
}

let token = 0;
let activeUrl: string | null = null;
let live: {
  built: Built;
  cam: THREE.Camera;
  clock: THREE.Clock;
  raf: number;
} | null = null;

/** Play an animation's skeleton in the shared overlay canvas, positioned over
 *  `rect` (a card's bounding rect). Replaces any previous preview. */
export async function playAnimPreview(
  url: string,
  rect: DOMRect
): Promise<void> {
  stopAnimPreview();
  const myToken = ++token;
  activeUrl = url;

  const renderer = getOverlay();
  const c = renderer.domElement;
  c.style.left = `${rect.left}px`;
  c.style.top = `${rect.top}px`;
  c.style.width = `${rect.width}px`;
  c.style.height = `${rect.height}px`;
  renderer.setSize(rect.width, rect.height, false);

  let loaded: Loaded;
  try {
    loaded = await parseAnim(url);
  } catch {
    return;
  }
  if (myToken !== token) return; // superseded while loading

  const built = build(loaded);
  const cam = frameCamera(built.root, rect.width / rect.height || 1);
  c.style.display = 'block';
  const clock = new THREE.Clock();
  live = { built, cam, clock, raf: 0 };

  const tick = () => {
    if (myToken !== token || !live) return;
    built.mixer.update(clock.getDelta());
    built.root.updateWorldMatrix(true, true);
    built.helper.updateMatrixWorld(true);
    renderer.render(built.scene, cam);
    live.raf = requestAnimationFrame(tick);
  };
  live.raf = requestAnimationFrame(tick);
}

export function stopAnimPreview(): void {
  token++;
  activeUrl = null;
  if (live) {
    cancelAnimationFrame(live.raf);
    dispose(live.built);
    live = null;
  }
  if (overlayRenderer) overlayRenderer.domElement.style.display = 'none';
}

/** Stop only if `url` is the one currently previewing (safe unmount cleanup). */
export function stopAnimPreviewFor(url: string): void {
  if (activeUrl === url) stopAnimPreview();
}
