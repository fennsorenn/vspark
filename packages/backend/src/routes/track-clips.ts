import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { _ws, _trackClipPlayback, _clipPlaybackForwarder } from './shared.js';
import { getMeshCollection } from '../mesh/index.js';

const router: ReturnType<typeof Router> = Router();

// Write-through (§10): a track clip is ONE aggregate document (clip + lanes +
// keyframes + events). Mutation routes load the current DTO from the replica,
// apply the change in memory, and set the whole aggregate; the onCommitted
// tap persists it (delete-then-reinsert, started_at/created_at round-trip)
// and emits sync.document. Playback control routes don't touch the document.
type ClipDto = {
  id: string;
  lanes: LaneDto[];
  events: EventDto[];
  [k: string]: unknown;
};
type LaneDto = {
  id: string;
  clipId: string;
  targetKind: string;
  targetId: string;
  paramPath: string;
  defaultValue: number;
  keyframes: KeyframeDto[];
};
type KeyframeDto = {
  id: string;
  t: number;
  value: number;
  easing: string;
  inHandleTFraction: number | null;
  inHandleVFraction: number | null;
  outHandleTFraction: number | null;
  outHandleVFraction: number | null;
};
type EventDto = {
  id: string;
  t: number;
  action: string;
  targetKind: string;
  targetId: string;
  payload: Record<string, unknown> | null;
};
const clipsCol = () => getMeshCollection('track_clip');

function storeNotReady(res: import('express').Response) {
  res.status(500).json({ ok: false, error: { message: 'store not ready' } });
}

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

/** Create a clip owned by either a scene node or a compose layer (exactly one)
 *  through the store. Returns the loaded clip bundle, or null on validation
 *  failure. */
async function insertClip(
  body: Record<string, unknown>,
  owner: { ownerNodeId: string } | { ownerLayerId: string }
) {
  const { id, name, duration, loop, mode, autoplay } = body;
  if (typeof name !== 'string' || !name) return null;
  const col = clipsCol();
  if (!col) return null;
  const clipId = (id as string) ?? randomUUID();
  await col.set(clipId, '', {
    id: clipId,
    ownerNodeId: 'ownerNodeId' in owner ? owner.ownerNodeId : null,
    ownerLayerId: 'ownerLayerId' in owner ? owner.ownerLayerId : null,
    name,
    duration: (duration as number) ?? 2,
    loop: !!loop,
    mode: (mode as string) ?? 'override',
    autoplay: !!autoplay,
    startedAt: null,
    lanes: [],
    events: [],
  }).ack;
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
router.post('/scene-nodes/:nodeId/track-clips', async (req, res) => {
  const data = await insertClip(req.body ?? {}, {
    ownerNodeId: req.params.nodeId,
  });
  if (!data) return nameRequired(res);
  res.status(201).json({ ok: true, data });
});

/** Create a track clip owned by a compose layer. */
router.post('/compose-layers/:layerId/track-clips', async (req, res) => {
  const data = await insertClip(req.body ?? {}, {
    ownerLayerId: req.params.layerId,
  });
  if (!data) return nameRequired(res);
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
router.put('/track-clips/:id', async (req, res) => {
  const id = req.params.id;
  const patch = req.body ?? {};
  const col = clipsCol();
  const cur = col?.get(id) as ClipDto | undefined;
  if (!col || !cur)
    return res.status(404).json({
      ok: false,
      error: {
        status: 404,
        message: 'track clip not found',
        code: 'NOT_FOUND',
      },
    });
  const next: ClipDto = { ...cur };
  let changed = false;
  for (const k of ['name', 'duration', 'mode'] as const) {
    if (patch[k] !== undefined) {
      next[k] = patch[k];
      changed = true;
    }
  }
  if (patch.loop !== undefined) {
    next.loop = !!patch.loop;
    changed = true;
  }
  if (patch.autoplay !== undefined) {
    next.autoplay = !!patch.autoplay;
    changed = true;
  }
  if (changed) {
    await col.set(id, '', next).ack;
    _trackClipPlayback?.onClipUpdated(id);
  }
  const data = loadClip(id);
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
router.delete('/track-clips/:id', async (req, res) => {
  const id = req.params.id;
  const col = clipsCol();
  if (!col) return storeNotReady(res);
  _trackClipPlayback?.onClipDeleted(id);
  await col.remove(id).ack;
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
router.post('/track-clips/:clipId/lanes', async (req, res) => {
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
  const col = clipsCol();
  const cur = col?.get(clipId) as ClipDto | undefined;
  if (!col || !cur)
    return res.status(404).json({
      ok: false,
      error: { status: 404, message: 'clip not found', code: 'NOT_FOUND' },
    });
  const data: LaneDto = {
    id: id ?? randomUUID(),
    clipId,
    targetKind,
    targetId,
    paramPath,
    defaultValue: defaultValue ?? 0,
    keyframes: [],
  };
  await col.set(clipId, '', {
    ...cur,
    lanes: [...(cur.lanes ?? []), data],
  }).ack;
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
router.put('/track-clip-lanes/:id', async (req, res) => {
  const id = req.params.id;
  const patch = req.body ?? {};
  const owner = getDb()
    .prepare('SELECT clip_id FROM track_clip_lanes WHERE id = ?')
    .get(id) as { clip_id: string } | undefined;
  const col = clipsCol();
  const cur = owner ? (col?.get(owner.clip_id) as ClipDto | undefined) : undefined;
  const lane = cur?.lanes?.find((l) => l.id === id);
  if (!col || !cur || !lane)
    return res.status(404).json({
      ok: false,
      error: { status: 404, message: 'lane not found', code: 'NOT_FOUND' },
    });
  const data: LaneDto = { ...lane };
  for (const k of [
    'targetKind',
    'targetId',
    'paramPath',
    'defaultValue',
  ] as const) {
    if (patch[k] !== undefined) (data as Record<string, unknown>)[k] = patch[k];
  }
  await col.set(cur.id, '', {
    ...cur,
    lanes: cur.lanes.map((l) => (l.id === id ? data : l)),
  }).ack;
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
router.delete('/track-clip-lanes/:id', async (req, res) => {
  const id = req.params.id;
  const row = getDb()
    .prepare('SELECT clip_id FROM track_clip_lanes WHERE id = ?')
    .get(id) as { clip_id: string } | undefined;
  const col = clipsCol();
  const cur = row ? (col?.get(row.clip_id) as ClipDto | undefined) : undefined;
  if (col && cur)
    await col.set(cur.id, '', {
      ...cur,
      lanes: (cur.lanes ?? []).filter((l) => l.id !== id),
    }).ack;
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
router.put('/track-clip-lanes/:id/keyframes', async (req, res) => {
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
  // 404 on a stale lane lets the frontend drop it from its state cleanly.
  const laneRow = getDb()
    .prepare('SELECT id, clip_id FROM track_clip_lanes WHERE id = ?')
    .get(laneId) as { id: string; clip_id: string } | undefined;
  const col = clipsCol();
  const cur = laneRow
    ? (col?.get(laneRow.clip_id) as ClipDto | undefined)
    : undefined;
  if (!col || !cur || !cur.lanes?.some((l) => l.id === laneId)) {
    return res.status(404).json({
      ok: false,
      error: { status: 404, message: 'lane not found', code: 'NOT_FOUND' },
    });
  }
  const next: KeyframeDto[] = keyframes
    .map((k) => ({
      id: k.id ?? randomUUID(),
      t: k.t,
      value: k.value,
      easing: k.easing ?? 'linear',
      inHandleTFraction: k.inHandleTFraction ?? null,
      inHandleVFraction: k.inHandleVFraction ?? null,
      outHandleTFraction: k.outHandleTFraction ?? null,
      outHandleVFraction: k.outHandleVFraction ?? null,
    }))
    .sort((a, b) => a.t - b.t);
  await col.set(cur.id, '', {
    ...cur,
    lanes: cur.lanes.map((l) =>
      l.id === laneId ? { ...l, keyframes: next } : l
    ),
  }).ack;
  const data = { laneId, keyframes: next };
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
  _clipPlaybackForwarder?.(req.params.id, 'trigger');
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
  _clipPlaybackForwarder?.(req.params.id, 'stop');
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
  _clipPlaybackForwarder?.(req.params.id, 'pause');
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
  _clipPlaybackForwarder?.(req.params.id, 'resume');
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
  _clipPlaybackForwarder?.(req.params.id, 'seek', t);
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
router.put('/track-clips/:id/events', async (req, res) => {
  const clipId = req.params.id;
  const events = (req.body?.events ?? []) as Array<{
    id?: string;
    t: number;
    action: string;
    targetKind?: string;
    targetId: string;
    payload?: Record<string, unknown> | null;
  }>;
  const col = clipsCol();
  const cur = col?.get(clipId) as ClipDto | undefined;
  if (!col || !cur) {
    return res.status(404).json({
      ok: false,
      error: { status: 404, message: 'clip not found', code: 'NOT_FOUND' },
    });
  }
  const next: EventDto[] = events
    .map((e) => ({
      id: e.id ?? randomUUID(),
      t: e.t ?? 0,
      action: e.action ?? 'play',
      targetKind: e.targetKind ?? 'scene_node',
      targetId: e.targetId,
      payload: e.payload ?? null,
    }))
    .sort((a, b) => a.t - b.t);
  await col.set(clipId, '', { ...cur, events: next }).ack;
  const data = { clipId, events: next };
  _ws?.broadcast('track_clip_events_replaced', data);
  res.json({ ok: true, data });
});

export default router;
