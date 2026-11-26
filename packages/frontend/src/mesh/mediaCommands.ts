/**
 * Media commands (play / pause / seek on a video or audio entity) arrive as
 * `media_control` documents on the `control` channel: events, not state — the
 * collection keeps nothing, so a command from an hour ago never fires for a
 * tab that connects later. Each one goes straight to the entity's player.
 */
import type { MeshPeer } from '@vspark/mesh';
import type { MediaCommand } from '@vspark/shared/types';
import { dispatchMediaCommand } from '../components/editor/mediaRegistry';

interface MediaControlDoc {
  id: string;
  targetKind: 'scene_node' | 'compose_layer';
  targetId: string;
  command: MediaCommand;
}

export function startMediaCommands(peer: MeshPeer): () => void {
  return peer
    .collection<MediaControlDoc>('media_control')
    .observe('**', (c) => {
      if (c.op === 'remove' || !c.doc?.command) return;
      dispatchMediaCommand(c.doc.targetId, c.doc.command);
    });
}
