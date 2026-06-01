/**
 * Shared helpers for overlive event nodes.
 *
 * Every overlive_* node follows the same pattern:
 *  - Receives the event via `graph.fire(nodeId, 'event', payload)` from
 *    OverliveManager.routeEvent. The OverliveManager already filtered by
 *    accountId + (optionally) channel before delivering, so this node only
 *    needs to honour event-specific filter inputs and surface the payload.
 *  - On the event-fire path: store the payload in state, emit a Trigger
 *    plus typed value outputs.
 *  - On the pull path: return the last-known stored payload (or defaults).
 *
 * The `account` and `channel` value inputs are part of the public node
 * surface so the user can wire / inline-set them in the editor, and so
 * OverliveManager can read them from the descriptor's defaultConfig to
 * route correctly. The node itself doesn't need to evaluate them at
 * execute time — the manager has already done that filtering.
 */
import { mkEvent } from '@vspark/shared/signal';
import type { Event, NodeExecutionContext } from '@vspark/shared/signal';

/**
 * Standard wrapper for an overlive node's execute(). Pass:
 *  - the inputs object
 *  - the ctx
 *  - a `project` function that, given the event payload, produces the
 *    extra typed outputs (e.g. { username, displayName, amount, ... }).
 *  - an `emptyOutputs` object for the pull path when no event has been
 *    received yet.
 *  - an optional `matches` predicate evaluated against the event before
 *    emission (e.g. command name filter). When it returns false the node
 *    falls back to the last-known state.
 */
export function handleOverliveEvent<Evt, Out extends Record<string, unknown>>(
  inputs: { event?: Event<unknown> },
  ctx: NodeExecutionContext,
  project: (e: Evt) => Out,
  emptyOutputs: Out,
  matches?: (e: Evt) => boolean
): { event: Event<void> } & Out {
  if (ctx.triggeredPort === 'event') {
    const evt = inputs.event;
    const payload = evt?.payload as Evt | undefined;
    if (payload === undefined) {
      return { event: mkEvent(undefined), ...emptyOutputs };
    }
    if (matches && !matches(payload)) {
      // Filtered out — keep state as-is and don't emit.
      const prev = ctx.getState<Out>() ?? emptyOutputs;
      return { event: mkEvent(undefined), ...prev };
    }
    const out = project(payload);
    ctx.setState(out);
    return { event: mkEvent(undefined, evt?.timestamp), ...out };
  }
  const prev = ctx.getState<Out>() ?? emptyOutputs;
  return { event: mkEvent(undefined), ...prev };
}
