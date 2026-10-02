import { describe, it, expect } from 'vitest';
import { SCENE_RENDER_SLOT, obsOutputWindowTitle } from '../src/types.js';

describe('types', () => {
  it('SCENE_RENDER_SLOT marks the 3D render slot at 0', () => {
    expect(SCENE_RENDER_SLOT).toBe(0);
  });

  it('obsOutputWindowTitle names the output window after the compose scene', () => {
    expect(obsOutputWindowTitle('Main Output')).toBe('vspark – Main Output');
  });
});
