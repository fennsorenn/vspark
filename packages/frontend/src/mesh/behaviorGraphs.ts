/**
 * Behaviors' stored graphs on the mesh: the `logic` document a behavior owns
 * (ownerKind 'behavior'), its Modified / template-update state, and Reset.
 * See dev-notes/modules/component-managers.md → "Stored, editable graphs".
 *
 * The graph is an ordinary Logic document, so the canvas edits it through
 * mesh/logicWrites like any other; the server's taps rebuild the running
 * graph in the behavior's manager. What lives here is what the behavior
 * section of the Properties panel needs.
 *
 * Unlike Actions, the editor holds no template code (the behavior templates
 * live in the backend): it fetches the template for a behavior from
 * `GET /api/behaviors/:id/template`, and refetches only when a config field the
 * template's STRUCTURE depends on (`shapeFields`) changes — none does today.
 */
import { useEffect, useMemo, useState } from 'react';
import { useCollection, useMeshSelector } from '@vspark/mesh-react';
import { graphFingerprint } from '@vspark/shared/actions';
import type { GraphDescriptorDoc } from '@vspark/shared/signal';
import { collectionOf } from './docs';
import { meshBatch } from './peer';
import { logicRecordOf } from './hooks';
import { actionLabel, watch } from './writeFeedback';
import {
  getBehaviorTemplate,
  type BehaviorTemplate,
  type LogicRecord,
  type RawLogic,
} from '../api/client';
import type { Behavior } from '../store/editorStore';

export interface BehaviorGraphStatus {
  /** No graph is stored (the behavior runs its template; Reset creates it). */
  missingGraph: boolean;
  /** The graph differs from the template output it was generated from. */
  modified: boolean;
  /** The template now produces something else than what the graph was
   *  generated from. Unknown (false) until the template is fetched. */
  templateUpdateAvailable: boolean;
}

const owns = (behaviorId: string) => (g: RawLogic | undefined) =>
  !!g && g.ownerKind === 'behavior' && g.ownerId === behaviorId;

/** The graph a behavior owns, in runtime form (undefined when missing). */
export function useBehaviorGraph(behaviorId: string): LogicRecord | undefined {
  const col = useCollection<RawLogic>('logic');
  return useMeshSelector(col, '**', (c) =>
    logicRecordOf(c.all().find(owns(behaviorId)))
  );
}

function readPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const k of path.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** The template for a behavior, fetched from the server; refetched when a
 *  structure-relevant config field changes. Null while loading / on error. */
export function useBehaviorTemplate(
  behavior: Pick<Behavior, 'id' | 'kind' | 'config'>
): BehaviorTemplate | null {
  const [state, setState] = useState<{
    key: string;
    template: BehaviorTemplate;
  } | null>(null);
  const shapeKey = useMemo(
    () =>
      JSON.stringify(
        (state?.template.shapeFields ?? []).map((p) =>
          readPath(behavior.config, p)
        )
      ),
    [state?.template.shapeFields, behavior.config]
  );
  const key = `${behavior.id}|${behavior.kind}|${shapeKey}`;
  useEffect(() => {
    if (state?.key === key) return;
    let cancelled = false;
    getBehaviorTemplate(behavior.id)
      .then((template) => {
        if (!cancelled) setState({ key, template });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // `state` is what we compare against, not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, behavior.id]);
  return state && state.template.graphId.endsWith(behavior.id)
    ? state.template
    : null;
}

/** Badge state (same rules as Actions' `actionGraphStatus`). */
export function behaviorGraphStatus(
  behavior: Pick<Behavior, 'templateFingerprint'>,
  graph: Pick<LogicRecord, 'descriptor'> | undefined,
  template: Pick<BehaviorTemplate, 'fingerprint'> | null
): BehaviorGraphStatus {
  const generated = behavior.templateFingerprint ?? null;
  return {
    missingGraph: !graph,
    modified:
      !!graph &&
      graphFingerprint(graph.descriptor as unknown as GraphDescriptorDoc) !==
        generated,
    templateUpdateAvailable: !!template && template.fingerprint !== generated,
  };
}

/** Regenerate the behavior's graph from its template (Reset), discarding
 *  graph edits — one undo step that restores them. Creates the graph when it
 *  is missing. The server rebuilds the running graph from the write. */
export function commitBehaviorGraphReset(
  behavior: Pick<Behavior, 'id' | 'templateFingerprint'>,
  template: BehaviorTemplate
): void {
  const logic = collectionOf<RawLogic>('logic');
  const behaviors = collectionOf<Behavior>('behavior');
  if (!behaviors.get(behavior.id)) return;
  const existing =
    logic.get(template.graphId) &&
    owns(behavior.id)(logic.get(template.graphId))
      ? logic.get(template.graphId)
      : logic.all().find(owns(behavior.id));
  const id = existing?.id ?? template.graphId;
  const descriptor = { ...template.descriptor, id };
  meshBatch(() => {
    const h = existing
      ? logic.set(id, 'descriptor', descriptor)
      : logic.create({
          id,
          ownerKind: 'behavior',
          ownerId: behavior.id,
          name: template.label,
          enabled: true,
          descriptor,
        } as unknown as RawLogic);
    watch(h.ack, actionLabel('logic'));
    if (behavior.templateFingerprint !== template.fingerprint)
      watch(
        behaviors.set(behavior.id, 'templateFingerprint', template.fingerprint)
          .ack,
        actionLabel('behavior')
      );
  });
}
