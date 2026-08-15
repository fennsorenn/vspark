import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { resetDb } from './helpers/testDb.js';
import { ObsWsManager } from '../src/obs/ws_manager.js';
import { logicManager } from '../src/logic/manager.js';
import type { WSSync } from '../src/ws/index.js';

/**
 * ObsWsManager — connection lifecycle, status broadcast, event fan-out, and
 * outbound requests, using a fake obs-websocket client + an in-memory DB.
 */

class FakeClient extends EventEmitter {
  identified = false;
  connect = vi.fn();
  close = vi.fn();
  request = vi.fn(async () => ({}) as Record<string, unknown>);
  /** Simulate a completed handshake. */
  goLive() {
    this.identified = true;
    this.emit('identified');
  }
}

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

async function insertConnection(projectId = 'p1', id = 'c1') {
  const { getDb } = await import('../src/db/index.js');
  getDb()
    .prepare('INSERT INTO projects (id, name) VALUES (?, ?)')
    .run(projectId, 'Test');
  getDb()
    .prepare(
      'INSERT INTO obs_connections (id, project_id, label, host, port, password, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)'
    )
    .run(id, projectId, 'OBS', 'localhost', 4455, '');
}

let fake: FakeClient;

beforeEach(async () => {
  await resetDb();
  fake = new FakeClient();
});
afterEach(() => vi.restoreAllMocks());

describe('ObsWsManager connection status', () => {
  it('broadcasts connecting then connected across the handshake', async () => {
    await insertConnection();
    vi.spyOn(logicManager, 'iterateNodes').mockReturnValue(
      [] as unknown as ReturnType<typeof logicManager.iterateNodes>
    );
    const { ws, broadcasts } = makeWsStub();
    const mgr = new ObsWsManager(ws, () => fake);

    mgr.refreshProject('p1');
    expect(fake.connect).toHaveBeenCalled();
    expect(broadcasts.at(-1)).toMatchObject({
      kind: 'obs_connection_status',
      payload: { projectId: 'p1', status: 'connecting' },
    });

    fake.goLive();
    expect(broadcasts.at(-1)).toMatchObject({
      kind: 'obs_connection_status',
      payload: { projectId: 'p1', status: 'connected' },
    });
    expect(mgr.isConnected('p1')).toBe(true);
  });

  it('fires obs_connection_state nodes on connect', async () => {
    await insertConnection();
    const fire = vi.spyOn(logicManager, 'fire').mockImplementation(() => {});
    vi.spyOn(logicManager, 'iterateNodes').mockReturnValue([
      { graphId: 'g', node: { id: 'cs', kind: 'obs_connection_state' }, projectId: 'p1' },
    ] as unknown as ReturnType<typeof logicManager.iterateNodes>);
    const mgr = new ObsWsManager(makeWsStub().ws, () => fake);
    mgr.refreshProject('p1');
    fake.goLive();
    expect(fire).toHaveBeenCalledWith(
      'g',
      'cs',
      'event',
      expect.objectContaining({ payload: { connected: true } })
    );
  });
});

describe('ObsWsManager event routing', () => {
  it('routes InputVolumeChanged into obs_volume_changed nodes', async () => {
    await insertConnection();
    const fire = vi.spyOn(logicManager, 'fire').mockImplementation(() => {});
    vi.spyOn(logicManager, 'iterateNodes').mockReturnValue([
      { graphId: 'g', node: { id: 'v', kind: 'obs_volume_changed' }, projectId: 'p1' },
    ] as unknown as ReturnType<typeof logicManager.iterateNodes>);
    const mgr = new ObsWsManager(makeWsStub().ws, () => fake);
    mgr.refreshProject('p1');
    fake.goLive();

    fake.emit('obsEvent', 'InputVolumeChanged', {
      inputName: 'Mic',
      inputVolumeMul: 0.5,
      inputVolumeDb: -6,
    });
    expect(fire).toHaveBeenCalledWith(
      'g',
      'v',
      'event',
      expect.objectContaining({
        payload: { input: 'Mic', mul: 0.5, db: -6 },
      })
    );
  });
});

describe('ObsWsManager scene + output events', () => {
  /** Connect, then hand back the `fire` spy and the live manager. */
  async function live(kind: string, nodeId = 'n') {
    await insertConnection();
    const fire = vi.spyOn(logicManager, 'fire').mockImplementation(() => {});
    vi.spyOn(logicManager, 'iterateNodes').mockReturnValue([
      { graphId: 'g', node: { id: nodeId, kind }, projectId: 'p1' },
    ] as unknown as ReturnType<typeof logicManager.iterateNodes>);
    const mgr = new ObsWsManager(makeWsStub().ws, () => fake);
    mgr.refreshProject('p1');
    fake.goLive();
    return { fire, mgr };
  }

  it('routes CurrentProgramSceneChanged with the cached canvas size', async () => {
    fake.request.mockResolvedValue({ baseWidth: 1920, baseHeight: 1080 });
    const { fire } = await live('obs_scene_changed');
    // Let the connect-time GetVideoSettings resolve.
    await new Promise((r) => setTimeout(r, 0));

    fake.emit('obsEvent', 'CurrentProgramSceneChanged', { sceneName: 'Intro' });
    expect(fire).toHaveBeenCalledWith(
      'g',
      'n',
      'event',
      expect.objectContaining({
        payload: {
          type: 'scene_changed',
          name: 'Intro',
          width: 1920,
          height: 1080,
        },
      })
    );
  });

  it('falls back to a 0×0 canvas when GetVideoSettings fails', async () => {
    fake.request.mockRejectedValue(new Error('nope'));
    const { fire } = await live('obs_scene_changed');
    await new Promise((r) => setTimeout(r, 0));

    fake.emit('obsEvent', 'CurrentProgramSceneChanged', { sceneName: 'Cam' });
    expect(fire).toHaveBeenCalledWith(
      'g',
      'n',
      'event',
      expect.objectContaining({
        payload: { type: 'scene_changed', name: 'Cam', width: 0, height: 0 },
      })
    );
  });

  it('folds output run-state events into the output_state shape', async () => {
    const { fire } = await live('obs_output_state');

    fake.emit('obsEvent', 'RecordStateChanged', {
      outputActive: true,
      outputState: 'OBS_WEBSOCKET_OUTPUT_PAUSED',
    });
    expect(fire).toHaveBeenLastCalledWith(
      'g',
      'n',
      'event',
      expect.objectContaining({
        payload: {
          type: 'output_state',
          output: 'recording',
          state: 'paused',
          active: true,
        },
      })
    );

    fake.emit('obsEvent', 'StreamStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
    });
    expect(fire).toHaveBeenLastCalledWith(
      'g',
      'n',
      'event',
      expect.objectContaining({
        payload: {
          type: 'output_state',
          output: 'streaming',
          state: 'stopped',
          active: false,
        },
      })
    );
  });

  it('maps ReplayBufferSaved onto the saved state', async () => {
    const { fire } = await live('obs_output_state');
    fake.emit('obsEvent', 'ReplayBufferSaved', {
      savedReplayPath: '/clips/x.mp4',
    });
    expect(fire).toHaveBeenLastCalledWith(
      'g',
      'n',
      'event',
      expect.objectContaining({
        payload: {
          type: 'output_state',
          output: 'replay',
          state: 'saved',
          active: true,
        },
      })
    );
  });

  it('drops run-states with no slot in the node vocabulary', async () => {
    const { fire } = await live('obs_output_state');
    fake.emit('obsEvent', 'StreamStateChanged', {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_RECONNECTING',
    });
    expect(fire).not.toHaveBeenCalled();
  });

  it('delivers one fire per event — no cross-source duplication', async () => {
    const { fire } = await live('obs_scene_changed');
    fake.emit('obsEvent', 'CurrentProgramSceneChanged', { sceneName: 'Intro' });
    fake.emit('obsEvent', 'CurrentProgramSceneChanged', { sceneName: 'Intro' });
    // Two OBS events → two fires: there is a single connection, so the browser
    // bridge's 400ms dedup window has nothing left to guard against.
    expect(fire).toHaveBeenCalledTimes(2);
  });
});

describe('ObsWsManager outbound requests', () => {
  beforeEach(() => {
    vi.spyOn(logicManager, 'iterateNodes').mockReturnValue(
      [] as unknown as ReturnType<typeof logicManager.iterateNodes>
    );
  });

  async function connected() {
    await insertConnection();
    const mgr = new ObsWsManager(makeWsStub().ws, () => fake);
    mgr.refreshProject('p1');
    fake.goLive();
    return mgr;
  }

  it('setVolume issues SetInputVolume with dB', async () => {
    const mgr = await connected();
    mgr.setVolume('p1', 'Mic', { db: -12 });
    expect(fake.request).toHaveBeenCalledWith('SetInputVolume', {
      inputName: 'Mic',
      inputVolumeDb: -12,
    });
  });

  it('setMute toggle issues ToggleInputMute', async () => {
    const mgr = await connected();
    mgr.setMute('p1', 'Mic', 'toggle');
    expect(fake.request).toHaveBeenCalledWith('ToggleInputMute', {
      inputName: 'Mic',
    });
  });

  it('setMute mute issues SetInputMute', async () => {
    const mgr = await connected();
    mgr.setMute('p1', 'Mic', 'mute');
    expect(fake.request).toHaveBeenCalledWith('SetInputMute', {
      inputName: 'Mic',
      inputMuted: true,
    });
  });

  it('setScene issues SetCurrentProgramScene', async () => {
    const mgr = await connected();
    mgr.setScene('p1', 'Intro');
    expect(fake.request).toHaveBeenCalledWith('SetCurrentProgramScene', {
      sceneName: 'Intro',
    });
  });

  it('setTransition issues SetCurrentSceneTransition', async () => {
    const mgr = await connected();
    mgr.setTransition('p1', 'Fade');
    expect(fake.request).toHaveBeenCalledWith('SetCurrentSceneTransition', {
      transitionName: 'Fade',
    });
  });

  it('control maps a verb onto its obs-websocket request', async () => {
    const mgr = await connected();
    mgr.control('p1', 'saveReplayBuffer');
    expect(fake.request).toHaveBeenCalledWith('SaveReplayBuffer');
    mgr.control('p1', 'unpauseRecording');
    expect(fake.request).toHaveBeenCalledWith('ResumeRecord');
  });

  it('setScene with an empty name warns instead of requesting', async () => {
    const mgr = await connected();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mgr.setScene('p1', '   ');
    // GetVideoSettings fires on connect, so assert on the scene request only.
    expect(fake.request).not.toHaveBeenCalledWith(
      'SetCurrentProgramScene',
      expect.anything()
    );
    expect(warn.mock.calls[0]?.[0]).toContain('SetCurrentProgramScene');
  });

  it('setScene without a connection warns instead of requesting', async () => {
    const mgr = new ObsWsManager(makeWsStub().ws, () => fake);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mgr.setScene('p1', 'Intro');
    expect(fake.request).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toContain('has no OBS connection');
  });

  it('getLastReplayPath returns savedReplayPath', async () => {
    const mgr = await connected();
    fake.request.mockResolvedValueOnce({ savedReplayPath: '/clips/x.mp4' });
    await expect(mgr.getLastReplayPath('p1')).resolves.toBe('/clips/x.mp4');
  });

  it('no-ops when the project has no live connection', async () => {
    const mgr = new ObsWsManager(makeWsStub().ws, () => fake);
    mgr.setVolume('p1', 'Mic', { db: 0 });
    expect(fake.request).not.toHaveBeenCalled();
  });
});
