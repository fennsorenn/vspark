# @vspark/plugin-sdk

TypeScript typings of the [vspark](https://github.com/fennsorenn/vspark) plugin
API (`apiVersion` 1). **Types only:** vspark injects the SDK into each entry
module's default-exported factory at runtime, so plugin code imports nothing
but types from here:

```ts
import type { BackendFactory } from '@vspark/plugin-sdk';

const plugin: BackendFactory = (sdk) => {
  const { Node, SignalNode, eventIn } = sdk.signal; // the host's own classes
  // … define node classes here, then:
  return { activate(ctx) { /* ctx.nodes.register(…) */ } };
};
export default plugin;
```

Start a plugin from the `vspark_plugin_template` repository. The package
major version follows `apiVersion`.
