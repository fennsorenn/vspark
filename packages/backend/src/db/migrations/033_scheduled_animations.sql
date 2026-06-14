-- 033_scheduled_animations: an avatar's animation timeline. Each row is one
-- scheduled clip on an avatar scene_node, ordered by start_epoch. A parallel
-- doc collection (like track_clips / animation_clips) — NOT a scene_node, so it
-- never shows in the scene tree, but it parents to the avatar via
-- avatar_node_id and rides the avatar's collab subtree subscription.
--
-- clip_id references an animation_clip (universal id across peers; the clip's
-- source asset is content-addressed + transferred by hash, the row's local
-- path resolved per-server). start_epoch is a clock-anchored start time
-- (mesh-clock, localized on receive). The frontend resolves the active entry
-- from the synced clock, preloads upcoming ones, drops past ones; pruning of
-- finished entries keeps the collection bounded.
-- See dev-notes/plans/avatar-animation.md.
CREATE TABLE IF NOT EXISTS scheduled_animations (
  id            TEXT PRIMARY KEY,
  avatar_node_id TEXT NOT NULL REFERENCES scene_nodes(id) ON DELETE CASCADE,
  clip_id       TEXT NOT NULL,
  start_epoch   INTEGER NOT NULL,   -- ms since epoch, mesh-clock anchored
  speed         REAL NOT NULL DEFAULT 1,
  loop          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sched_anim_node ON scheduled_animations(avatar_node_id);
