/**
 * Behavior graph templates — what each behavior kind's graph is generated
 * from (plan: dev-notes/plans/actions.md Phase 4, module:
 * dev-notes/modules/component-managers.md → "Stored, editable graphs").
 *
 * A Behavior's graph is STORED (a `logic` document with
 * `ownerKind: 'behavior'`) and editable; the template is only where it starts
 * and what Reset goes back to. The behavior records which template output its
 * graph was generated from as `templateFingerprint` (the same structural
 * fingerprint Actions use, `@vspark/shared/actions` → `graphFingerprint`).
 *
 * Settings are classified like Actions' settings:
 *   - value settings reach the graph through `settings` nodes, live;
 *   - shape settings select the template's structure, so changing one
 *     regenerates the graph (`build` only ever sees the shape projection).
 *
 * Classification today: EVERY behavior setting is a value setting — no
 * template reads the config at build time. The eye range stage
 * (`withEyeRangeStage`) is inserted unconditionally and switched by the
 * `eyeRange.enabled` settings node; the MediaPipe switches (`useIk`,
 * `enableFace/Pose/Hands`, `armSolve.*`) and every receiver's `nodeConfig.*`
 * mapper toggles are settings nodes too. What differs between VMC 3D and 2D
 * is the behavior KIND, which never changes for a behavior. So `shapeFields`
 * is empty for every kind; the shape path (lifecycle `followShape`) exists so
 * a kind can declare one without new plumbing. (Inferred from the code, not a
 * user decision.)
 *
 * Import discipline: migration 047 imports this module from the database
 * layer, so the templates (and what they import) must not reach node classes,
 * the database or the mesh — that closes an import cycle through the node
 * registry (see signal/eyeRangeDefaults.ts).
 *
 * Kept in the backend (not in `@vspark/shared` like the Actions templates):
 * the templates are large, the editor does not need to preview them, and it
 * fetches the template for Reset from `GET /api/behaviors/:id/template`.
 */
import type { GraphDescriptor } from '@vspark/shared/signal';
import { graphFingerprint } from '@vspark/shared/actions';
import {
  VMC_PIPELINE_TEMPLATE,
  VMC_2D_PIPELINE_TEMPLATE,
} from './vmc_receiver/graph.js';
import { IFACIALMOCAP_PIPELINE_TEMPLATE } from './ifacialmocap_receiver/graph.js';
import { BREATHING_PIPELINE_TEMPLATE } from './breathing/graph.js';
import { MANUAL_CALIBRATION_TEMPLATE } from './manual_calibration/graph.js';
import { POSE_STYLIZER_TEMPLATE } from './pose_stylizer/graph.js';
import { BLENDSHAPE_LIMITER_TEMPLATE } from './blendshape_limiter/graph.js';
import { LIPSYNC_PIPELINE_TEMPLATE } from './lipsync/graph.js';
import { MEDIAPIPE_PIPELINE_TEMPLATE } from './mediapipe_tracker/graph.js';

export type BehaviorConfig = Record<string, unknown>;

export interface BehaviorTemplate {
  kind: string;
  /** Prefix of the runtime graph id (`<prefix><behaviorId>`). The stored
   *  graph document is created under the same id, so the signal routes
   *  (node states, fire) keep finding a behavior graph by it. */
  graphIdPrefix: string;
  /** Dotted config paths that select the structure. Every other config path
   *  is a value setting. Empty for every kind today (see the header). */
  shapeFields: readonly string[];
  /** The template. Receives ONLY the shape projection of the config. */
  build(shape: BehaviorConfig): Omit<GraphDescriptor, 'id'>;
}

const fixed = (
  kind: string,
  graphIdPrefix: string,
  template: Omit<GraphDescriptor, 'id'>
): BehaviorTemplate => ({
  kind,
  graphIdPrefix,
  shapeFields: [],
  build: () => template,
});

const TEMPLATES = new Map<string, BehaviorTemplate>(
  [
    fixed('vmc_receiver', 'vmc-pipeline:', VMC_PIPELINE_TEMPLATE),
    fixed('vmc_receiver_2d', 'vmc-pipeline-2d:', VMC_2D_PIPELINE_TEMPLATE),
    fixed(
      'ifacialmocap_receiver',
      'ifacialmocap-pipeline:',
      IFACIALMOCAP_PIPELINE_TEMPLATE
    ),
    fixed('breathing', 'breathing:', BREATHING_PIPELINE_TEMPLATE),
    fixed(
      'manual_calibration',
      'manual_calibration:',
      MANUAL_CALIBRATION_TEMPLATE
    ),
    fixed('pose_stylizer', 'pose_stylizer:', POSE_STYLIZER_TEMPLATE),
    fixed(
      'blendshape_limiter',
      'blendshape_limiter:',
      BLENDSHAPE_LIMITER_TEMPLATE
    ),
    fixed('lipsync_processor', 'lipsync:', LIPSYNC_PIPELINE_TEMPLATE),
    fixed(
      'mediapipe_tracker',
      'mediapipe_tracker:',
      MEDIAPIPE_PIPELINE_TEMPLATE
    ),
  ].map((t) => [t.kind, t])
);

/** The template of a behavior kind; undefined for kinds without a graph
 *  (`api_controller`). */
export function behaviorTemplate(kind: string): BehaviorTemplate | undefined {
  return TEMPLATES.get(kind);
}

/** Register (or replace) a template. For tests that need a kind with shape
 *  fields; returns the restore function. */
export function registerBehaviorTemplate(t: BehaviorTemplate): () => void {
  const prev = TEMPLATES.get(t.kind);
  TEMPLATES.set(t.kind, t);
  return () => {
    if (prev) TEMPLATES.set(t.kind, prev);
    else TEMPLATES.delete(t.kind);
  };
}

/** The id a behavior's graph runs (and is stored) under. */
export function behaviorGraphId(kind: string, behaviorId: string): string {
  const t = TEMPLATES.get(kind);
  return `${t?.graphIdPrefix ?? `${kind}:`}${behaviorId}`;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function readPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const k of path.split('.')) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** The shape projection of a config: only the kind's shape fields (dotted
 *  paths kept flat — `build` reads them by path). */
export function shapeOfConfig(kind: string, config: unknown): BehaviorConfig {
  const t = TEMPLATES.get(kind);
  const out: BehaviorConfig = {};
  for (const p of t?.shapeFields ?? []) out[p] = readPath(config, p);
  return out;
}

/** The template output for this behavior as a runtime descriptor (a fresh
 *  copy — callers may hand it to the mesh). Null for kinds without a graph. */
export function behaviorTemplateGraph(
  kind: string,
  behaviorId: string,
  config: unknown
): GraphDescriptor | null {
  const t = TEMPLATES.get(kind);
  if (!t) return null;
  const g = structuredClone(t.build(shapeOfConfig(kind, config)));
  return {
    id: behaviorGraphId(kind, behaviorId),
    label: g.label,
    readonly: false,
    nodes: g.nodes,
    edges: g.edges,
  };
}

/** Fingerprint of what the template produces for this config (positions
 *  excluded). Null for kinds without a graph. */
export function behaviorTemplateFingerprint(
  kind: string,
  config: unknown
): string | null {
  const t = TEMPLATES.get(kind);
  if (!t) return null;
  return graphFingerprint({ id: '', ...t.build(shapeOfConfig(kind, config)) });
}
