import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { ObsManager } from '../src/obs/manager.js';
import { logicManager } from '../src/logic/manager.js';
import type { WSSync } from '../src/ws/index.js';

/**
 * ObsManager — the OBS browser-source bridge. Routing fan-out is exercised by
 * stubbing logicManager (iterateNodes/fire); command fan-out and client
 * counting are exercised against a WSSync stub.
 */

function makeWsStub() {
  const broadcasts: Array<{ kind: string; payload: Record<string, unknown> }> =
    [];
  const ws = {
    broadcast(kind: string, payload: Record<string, unknown>) {
      broadcasts.push({ kind, payload });
    },
  } as unknown as WSSync;
  return { ws, broadcasts };
}

/** Two distinct objects usable as WebSocket map keys. */
const sockA = {} as WebSocket;
const sockB = {} as WebSocket;

const SCENE_EVENT = {
  type: 'scene_changed' as const,
  name: 'Intro',
  width: 1920,
  height: 1080,
};

describe('ObsManager.command', () => {
  it('broadcasts obs_command with the command payload', () => {
    const { ws, broadcasts } = makeWsStub();
    const mgr = new ObsManager(ws);
    mgr.command({ verb: 'saveReplayBuffer' });
    expect(broadcasts).toEqual([
      { kind: 'obs_command', payload: { command: { verb: 'saveReplayBuffer' } } },
    ]);
  });
});

describe('ObsManager event routing', () => {
  let fire: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fire = vi.spyOn(logicManager, 'fire').mockImplementation(() => {});
    vi.spyOn(logicManager, 'iterateNodes').mockReturnValue(
      [
        { graphId: 'g1', node: { id: 'a', kind: 'obs_scene_changed' }, projectId: 'p1' },
        { graphId: 'g1', node: { id: 'b', kind: 'obs_output_state' }, projectId: 'p1' },
      ] as unknown as ReturnType<typeof logicManager.iterateNodes>
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('delivers an event only to nodes of the matching kind', () => {
    const mgr = new ObsManager();
    mgr.handleEvent(sockA, SCENE_EVENT);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith('g1', 'a', 'event', expect.anything());
  });

  it('de-duplicates an identical event seen again within the window', () => {
    const mgr = new ObsManager();
    mgr.handleEvent(sockA, SCENE_EVENT);
    mgr.handleEvent(sockB, SCENE_EVENT); // same event from another source
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('does not de-duplicate distinct events', () => {
    const mgr = new ObsManager();
    mgr.handleEvent(sockA, SCENE_EVENT);
    mgr.handleEvent(sockA, { ...SCENE_EVENT, name: 'Outro' });
    expect(fire).toHaveBeenCalledTimes(2);
  });
});

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
