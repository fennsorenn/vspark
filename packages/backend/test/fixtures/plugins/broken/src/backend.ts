export default function backend(sdk: any) {
  const { Node, SignalNode } = sdk.signal;
  @SignalNode({ label: 'Broken', tags: [], color: '#000000' })
  class BrokenX extends Node {
    static readonly kind = 'broken_x';
  }
  return {
    activate(c: any) {
      c.nodes.register(BrokenX);
      c.onDispose(() => {
        (globalThis as any).__brokenDisposed = true;
      });
      throw new Error('boom');
    },
  };
}
