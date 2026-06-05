-- 021_track_clip_events: discrete event/marker lane for track clips.
-- A track clip can carry timed markers that fire fire-and-forget media commands
-- (play/pause/stop/restart/seek/setVolume/mute) at a given playhead time `t`.
-- Unlike scalar lanes (which interpolate continuously), events fire once when
-- the playhead crosses them (re-armed per loop). Evaluated client-side in
-- useTrackClipEvaluator and dispatched to the media registry.
-- See dev-notes/modules/track-clips.md and dev-notes/modules/media.md.

CREATE TABLE IF NOT EXISTS track_clip_events (
  id          TEXT PRIMARY KEY,
  clip_id     TEXT NOT NULL REFERENCES track_clips(id) ON DELETE CASCADE,
  t           REAL NOT NULL DEFAULT 0,
  action      TEXT NOT NULL DEFAULT 'play',
  target_kind TEXT NOT NULL DEFAULT 'scene_node',
  target_id   TEXT NOT NULL,
  payload     TEXT
);

CREATE INDEX IF NOT EXISTS idx_track_clip_events_clip_t ON track_clip_events(clip_id, t);
