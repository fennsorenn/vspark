// Fixture: a plugin's shared module (factory receives the injected SDK).
export default function shared(sdk: any) {
  const kind = {
    kind: 'hello_wave',
    label: 'Wave',
    icon: '👋',
    fields: [],
    form: [{ path: 'name', control: 'text', label: 'field.name' }],
    defaults: () => ({ name: '' }),
    normalize: (raw: any) => ({ name: typeof raw?.name === 'string' ? raw.name : '' }),
    build: () => {
      const b = new sdk.actions.Tpl();
      b.node('trigger', sdk.actions.sources.namedTrigger, 0, 0);
      b.setting('name', 'trigger', 'name', -280, 0);
      return b.out();
    },
    preview: (s: any) => ({ headline: [{ t: 'text', text: s.name || '—' }], lines: [] }),
  };
  return {
    responseTypes: {
      hello_greet: { nodeKind: 'hello_greet', entryPort: 'fire', fields: ['name'], label: 'response.greet', form: [{ path: 'name', control: 'text', label: 'field.name' }] },
    },
    actionKinds: [kind],
    compositeTypes: [{ type: 'hello_banner', rootRtype: 'compose_layer', parts: { panel: 'compose_layer' }, settings: [] }],
    compositePresets: [
      {
        type: 'hello_banner',
        name: 'composite.banner.name',
        description: 'composite.banner.description',
        template: '${helloGreeting ? html`<b>${helloGreeting}</b>` : null}',
        css: 'b { color: white; }',
        box: { x: 0, y: 0, width: 300, height: 80 },
      },
    ],
  };
}
