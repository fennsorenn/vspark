import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { _ws, _trackClipPlayback } from './shared.js';

const router: ReturnType<typeof Router> = Router();

type ClipRow = {
  id: string;
  owner_node_id: string | null;
  owner_layer_id: string | null;
  name: string;
  duration: number;
  loop: number;
  mode: string;
  autoplay: number;
  started_at: number | null;
  created_at: string;
};

type LaneRow = {
  id: string;
  clip_id: string;
  target_kind: string;
  target_id: string;
  param_path: string;
  default_value: number;
};

type KeyframeRow = {
  id: string;
  lane_id: string;
  t: number;
  value: number;
  easing: string;
  in_handle_t_fraction: number | null;
  in_handle_v_fraction: number | null;
  out_handle_t_fraction: number | null;
  out_handle_v_fraction: number | null;
};

type EventRow = {
  id: string;
  clip_id: string;
  t: number;
  action: string;
  target_kind: string;
  target_id: string;
  payload: string | null;
};

function mapEvent(r: EventRow) {
  let payload: Record<string, unknown> | null = null;
  if (r.payload) {
    try {
      payload = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  return {
    id: r.id,
    t: r.t,
    action: r.action,
    targetKind: r.target_kind,
    targetId: r.target_id,
    payload,
  };
}

function mapKeyframe(r: KeyframeRow) {
  return {
    id: r.id,
    t: r.t,
    value: r.value,
    easing: r.easing,
    inHandleTFraction: r.in_handle_t_fraction,
    inHandleVFraction: r.in_handle_v_fraction,
    outHandleTFraction: r.out_handle_t_fraction,
    outHandleVFraction: r.out_handle_v_fraction,
  };
}

function mapLane(r: LaneRow, keyframes: KeyframeRow[]) {
  return {
    id: r.id,
    clipId: r.clip_id,
    targetKind: r.target_kind,
    targetId: r.target_id,
    paramPath: r.param_path,
    defaultValue: r.default_value,
    keyframes: keyframes.map(mapKeyframe),
  };
}

function mapClip(
  r: ClipRow,
  lanes: { lane: LaneRow; kfs: KeyframeRow[] }[],
  events: EventRow[]
) {
  return {
    id: r.id,
    ownerNodeId: r.owner_node_id,
    ownerLayerId: r.owner_layer_id,
    name: r.name,
    duration: r.duration,
    loop: r.loop === 1,
    mode: r.mode,
    autoplay: r.autoplay === 1,
    startedAt: r.started_at,
    createdAt: r.created_at,
    lanes: lanes.map(({ lane, kfs }) => mapLane(lane, kfs)),
    events: events.map(mapEvent),
  };
}

export function loadClip(clipId: string) {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM track_clips WHERE id = ?')
    .get(clipId) as ClipRow | undefined;
  if (!row) return null;
  const lanes = db
    .prepare('SELECT * FROM track_clip_lanes WHERE clip_id = ?')
    .all(clipId) as LaneRow[];
  const laneBundles = lanes.map((lane) => ({
    lane,
    kfs: db
      .prepare(
        'SELECT * FROM track_clip_keyframes WHERE lane_id = ? ORDER BY t'
      )
      .all(lane.id) as KeyframeRow[],
  }));
  const events = db
    .prepare('SELECT * FROM track_clip_events WHERE clip_id = ? ORDER BY t')
    .all(clipId) as EventRow[];
  return mapClip(row, laneBundles, events);
}

/** GET track clips owned by a specific scene node (scene roots included). */
router.get('/scene-nodes/:nodeId/track-clips', (req, res) => {
  const db = getDb();
  const clips = db
    .prepare(
      'SELECT * FROM track_clips WHERE owner_node_id = ? ORDER BY created_at'
    )
    .all(req.params.nodeId) as ClipRow[];
  const data = clips.map((c) => loadClip(c.id)).filter((c) => c != null);
  res.json({ ok: true, data });
});

/** GET track clips owned by a specific compose layer. */
router.get('/compose-layers/:layerId/track-clips', (req, res) => {
  const db = getDb();
  const clips = db
    .prepare(
      'SELECT * FROM track_clips WHERE owner_layer_id = ? ORDER BY created_at'
    )
    .all(req.params.layerId) as ClipRow[];
  const data = clips.map((c) => loadClip(c.id)).filter((c) => c != null);
  res.json({ ok: true, data });
});

/** Insert a clip owned by either a scene node or a compose layer (exactly one).
 *  Returns the loaded clip bundle, or null on validation failure. */
function insertClip(
  body: Record<string, unknown>,
  owner: { ownerNodeId: string } | { ownerLayerId: string }
) {
  const { id, name, duration, loop, mode, autoplay } = body;
  if (typeof name !== 'string' || !name) return null;
  const clipId = (id as string) ?? randomUUID();
  const ownerNodeId = 'ownerNodeId' in owner ? owner.ownerNodeId : null;
  const ownerLayerId = 'ownerLayerId' in owner ? owner.ownerLayerId : null;
  getDb()
    .prepare(
      `INSERT INTO track_clips (id, owner_node_id, owner_layer_id, name, duration, loop, mode, autoplay)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      clipId,
      ownerNodeId,
      ownerLayerId,
      name,
      (duration as number) ?? 2,
      loop ? 1 : 0,
      (mode as string) ?? 'override',
      autoplay ? 1 : 0
    );
  return loadClip(clipId);
}

function nameRequired(res: import('express').Response) {
  res.status(400).json({
    ok: false,
    error: {
      status: 400,
      message: 'name is required',
      code: 'VALIDATION_ERROR',
    },
  });
}

/** Create a track clip owned by a scene node. */
router.post('/scene-nodes/:nodeId/track-clips', (req, res) => {
  const data = insertClip(req.body ?? {}, { ownerNodeId: req.params.nodeId });
  if (!data) return nameRequired(res);
  _ws?.broadcast('track_clip_added', data as Record<string, unknown>);
  res.status(201).json({ ok: true, data });
});

/** Create a track clip owned by a compose layer. */
router.post('/compose-layers/:layerId/track-clips', (req, res) => {
  const data = insertClip(req.body ?? {}, { ownerLayerId: req.params.layerId });
  if (!data) return nameRequired(res);
  _ws?.broadcast('track_clip_added', data as Record<string, unknown>);
  res.status(201).json({ ok: true, data });
});

/**
 * @openapi
 * /api/track-clips/{id}:
 *   put:
 *     tags: [track_clips]
 *     summary: Patch a track clip's top-level fields
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdateTrackClip' }
 *     responses:
 *       200: { description: Updated; broadcast as track_clip_updated }
 */
router.put('/track-clips/:id', (req, res) => {
  const id = req.params.id;
  const patch = req.body ?? {};
  const cols: string[] = [];
  const vals: unknown[] = [];
  if (patch.name !== undefined) {
    cols.push('name = ?');
    vals.push(patch.name);
  }
  if (patch.duration !== undefined) {
    cols.push('duration = ?');
    vals.push(patch.duration);
  }
  if (patch.loop !== undefined) {
    cols.push('loop = ?');
    vals.push(patch.loop ? 1 : 0);
  }
  if (patch.mode !== undefined) {
    cols.push('mode = ?');
    vals.push(patch.mode);
  }
  if (patch.autoplay !== undefined) {
    cols.push('autoplay = ?');
    vals.push(patch.autoplay ? 1 : 0);
  }
  if (cols.length > 0) {
    vals.push(id);
    getDb()
      .prepare(`UPDATE track_clips SET ${cols.join(', ')} WHERE id = ?`)
      .run(...vals);
    _trackClipPlayback?.onClipUpdated(id);
  }
  const data = loadClip(id);
  if (!data)
    return res.status(404).json({
      ok: false,
      error: {
        status: 404,
        message: 'track clip not found',
        code: 'NOT_FOUND',
      },
    });
  _ws?.broadcast('track_clip_updated', data as Record<string, unknown>);
  res.json({ ok: true, data });
});

/**
 * @openapi
 * /api/track-clips/{id}:
 *   delete:
 *     tags: [track_clips]
 *     summary: Delete a track clip (cascades lanes + keyframes)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted; broadcast as track_clip_removed }
 */
router.delete('/track-clips/:id', (req, res) => {
  const id = req.params.id;
  _trackClipPlayback?.onClipDeleted(id);
  getDb().prepare('DELETE FROM track_clips WHERE id = ?').run(id);
  _ws?.broadcast('track_clip_removed', { id });
  res.json({ ok: true, data: { id } });
});

/**
 * @openapi
 * /api/track-clips/{clipId}/lanes:
 *   post:
 *     tags: [track_clips]
 *     summary: Add a lane to a track clip
 *     parameters:
 *       - { in: path, name: clipId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateTrackClipLane' }
 *     responses:
 *       201: { description: Created; broadcast as track_clip_lane_added }
 */
router.post('/track-clips/:clipId/lanes', (req, res) => {
  const clipId = req.params.clipId;
  const { id, targetKind, targetId, paramPath, defaultValue } = req.body ?? {};
  if (!targetKind || !targetId || !paramPath) {
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'targetKind, targetId, paramPath required',
        code: 'VALIDATION_ERROR',
      },
    });
  }
  const laneId = id ?? randomUUID();
  getDb()
    .prepare(
      `INSERT INTO track_clip_lanes (id, clip_id, target_kind, target_id, param_path, default_value)
     VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(laneId, clipId, targetKind, targetId, paramPath, defaultValue ?? 0);
  const row = getDb()
    .prepare('SELECT * FROM track_clip_lanes WHERE id = ?')
    .get(laneId) as LaneRow;
  const data = mapLane(row, []);
  _ws?.broadcast(
    'track_clip_lane_added',
    data as unknown as Record<string, unknown>
  );
  res.status(201).json({ ok: true, data });
});

/**
 * @openapi
 * /api/track-clip-lanes/{id}:
 *   put:
 *     tags: [track_clips]
 *     summary: Patch a lane's target/param/default
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdateTrackClipLane' }
 *     responses:
 *       200: { description: Updated; broadcast as track_clip_lane_updated }
 */
router.put('/track-clip-lanes/:id', (req, res) => {
  const id = req.params.id;
  const patch = req.body ?? {};
  const cols: string[] = [];
  const vals: unknown[] = [];
  if (patch.targetKind !== undefined) {
    cols.push('target_kind = ?');
    vals.push(patch.targetKind);
  }
  if (patch.targetId !== undefined) {
    cols.push('target_id = ?');
    vals.push(patch.targetId);
  }
  if (patch.paramPath !== undefined) {
    cols.push('param_path = ?');
    vals.push(patch.paramPath);
  }
  if (patch.defaultValue !== undefined) {
    cols.push('default_value = ?');
    vals.push(patch.defaultValue);
  }
  if (cols.length > 0) {
    vals.push(id);
    getDb()
      .prepare(`UPDATE track_clip_lanes SET ${cols.join(', ')} WHERE id = ?`)
      .run(...vals);
  }
  const row = getDb()
    .prepare('SELECT * FROM track_clip_lanes WHERE id = ?')
    .get(id) as LaneRow | undefined;
  if (!row)
    return res.status(404).json({
      ok: false,
      error: { status: 404, message: 'lane not found', code: 'NOT_FOUND' },
    });
  const kfs = getDb()
    .prepare('SELECT * FROM track_clip_keyframes WHERE lane_id = ? ORDER BY t')
    .all(id) as KeyframeRow[];
  const data = mapLane(row, kfs);
  _ws?.broadcast(
    'track_clip_lane_updated',
    data as unknown as Record<string, unknown>
  );
  res.json({ ok: true, data });
});

/**
 * @openapi
 * /api/track-clip-lanes/{id}:
 *   delete:
 *     tags: [track_clips]
 *     summary: Delete a lane (cascades keyframes)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted; broadcast as track_clip_lane_removed }
 */
router.delete('/track-clip-lanes/:id', (req, res) => {
  const id = req.params.id;
  const row = getDb()
    .prepare('SELECT clip_id FROM track_clip_lanes WHERE id = ?')
    .get(id) as { clip_id: string } | undefined;
  getDb().prepare('DELETE FROM track_clip_lanes WHERE id = ?').run(id);
  _ws?.broadcast('track_clip_lane_removed', {
    id,
    clipId: row?.clip_id ?? null,
  });
  res.json({ ok: true, data: { id } });
});

/**
 * @openapi
 * /api/track-clip-lanes/{id}/keyframes:
 *   put:
 *     tags: [track_clips]
 *     summary: Replace all keyframes on a lane (drag-then-commit pattern)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ReplaceTrackClipKeyframes' }
 *     responses:
 *       200: { description: Replaced; broadcast as track_clip_keyframes_replaced }
 */
router.put('/track-clip-lanes/:id/keyframes', (req, res) => {
  const laneId = req.params.id;
  const keyframes = (req.body?.keyframes ?? []) as Array<{
    id?: string;
    t: number;
    value: number;
    easing?: string;
    inHandleTFraction?: number | null;
    inHandleVFraction?: number | null;
    outHandleTFraction?: number | null;
    outHandleVFraction?: number | null;
  }>;
  const db = getDb();

  // Validate the lane exists up-front: otherwise the DELETE silently no-ops and
  // the INSERTs blow up with a FOREIGN KEY violation (500). Returning 404 lets
  // the frontend drop the stale lane from its state cleanly.
  const laneRow = db
    .prepare('SELECT id FROM track_clip_lanes WHERE id = ?')
    .get(laneId) as { id: string } | undefined;
  if (!laneRow) {
    return res.status(404).json({
      ok: false,
      error: { status: 404, message: 'lane not found', code: 'NOT_FOUND' },
    });
  }

  db.prepare('DELETE FROM track_clip_keyframes WHERE lane_id = ?').run(laneId);
  // NOTE: db.prepare() returns a PreparedStatement that auto-finalizes after
  // each .run(), so we can't hoist this out of the loop and re-use it. The
  // keyframe list per commit is small (a handful at most), so re-preparing
  // per row is fine. If this becomes a hot path, fix the wrapper instead.
  for (const k of keyframes) {
    db.prepare(
      `INSERT INTO track_clip_keyframes
         (id, lane_id, t, value, easing,
          in_handle_t_fraction, in_handle_v_fraction,
          out_handle_t_fraction, out_handle_v_fraction)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      k.id ?? randomUUID(),
      laneId,
      k.t,
      k.value,
      k.easing ?? 'linear',
      k.inHandleTFraction ?? null,
      k.inHandleVFraction ?? null,
      k.outHandleTFraction ?? null,
      k.outHandleVFraction ?? null
    );
  }
  const rows = db
    .prepare('SELECT * FROM track_clip_keyframes WHERE lane_id = ? ORDER BY t')
    .all(laneId) as KeyframeRow[];
  const data = { laneId, keyframes: rows.map(mapKeyframe) };
  _ws?.broadcast('track_clip_keyframes_replaced', data);
  res.json({ ok: true, data });
});

/**
 * @openapi
 * /api/track-clips/{id}/trigger:
 *   post:
 *     tags: [track_clips]
 *     summary: Start playback now. Broadcasts track_clip_started.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Triggered }
 */
router.post('/track-clips/:id/trigger', (req, res) => {
  if (!_trackClipPlayback) {
    return res.status(503).json({
      ok: false,
      error: {
        status: 503,
        message: 'playback manager not ready',
        code: 'NOT_READY',
      },
    });
  }
  _trackClipPlayback.trigger(req.params.id);
  res.json({ ok: true, data: { id: req.params.id } });
});

/**
 * @openapi
 * /api/track-clips/{id}/stop:
 *   post:
 *     tags: [track_clips]
 *     summary: Stop playback. Broadcasts track_clip_stopped.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Stopped }
 */
router.post('/track-clips/:id/stop', (req, res) => {
  if (!_trackClipPlayback) {
    return res.status(503).json({
      ok: false,
      error: {
        status: 503,
        message: 'playback manager not ready',
        code: 'NOT_READY',
      },
    });
  }
  _trackClipPlayback.stop(req.params.id);
  res.json({ ok: true, data: { id: req.params.id } });
});

/**
 * @openapi
 * /api/track-clips/{id}/pause:
 *   post:
 *     tags: [track_clips]
 *     summary: Freeze playback at the current playhead. Broadcasts track_clip_paused.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Paused }
 */
router.post('/track-clips/:id/pause', (req, res) => {
  if (!_trackClipPlayback) {
    return res.status(503).json({
      ok: false,
      error: {
        status: 503,
        message: 'playback manager not ready',
        code: 'NOT_READY',
      },
    });
  }
  _trackClipPlayback.pause(req.params.id);
  res.json({ ok: true, data: { id: req.params.id } });
});

/**
 * @openapi
 * /api/track-clips/{id}/resume:
 *   post:
 *     tags: [track_clips]
 *     summary: Resume from a paused state. Broadcasts track_clip_started.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Resumed }
 */
router.post('/track-clips/:id/resume', (req, res) => {
  if (!_trackClipPlayback) {
    return res.status(503).json({
      ok: false,
      error: {
        status: 503,
        message: 'playback manager not ready',
        code: 'NOT_READY',
      },
    });
  }
  _trackClipPlayback.resume(req.params.id);
  res.json({ ok: true, data: { id: req.params.id } });
});

/**
 * @openapi
 * /api/track-clips/{id}/seek:
 *   post:
 *     tags: [track_clips]
 *     summary: Move the playhead to time `t` (seconds). Creates a paused entry if none exists.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [t]
 *             properties: { t: { type: number } }
 *     responses:
 *       200: { description: Seeked }
 */
router.post('/track-clips/:id/seek', (req, res) => {
  if (!_trackClipPlayback) {
    return res.status(503).json({
      ok: false,
      error: {
        status: 503,
        message: 'playback manager not ready',
        code: 'NOT_READY',
      },
    });
  }
  const t = Number(req.body?.t);
  if (!Number.isFinite(t)) {
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 't (number) is required',
        code: 'VALIDATION_ERROR',
      },
    });
  }
  _trackClipPlayback.seek(req.params.id, t);
  res.json({ ok: true, data: { id: req.params.id, t } });
});

/**
 * @openapi
 * /api/track-clips/{id}/events:
 *   put:
 *     tags: [track_clips]
 *     summary: Replace all event markers on a clip (drag-then-commit pattern)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Replaced; broadcast as track_clip_events_replaced }
 */
router.put('/track-clips/:id/events', (req, res) => {
  const clipId = req.params.id;
  const events = (req.body?.events ?? []) as Array<{
    id?: string;
    t: number;
    action: string;
    targetKind?: string;
    targetId: string;
    payload?: Record<string, unknown> | null;
  }>;
  const db = getDb();

  const clipRow = db
    .prepare('SELECT id FROM track_clips WHERE id = ?')
    .get(clipId) as { id: string } | undefined;
  if (!clipRow) {
    return res.status(404).json({
      ok: false,
      error: { status: 404, message: 'clip not found', code: 'NOT_FOUND' },
    });
  }

  db.prepare('DELETE FROM track_clip_events WHERE clip_id = ?').run(clipId);
  for (const e of events) {
    db.prepare(
      `INSERT INTO track_clip_events
         (id, clip_id, t, action, target_kind, target_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      e.id ?? randomUUID(),
      clipId,
      e.t ?? 0,
      e.action ?? 'play',
      e.targetKind ?? 'scene_node',
      e.targetId,
      e.payload != null ? JSON.stringify(e.payload) : null
    );
  }
  const rows = db
    .prepare('SELECT * FROM track_clip_events WHERE clip_id = ? ORDER BY t')
    .all(clipId) as EventRow[];
  const data = { clipId, events: rows.map(mapEvent) };
  _ws?.broadcast('track_clip_events_replaced', data);
  res.json({ ok: true, data });
});

export default router;
