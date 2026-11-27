// Type-level check: a minimal plugin written against the SDK must compile.
// Not shipped (see package.json "files").
import type { BackendFactory, Emitter, SharedFactory } from '../index.js';

export const shared: SharedFactory = (sdk) => ({
  responseTypes: {
    example_ping: { nodeKind: 'example_ping', entryPort: 'fire', fields: [], form: [], label: 'response.ping' },
  },
  actionKinds: [
    {
      kind: 'example_wave',
      label: 'Wave',
      icon: '👋',
      fields: [{ path: 'mode', class: 'shape' }],
      form: [{ path: 'mode', control: 'select', label: 'field.mode', options: ['a', 'b'] }],
      defaults: () => ({ mode: 'a' }),
      normalize: (raw) => ({ mode: (raw as { mode?: string })?.mode ?? 'a' }),
      build: () => {
        const b = new sdk.actions.Tpl();
        b.node('t', sdk.actions.sources.namedTrigger, 0, 0);
        return b.out();
      },
      preview: () => ({ headline: [{ t: 'text', text: 'wave' }], lines: [] }),
    },
  ],
});

export const backend: BackendFactory = (sdk) => {
  const { Node, SignalNode, eventIn, eventOut } = sdk.signal;

  @SignalNode({ label: 'Example: Ping', tags: ['example'], color: '#336699' })
  class ExamplePing extends Node {
    static readonly kind = 'example_ping';
    @eventOut('done', 'Trigger') done!: Emitter<void>;
    @eventIn('fire', 'Trigger')
    onFire(): void {
      this.done.emit(undefined);
    }
  }

  return {
    activate(ctx) {
      ctx.nodes.register(ExamplePing);
      ctx.data.publish('p', { examplePing: 1 });
      ctx.onDispose(() => ctx.log.info('bye'));
    },
  };
};
