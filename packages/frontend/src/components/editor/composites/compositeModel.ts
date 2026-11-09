/**
 * Composites in the create palette (see @vspark/shared/composites and
 * dev-notes/plans/composites.md): which ones there are and placing one. The
 * document side — markers, part protection, dissolving, setting writes —
 * lives in mesh/composites.ts, next to the write helpers that enforce it.
 */
import {
  Bell,
  History,
  Hourglass,
  Megaphone,
  MessageSquare,
  MessagesSquare,
  MessageSquareText,
  Target,
  Timer,
  Trophy,
  type LucideIcon,
} from 'lucide-react';
import type { CompositeRootRtype } from '@vspark/shared/composites';
import { getBuiltinPreset, instantiatePreset } from '../../../api/client';
import {
  currentProjectDocs,
  uniqueName,
  VARIABLE_NODE_KINDS,
  variableNames,
} from '../../../mesh/names';

export {
  commitSettingWrites,
  compositeOf,
  compositeView,
  dissolveComposite,
  owningCompositeId,
} from '../../../mesh/composites';

// ── Palette ─────────────────────────────────────────────────────────────────

export interface CompositeDef {
  type: string;
  /** Built-in payload served by GET /api/presets/builtin/:id. */
  presetId: string;
  rootRtype: CompositeRootRtype;
  icon: LucideIcon;
  /** English fallback; the label is `composites:type.<type>`. */
  label: string;
  /** A shared-scope variable its graph names: renamed on placement to the
   *  first free `<name>`, `<name> 2`, … so two of them don't share a value. */
  uniqueVariable?: string;
}

export const COMPOSITE_DEFS: CompositeDef[] = [
  {
    type: 'alert',
    presetId: 'builtin:composite-alert',
    rootRtype: 'compose_layer',
    icon: Bell,
    label: 'Alert',
  },
  {
    type: 'chat_overlay',
    presetId: 'builtin:composite-chat-overlay',
    rootRtype: 'compose_layer',
    icon: MessageSquare,
    label: 'Chat Overlay',
  },
  {
    type: 'goal',
    presetId: 'builtin:composite-goal',
    rootRtype: 'compose_layer',
    icon: Target,
    label: 'Goal',
    uniqueVariable: 'goal',
  },
  {
    type: 'countdown',
    presetId: 'builtin:composite-countdown',
    rootRtype: 'compose_layer',
    icon: Timer,
    label: 'Countdown',
  },
  {
    type: 'subathon',
    presetId: 'builtin:composite-subathon',
    rootRtype: 'compose_layer',
    icon: Hourglass,
    label: 'Subathon Timer',
  },
  {
    type: 'recent_events',
    presetId: 'builtin:composite-recent-events',
    rootRtype: 'compose_layer',
    icon: History,
    label: 'Recent Events',
  },
  {
    type: 'top_supporters',
    presetId: 'builtin:composite-top-supporters',
    rootRtype: 'compose_layer',
    icon: Trophy,
    label: 'Top Supporters',
  },
  {
    type: 'ad_break',
    presetId: 'builtin:composite-ad-break',
    rootRtype: 'compose_layer',
    icon: Megaphone,
    label: 'Ad Break',
  },
  {
    type: 'chat_overlay_3d',
    presetId: 'builtin:composite-chat-overlay-3d',
    rootRtype: 'scene_node',
    icon: MessagesSquare,
    label: 'Chat Overlay (3D)',
  },
  {
    type: 'scrolling_chat',
    presetId: 'builtin:composite-scrolling-chat',
    rootRtype: 'scene_node',
    icon: MessageSquareText,
    label: 'Scrolling Chat (3D)',
  },
];

/** Place a composite at the top of a scene (compose scene for layer
 *  composites). Resolves to the new root's id. Its documents arrive through
 *  the mesh, like any preset. */
export async function placeComposite(
  def: CompositeDef,
  target: {
    projectId: string;
    sceneId: string | null;
    composeSceneId: string | null;
  }
): Promise<string> {
  const preset = await getBuiltinPreset(def.presetId);
  const compose = def.rootRtype === 'compose_layer';
  let payload = preset.payload;
  if (def.uniqueVariable) {
    const taken = variableNames(target.projectId, '', currentProjectDocs());
    payload = renameVariable(
      payload,
      def.uniqueVariable,
      uniqueName(def.uniqueVariable, taken)
    );
  }
  const res = await instantiatePreset(
    payload,
    target.projectId,
    // The route needs a 3D scene id; it is unused for layer roots.
    compose ? (target.sceneId ?? '') : target.sceneId!,
    compose ? target.composeSceneId : null,
    null
  );
  return res.rootId;
}

/** `payload` with every variable node naming `from` (in the shared scope:
 *  no scope set) renamed to `to`. */
export function renameVariable<P>(payload: P, from: string, to: string): P {
  if (from === to) return payload;
  const copy = JSON.parse(JSON.stringify(payload)) as {
    logic?: { descriptor?: { nodes?: unknown } }[];
  };
  for (const g of copy.logic ?? []) {
    const nodes = g.descriptor?.nodes;
    const list = (
      Array.isArray(nodes) ? nodes : Object.values(nodes ?? {})
    ) as { kind?: string; defaultConfig?: Record<string, unknown> }[];
    for (const n of list) {
      const cfg = n.defaultConfig;
      if (
        n.kind &&
        VARIABLE_NODE_KINDS.has(n.kind) &&
        cfg?.name === from &&
        !cfg.scope
      )
        cfg.name = to;
    }
  }
  return copy as P;
}
