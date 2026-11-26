/**
 * LipsyncManager publishes its server-side capture state as the behavior's
 * `server_status` document (what the editor's status row and the scene
 * graph's connection dot read), and drops it when the capture stops.
 * `parec` is replaced by a fake child process; the status module is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const { publishTracking, clearStatus } = vi.hoisted(() => ({
  publishTracking: vi.fn(),
  clearStatus: vi.fn(),
}));
vi.mock('../src/mesh/status.js', () => ({ publishTracking, clearStatus }));

import { LipsyncManager } from '../src/behaviors/lipsync/manager.js';
import type { SpawnFn } from '../src/behaviors/lipsync/pipewireCapture.js';
import { runMigrations, closeDb } from '../src/db/index.js';

beforeEach(async () => {
  process.env.VSPARK_DB_PATH = ':memory:';
  closeDb();
  await runMigrations();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  publishTracking.mockClear();
  clearStatus.mockClear();
});
afterEach(() => vi.restoreAllMocks());

function manager() {
  const children: (EventEmitter & { stdout: EventEmitter })[] = [];
  const spawn = (() => {
    const c = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    children.push(c);
    return c;
  }) as unknown as SpawnFn;
  return { mgr: new LipsyncManager(spawn), children };
}

const comp = (config: Record<string, unknown>) => ({
  id: 'ls1',
  nodeId: 'node1',
  kind: 'lipsync_processor',
  enabled: true,
  config,
});

describe('LipsyncManager capture status', () => {
  it('publishes the capture state on the behavior and clears it on stop', () => {
    const { mgr, children } = manager();
    mgr.syncBehaviors([
      comp({ inputMode: 'pipewire', pipewireSource: 'vmic.monitor' }),
    ]);
    expect(publishTracking).toHaveBeenLastCalledWith({
      behaviorId: 'ls1',
      connected: false,
      capture: { state: 'starting' },
    });

    // Sound (a 300 Hz tone), not just samples, reads as capturing.
    const n = 1600 * 3;
    const tone = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++)
      tone.writeFloatLE(0.3 * Math.sin((2 * Math.PI * 300 * i) / 48000), i * 4);
    children[0].stdout.emit('data', tone);
    expect(publishTracking).toHaveBeenLastCalledWith({
      behaviorId: 'ls1',
      connected: true,
      capture: { state: 'capturing' },
    });

    // Back to browser input: the capture and its status go away.
    mgr.syncBehaviors([comp({ inputMode: 'browser' })]);
    expect(clearStatus).toHaveBeenCalledWith('tracking', 'ls1');
    mgr.close();
  });

  it('publishes nothing for browser input', () => {
    const { mgr } = manager();
    mgr.syncBehaviors([comp({ inputMode: 'browser' })]);
    expect(publishTracking).not.toHaveBeenCalled();
    mgr.close();
  });
});
