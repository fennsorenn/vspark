/**
 * Names already in use in a project, for the inputs that name a variable, a
 * variable scope, a cooldown group or a named trigger: they suggest these
 * while still taking any new name (`<datalist>`). Read live from this tab's
 * replica:
 *  - variables that exist (the `variable` / `runtime_variable` documents),
 *  - names configured on the nodes that address one (variable, set / increment
 *    variable, deadline, tally; cooldown groups; send / on trigger),
 *  - the Actions settings that become those (counter name, cooldown group,
 *    trigger to send).
 * A node's scope is its `scope` setting, or the graph's own id when a
 * `logic_id` node is wired in (see @vspark/shared/variables).
 */
import { useCollection, useMeshAll } from '@vspark/mesh-react';
import { toGraphDescriptor } from '@vspark/shared/signal';
import { useEditorStore } from '../store/editorStore';
import { collectionOf } from './docs';

type Doc = Record<string, unknown>;

/** Node kinds whose `name` / `scope` address a project variable. */
export const VARIABLE_NODE_KINDS = new Set([
  'variable',
  'set_variable',
  'increment_variable',
  'deadline',
  'tally',
]);
/** Node kinds whose `name` is a named trigger. */
export const TRIGGER_NODE_KINDS = new Set(['send_trigger', 'on_trigger']);
/** The variable scope cooldown groups live in (signal/nodes/cooldown.ts). */
export const COOLDOWN_SCOPE = '__cooldown';

export interface ProjectDocs {
  variables: Doc[];
  logic: Doc[];
  actions: Doc[];
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const sorted = (s: Set<string>) =>
  [...s].filter((x) => x !== '').sort((a, b) => a.localeCompare(b));

/** Each node of each graph of the project, with the scope it addresses. */
function* projectNodes(projectId: string, logic: Doc[]) {
  for (const g of logic) {
    if (g.projectId !== projectId || !g.descriptor) continue;
    let d;
    try {
      d = toGraphDescriptor(
        g.descriptor as Parameters<typeof toGraphDescriptor>[0]
      );
    } catch {
      continue;
    }
    for (const n of d.nodes) {
      const cfg = (n.defaultConfig ?? {}) as Doc;
      const into = d.edges.find(
        (e) => e.toNodeId === n.id && e.toPort === 'scope'
      );
      const wiredGraph =
        into &&
        d.nodes.find((x) => x.id === into.fromNodeId)?.kind === 'logic_id';
      yield {
        kind: n.kind,
        cfg,
        scope: wiredGraph ? String(g.id) : str(cfg.scope),
        /** Whether the scope is wired from something other than the graph id
         *  (unknown until it runs). */
        scopeUnknown: !!into && !wiredGraph,
      };
    }
  }
}

const actionSettings = (projectId: string, actions: Doc[]) =>
  actions
    .filter((a) => a.projectId === projectId)
    .map((a) => (a.settings ?? {}) as Doc);

/** Variable names in use in `scope` ('' = the shared namespace). */
export function variableNames(
  projectId: string,
  scope: string,
  docs: ProjectDocs
): string[] {
  const out = new Set<string>();
  for (const v of docs.variables)
    if (v.projectId === projectId && v.scope === scope) out.add(str(v.name));
  for (const n of projectNodes(projectId, docs.logic))
    if (VARIABLE_NODE_KINDS.has(n.kind) && !n.scopeUnknown && n.scope === scope)
      out.add(str(n.cfg.name));
  if (scope === '')
    for (const s of actionSettings(projectId, docs.actions))
      out.add(str((s.counter as Doc | undefined)?.name));
  if (scope === COOLDOWN_SCOPE) {
    for (const n of projectNodes(projectId, docs.logic))
      if (n.kind === 'cooldown') out.add(str(n.cfg.group));
    for (const s of actionSettings(projectId, docs.actions))
      out.add(str((s.cooldown as Doc | undefined)?.group));
  }
  return sorted(out);
}

/** Named triggers in use (sent or listened for). */
export function triggerNames(projectId: string, docs: ProjectDocs): string[] {
  const out = new Set<string>();
  for (const n of projectNodes(projectId, docs.logic))
    if (TRIGGER_NODE_KINDS.has(n.kind)) out.add(str(n.cfg.name));
  for (const s of actionSettings(projectId, docs.actions))
    out.add(str(s.trigger));
  return sorted(out);
}

export interface ScopeOption {
  value: string;
  label: string;
}

/** Scopes to pick from: the shared namespace, and each graph of the project
 *  (a graph's own scope is its id; the label is its name). */
export function scopeOptions(
  projectId: string,
  logic: Doc[],
  sharedLabel: string
): ScopeOption[] {
  return [
    { value: '', label: sharedLabel },
    ...logic
      .filter((g) => g.projectId === projectId)
      .map((g) => ({ value: String(g.id), label: str(g.name) || String(g.id) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];
}

/** The first of `base`, `base 2`, `base 3`, … not in `taken`. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const have = new Set(taken);
  if (!have.has(base)) return base;
  for (let i = 2; ; i++) if (!have.has(`${base} ${i}`)) return `${base} ${i}`;
}

// ── Live (hooks) and one-off (current replica) reads ────────────────────────

function useProjectDocs(): ProjectDocs {
  const persistent = useMeshAll(useCollection<Doc>('variable'));
  const runtime = useMeshAll(useCollection<Doc>('runtime_variable'));
  const logic = useMeshAll(useCollection<Doc>('logic'));
  const actions = useMeshAll(useCollection<Doc>('action'));
  return { variables: [...persistent, ...runtime], logic, actions };
}

/** The replica's documents right now (outside React). */
export function currentProjectDocs(): ProjectDocs {
  return {
    variables: [
      ...collectionOf<Doc>('variable').all(),
      ...collectionOf<Doc>('runtime_variable').all(),
    ],
    logic: collectionOf<Doc>('logic').all(),
    actions: collectionOf<Doc>('action').all(),
  };
}

export function useVariableNames(scope: string): string[] {
  const projectId = useEditorStore((s) => s.projectId) ?? '';
  return variableNames(projectId, scope, useProjectDocs());
}

export function useTriggerNames(): string[] {
  const projectId = useEditorStore((s) => s.projectId) ?? '';
  return triggerNames(projectId, useProjectDocs());
}

export function useScopeOptions(sharedLabel: string): ScopeOption[] {
  const projectId = useEditorStore((s) => s.projectId) ?? '';
  return scopeOptions(projectId, useProjectDocs().logic, sharedLabel);
}

/** What a name input names. */
export type NameSpec =
  | { kind: 'variable'; scope: string }
  | { kind: 'trigger' }
  | { kind: 'scope'; sharedLabel: string };

/** Suggestions for one name input (none for `null`). One hook for every
 *  kind, so a component can pick the kind at render time. */
export function useNameSuggestions(
  spec: NameSpec | null
): (string | ScopeOption)[] | undefined {
  const projectId = useEditorStore((s) => s.projectId) ?? '';
  const docs = useProjectDocs();
  if (!spec) return undefined;
  if (spec.kind === 'variable')
    return variableNames(projectId, spec.scope, docs);
  if (spec.kind === 'trigger') return triggerNames(projectId, docs);
  // The shared namespace is the empty scope — an empty input; offer graphs.
  return scopeOptions(projectId, docs.logic, spec.sharedLabel).filter(
    (o) => o.value !== ''
  );
}

/** What the input for `port` of a node of `kind` names, if anything.
 *  `scope` is where its variable lives (null when wired from something that
 *  is only known at run time). */
export function nodePortNameSpec(
  kind: string,
  port: string,
  scope: string | null,
  sharedLabel: string
): NameSpec | null {
  if (VARIABLE_NODE_KINDS.has(kind)) {
    if (port === 'name')
      return scope === null ? null : { kind: 'variable', scope };
    if (port === 'scope') return { kind: 'scope', sharedLabel };
  }
  if (kind === 'cooldown' && port === 'group')
    return { kind: 'variable', scope: COOLDOWN_SCOPE };
  if (TRIGGER_NODE_KINDS.has(kind) && port === 'name')
    return { kind: 'trigger' };
  return null;
}

/** The bases of trigger sets named `<base> start|pause|resume|reset` (the
 *  timer widgets' control triggers). */
export function triggerBases(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const m = /^(.+) (start|pause|resume|reset)$/.exec(n);
    if (m) out.add(m[1]);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}
