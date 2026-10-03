import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { ObsManager } from '../src/obs/manager.js';
import { logicManager } from '../src/logic/manager.js';

/**
 * ObsManager — render-client lifecycle bookkeeping. Fan-out is exercised by
 * stubbing logicManager (iterateNodes/fire).
 *
 * OBS event routing and control commands used to live here too; they moved to
 * obs-websocket — see obs.ws_manager.test.ts.
 */

/** Two distinct objects usable as WebSocket map keys. */
const sockA = {} as WebSocket;
const sockB = {} as WebSocket;

describe('ObsManager client lifecycle', () => {
  beforeEach(() => {
    vi.spyOn(logicManager, 'fire').mockImplementation(() => {});
    vi.spyOn(logicManager, 'iterateNodes').mockReturnValue(
      [] as unknown as ReturnType<typeof logicManager.iterateNodes>
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('tracks per-project client count across connect/disconnect', () => {
    const mgr = new ObsManager();
    mgr.handleHello(sockA, 'p1', 'main');
    mgr.handleHello(sockB, 'p1', 'overlay');
    expect(mgr.clientCount('p1')).toBe(2);
    mgr.handleClientGone(sockA);
    expect(mgr.clientCount('p1')).toBe(1);
  });

  it('a disconnect for an unknown socket is a no-op', () => {
    const mgr = new ObsManager();
    expect(() => mgr.handleClientGone(sockA)).not.toThrow();
    expect(mgr.clientCount('p1')).toBe(0);
  });

  it('fires the client_lifecycle event on hello with phase + count', () => {
    const mgr = new ObsManager();
    const lifecycleNode = [
      { graphId: 'g', node: { id: 'cl', kind: 'client_lifecycle' }, projectId: 'p1' },
    ] as unknown as ReturnType<typeof logicManager.iterateNodes>;
    vi.spyOn(logicManager, 'iterateNodes').mockReturnValue(lifecycleNode);
    const fire = vi.spyOn(logicManager, 'fire').mockImplementation(() => {});
    mgr.handleHello(sockA, 'p1', 'main');
    expect(fire).toHaveBeenCalledWith(
      'g',
      'cl',
      'event',
      expect.objectContaining({
        payload: { phase: 'connected', target: 'main', count: 1 },
      })
    );
  });
});
