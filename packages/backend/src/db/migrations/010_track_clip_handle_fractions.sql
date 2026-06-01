-- 010_track_clip_handle_fractions: store bezier handles as fractions of the
-- adjoining segment's (Δt, Δv) instead of absolute (Δt-seconds, Δv-units).
-- Resolving to absolute deltas happens at evaluation / render time, so a
-- keyframe's handle shape is preserved when neighbouring keyframes move.
--
-- The old columns held absolute deltas. There's no safe in-place migration of
-- the existing values (they were authored against a snapshot of neighbour
-- positions that we no longer have), so per the design decision we drop the
-- old handle columns and add fresh fraction columns. Existing curves lose
-- their bezier handles and revert to flat-tangent defaults the next time
-- they're evaluated.

ALTER TABLE track_clip_keyframes DROP COLUMN in_handle_t;
ALTER TABLE track_clip_keyframes DROP COLUMN in_handle_v;
ALTER TABLE track_clip_keyframes DROP COLUMN out_handle_t;
ALTER TABLE track_clip_keyframes DROP COLUMN out_handle_v;

ALTER TABLE track_clip_keyframes ADD COLUMN in_handle_t_fraction  REAL;
ALTER TABLE track_clip_keyframes ADD COLUMN in_handle_v_fraction  REAL;
ALTER TABLE track_clip_keyframes ADD COLUMN out_handle_t_fraction REAL;
ALTER TABLE track_clip_keyframes ADD COLUMN out_handle_v_fraction REAL;
