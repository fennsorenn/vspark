/**
 * Macro UI — shared types for the bidirectional projection over
 * `system_hotkey → action` logic graphs.
 *
 * The macro panel owns no state: rows are DERIVED from the logic descriptors
 * (see projection.ts) and edits write back into those same descriptors. Each
 * action is one {@link MacroActionDef} whose `match`/`build` pair are inverses —
 * that single pair is the read-back (graph → UI) AND the editor (UI → graph),
 * which is what makes the binding bidirectional. See dev-notes/plans/macro-ui.md.
 */

import type {
  GraphDescriptor,
  GraphNodeDescriptor,
  GraphEdgeDescriptor,
} from '@vspark/shared/signal';

/** The combo carried by a `system_hotkey` node's config. */
export interface HotkeyCombo {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/** How a field's value is edited in the inline action form (Stage 3 renders it). */
export type MacroFieldControl =
  | 'clip'
  | 'sceneNode'
  | 'composeLayer'
  | 'sceneEntity'
  | 'expression'
  | 'paramPath'
  | 'string'
  | 'number'
  | 'bool'
  | 'enum';

export interface MacroFieldOption {
  value: string;
  labelKey?: string;
}

export interface MacroField {
  /** Logical field name — the key in a MacroActionValues record. */
  key: string;
  /** i18n key for the field label. */
  labelKey: string;
  control: MacroFieldControl;
  /**
   * The node value-input PORT this field binds to (config-fallback edited
   * inline). When set, a wire into that port makes the action non-modelable
   * (the inline editor can't represent a wired value), so `match` bails to
   * keep the projection lossless. Omit for config-only fields (no port, e.g.
   * an enum stored only in defaultConfig) — those are never "wired".
   */
  port?: string;
  /** Fixed options for `control: 'enum'`. */
  options?: MacroFieldOption[];
  min?: number;
  max?: number;
  step?: number;
}

export type MacroFieldValue = string | number | boolean | undefined;
export type MacroActionValues = Record<string, MacroFieldValue>;

/** A concrete action: which definition + the field values pulled from its node. */
export interface MacroActionInstance {
  defId: string;
  values: MacroActionValues;
}

/** The node(s) + edges that implement an action, plus where the trigger wires in. */
export interface BuiltSubgraph {
  nodes: GraphNodeDescriptor[];
  edges: GraphEdgeDescriptor[];
  /** Node + event-input port the upstream trigger (hotkey / cycle output) wires into. */
  entryNodeId: string;
  entryPort: string;
}

export interface MacroActionDef {
  /** Stable id used in MacroActionInstance.defId + i18n keys. */
  id: string;
  labelKey: string;
  /** Signal-node kind this action is implemented by. */
  nodeKind: string;
  /** Event-input port the trigger wires into (all current actions use 'fire'). */
  entryPort: string;
  fields: MacroField[];
  /**
   * graph → UI. Extract field values from a candidate sink node, or return
   * `null` if this def does NOT losslessly describe it (wrong kind, or a bound
   * port is wired). A conservative `match` is what keeps the projection total:
   * anything it declines shows as an opaque "Custom" row rather than a wrong one.
   */
  match(
    node: GraphNodeDescriptor,
    descriptor: GraphDescriptor
  ): MacroActionValues | null;
  /**
   * UI → graph. Produce the node(s) + internal edges implementing the action,
   * naming fresh ids via `makeId`, and name the entry node/port the trigger
   * should connect to. `match(build(v).entry) === v` must hold.
   */
  build(values: MacroActionValues, makeId: () => string): BuiltSubgraph;
}

/** How a hotkey's downstream chain classifies. */
export type MacroRowKind = 'single' | 'cycle' | 'empty' | 'opaque';

export interface MacroRow {
  /** The logic graph this macro lives in. */
  logicId: string;
  /** The `system_hotkey` node id (stable row identity within a logic graph). */
  hotkeyNodeId: string;
  shortcut: HotkeyCombo;
  /** Whether the macro fires — the hotkey node's `enabled` gate (default true). */
  enabled: boolean;
  kind: MacroRowKind;
  /** kind === 'single': the one modeled action. */
  action?: MacroActionInstance;
  /** kind === 'cycle': one entry per cycle output; null = that output's sink
   *  is unset or not modelable. */
  states?: (MacroActionInstance | null)[];
}
