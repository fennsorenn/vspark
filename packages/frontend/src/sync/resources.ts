/**
 * Client resource bindings for the unified sync layer.
 *
 * Importing this module registers every resource's `apply` (rtype → store slice)
 * via {@link bindResource}. Imported for side effects by `useWsSync`.
 *
 * Phase 0: empty. CRUD document bindings land in Phase 1, fields in Phase 2,
 * streams in Phase 3.
 *
 * Design: dev-notes/plans/unified-sync-layer.md
 */
export {};
