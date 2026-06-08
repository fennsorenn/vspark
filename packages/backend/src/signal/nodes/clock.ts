import { SignalNode, mkEvent } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { valueIn, eventOut } from '@vspark/shared/node_decorators';

/**
 * Fires a `tick` trigger at a configurable interval. The actual ticking is driven
 * out-of-band by `Clock.attach(...)` (a self-scheduling interval set up by the
 * component/graph manager); the node instance only declares the ports. `hz` is a
 * value input (wire it or set `config.hz`) read by the manager's `getHz` callback.
 */
@SignalNode({
  label: 'Clock',
  description:
    'Fires a trigger at a configurable interval. Connect the interval value port to control Hz, or set it via config.',
  tags: ["input"],
  color: '#4a7a5a',
})
export class Clock extends Node {
  static readonly kind = 'clock';

  @valueIn('hz', 'Float') hz!: () => number | undefined;
  @eventOut('tick', 'Trigger') tick!: Emitter<void>;

  /**
   * Called by the component host after graph construction. Reads hz from a manager
   * callback (updated when the hz value port changes) or falls back to the default.
   * Returns a cleanup function to call on graph teardown. Unchanged from the
   * pre-Phase-2 model — the ticking lives here, not in a node reaction.
   */
  static attach(
    graphNodeId: string,
    defaultHz: number,
    getHz: (graphNodeId: string) => number,
    fireEvent: (graphNodeId: string, port: string, value: unknown) => void
  ): () => void {
    let currentHz = defaultHz;
    let currentId: ReturnType<typeof setInterval>;

    const reschedule = () => {
      clearInterval(currentId);
      const intervalMs = Math.max(1, Math.round(1000 / currentHz));
      currentId = setInterval(() => {
        const hz = getHz(graphNodeId);
        if (hz !== currentHz && hz > 0) {
          currentHz = hz;
          reschedule();
          return;
        }
        fireEvent(graphNodeId, 'tick', mkEvent(undefined));
      }, intervalMs);
    };

    reschedule();
    return () => clearInterval(currentId);
  }
}
