import { getDb } from '../db/index.js';

export function getSceneNodeDescendants(rootId: string): string[] {
  const db = getDb();
  const ids: string[] = [rootId];
  const queue = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    const children = db
      .prepare('SELECT id FROM scene_nodes WHERE parent_id = ?')
      .all(parentId) as { id: string }[];
    for (const c of children) {
      ids.push(c.id);
      queue.push(c.id);
    }
  }
  return ids;
}

export function getComposeLayerDescendants(rootId: string): string[] {
  const db = getDb();
  const ids: string[] = [rootId];
  const queue = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    const children = db
      .prepare('SELECT id FROM compose_layers WHERE parent_id = ?')
      .all(parentId) as { id: string }[];
    for (const c of children) {
      ids.push(c.id);
      queue.push(c.id);
    }
  }
  return ids;
}
