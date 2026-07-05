/**
 * Macro Action Registry — the set of "what happens" actions a macro can run,
 * each a bidirectional {@link MacroActionDef} (see types.ts + dev-notes/plans/macro-ui.md).
 *
 * Every action here is a SINGLE signal node whose fields map straight onto its
 * `defaultConfig` (the node's value-input ports fall back to config, so the
 * inline form edits config). That shape makes `match`/`build` trivially inverse.
 * Richer actions (multi-node chains) would supply their own match/build.
 */

import type {
  MacroActionDef,
  MacroActionValues,
  MacroField,
} from './types.js';

/**
 * Build a def for an action backed by one node whose fields ARE its config keys
 * (`field.key === defaultConfig key`).
 *
 * Losslessness rule: `match` claims the node only if the ONLY wiring into it is
 * the trigger edge (into `entryPort`). Any other incoming edge means a wired
 * value the inline form can't represent → the projection falls back to an
 * opaque "Custom" row rather than a lossy one.
 */
function singleNodeAction(spec: {
  id: string;
  nodeKind: string;
  entryPort?: string;
  fields: MacroField[];
}): MacroActionDef {
  const entryPort = spec.entryPort ?? 'fire';
  return {
    id: spec.id,
    labelKey: `macros.action.${spec.id}`,
    nodeKind: spec.nodeKind,
    entryPort,
    fields: spec.fields,
    match(node, descriptor) {
      if (node.kind !== spec.nodeKind) return null;
      for (const e of descriptor.edges) {
        if (e.toNodeId === node.id && e.toPort !== entryPort) return null;
      }
      const cfg = node.defaultConfig ?? {};
      const values: MacroActionValues = {};
      for (const f of spec.fields) {
        values[f.key] = cfg[f.key] as MacroActionValues[string];
      }
      return values;
    },
    build(values, makeId) {
      const id = makeId();
      const defaultConfig: Record<string, unknown> = {};
      for (const f of spec.fields) {
        const v = values[f.key];
        if (v !== undefined) defaultConfig[f.key] = v;
      }
      return {
        nodes: [
          { id, kind: spec.nodeKind, position: { x: 0, y: 0 }, defaultConfig },
        ],
        edges: [],
        entryNodeId: id,
        entryPort,
      };
    },
  };
}

// ── The v1 action set ─────────────────────────────────────────────────────────

/** Play a track clip. */
const playClip = singleNodeAction({
  id: 'play_clip',
  nodeKind: 'start_clip',
  fields: [
    { key: 'clipId', labelKey: 'macros.field.clip', control: 'clip', port: 'clipId' },
  ],
});

/** Set a VRM expression weight on an avatar. */
const setExpression = singleNodeAction({
  id: 'set_expression',
  nodeKind: 'set_expression',
  fields: [
    { key: 'nodeId', labelKey: 'macros.field.avatar', control: 'sceneNode', port: 'nodeId' },
    { key: 'expression', labelKey: 'macros.field.expression', control: 'expression', port: 'expression' },
    { key: 'weight', labelKey: 'macros.field.weight', control: 'number', port: 'weight', min: 0, max: 1, step: 0.05 },
  ],
});

/** Set any registered scene-node property (visibility, opacity, transform, text…). */
const setProperty = singleNodeAction({
  id: 'set_property',
  nodeKind: 'set_scene_node_param',
  fields: [
    { key: 'targetId', labelKey: 'macros.field.target', control: 'sceneNode', port: 'targetId' },
    { key: 'paramPath', labelKey: 'macros.field.property', control: 'paramPath', port: 'paramPath' },
    { key: 'value', labelKey: 'macros.field.value', control: 'string', port: 'value' },
  ],
});

/** Play / pause / stop / restart a video or audio entity. */
const controlMedia = singleNodeAction({
  id: 'control_media',
  nodeKind: 'media_control',
  fields: [
    { key: 'target', labelKey: 'macros.field.target', control: 'sceneEntity', port: 'target' },
    {
      key: 'action',
      labelKey: 'macros.field.action',
      control: 'enum',
      options: [
        { value: 'play', labelKey: 'macros.mediaAction.play' },
        { value: 'pause', labelKey: 'macros.mediaAction.pause' },
        { value: 'stop', labelKey: 'macros.mediaAction.stop' },
        { value: 'restart', labelKey: 'macros.mediaAction.restart' },
        { value: 'mute', labelKey: 'macros.mediaAction.mute' },
        { value: 'unmute', labelKey: 'macros.mediaAction.unmute' },
      ],
    },
  ],
});

export const MACRO_ACTION_DEFS: readonly MacroActionDef[] = [
  playClip,
  setExpression,
  setProperty,
  controlMedia,
];

const BY_ID = new Map(MACRO_ACTION_DEFS.map((d) => [d.id, d]));

export function macroActionById(id: string): MacroActionDef | undefined {
  return BY_ID.get(id);
}

/**
 * Find the def that implements a node kind entered through a given port —
 * used by the projection to read a sink node back into an action. Returns
 * undefined if no def matches (→ the row is opaque).
 */
export function macroActionForNode(
  nodeKind: string,
  entryPort: string
): MacroActionDef | undefined {
  return MACRO_ACTION_DEFS.find(
    (d) => d.nodeKind === nodeKind && d.entryPort === entryPort
  );
}
