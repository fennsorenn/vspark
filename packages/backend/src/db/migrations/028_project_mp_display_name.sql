-- 028_project_mp_display_name: per-project multiplayer display name — the name
-- other peers see you as while this project is active. See Phase 5
-- (dev-notes/plans/multiplayer-phase5.md).
ALTER TABLE projects ADD COLUMN mp_display_name TEXT NOT NULL DEFAULT '';
