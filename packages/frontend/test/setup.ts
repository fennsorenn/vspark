import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// vitest isn't run with `globals: true`, so React Testing Library's automatic
// afterEach cleanup never registers — without this, mounted components from one
// test leak into the next and queries match multiple renders. Unmount after each.
afterEach(() => {
  cleanup();
});
