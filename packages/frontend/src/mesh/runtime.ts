/**
 * Runtime state, read from the replica: graph-driven param overrides, the
 * published data fields that feed templates, and the server's live status
 * (backend mesh/runtime.ts and mesh/status.ts). Only the server writes these.
 */
import { useCollection, useMeshDoc, useMeshSelector } from '@vspark/mesh-react';
import type { RuntimeOverrideMap } from '../store/editorStore';

interface OverrideDoc {
  id: string;
  targetKind: 'scene_node' | 'compose_layer';
  targetId: string;
  paramPath: string;
  value: number | string | boolean;
}

interface DataFieldDoc {
  id: string;
  scope: string;
  field: string;
  value: unknown;
}

export interface StatusDoc {
  id: string;
  kind: string;
  key: string;
  [field: string]: unknown;
}

/** The runtime overrides on one scene node or compose layer, by param path
 *  (one document per path, parented to the target); undefined when none. */
export function useRuntimeOverrides(
  kind: OverrideDoc['targetKind'],
  targetId: string
): RuntimeOverrideMap | undefined {
  return useMeshSelector(
    useCollection<OverrideDoc>('runtime_override'),
    { subtree: targetId },
    (c) => {
      const mine = c
        .children(targetId)
        .filter((d) => d.targetKind === kind && d.targetId === targetId);
      return mine.length
        ? Object.fromEntries(mine.map((d) => [d.paramPath, d.value]))
        : undefined;
    }
  );
}

/** The data fields published to one scope (an entity id, or '' for global). */
export function useDataFields(
  scope: string
): Record<string, unknown> | undefined {
  return useMeshSelector(
    useCollection<DataFieldDoc>('data_field'),
    '**',
    (c) => {
      const mine = c.all().filter((d) => d.scope === scope);
      return mine.length
        ? Object.fromEntries(mine.map((d) => [d.field, d.value]))
        : undefined;
    }
  );
}

/** One server status document (`${kind}:${key}`). */
export function useServerStatus(
  kind: string,
  key: string
): StatusDoc | undefined {
  return useMeshDoc(
    useCollection<StatusDoc>('server_status'),
    `${kind}:${key}`
  );
}

/** Every status of one kind, by key. */
export function useServerStatuses(kind: string): Record<string, StatusDoc> {
  return useMeshSelector(useCollection<StatusDoc>('server_status'), '**', (c) =>
    Object.fromEntries(
      c
        .all()
        .filter((d) => d.kind === kind)
        .map((d) => [d.key, d])
    )
  );
}

/** A REST record with its live status laid over it: `status`, `reason`,
 *  `message` of a status document become `status`, `statusReason`,
 *  `statusMessage`. */
export function withLiveStatus<
  T extends {
    status?: unknown;
    statusReason?: unknown;
    statusMessage?: unknown;
  },
>(record: T, doc: StatusDoc | undefined): T {
  if (!doc) return record;
  return {
    ...record,
    ...(doc.status !== undefined ? { status: doc.status } : {}),
    ...(doc.reason !== undefined ? { statusReason: doc.reason } : {}),
    ...(doc.message !== undefined ? { statusMessage: doc.message } : {}),
  };
}
