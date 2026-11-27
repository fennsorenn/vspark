/**
 * A plugin's placeable composite, declared in its shared module as a feed
 * layer (template + css + box, optional logic graph), turned into the same
 * preset payload the built-in composites use.
 */
import type { GraphNodeDescriptor } from '@vspark/shared/signal';
import {
  composeLayer,
  composeLayerPreset,
  graph,
  ref,
  type EdgeKind,
} from '../presets/builtin_presets/helpers.js';
import type { BuiltinComposite } from '../presets/builtin_presets/composites.js';

export interface FeedCompositePreset {
  /** Composite type it instantiates (`<pluginId>_…`). */
  type: string;
  /** i18n keys in the plugin namespace (resolved to English for the list). */
  name: string;
  description: string;
  template: string;
  css: string;
  box: { x: number; y: number; width: number; height: number };
  /** Optional graph owned by the layer, role `flow`. Edges name their
   *  transport (`kind`) like the built-in composite payloads. */
  flow?: {
    nodes: GraphNodeDescriptor[];
    edges: Array<{ fromNodeId: string; fromPort: string; toNodeId: string; toPort: string; kind: EdgeKind }>;
  };
}

/** Preset id of a plugin composite. Shared with the editor's palette entry. */
export const pluginCompositePresetId = (pluginId: string, type: string) =>
  `plugin:${pluginId}:${type}`;

export function feedCompositePayload(
  pluginId: string,
  p: FeedCompositePreset,
  text: (key: string) => string
): BuiltinComposite {
  const parts: Record<string, string> = { panel: 'l1', ...(p.flow ? { flow: 'g1' } : {}) };
  const marker = {
    type: p.type,
    parts: Object.fromEntries(Object.entries(parts).map(([role, id]) => [role, ref(id)])),
  };
  const name = text(p.name);
  return {
    ...composeLayerPreset(
      pluginCompositePresetId(pluginId, p.type),
      name,
      text(p.description),
      [
        composeLayer('l1', null, name, 'feed', {
          config: { template: p.template, css: p.css, composite: marker },
          ...p.box,
          anchorH: 'left',
          anchorV: 'top',
        }),
      ],
      p.flow
        ? { logic: [graph('g1', 'compose_layer', 'l1', name, p.flow.nodes, p.flow.edges)] }
        : {}
    ),
    composite: p.type,
  };
}
