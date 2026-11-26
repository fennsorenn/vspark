/**
 * Cross-graph triggers: `send_trigger` fires a named trigger, every running
 * Logic graph of the same project receives it on its `on_trigger` nodes.
 * Project-wide by decision (Actions plan); finer scoping is deferred.
 *
 * Routing walks `logicManager.iterateNodes()`, like hotkeys and overlive
 * events. Every `on_trigger` node of the project gets the trigger; the node
 * compares the name against its own `name` input, so the name may be wired
 * (e.g. from a settings node) rather than only typed inline.
 *
 * Delivery is synchronous: the receiving graphs run inside the sender's
 * `fire`. A trigger that (directly or through other triggers) re-sends itself
 * would recurse without bound, so the router refuses:
 *  - a trigger whose (project, name) is already being delivered further up
 *    the stack — a loop, and
 *  - any trigger nested deeper than MAX_TRIGGER_DEPTH sends — a backstop for
 *    long non-repeating chains.
 * A refused send is dropped and warned about once per (project, name, reason).
 */
import { mkEvent } from '@vspark/shared/signal';
import { logicManager } from '../logic/manager.js';

export const ON_TRIGGER_KIND = 'on_trigger';
export const MAX_TRIGGER_DEPTH = 16;

/** What an `on_trigger` node receives on its external `event` port. */
export interface TriggerEventPayload {
  name: string;
  payload: unknown;
}

export type TriggerSendResult =
  | { status: 'sent'; delivered: number }
  | { status: 'refused'; reason: 'loop' | 'depth' };

class TriggerRouter {
  /** (project, name) of every trigger being delivered, outermost first. */
  private readonly stack: string[] = [];
  private readonly warned = new Set<string>();

  send(projectId: string, name: string, payload: unknown): TriggerSendResult {
    const key = `${projectId}\u0000${name}`;
    if (this.stack.includes(key)) return this.refuse(projectId, name, 'loop');
    if (this.stack.length >= MAX_TRIGGER_DEPTH)
      return this.refuse(projectId, name, 'depth');

    // Collect the targets before delivering: a handler may start or stop
    // graphs, which would otherwise change the set mid-iteration.
    const targets: Array<{ graphId: string; nodeId: string }> = [];
    for (const { graphId, node, projectId: pid } of logicManager.iterateNodes())
      if (pid === projectId && node.kind === ON_TRIGGER_KIND)
        targets.push({ graphId, nodeId: node.id });

    this.stack.push(key);
    try {
      const ev: TriggerEventPayload = { name, payload };
      for (const t of targets)
        logicManager.fire(t.graphId, t.nodeId, 'event', mkEvent(ev));
    } finally {
      this.stack.pop();
    }
    return { status: 'sent', delivered: targets.length };
  }

  private refuse(
    projectId: string,
    name: string,
    reason: 'loop' | 'depth'
  ): TriggerSendResult {
    const key = `${projectId}\u0000${name}\u0000${reason}`;
    if (!this.warned.has(key)) {
      this.warned.add(key);
      console.warn(
        reason === 'loop'
          ? `[triggers] "${name}" was sent again while it was being handled — dropped to stop a trigger loop.`
          : `[triggers] "${name}" is nested more than ${MAX_TRIGGER_DEPTH} triggers deep — dropped.`
      );
    }
    return { status: 'refused', reason };
  }
}

export const triggerRouter = new TriggerRouter();
