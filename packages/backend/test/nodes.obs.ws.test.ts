import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loneNode } from './helpers/nodeHarness.js';

/**
 * OBS power-tier (obs-websocket) nodes. Source nodes map events onto state like
 * the browser-bridge ones; action nodes call getObsWsManager() (mocked here).
 */

const setVolume = vi.fn();
const setMute = vi.fn();
const setScene = vi.fn();
const getLastReplayPath = vi.fn(async () => '/clips/last.mp4');
vi.mock('../src/obs/ws_manager.js', () => ({
  getObsWsManager: () => ({ setVolume, setMute, setScene, getLastReplayPath }),
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setVolume.mockClear();
  setMute.mockClear();
  setScene.mockClear();
  getLastReplayPath.mockClear();
});

describe('obs_volume_changed', () => {
  it('maps input/mul/db', () => {
    const n = loneNode('obs_volume_changed');
    n.deliver('event', { input: 'Mic', mul: 0.5, db: -6 });
    expect(n.state()).toEqual({ input: 'Mic', mul: 0.5, db: -6 });
  });

  it('onlyInput filter drops other inputs', () => {
    const n = loneNode('obs_volume_changed', { onlyInput: 'Mic' });
    n.deliver('event', { input: 'Music', mul: 1, db: 0 });
    expect(n.state()).toBeUndefined();
  });
});

describe('obs_mute_changed', () => {
  it('maps input/muted', () => {
    const n = loneNode('obs_mute_changed');
    n.deliver('event', { input: 'Mic', muted: true });
    expect(n.state()).toEqual({ input: 'Mic', muted: true });
  });
});

describe('obs_connection_state', () => {
  it('records the connected flag', () => {
    const n = loneNode('obs_connection_state');
    n.deliver('event', { connected: true });
    expect(n.state()).toEqual({ connected: true });
    n.deliver('event', { connected: false });
    expect(n.state()).toEqual({ connected: false });
  });
});

describe('obs_set_volume', () => {
  it('sends dB by default', () => {
    const n = loneNode('obs_set_volume', {
      _projectId: 'p1',
      inputName: 'Mic',
      value: -10,
    });
    n.deliver('fire', undefined);
    expect(setVolume).toHaveBeenCalledWith('p1', 'Mic', { db: -10 });
  });

  it('sends linear multiplier when mode=mul', () => {
    const n = loneNode('obs_set_volume', {
      _projectId: 'p1',
      inputName: 'Mic',
      mode: 'mul',
      value: 0.25,
    });
    n.deliver('fire', undefined);
    expect(setVolume).toHaveBeenCalledWith('p1', 'Mic', { mul: 0.25 });
  });

  it('no-ops without a project or input', () => {
    loneNode('obs_set_volume', { inputName: 'Mic', value: 0 }).deliver(
      'fire',
      undefined
    );
    loneNode('obs_set_volume', { _projectId: 'p1', value: 0 }).deliver(
      'fire',
      undefined
    );
    expect(setVolume).not.toHaveBeenCalled();
  });
});

describe('obs_mute', () => {
  it('toggles by default', () => {
    const n = loneNode('obs_mute', { _projectId: 'p1', inputName: 'Mic' });
    n.deliver('fire', undefined);
    expect(setMute).toHaveBeenCalledWith('p1', 'Mic', 'toggle');
  });

  it('honours the action config', () => {
    const n = loneNode('obs_mute', {
      _projectId: 'p1',
      inputName: 'Mic',
      action: 'mute',
    });
    n.deliver('fire', undefined);
    expect(setMute).toHaveBeenCalledWith('p1', 'Mic', 'mute');
  });
});

describe('obs_set_scene', () => {
  it('sets the scene from config', () => {
    const n = loneNode('obs_set_scene', { _projectId: 'p1', scene: 'Intro' });
    n.deliver('fire', undefined);
    expect(setScene).toHaveBeenCalledWith('p1', 'Intro');
  });

  it('passes an empty name through so the manager can name the reason', () => {
    const n = loneNode('obs_set_scene', { _projectId: 'p1' });
    n.deliver('fire', undefined);
    expect(setScene).toHaveBeenCalledWith('p1', '');
  });
});

describe('obs_replay_path', () => {
  it('fetches the path and stores it', async () => {
    const n = loneNode('obs_replay_path', { _projectId: 'p1' });
    n.deliver('fire', undefined);
    await flush();
    expect(getLastReplayPath).toHaveBeenCalledWith('p1');
    expect(n.state()).toEqual({ path: '/clips/last.mp4' });
  });

  it('no-ops without a project', () => {
    loneNode('obs_replay_path').deliver('fire', undefined);
    expect(getLastReplayPath).not.toHaveBeenCalled();
  });
});
