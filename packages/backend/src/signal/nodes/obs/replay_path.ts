import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, eventOut, valueOut } from '@vspark/shared/node_decorators';
import { getObsWsManager } from '../../../obs/ws_manager.js';

interface ReplayOut {
  path: string;
}

const EMPTY: ReplayOut = { path: '' };

/**
 * On `fire`, asks OBS for the last saved replay-buffer file path over
 * obs-websocket (`GetLastReplayBufferReplay`), then emits `done` with the path
 * on the `path` output. Pairs with the browser-source `obs_output_state` replay
 * `saved` event (which signals *that* a clip saved but not *where*). Requires an
 * OBS connection for the project.
 */
@SignalNode({
  label: 'OBS Replay Path',
  description:
    'Fetch the last saved replay-buffer file path over obs-websocket. Needs an OBS connection.',
  tags: ['obs'],
  color: '#5a3a5a',
})
export class ObsReplayPath extends Node {
  static readonly kind = 'obs_replay_path';

  @eventOut('done', 'Trigger') done!: Emitter<void>;
  @valueOut('path', 'String') pathOut = (): string => this._out().path;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const cfg = (this.config ?? {}) as { _projectId?: string };
    const projectId = cfg._projectId ?? '';
    if (!projectId) return;
    void getObsWsManager()
      .getLastReplayPath(projectId)
      .then((path) => {
        this.setState({ path } satisfies ReplayOut);
        this.done.emit(undefined);
      });
  }

  private _out(): ReplayOut {
    return this.getState<ReplayOut>() ?? EMPTY;
  }
}
