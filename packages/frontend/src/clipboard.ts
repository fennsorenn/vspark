/**
 * Editor clipboard.
 *
 * Single slot, mirrored in two places:
 *  - OS clipboard via navigator.clipboard — survives reloads and crosses
 *    windows / tabs. Read asynchronously on paste; written eagerly on copy.
 *  - In-memory Zustand slice (`clipboardPayload`) — synchronous read used by
 *    context menus to decide which Paste items to render without an
 *    async-permission round-trip on every right-click.
 *
 * Both surfaces hold a discriminated `ClipboardPayload` union plus a wrapper
 * tag so foreign clipboard contents are ignored cleanly.
 */
import type {
  GraphDescriptor,
  GraphNodeDescriptor,
  GraphEdgeDescriptor,
} from '@vspark/shared/signal';
import type { PresetPayloadInput } from '@vspark/shared/schema';
import type {
  CameraEffectRecord,
  NodeComponentRecord,
  TrackClipRecord,
} from './api/client';

export type OwnerKind = 'project' | 'scene_node' | 'compose_layer';

export type ClipboardPayload =
  | {
      kind: 'graph-nodes';
      nodes: GraphNodeDescriptor[];
      edges: GraphEdgeDescriptor[];
    }
  | {
      kind: 'graph';
      name: string;
      descriptor: GraphDescriptor;
      sourceOwnerKind: OwnerKind;
    }
  | { kind: 'scene-node'; preset: PresetPayloadInput }
  | { kind: 'compose-layer'; preset: PresetPayloadInput }
  | {
      kind: 'camera-effect';
      effect: Omit<CameraEffectRecord, 'id' | 'nodeId'>;
    }
  | {
      kind: 'node-component';
      component: Omit<NodeComponentRecord, 'id' | 'nodeId'>;
    }
  | {
      kind: 'track-clip';
      /** Snapshot of the source clip's top-level fields + lanes + keyframes.
       *  Ids inside (lane.id, kf.id, lane.clipId) are NOT carried — paste
       *  re-mints them. lane.targetId is preserved so the paste-side can
       *  rewrite it conditionally (see ClipsSection.handlePasteClip). */
      clip: Omit<TrackClipRecord, 'id' | 'ownerNodeId' | 'ownerLayerId' | 'startedAt'>;
      /** Owner id at the time of copy. Used by paste to decide which lane
       *  targets to retarget to the destination owner. */
      sourceOwnerId: string;
      sourceOwnerKind: 'scene_node' | 'compose_layer';
    };

export type ClipboardKind = ClipboardPayload['kind'];

const WRAPPER_TAG = 'vspark.clipboard.v1';

interface Wrapper {
  vspark: typeof WRAPPER_TAG;
  payload: ClipboardPayload;
}

/** Serialise a payload and best-effort write to the OS clipboard.
 *  Returns the JSON so the caller can also stash it in memory.
 *  OS-clipboard failures are non-fatal: the in-memory mirror still works. */
export async function writeClipboard(
  payload: ClipboardPayload
): Promise<string> {
  const wrapper: Wrapper = { vspark: WRAPPER_TAG, payload };
  const json = JSON.stringify(wrapper);
  try {
    await navigator.clipboard.writeText(json);
  } catch {
    /* Permission denied / unsupported — in-memory mirror is the fallback. */
  }
  return json;
}

/** Read + parse the OS clipboard. Returns null when the clipboard is empty,
 *  unreadable, or holds something that isn't a vspark payload. */
export async function readClipboard(): Promise<ClipboardPayload | null> {
  try {
    const text = await navigator.clipboard.readText();
    return parseClipboardJson(text);
  } catch {
    return null;
  }
}

/** Convenience: write to OS clipboard AND mirror into the Zustand slice.
 *  Returns the parsed payload echoed back. Callers can ignore the return
 *  value; it's there to make optimistic UI ("you copied 3 nodes") trivial. */
export async function copyToClipboard(
  payload: ClipboardPayload,
  setMemoryClipboard: (p: ClipboardPayload | null) => void
): Promise<ClipboardPayload> {
  await writeClipboard(payload);
  setMemoryClipboard(payload);
  return payload;
}

/** Convenience: prefer the in-memory mirror (synchronous, always current)
 *  but fall back to an async OS-clipboard read so paste works across page
 *  reloads. Returns null when neither has anything usable. */
export async function pasteFromClipboard(
  memoryClipboard: ClipboardPayload | null
): Promise<ClipboardPayload | null> {
  if (memoryClipboard) return memoryClipboard;
  return readClipboard();
}

/** Parse the in-memory string form (used when we wrote a JSON snapshot to
 *  the store at copy-time but the OS read failed). Exposed for testing /
 *  fallbacks. */
export function parseClipboardJson(text: string): ClipboardPayload | null {
  if (!text) return null;
  try {
    const obj = JSON.parse(text) as Partial<Wrapper>;
    if (obj?.vspark !== WRAPPER_TAG) return null;
    const p = obj.payload as ClipboardPayload | undefined;
    if (!p || typeof p !== 'object' || !('kind' in p)) return null;
    return p;
  } catch {
    return null;
  }
}
