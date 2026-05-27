import {
  SignalNode,
  eventPort,
  valuePort,
  mkEvent,
} from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
} from '@vspark/shared/signal';

interface ClockConfig {
  /** Tick rate in Hz. Default 60. */
  hz?: number;
}

@SignalNode({
  label: 'Clock',
  description:
    'Fires a trigger at a configurable interval. Connect the interval value port to control Hz, or set it via config.',
  tags: ['source'],
  color: '#4a7a5a',
})
export class Clock {
  static readonly kind = 'clock';
  static readonly inputPorts = [valuePort('hz', 'Float')] as const;
  static readonly outputPorts = [eventPort('tick', 'Trigger')] as const;

  static execute(
    _inputs: InputsOf<typeof Clock>,
    _config: unknown,
    _ctx: NodeExecutionContext
  ): OutputsOf<typeof Clock> {
    return { tick: mkEvent(undefined) };
  }

  /**
   * Called by the component host after graph construction.
   * Reads hz from node state (updated by the graph when the hz value port
   * changes) or falls back to config default.
   * Returns a cleanup function to call on graph teardown.
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
