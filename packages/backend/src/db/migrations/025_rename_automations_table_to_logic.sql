-- 025_rename_automations_table_to_logic: the standalone-graph feature was
-- renamed "Automation" -> "Logic" in the UI/code; the table follows.
-- Data-preserving ALTER (indexes + FK refs carried across). Runs once.
-- Chain on existing DBs: graphs (014) -> automations (022) -> logic (025).
ALTER TABLE automations RENAME TO logic;
