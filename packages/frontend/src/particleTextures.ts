/**
 * Built-in particle textures generated on a 64×64 canvas.
 * Each entry is a data: URI PNG that can be used directly as a texture URL.
 */

function makeHTML(
  draw: (ctx: CanvasRenderingContext2D, size: number) => void
): string {
  const size = 64;
  const el = document.createElement('canvas');
  el.width = size;
  el.height = size;
  const ctx = el.getContext('2d')!;
  draw(ctx, size);
  return el.toDataURL('image/png');
}

/** Solid white square — hard edge, great for sparks/pixels */
function makeSquare(): string {
  return makeHTML((ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, s, s);
  });
}

/** Soft square — square shape with rounded alpha falloff toward edges */
function makeSoftSquare(): string {
  return makeHTML((ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    const half = s / 2;
    const grd = ctx.createRadialGradient(half, half, 0, half, half, half * 1.2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.6, 'rgba(255,255,255,0.8)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Sharp circle — hard-edge white disc */
function makeCircle(): string {
  return makeHTML((ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    const half = s / 2;
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  });
}

/** Soft circle — disc with smooth alpha falloff */
function makeSoftCircle(): string {
  return makeHTML((ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    const half = s / 2;
    const grd = ctx.createRadialGradient(half, half, 0, half, half, half);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.9)');
    grd.addColorStop(0.85, 'rgba(255,255,255,0.3)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(half, half, half, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();
  });
}

/** Gaussian blob — smooth bell-curve radial gradient, no hard edge */
function makeGaussian(): string {
  return makeHTML((ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    const half = s / 2;
    // Approximate Gaussian with multiple gradient stops
    const grd = ctx.createRadialGradient(half, half, 0, half, half, half);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.2, 'rgba(255,255,255,0.97)');
    grd.addColorStop(0.4, 'rgba(255,255,255,0.84)');
    grd.addColorStop(0.6, 'rgba(255,255,255,0.54)');
    grd.addColorStop(0.75, 'rgba(255,255,255,0.25)');
    grd.addColorStop(0.88, 'rgba(255,255,255,0.08)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Wide gaussian — very diffuse, great for fog/smoke */
function makeWideGaussian(): string {
  return makeHTML((ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    const half = s / 2;
    const grd = ctx.createRadialGradient(half, half, 0, half, half, half);
    grd.addColorStop(0, 'rgba(255,255,255,0.6)');
    grd.addColorStop(0.3, 'rgba(255,255,255,0.35)');
    grd.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    grd.addColorStop(0.85, 'rgba(255,255,255,0.03)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Star — 4-pointed cross/sparkle */
function makeStar(): string {
  return makeHTML((ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    const half = s / 2;
    // Draw a 4-pointed star as two rotated thin ellipses
    for (let angle = 0; angle < Math.PI; angle += Math.PI / 2) {
      ctx.save();
      ctx.translate(half, half);
      ctx.rotate(angle);
      const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, half);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.15, 'rgba(255,255,255,0.9)');
      grd.addColorStop(0.4, 'rgba(255,255,255,0.4)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.scale(1, 0.12);
      ctx.beginPath();
      ctx.arc(0, 0, half, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();
      ctx.restore();
    }
    // Bright center
    const center = ctx.createRadialGradient(
      half,
      half,
      0,
      half,
      half,
      half * 0.18
    );
    center.addColorStop(0, 'rgba(255,255,255,1)');
    center.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = center;
    ctx.beginPath();
    ctx.arc(half, half, half * 0.18, 0, Math.PI * 2);
    ctx.fill();
  });
}

/** Ring — hollow circle */
function makeRing(): string {
  return makeHTML((ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    const half = s / 2;
    const outer = half - 2;
    const inner = half * 0.55;
    const grd = ctx.createRadialGradient(
      half,
      half,
      inner * 0.8,
      half,
      half,
      outer
    );
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.3, 'rgba(255,255,255,1)');
    grd.addColorStop(0.6, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(half, half, outer, 0, Math.PI * 2);
    ctx.arc(half, half, inner * 0.6, 0, Math.PI * 2, true);
    ctx.fillStyle = grd;
    ctx.fill();
  });
}

export interface BuiltinParticleTexture {
  label: string;
  dataUrl: string;
}

// Lazily generated once on first access
let _cache: BuiltinParticleTexture[] | null = null;

export function getBuiltinParticleTextures(): BuiltinParticleTexture[] {
  if (_cache) return _cache;
  _cache = [
    { label: 'Square', dataUrl: makeSquare() },
    { label: 'Soft Square', dataUrl: makeSoftSquare() },
    { label: 'Circle', dataUrl: makeCircle() },
    { label: 'Soft Circle', dataUrl: makeSoftCircle() },
    { label: 'Gaussian', dataUrl: makeGaussian() },
    { label: 'Wide Gaussian', dataUrl: makeWideGaussian() },
    { label: 'Star', dataUrl: makeStar() },
    { label: 'Ring', dataUrl: makeRing() },
  ];
  return _cache;
}
