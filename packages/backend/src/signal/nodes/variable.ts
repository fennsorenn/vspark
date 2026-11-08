import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import {
  eventIn,
  eventOut,
  valueIn,
  valueOut,
} from '@vspark/shared/node_decorators';
import {
  incrementVariable,
  readVariable,
  variableRef,
  writeVariable,
  type VariableRef,
} from '../../variables/store.js';

/**
 * Graph variables — see variables/store.ts. A variable is named by its `name`
 * within a `scope` ('' = the project's shared namespace; wire `logic_id` in to
 * keep it private to the graph) and is project-wide: every Logic graph of the
 * project sees the same value. The project comes from the `_projectId` that
 * LogicManager injects into every node's config, so outside a Logic graph the
 * nodes are inert.
 *
 * `persistent` (default false) decides, on each write, whether the variable
 * survives a restart. Writes happen on the backend only, so increments never
 * lose updates.
 */

/** The variable a node addresses: `_projectId` (injected by LogicManager)
 *  plus its `scope` / `name` inputs; null when unusable. The port decorators
 *  are repeated in each class rather than put on a shared base: where the
 *  toolchain inherits decorator metadata prototypically, a subclass's ports
 *  would land in the base class's port buffer (see `bufferPort`, shared/node.ts). */
function refOf(
  config: Record<string, unknown>,
  scope: unknown,
  name: unknown
): VariableRef | null {
  return variableRef(config._projectId, scope, name);
}

/** Pure read: the variable's current value (unset → nothing). */
@SignalNode({
  label: 'Get Variable',
  description:
    'Reads a project variable by name. Scope keeps names apart: leave it empty for the shared namespace, or wire "This Logic" to keep the variable private to this graph.',
  tags: ['variables'],
  color: '#6a4a8a',
})
export class GetVariable extends Node {
  static readonly kind = 'variable';

  @valueIn('name', 'String') name!: () => unknown;
  @valueIn('scope', 'String') scope!: () => unknown;

  @valueOut('value', 'Any') value = (): unknown => {
    const ref = refOf(this.config, this.scope(), this.name());
    return ref ? readVariable(ref) : undefined;
  };
}

/** Boundary node: on `fire`, stores `value`; then fires `done`. `value`
 *  (output) reads the variable, so on `done` it is the value just stored. */
@SignalNode({
  label: 'Set Variable',
  description:
    'Stores a value in a project variable when fired. Tick "persistent" to keep it across restarts.',
  tags: ['variables'],
  color: '#6a4a8a',
})
export class SetVariable extends Node {
  static readonly kind = 'set_variable';

  @valueIn('name', 'String') name!: () => unknown;
  @valueIn('scope', 'String') scope!: () => unknown;

  @valueIn('value', 'Any') valueIn!: () => unknown;
  @valueIn('persistent', 'Bool') persistent!: () => unknown;

  @eventOut('done', 'Trigger') done!: Emitter<void>;
  @valueOut('value', 'Any') value = (): unknown => this.current();

  private ref(): VariableRef | null {
    return refOf(this.config, this.scope(), this.name());
  }

  private current(): unknown {
    const ref = this.ref();
    return ref ? readVariable(ref) : undefined;
  }

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const ref = this.ref();
    if (!ref) return;
    writeVariable(ref, this.valueIn(), this.persistent() === true);
    this.done.emit(undefined);
  }
}

/** Boundary node: on `fire`, adds `by` (default 1) to the variable — unset or
 *  non-numeric counts as 0 — then fires `done`; `value` is the new count. */
@SignalNode({
  label: 'Increment Variable',
  description:
    'Adds a number (default 1) to a project variable when fired and outputs the new value. Tick "persistent" to keep the count across restarts.',
  tags: ['variables'],
  color: '#6a4a8a',
})
export class IncrementVariable extends Node {
  static readonly kind = 'increment_variable';

  @valueIn('name', 'String') name!: () => unknown;
  @valueIn('scope', 'String') scope!: () => unknown;

  @valueIn('by', 'Float') by!: () => unknown;
  @valueIn('persistent', 'Bool') persistent!: () => unknown;

  @eventOut('done', 'Trigger') done!: Emitter<void>;
  @valueOut('value', 'Float') value = (): number => {
    const v = this.current();
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };

  private ref(): VariableRef | null {
    return refOf(this.config, this.scope(), this.name());
  }

  private current(): unknown {
    const ref = this.ref();
    return ref ? readVariable(ref) : undefined;
  }

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const ref = this.ref();
    if (!ref) return;
    const raw = this.by();
    const by =
      raw === undefined || raw === null || raw === '' ? 1 : Number(raw);
    if (!Number.isFinite(by)) {
      console.warn(`[increment_variable ${this.selfId}] "by" is not a number`);
      return;
    }
    incrementVariable(ref, by, this.persistent() === true);
    this.done.emit(undefined);
  }
}
