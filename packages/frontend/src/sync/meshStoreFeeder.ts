/**
 * Mesh → editorStore feeder (§11 frontend bindings, reads-first).
 *
 * Feeds the editorStore's synced slices from the tab's mesh replica — every
 * document rtype the tab subscribes to (RTYPES in mesh/peer.ts; nine at time
 * of writing); the legacy 'sync'-envelope bindings are retired. The mesh
 * replica already does HLC LWW internally, so observe() only ever fires for
 * applied changes — no client-side stale-drop needed.
 *
 * In-flight gesture values arrive on the mesh 'preview' channel as per-key
 * ephemeral overlays composed over the retained doc, so the CHANNEL is the
 * discriminator — an ephemeral op is a gesture by construction and a retained
 * op is model state (see the compose_layer observer below). The bespoke
 * `compose_layer_preview` / `compose_layer_updated` WS kinds that used to carry
 * that beside the mesh have no producer or consumer left, and node gestures now
 * ride the same channel — including the ones a peer's object-share subscribers
 * see, which read the same overlays through sync/meshProjection. The
 * `node_transform_preview` WS kind that used to carry those is gone.
 *
 * Foreign docs: the tab replica also holds behaviors/effects of PLACED
 * remote objects (their subtree subscription is cross-type). Projections
 * are inert — behaviors run only on the owner — so docs whose parent node
 * is a projected remote node are not mirrored. A doc whose node isn't in
 * the store yet is mirrored anyway (a local node arriving over the other
 * transport may simply be late; stray rows are invisible because panels
 * list by selected local node).
 *
 * Started from the Editor AND the Viewer page (both render live state).
 */
import type { MediaCommand } from '@vspark/shared/types';
import { initMeshPeer } from '../mesh/peer';
import { dispatchMediaCommand } from '../components/editor/mediaRegistry';
import { useEditorStore } from '../store/editorStore';

let started = false;

/** A `runtime_override` document, as the backend writes it. */
interface RawOverride {
  id: string;
  targetKind: 'scene_node' | 'compose_layer';
  targetId: string;
  paramPath: string;
  value: number | string | boolean;
}

/** Split a `runtime_override` id back into its parts. Needed only on remove,
 *  where there is no document left to read the fields off. The id is
 *  `${targetKind}:${targetId}:${paramPath}` — kind and id are colon-free, so
 *  the two splits are unambiguous even though a paramPath contains dots. */
function parseOverrideId(id: string): {
  targetKind: 'scene_node' | 'compose_layer';
  targetId: string;
  paramPath: string;
} | null {
  const i = id.indexOf(':');
  if (i < 0) return null;
  const targetKind = id.slice(0, i);
  if (targetKind !== 'scene_node' && targetKind !== 'compose_layer')
    return null;
  const rest = id.slice(i + 1);
  const j = rest.indexOf(':');
  if (j < 0) return null;
  return {
    targetKind,
    targetId: rest.slice(0, j),
    paramPath: rest.slice(j + 1),
  };
}

/** A `data_field` document. */
interface RawDataField {
  id: string;
  scope: string;
  field: string;
  value: unknown;
}

/** Split a `data_field` id — needed on remove, where the document is gone. The
 *  scope is an entity id or '' (global), so it never contains a colon; the
 *  field label is arbitrary user text and takes the rest. */
function parseDataFieldId(id: string): { scope: string; field: string } | null {
  const i = id.indexOf(':');
  if (i < 0) return null;
  return { scope: id.slice(0, i), field: id.slice(i + 1) };
}

/** A `server_status` document (backend mesh/status.ts). */
interface RawStatus {
  id: string;
  kind: 'tracking' | 'obs_connection' | 'overlive_account' | 'output_window';
  key: string;
  [field: string]: unknown;
}

/** Route one status document into the store slice that shows it. */
function applyStatus(d: RawStatus): void {
  const s = useEditorStore.getState();
  switch (d.kind) {
    case 'tracking':
      return; // read straight from the replica (useTrackingStatuses)
    case 'obs_connection':
      s.patchObsConnectionStatus({
        connectionId: d.key,
        status: d.status as import('../api/client').ObsConnectionStatus,
        reason: (d.reason as string | null) ?? null,
        message: (d.message as string | null) ?? null,
      });
      return;
    case 'overlive_account':
      s.setOverliveAccounts(
        s.overliveAccounts.map((a) =>
          a.id === d.key
            ? {
                ...a,
                status: d.status as typeof a.status,
                statusReason: (d.reason as string | null) ?? null,
                statusMessage: (d.message as string | null) ?? null,
              }
            : a
        )
      );
      return;
    case 'output_window':
      s.setOutputWindowStatus(
        d as unknown as import('../store/editorStore').OutputWindowStatus
      );
      return;
  }
}

/** A `media_control` document. */
interface RawMediaControl {
  id: string;
  targetKind: 'scene_node' | 'compose_layer';
  targetId: string;
  command: MediaCommand;
}

export function startMeshStoreFeeder(): void {
  if (started) return;
  started = true;
  void initMeshPeer()
    .then((h) => {
      // Graph-driven param overrides. One document per overridden path, so a
      // remove IS the clear — including the whole-target clear, which arrives
      // as one remove per path rather than a single message with an optional
      // `paramPath`. There is no snapshot to handle: the channel is retained,
      // so the subscription snapshot delivers the live overrides as ordinary
      // applies through this same observer.
      h.collections.runtime_override.observe('**', (c) => {
        const s = useEditorStore.getState();
        if (c.op === 'remove') {
          const k = parseOverrideId(c.id);
          if (k) s.clearRuntimeOverride(k.targetKind, k.targetId, k.paramPath);
          return;
        }
        const d = c.doc as unknown as RawOverride | undefined;
        if (d)
          s.setRuntimeOverride(d.targetKind, d.targetId, d.paramPath, d.value);
      });
      // Same reason as `logic`: no REST load hydrates this slice, so a
      // subscription snapshot that landed before the observer registered would
      // be lost. Seed from what the replica already holds.
      for (const d of h.collections.runtime_override.all() as unknown as RawOverride[])
        useEditorStore
          .getState()
          .setRuntimeOverride(d.targetKind, d.targetId, d.paramPath, d.value);
      // Published data fields. One document per (scope, field), so a merge is
      // just an upsert and a clear is a remove — the `data_channel_set` /
      // `_clear` / `_snapshot` trio collapses into these two cases.
      h.collections.data_field.observe('**', (c) => {
        const s = useEditorStore.getState();
        if (c.op === 'remove') {
          const k = parseDataFieldId(c.id);
          if (k) s.clearDataChannels(k.scope, k.field);
          return;
        }
        const d = c.doc as unknown as RawDataField | undefined;
        if (d) s.mergeDataChannels(d.scope, { [d.field]: d.value });
      });
      for (const d of h.collections.data_field.all() as unknown as RawDataField[])
        useEditorStore
          .getState()
          .mergeDataChannels(d.scope, { [d.field]: d.value });
      // Media commands. An EVENT, not state: the collection has no retained
      // channel, so there is nothing to seed from and nothing replayed to a tab
      // that connects later — a play from an hour ago must not fire now.
      // Server status (backend mesh/status.ts): retained while the server
      // runs, so a tab that opens later gets it from the snapshot.
      h.collections.server_status.observe('**', (c) => {
        if (c.op !== 'remove' && c.doc)
          applyStatus(c.doc as unknown as RawStatus);
      });
      for (const d of h.collections.server_status.all())
        applyStatus(d as unknown as RawStatus);
      h.collections.media_control.observe('**', (c) => {
        const d = c.doc as unknown as RawMediaControl | undefined;
        if (c.op === 'remove' || !d?.command) return;
        dispatchMediaCommand(d.targetId, d.command);
      });
    })
    .catch((err) => console.warn('[mesh] store feeder init failed:', err));
}
