/**
 * Per-kind `inferPorts` functions for the inference-bearing nodes (Phase 2).
 *
 * These are pure and live in shared so the backend engine and the frontend editor
 * compute identical resolved ports from the same `INFER_BY_KIND` table — FE and BE
 * never drift. Ordinary nodes have no entry here and fall back to `defaultInfer`.
 *
 * The runtime behaviour of these nodes lives in their backend classes
 * (`signal/nodes/{pack_event,queue_events,unpack_event}.ts`); only the *shape*
 * computation is here.
 */

import type { InferCtx, InferResult, PortMeta } from './node.js';
import {
  type ResolvedType,
  type ResolvedPort,
  RT,
  typeTagToResolved,
} from './signal_types.js';
import type { InferPortsFn } from './inference.js';
import { defaultInfer } from './inference.js';

// ──────────────────────────────────────────────────────────────────────────────
// pack_event — user-defined named input fields → Event<record>
//
// config.fields: string[] holds the user's field NAMES (+ order). A field's type is
// whatever is wired into it (resolvedInputs[name]); unconnected → unknown and omitted
// from the output record. One trailing empty slot ('') is always appended so the
// editor can name the next field by wiring into it.
// ──────────────────────────────────────────────────────────────────────────────

interface PackEventConfig {
  fields?: string[];
}

const TRAILING_SLOT = '';

export const inferPackEvent: InferPortsFn = (ctx: InferCtx): InferResult => {
  const cfg = (ctx.config ?? {}) as PackEventConfig;
  const fields = (cfg.fields ?? []).filter((f) => f.length > 0);

  const inputPorts: ResolvedPort[] = [
    { name: 'fire', type: RT.event(RT.primitive('Trigger')) },
  ];
  const recordFields: Record<string, ResolvedType> = {};
  for (const name of fields) {
    const t = ctx.resolvedInputs[name] ?? RT.unknown();
    inputPorts.push({ name, type: t });
    if (t.kind !== 'unknown') recordFields[name] = t;
  }
  // Always-present empty slot for adding the next field.
  inputPorts.push({ name: TRAILING_SLOT, type: RT.unknown() });

  return {
    inputPorts,
    outputPorts: [{ name: 'event', type: RT.event(RT.record(recordFields)) }],
  };
};

// ──────────────────────────────────────────────────────────────────────────────
// queue_events — FIFO passthrough; `popped` mirrors the enqueued payload type
// ──────────────────────────────────────────────────────────────────────────────

export const inferQueueEvents: InferPortsFn = (ctx: InferCtx): InferResult => {
  const enq = ctx.resolvedInputs['enqueue'];
  // enqueue is an event port; its resolved type is Event<payload>. Mirror it onto popped.
  const poppedType: ResolvedType =
    enq && enq.kind === 'event' ? RT.event(enq.payload) : RT.event(RT.unknown());
  return {
    inputPorts: [
      { name: 'enqueue', type: RT.event(RT.unknown()) },
      { name: 'pop', type: RT.event(RT.primitive('Trigger')) },
    ],
    outputPorts: [
      { name: 'popped', type: poppedType },
      { name: 'size', type: RT.primitive('Float') },
    ],
  };
};

// ──────────────────────────────────────────────────────────────────────────────
// unpack_event — one typed output port per field of the resolved event payload
//
// If the input resolves to Event<record>, emit one output per record field. Else
// fall back to a single `value: unknown` output (preserves pre-Phase-2 behaviour).
// A `trigger` event output always fires alongside.
// ──────────────────────────────────────────────────────────────────────────────

export const inferUnpackEvent: InferPortsFn = (ctx: InferCtx): InferResult => {
  const inT = ctx.resolvedInputs['event'];
  // `trigger` is the only EVENT (push) output; field outputs are VALUE (pull) outputs
  // read from the stored payload — this preserves the push→pull bridge that the
  // VMC/lipsync/mediapipe pipelines depend on.
  const outputPorts: ResolvedPort[] = [
    { name: 'trigger', type: RT.event(RT.primitive('Trigger')) },
  ];
  if (inT && inT.kind === 'event' && inT.payload.kind === 'record') {
    for (const [name, fieldType] of Object.entries(inT.payload.fields)) {
      outputPorts.push({ name, type: fieldType });
    }
  } else {
    outputPorts.push({ name: 'value', type: RT.unknown() });
  }
  return {
    inputPorts: [{ name: 'event', type: RT.event(RT.unknown()) }],
    outputPorts,
  };
};

// ──────────────────────────────────────────────────────────────────────────────
// Registry — kind → inferPorts. Imported by both engine and editor.
// ──────────────────────────────────────────────────────────────────────────────

export const INFER_BY_KIND: Record<string, InferPortsFn> = {
  pack_event: inferPackEvent,
  queue_events: inferQueueEvents,
  unpack_event: inferUnpackEvent,
};

export function inferForKind(kind: string): InferPortsFn | undefined {
  return INFER_BY_KIND[kind];
}

/** Convenience: resolve a kind's ports given ctx, using its inferPorts or the default. */
export function inferPortsFor(
  kind: string,
  ctx: InferCtx,
  staticPorts: PortMeta[]
): InferResult {
  const fn = INFER_BY_KIND[kind];
  return fn ? fn(ctx, staticPorts) : defaultInfer(staticPorts);
}

// Re-export so consumers can import typeTag lifting from one place if needed.
export { typeTagToResolved };
