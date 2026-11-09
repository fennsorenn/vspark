/**
 * Project variables on this tab's replica (see @vspark/shared/variables): the
 * editor reads them live and writes them — a widget's Start / Pause buttons,
 * a goal's count set by hand — and the nodes holding them react. Writes stay
 * off the undo stack: they are runtime state, not document edits (the same
 * rule the backend store follows).
 */
import { useCollection, useMeshDoc } from '@vspark/mesh-react';
import {
  persistentVariableId,
  runtimeVariableId,
  type VariableRef,
} from '@vspark/shared/variables';
import { collectionOf } from './docs';

interface VariableDoc {
  id: string;
  projectId: string;
  scope: string;
  name: string;
  value: unknown;
  [k: string]: unknown;
}

/** The variable's current value (undefined when unset), live. */
export function useVariable(ref: VariableRef | null): unknown {
  const persistent = useMeshDoc(
    useCollection<VariableDoc>('variable'),
    ref ? persistentVariableId(ref) : ''
  );
  const runtime = useMeshDoc(
    useCollection<VariableDoc>('runtime_variable'),
    ref ? runtimeVariableId(ref) : ''
  );
  return (persistent ?? runtime)?.value;
}

/** Set a variable. It goes to the collection `persistent` names; a copy in
 *  the other one is removed, so a read never sees two values. */
export function writeVariable(
  ref: VariableRef,
  value: unknown,
  persistent: boolean
): void {
  const pid = persistentVariableId(ref);
  const rid = runtimeVariableId(ref);
  const id = persistent ? pid : rid;
  const doc: VariableDoc = { id, ...ref, value: JSON.parse(JSON.stringify(value ?? null)) };
  const target = collectionOf<VariableDoc>(persistent ? 'variable' : 'runtime_variable');
  const other = collectionOf<VariableDoc>(persistent ? 'runtime_variable' : 'variable');
  target.set(id, '', doc, { undo: false });
  const otherId = persistent ? rid : pid;
  if (other.get(otherId)) other.remove(otherId, { undo: false });
}
