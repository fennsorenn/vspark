-- 009_track_clips: Timeline-based parameter animation clips.
-- A clip is scene-scoped, has a duration in seconds, and either loops or plays once.
-- Each lane targets a single scalar parameter on either a scene_node or compose_layer.
-- Keyframes define (t, value) pairs with per-keyframe easing (linear/step/bezier).
-- When loop=1 AND autoplay=1, started_at persists the playhead anchor so playback
-- resumes in-phase across backend restarts. See dev-notes/modules/track-clips.md.

CREATE TABLE IF NOT EXISTS track_clips (
  id           TEXT PRIMARY KEY,
  scene_id     TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  duration     REAL NOT NULL DEFAULT 2,
  loop         INTEGER NOT NULL DEFAULT 0,
  mode         TEXT NOT NULL DEFAULT 'override',
  autoplay     INTEGER NOT NULL DEFAULT 0,
  started_at   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS track_clip_lanes (
  id            TEXT PRIMARY KEY,
  clip_id       TEXT NOT NULL REFERENCES track_clips(id) ON DELETE CASCADE,
  target_kind   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  param_path    TEXT NOT NULL,
  default_value REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS track_clip_keyframes (
  id            TEXT PRIMARY KEY,
  lane_id       TEXT NOT NULL REFERENCES track_clip_lanes(id) ON DELETE CASCADE,
  t             REAL NOT NULL,
  value         REAL NOT NULL,
  easing        TEXT NOT NULL DEFAULT 'linear',
  in_handle_t   REAL,
  in_handle_v   REAL,
  out_handle_t  REAL,
  out_handle_v  REAL
);

CREATE INDEX IF NOT EXISTS idx_track_clips_scene_id        ON track_clips(scene_id);
CREATE INDEX IF NOT EXISTS idx_track_clip_lanes_clip_id    ON track_clip_lanes(clip_id);
CREATE INDEX IF NOT EXISTS idx_track_clip_keyframes_lane_t ON track_clip_keyframes(lane_id, t);
