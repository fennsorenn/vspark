import { describe, it, expect } from 'vitest';
import { obsOutputWindowTitle } from '../src/types.js';

describe('types', () => {
  it('obsOutputWindowTitle names the output window after the compose scene', () => {
    expect(obsOutputWindowTitle('Main Output')).toBe('vspark – Main Output');
  });
});
