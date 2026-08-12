/**
 * Server-authoritative checks for client-authored document writes.
 *
 * These used to live inside `POST /scenes/:sceneId/nodes`, which was fine while
 * every create arrived over REST. Clients now author creates directly onto the
 * mesh (so the create lands on the authoring tab's undo stack), and a client
 * must not be able to write a node the route would have refused. The mesh
 * `validate` hook runs on the authority for whole-doc upserts and a throw is
 * returned to the writer as a nack — which rolls their optimistic write back —
 * so the same function guards both paths.
 *
 * Throws {@link SceneNodeInvalid} so the REST route can map it to a 400 while
 * the mesh path turns it into a rejected ack.
 */
import { getDb } from '../db/index.js';

export class SceneNodeInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SceneNodeInvalid';
  }
}

/** The project a scene belongs to, or undefined when it isn't a scene. */
export function sceneProjectId(sceneId: string): string | undefined {
  const row = getDb()
    .prepare(
      "SELECT project_id FROM scene_nodes WHERE id = ? AND kind = 'scene'"
    )
    .get(sceneId) as { project_id: string } | undefined;
  return row?.project_id;
}

/**
 * A `scene_instance` must reference a real scene in the same project, must not
 * instance itself, and must not close a cycle — otherwise scene expansion
 * recurses forever.
 *
 * `projectId` is the project of the scene the instance is being placed IN
 * (derived from the target scene, never taken from the writer).
 */
export function assertSceneInstanceValid(
  rootSceneNodeId: string,
  projectId: string,
  properties: unknown
): void {
  const sourceSceneId = (properties as Record<string, unknown> | undefined)
    ?.sourceSceneId as string | undefined;
  if (!sourceSceneId)
    throw new SceneNodeInvalid(
      'scene_instance requires properties.sourceSceneId'
    );

  const db = getDb();
  const source = db
    .prepare(
      "SELECT id, project_id FROM scene_nodes WHERE id = ? AND kind = 'scene'"
    )
    .get(sourceSceneId) as { id: string; project_id: string } | undefined;
  if (!source || source.project_id !== projectId)
    throw new SceneNodeInvalid(
      'sourceSceneId must reference a scene in the same project'
    );
  if (sourceSceneId === rootSceneNodeId)
    throw new SceneNodeInvalid('a scene cannot instance itself');

  // Walk the instances reachable from the source; reaching the target scene
  // again means placing this instance would close a loop.
  const visited = new Set<string>([rootSceneNodeId]);
  const queue = [sourceSceneId];
  while (queue.length > 0) {
    const sid = queue.shift()!;
    if (visited.has(sid))
      throw new SceneNodeInvalid('circular scene instance detected');
    visited.add(sid);
    const instances = db
      .prepare(
        "SELECT properties FROM scene_nodes WHERE root_scene_node_id = ? AND kind = 'scene_instance'"
      )
      .all(sid) as { properties: string }[];
    for (const inst of instances) {
      const props = JSON.parse(inst.properties || '{}') as {
        sourceSceneId?: string;
      };
      if (props.sourceSceneId) queue.push(props.sourceSceneId);
    }
  }
}

/**
 * Guard a whole-doc scene_node write authored by a browser client.
 *
 * Returns the doc with `projectId` re-derived from the scene it lives in: the
 * client supplies one when creating, and the server owning the row decides what
 * it actually is rather than trusting the writer. Docs whose scene we don't
 * hold are left alone — those are collab projections, handled by the caller.
 */
export function guardClientSceneNode(
  d: Record<string, unknown>
): Record<string, unknown> {
  const rootId =
    typeof d.rootSceneNodeId === 'string' ? d.rootSceneNodeId : undefined;
  // A scene row itself (kind 'scene') is its own root and isn't client-created.
  if (!rootId || rootId === d.id) return d;
  const projectId = sceneProjectId(rootId);
  if (!projectId) return d; // not ours — a collab projection

  if (d.kind === 'scene_instance')
    assertSceneInstanceValid(rootId, projectId, d.properties);

  return d.projectId === projectId ? d : { ...d, projectId };
}

/**
 * Guard a whole-doc compose_layer write authored by a browser client.
 *
 * Compose layers have no cross-document invariant to check the way
 * `scene_instance` does — ordering is a per-sibling fractional key, which can't
 * be made inconsistent by a single write. What the server does own is
 * `projectId`: it is re-derived from the compose scene the layer belongs to
 * rather than taken from the writer. Docs whose compose scene we don't hold are
 * left alone — those are collab projections.
 */
export function guardClientComposeLayer(
  d: Record<string, unknown>
): Record<string, unknown> {
  const rootId =
    typeof d.rootComposeSceneId === 'string' ? d.rootComposeSceneId : undefined;
  // A compose_scene row is its own root and carries no parent scene.
  if (!rootId || rootId === d.id) return d;
  const row = getDb()
    .prepare('SELECT project_id FROM compose_layers WHERE id = ?')
    .get(rootId) as { project_id: string } | undefined;
  if (!row) return d; // not ours — a collab projection
  return d.projectId === row.project_id
    ? d
    : { ...d, projectId: row.project_id };
}
