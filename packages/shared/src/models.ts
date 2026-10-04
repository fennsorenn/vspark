/**
 * vspark's mesh document types and channels, declared once.
 *
 * Backend and frontend both open their collections from these declarations
 * (`createMeshPeer({ models: MODELS })`), so a parent function or channel list
 * can no longer differ between the two sides. That mismatch used to make the
 * peers' containment indexes diverge silently. What only one side contributes
 * stays with that side: the backend adds persistence, its own checks and its
 * grants; a tab adds its server as the ack authority.
 *
 * The shapes here are structural: the mesh's `ModelDecl` accepts them, and
 * shared code does not depend on the mesh package.
 *
 * Plan: dev-notes/plans/mesh-store-surface.md, step 1.
 */

type Dto = Record<string, unknown>;
type ParentRef = { rtype: string; id: string } | null;

/** One document type, as every peer sees it. */
export interface DocModel {
  /** The containing document, for subtree reads, grants and subscriptions. */
  parent?: (d: Dto) => ParentRef;
  /** Allowed channels; default `['committed', 'preview']`. */
  channels?: string[];
  /** Top-level wall-clock fields (ms) on the writer's clock; each peer
   *  translates them onto its own clock as they arrive. */
  clockFields?: string[];
  /** Checks every peer can run on the composed document (no database). */
  validate?: (doc: unknown, ctx: { origin: string; prev: unknown }) => Dto;
}

const RUNTIME = 'runtime';
const CONTROL = 'control';

const childOfNode = (d: Dto): ParentRef =>
  typeof d.nodeId === 'string' ? { rtype: 'scene_node', id: d.nodeId } : null;

/** A document scoped to a scene node or compose layer by a (kind, id) pair. */
const scopedTo =
  (kindField: string, idField: string) =>
  (d: Dto): ParentRef =>
    (d[kindField] === 'scene_node' || d[kindField] === 'compose_layer') &&
    typeof d[idField] === 'string' &&
    d[idField] !== ''
      ? { rtype: d[kindField] as string, id: d[idField] as string }
      : null;

export const MODELS = {
  // Top-level nodes have parentId null and hang off the scene root through
  // rootSceneNodeId; the scene root itself is its own root, so it has none.
  scene_node: {
    parent: (d) =>
      typeof d.parentId === 'string'
        ? { rtype: 'scene_node', id: d.parentId }
        : typeof d.rootSceneNodeId === 'string' && d.rootSceneNodeId !== d.id
          ? { rtype: 'scene_node', id: d.rootSceneNodeId }
          : null,
  },
  behavior: { parent: childOfNode },
  camera_effect: { parent: childOfNode },
  // Same fallback shape as scene_node, through rootComposeSceneId.
  compose_layer: {
    parent: (d) =>
      typeof d.parentId === 'string'
        ? { rtype: 'compose_layer', id: d.parentId }
        : typeof d.rootComposeSceneId === 'string' &&
            d.rootComposeSceneId !== d.id
          ? { rtype: 'compose_layer', id: d.rootComposeSceneId }
          : null,
  },
  // A clip belongs to its owning node or compose layer, so a scene-subtree
  // grant covers it cross-type.
  track_clip: {
    parent: (d) =>
      typeof d.ownerNodeId === 'string'
        ? { rtype: 'scene_node', id: d.ownerNodeId }
        : typeof d.ownerLayerId === 'string'
          ? { rtype: 'compose_layer', id: d.ownerLayerId }
          : null,
  },
  // FBX/BVH imports belong to their source node.
  animation_clip: {
    parent: (d) =>
      typeof d.sourceNodeId === 'string'
        ? { rtype: 'scene_node', id: d.sourceNodeId }
        : null,
  },
  // A timeline entry belongs to its avatar node; startEpoch is a wall-clock
  // anchor on the writer's clock.
  scheduled_animation: {
    parent: (d) =>
      typeof d.avatarNodeId === 'string'
        ? { rtype: 'scene_node', id: d.avatarNodeId }
        : null,
    clockFields: ['startEpoch'],
  },
  // Transport state belongs to its clip. Keyed on clipId, not id: the
  // containment index keys by id across every rtype, so a playback doc sharing
  // its clip's id would collide with the clip's own entry.
  clip_playback: {
    parent: (d) =>
      typeof d.clipId === 'string'
        ? { rtype: 'track_clip', id: d.clipId }
        : null,
    clockFields: ['startEpoch'],
  },
  // Owned polymorphically by a project, a scene node or a compose layer. A
  // project-owned graph has no parent: there is no `project` rtype.
  logic: {
    parent: (d) =>
      d.ownerKind === 'scene_node' && typeof d.ownerId === 'string'
        ? { rtype: 'scene_node', id: d.ownerId }
        : d.ownerKind === 'compose_layer' && typeof d.ownerId === 'string'
          ? { rtype: 'compose_layer', id: d.ownerId }
          : null,
  },
  // Runtime state hangs off the entity it targets or is scoped to; a global
  // data field (scope '') belongs to no entity.
  runtime_override: {
    channels: [RUNTIME],
    parent: scopedTo('targetKind', 'targetId'),
  },
  data_field: { channels: [RUNTIME], parent: scopedTo('scopeKind', 'scope') },
  media_control: {
    channels: [CONTROL],
    parent: scopedTo('targetKind', 'targetId'),
  },
  // A status about a document hangs off it.
  server_status: {
    channels: [RUNTIME],
    parent: (d) => {
      const of = d.of as { rtype?: unknown; id?: unknown } | null | undefined;
      return of && typeof of.rtype === 'string' && typeof of.id === 'string'
        ? { rtype: of.rtype, id: of.id }
        : null;
    },
  },
  peer_grant: { channels: [RUNTIME] },
  // Server-to-server only: pose/blendshape/drag frames on collab nodes, and
  // runtime events per collab scene.
  node_stream: { channels: ['preview'] },
  runtime_control: { channels: [CONTROL] },
} satisfies Record<string, DocModel>;

export type ModelName = keyof typeof MODELS;

/** The document types a browser tab opens. */
export const TAB_MODELS: readonly ModelName[] = [
  'scene_node',
  'behavior',
  'camera_effect',
  'compose_layer',
  'track_clip',
  'animation_clip',
  'scheduled_animation',
  'clip_playback',
  'logic',
  'runtime_override',
  'data_field',
  'media_control',
  'server_status',
  'peer_grant',
];
