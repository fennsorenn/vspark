-- 022_rename_tables_to_vocab: Phase 3 of the vocabulary refactor.
-- Rename two tables so the schema matches the user-facing vocabulary:
--   node_components -> behaviors    (the attachable behavioural drivers; the
--                                    "Behaviors" tab — vmc_receiver, breathing, …)
--   graphs          -> automations  (user-built standalone signal graphs; the
--                                    "Automation" panel)
-- Data-preserving: ALTER TABLE ... RENAME TO keeps every row, and SQLite carries
-- the table's indexes and any foreign-key references across the rename. Runs
-- exactly once (tracked in _migrations). The historical CREATE migrations (002,
-- 014) are left untouched on purpose — on a fresh DB they create the old names
-- and this migration renames them.
-- NOTE: the `project_graphs` table (migration 011, legacy) is intentionally NOT
-- renamed here — the live feature uses the `graphs` table (migration 014).
ALTER TABLE node_components RENAME TO behaviors;
ALTER TABLE graphs RENAME TO automations;
