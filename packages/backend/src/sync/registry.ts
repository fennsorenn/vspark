/**
 * Server-side resource registry for the unified sync layer.
 *
 * One descriptor per syncable resource type. The descriptor is the ONLY place
 * vspark-specific knowledge lives (how to load a row, what scope it belongs to);
 * the producer hub and transport stay domain-agnostic.
 *
 * Design: dev-notes/plans/unified-sync-layer.md
 */
import type { ResourceClass } from '@vspark/shared/sync';

export interface ResourceDescriptor<Dto = Record<string, unknown>> {
  rtype: string;
  cls: ResourceClass;
  /** Routing scope for a DTO (e.g. its sceneId). undefined = global fan-out. */
  scope?: (dto: Dto) => string | undefined;
  /** Document only: load a row by id and map it to the canonical DTO.
   *  Returns undefined if the row no longer exists. */
  load?: (id: string) => Dto | undefined;
}

const REGISTRY = new Map<string, ResourceDescriptor>();

export function defineResource<Dto>(d: ResourceDescriptor<Dto>): void {
  REGISTRY.set(d.rtype, d as unknown as ResourceDescriptor);
}

export function getResource(rtype: string): ResourceDescriptor | undefined {
  return REGISTRY.get(rtype);
}

export function allResources(): ResourceDescriptor[] {
  return [...REGISTRY.values()];
}
