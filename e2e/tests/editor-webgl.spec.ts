import { test, expect } from '../fixtures/controlCoverage';

/**
 * WebGL spike (de-risks Phase 8 — editor-flow E2E breadth).
 *
 * Every other spec uses the deliberately WebGL-free Home page. This one proves
 * the React-Three-Fiber editor viewport actually mounts a live WebGL context
 * under headless Chromium — the load-bearing assumption for all editor-level
 * E2E tests. It asserts the canvas mounts at non-zero size, a WebGL context
 * exists and is not lost, and no WebGL/Three-specific console errors fire.
 *
 * It does NOT assert anything about rendered pixels (no screenshot diffing) —
 * only that the GL pipeline initialised. Asset-loading failures (e.g. the drei
 * environment HDR over a blocked network) are intentionally out of scope: the
 * console filter matches only WebGL/Three errors, not generic network ones.
 */
test('editor viewport mounts a live WebGL canvas (headless)', async ({
  page,
  request,
}) => {
  const glErrors: string[] = [];
  const isGlError = (s: string) =>
    /webgl|three\.|context lost|getcontext|gl_/i.test(s);
  page.on('console', (m) => {
    if (m.type() === 'error' && isGlError(m.text())) glErrors.push(m.text());
  });
  page.on('pageerror', (e) => {
    if (isGlError(e.message)) glErrors.push(e.message);
  });

  // Seed a project + scene via the API (independent of the create UI).
  const projRes = await request.post('/api/projects', {
    data: { name: `E2E WebGL ${Date.now()}` },
  });
  expect(projRes.status()).toBe(201);
  const projectId = (await projRes.json()).data.id as string;
  const sceneRes = await request.post(`/api/projects/${projectId}/scenes`, {
    data: { name: 'Scene' },
  });
  expect(sceneRes.ok()).toBeTruthy();

  await page.goto(`/editor/${projectId}`);

  // R3F renders a <canvas>. Wait for it to mount at a non-zero size.
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  const box = await canvas.boundingBox();
  expect(box, 'viewport canvas has no layout box').not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);

  // The real headless risk: did a live WebGL context actually initialise?
  const gl = await canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext('webgl2') ?? el.getContext('webgl');
    if (!ctx) return { ok: false as const };
    return {
      ok: true as const,
      lost: ctx.isContextLost(),
      version: String(ctx.getParameter(ctx.VERSION)),
    };
  });
  expect(gl.ok, 'no WebGL context on the viewport canvas').toBeTruthy();
  if (gl.ok) {
    expect(gl.lost, 'WebGL context was lost').toBeFalsy();
    expect(gl.version).toMatch(/WebGL/i);
  }

  expect(
    glErrors,
    `WebGL/Three console errors:\n${glErrors.join('\n')}`
  ).toEqual([]);
});
