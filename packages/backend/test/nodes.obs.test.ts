import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loneNode } from './helpers/nodeHarness.js';

/**
 * OBS browser-source bridge nodes.
 *
 * Source nodes (obs_scene_changed / obs_output_state / client_lifecycle) share
 * the overlive shape: an `@eventIn('event')` handler maps the payload onto node
 * state (applying config filters) and re-emits. Outputs read from state.
 *
 * Action nodes (obs_set_scene / obs_set_transition / obs_control) call
 * getObsManager().command(...) on `fire` — mocked here so the call is
 * observable.
 */

const command = vi.fn();
vi.mock('../src/obs/manager.js', () => ({
  getObsManager: () => ({ command }),
}));

beforeEach(() => command.mockClear());

describe('obs_scene_changed', () => {
  it('maps name/width/height from the payload', () => {
    const n = loneNode('obs_scene_changed');
    n.deliver('event', {
      type: 'scene_changed',
      name: 'Intro',
      width: 1920,
      height: 1080,
    });
    expect(n.state()).toEqual({ name: 'Intro', width: 1920, height: 1080 });
  });

  it('defaults missing dimensions to 0', () => {
    const n = loneNode('obs_scene_changed');
    n.deliver('event', { type: 'scene_changed', name: 'Cam' });
    expect(n.state()).toEqual({ name: 'Cam', width: 0, height: 0 });
  });

  it('onlyScene filter drops non-matching scenes', () => {
    const n = loneNode('obs_scene_changed', { onlyScene: 'Intro' });
    n.deliver('event', { type: 'scene_changed', name: 'Outro' });
    expect(n.state()).toBeUndefined();
  });

  it('a probe (undefined payload) emits without setting state', () => {
    const n = loneNode('obs_scene_changed');
    n.deliver('event', undefined);
    expect(n.state()).toBeUndefined();
  });
});

describe('obs_output_state', () => {
  it('maps output/state/active', () => {
    const n = loneNode('obs_output_state');
    n.deliver('event', {
      type: 'output_state',
      output: 'recording',
      state: 'started',
      active: true,
    });
    expect(n.state()).toEqual({
      output: 'recording',
      state: 'started',
      active: true,
    });
  });

  it('onlyOutput filter drops other outputs', () => {
    const n = loneNode('obs_output_state', { onlyOutput: 'streaming' });
    n.deliver('event', {
      type: 'output_state',
      output: 'replay',
      state: 'saved',
      active: true,
    });
    expect(n.state()).toBeUndefined();
  });
});

describe('client_lifecycle', () => {
  it('records target + count on connect', () => {
    const n = loneNode('client_lifecycle');
    n.deliver('event', { phase: 'connected', target: 'main', count: 2 });
    expect(n.state()).toEqual({ target: 'main', count: 2 });
  });

  it('updates state on disconnect too', () => {
    const n = loneNode('client_lifecycle');
    n.deliver('event', { phase: 'disconnected', target: 'main', count: 0 });
    expect(n.state()).toEqual({ target: 'main', count: 0 });
  });

  it('onlyTarget filter ignores other targets', () => {
    const n = loneNode('client_lifecycle', { onlyTarget: 'overlay' });
    n.deliver('event', { phase: 'connected', target: 'main', count: 1 });
    expect(n.state()).toBeUndefined();
  });
});

// obs_set_scene moved onto obs-websocket — see nodes.obs.ws.test.ts.

describe('obs_set_transition', () => {
  it('issues setCurrentTransition with the config name', () => {
    const n = loneNode('obs_set_transition', { transition: 'Fade' });
    n.deliver('fire', undefined);
    expect(command).toHaveBeenCalledWith({
      verb: 'setCurrentTransition',
      arg: 'Fade',
    });
  });
});

describe('obs_control', () => {
  it('issues a whitelisted arg-less verb', () => {
    const n = loneNode('obs_control', { action: 'saveReplayBuffer' });
    n.deliver('fire', undefined);
    expect(command).toHaveBeenCalledWith({ verb: 'saveReplayBuffer' });
  });

  it('ignores an unknown action', () => {
    const n = loneNode('obs_control', { action: 'launchMissiles' });
    n.deliver('fire', undefined);
    expect(command).not.toHaveBeenCalled();
  });
});
