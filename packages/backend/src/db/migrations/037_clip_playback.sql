-- 037_clip_playback: a track clip's transport state, as a synced document.
--
-- Replaces the backend-authoritative playhead (track_clips/playback.ts), which
-- held state in an in-memory Map and pushed track_clip_started/paused/stopped
-- over /ws. Under "sync the inputs, derive the outputs" a peer needs the clip
-- and this row to evaluate playback itself: the playhead is DERIVED from
-- start_epoch against the wall clock, never streamed.
--
-- Why its own table rather than a column on track_clips: the old playhead wrote
-- track_clips.started_at with raw SQL while every clip route rebuilt the whole
-- aggregate from the mesh replica, so renaming a clip mid-playback stamped a
-- stale anchor back over the live one. Two writers, one column. Splitting the
-- anchor onto its own document removes the class rather than the instance.
--
-- Why its own id rather than reusing clip_id as the primary key: the mesh's
-- ContainmentIndex (packages/shared/src/containment.ts) keys by id ALONE,
-- across every rtype. A clip_playback doc sharing an id with its track_clip
-- would collide in that index. So: own uuid, plus a UNIQUE clip_id that carries
-- the 1-to-0..1 relation and the FK cascade.
--
-- state 'stopped' is a ROW, not the absence of one. Absence-means-stopped would
-- make every Stop a document delete and every Play a create — tombstone churn
-- on the most-pressed control in the app, and the mesh parks a first write to a
-- document it has not seen. A clip that has never been played simply has no row.
--
-- paused_at_t freezes the playhead while paused; start_epoch is re-anchored on
-- resume so the derivation stays a single subtraction. start_epoch is
-- mesh-clock anchored and localized on receive, same as scheduled_animations.
CREATE TABLE IF NOT EXISTS clip_playback (
  id          TEXT PRIMARY KEY,
  clip_id     TEXT NOT NULL UNIQUE REFERENCES track_clips(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'stopped',  -- playing | paused | stopped
  start_epoch INTEGER,                          -- ms, mesh-clock anchored
  paused_at_t REAL,                             -- playhead (s) while paused
  speed       REAL NOT NULL DEFAULT 1,
  loop        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clip_playback_clip ON clip_playback(clip_id);
