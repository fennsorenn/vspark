import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { resetTestPeer, testHandles, testPeer } from './helpers/mesh';

// vitest isn't run with `globals: true`, so React Testing Library's automatic
// afterEach cleanup never registers — without this, mounted components from one
// test leak into the next and queries match multiple renders. Unmount after each.
afterEach(() => {
  cleanup();
  resetTestPeer();
});

// The app creates its tab peer before rendering; tests get a local one (see
// helpers/mesh.ts). A spec that needs a different peer mocks the module itself.
vi.mock('../src/mesh/peer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/mesh/peer')>()),
  getMeshHandles: () => testHandles(),
  meshBatch: <T>(fn: () => T): T => testPeer().batch(fn),
}));
