// Fixture: a plugin's backend module. Node classes use the injected SDK's
// decorators, defined inside the factory.
export default function backend(sdk: any) {
  const { Node, SignalNode, eventIn, eventOut, valueIn, valueOut } = sdk.signal;
  let ctx: any;

  @SignalNode({ label: 'Hello: Greet', tags: ['hello'], color: '#3a7a5a' })
  class HelloGreet extends Node {
    static readonly kind = 'hello_greet';
    @valueIn('name', 'String') name!: () => string | undefined;
    @eventOut('done', 'Trigger') done!: { emit(v: unknown): void };
    @valueOut('text', 'String') text = (): string => `Hello, ${this.name() ?? (this as any).config.name ?? ''}!`;
    @eventIn('fire', 'Trigger')
    onFire(): void {
      const projectId = (this as any).config._projectId;
      if (projectId) ctx.data.publish(projectId, { helloGreeting: this.text() });
      ctx.storage.set('greetings', (ctx.storage.get('greetings') ?? 0) + 1);
      this.done.emit(undefined);
    }
  }

  return {
    activate(c: any) {
      ctx = c;
      c.nodes.register(HelloGreet);
      c.http.router().get('/ping', (_req: any, res: any) => res.json({ pong: true, config: c.config }));
      c.accounts.defineProvider({
        id: 'svc',
        label: 'account.provider',
        auth: { kind: 'oauth_pkce', authorizeUrl: 'https://example.test/authorize', tokenUrl: 'https://example.test/token', scopes: ['a'], appFields: [{ path: 'clientId', control: 'text', label: 'account.clientId' }] },
        fetchIdentity: async (t: any) => ({ label: `user-${t.accessToken}`, identity: { token: t.accessToken } }),
      });
      (globalThis as any).__helloActivations = ((globalThis as any).__helloActivations ?? 0) + 1;
      c.onDispose(() => {
        (globalThis as any).__helloDisposed = true;
      });
    },
  };
}
