import { getDb } from '../db/index.js';
import type { WSSync } from '../ws/index.js';

/** A clip is either actively playing (anchor = `startedAt`, wall clock advances)
 *  or paused at a frozen `pausedAtT` seconds. The autoStopTimer only exists for
 *  active non-looping clips. */
type PlaybackEntry =
  | {
      kind: 'playing';
      startedAt: number;
      loop: boolean;
      duration: number;
      stopTimer: NodeJS.Timeout | null;
    }
  | {
      kind: 'paused';
      pausedAtT: number;
      loop: boolean;
      duration: number;
    };

interface BroadcastEntry {
  clipId: string;
  loop: boolean;
  /** ms epoch anchor when playing; absent when paused. */
  startedAt?: number;
  /** seconds-into-clip when paused; absent when playing. */
  pausedAtT?: number;
}

/** Owns the backend-authoritative playhead for all active track clips.
 *  Clients receive an anchor (startedAt) when playing or a frozen pausedAtT when
 *  paused, plus serverNow for clock-skew correction.
 *  Looping clips with autoplay=1 persist started_at so they resume in-phase
 *  after a backend restart. */
export class TrackClipPlaybackManager {
  private active = new Map<string, PlaybackEntry>();

  constructor(private ws: WSSync) {}

  /** Restore loop+autoplay clips on boot. */
  hydrateAutoplay(): void {
    const rows = getDb()
      .prepare(
        'SELECT id, duration, loop, autoplay, started_at FROM track_clips WHERE loop = 1 AND autoplay = 1'
      )
      .all() as {
      id: string;
      duration: number;
      loop: number;
      autoplay: number;
      started_at: number | null;
    }[];

    for (const r of rows) {
      const startedAt = r.started_at ?? Date.now();
      if (r.started_at == null) {
        getDb()
          .prepare('UPDATE track_clips SET started_at = ? WHERE id = ?')
          .run(startedAt, r.id);
      }
      this.active.set(r.id, {
        kind: 'playing',
        startedAt,
        loop: true,
        duration: r.duration,
        stopTimer: null,
      });
    }
  }

  /** Send the current playback snapshot to a freshly-connected WS client. */
  sendSnapshotTo(
    send: (kind: string, payload: Record<string, unknown>) => void
  ): void {
    send('track_clip_playback_snapshot', {
      entries: this.snapshotEntries(),
      serverNow: Date.now(),
    });
  }

  private snapshotEntries(): BroadcastEntry[] {
    return Array.from(this.active.entries()).map(([clipId, e]) =>
      e.kind === 'playing'
        ? { clipId, loop: e.loop, startedAt: e.startedAt }
        : { clipId, loop: e.loop, pausedAtT: e.pausedAtT }
    );
  }

  /** Begin playback for a clip. Stops any prior playback for the same clip first. */
  trigger(clipId: string): void {
    const row = this.loadClipRow(clipId);
    if (!row) return;

    this.clearAutoStopTimer(clipId);

    const startedAt = Date.now();
    const loop = row.loop === 1;
    const entry: PlaybackEntry = {
      kind: 'playing',
      startedAt,
      loop,
      duration: row.duration,
      stopTimer: null,
    };
    if (!loop) {
      entry.stopTimer = setTimeout(
        () => this.stop(clipId),
        Math.max(0, row.duration * 1000)
      );
    }
    this.active.set(clipId, entry);

    this.persistAnchorIfAutoplay(clipId, row, startedAt);
    this.broadcastStarted(clipId, startedAt, loop);
  }

  /** Freeze playback at the current playhead (or no-op if not playing/paused). */
  pause(clipId: string): void {
    const entry = this.active.get(clipId);
    if (!entry || entry.kind === 'paused') return;

    const tNow = Date.now();
    let pausedAtT = (tNow - entry.startedAt) / 1000;
    if (entry.loop && entry.duration > 0) {
      pausedAtT = pausedAtT % entry.duration;
      if (pausedAtT < 0) pausedAtT += entry.duration;
    } else {
      pausedAtT = Math.max(0, Math.min(entry.duration, pausedAtT));
    }

    this.clearAutoStopTimer(clipId);
    this.active.set(clipId, {
      kind: 'paused',
      pausedAtT,
      loop: entry.loop,
      duration: entry.duration,
    });
    // Stop persisting an anchor while paused — restart-after-pause is undefined
    // behaviour for v1 (treat paused state as ephemeral).
    getDb()
      .prepare('UPDATE track_clips SET started_at = NULL WHERE id = ?')
      .run(clipId);
    this.broadcastPaused(clipId, pausedAtT);
  }

  /** Resume from a paused state by anchoring `startedAt` such that the current
   *  elapsed time equals the previously-paused playhead. */
  resume(clipId: string): void {
    const entry = this.active.get(clipId);
    if (!entry) return;
    if (entry.kind === 'playing') return;

    const row = this.loadClipRow(clipId);
    if (!row) return;

    const startedAt = Date.now() - entry.pausedAtT * 1000;
    const loop = entry.loop;
    const next: PlaybackEntry = {
      kind: 'playing',
      startedAt,
      loop,
      duration: entry.duration,
      stopTimer: null,
    };
    if (!loop) {
      const remainingMs = Math.max(
        0,
        (entry.duration - entry.pausedAtT) * 1000
      );
      next.stopTimer = setTimeout(() => this.stop(clipId), remainingMs);
    }
    this.active.set(clipId, next);
    this.persistAnchorIfAutoplay(clipId, row, startedAt);
    this.broadcastStarted(clipId, startedAt, loop);
  }

  /** Seek to time `t` (seconds). Creates a paused entry if none exists yet so the
   *  user can scrub before pressing Play. If the clip was playing, it stays playing
   *  with `startedAt` shifted so elapsed = t. */
  seek(clipId: string, tRequested: number): void {
    const row = this.loadClipRow(clipId);
    if (!row) return;
    const duration = row.duration;
    const loop = row.loop === 1;
    const t = clampOrWrap(tRequested, duration, loop);

    const entry = this.active.get(clipId);

    if (!entry || entry.kind === 'paused') {
      // Stay paused / become paused at the new t.
      this.active.set(clipId, {
        kind: 'paused',
        pausedAtT: t,
        loop,
        duration,
      });
      getDb()
        .prepare('UPDATE track_clips SET started_at = NULL WHERE id = ?')
        .run(clipId);
      this.broadcastPaused(clipId, t);
      return;
    }

    // Playing: shift startedAt so elapsed = t. Reset any pending auto-stop.
    this.clearAutoStopTimer(clipId);
    const startedAt = Date.now() - t * 1000;
    const next: PlaybackEntry = {
      kind: 'playing',
      startedAt,
      loop,
      duration,
      stopTimer: null,
    };
    if (!loop) {
      const remainingMs = Math.max(0, (duration - t) * 1000);
      next.stopTimer = setTimeout(() => this.stop(clipId), remainingMs);
    }
    this.active.set(clipId, next);
    this.persistAnchorIfAutoplay(clipId, row, startedAt);
    this.broadcastStarted(clipId, startedAt, loop);
  }

  stop(clipId: string): void {
    this.stopInternal(clipId, /*broadcast=*/ true);
  }

  private stopInternal(clipId: string, broadcast: boolean): void {
    this.clearAutoStopTimer(clipId);
    if (!this.active.delete(clipId)) return;
    getDb()
      .prepare('UPDATE track_clips SET started_at = NULL WHERE id = ?')
      .run(clipId);
    if (broadcast) this.ws.broadcast('track_clip_stopped', { clipId });
  }

  private clearAutoStopTimer(clipId: string): void {
    const entry = this.active.get(clipId);
    if (entry?.kind === 'playing' && entry.stopTimer)
      clearTimeout(entry.stopTimer);
  }

  /** Called when a clip's settings change. If autoplay was turned off, clear the
   *  persisted anchor. If autoplay+loop turned on while a clip is currently playing,
   *  persist the active anchor. (Paused clips do not persist.) */
  onClipUpdated(clipId: string): void {
    const row = getDb()
      .prepare('SELECT loop, autoplay FROM track_clips WHERE id = ?')
      .get(clipId) as { loop: number; autoplay: number } | undefined;
    if (!row) return;
    const entry = this.active.get(clipId);
    if (!entry) return;

    if (entry.kind === 'playing' && row.loop === 1 && row.autoplay === 1) {
      getDb()
        .prepare('UPDATE track_clips SET started_at = ? WHERE id = ?')
        .run(entry.startedAt, clipId);
    } else {
      getDb()
        .prepare('UPDATE track_clips SET started_at = NULL WHERE id = ?')
        .run(clipId);
    }
  }

  onClipDeleted(clipId: string): void {
    this.stopInternal(clipId, /*broadcast=*/ true);
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private loadClipRow(
    clipId: string
  ): {
    duration: number;
    loop: number;
    autoplay: number;
  } | null {
    const r = getDb()
      .prepare(
        'SELECT duration, loop, autoplay FROM track_clips WHERE id = ?'
      )
      .get(clipId) as
      | {
          duration: number;
          loop: number;
          autoplay: number;
        }
      | undefined;
    return r ?? null;
  }

  private persistAnchorIfAutoplay(
    clipId: string,
    row: { loop: number; autoplay: number },
    startedAt: number
  ): void {
    if (row.loop === 1 && row.autoplay === 1) {
      getDb()
        .prepare('UPDATE track_clips SET started_at = ? WHERE id = ?')
        .run(startedAt, clipId);
    } else {
      getDb()
        .prepare('UPDATE track_clips SET started_at = NULL WHERE id = ?')
        .run(clipId);
    }
  }

  private broadcastStarted(
    clipId: string,
    startedAt: number,
    loop: boolean
  ): void {
    this.ws.broadcast('track_clip_started', {
      clipId,
      startedAt,
      loop,
      serverNow: Date.now(),
    });
  }

  private broadcastPaused(clipId: string, pausedAtT: number): void {
    this.ws.broadcast('track_clip_paused', {
      clipId,
      pausedAtT,
      serverNow: Date.now(),
    });
  }
}

function clampOrWrap(t: number, duration: number, loop: boolean): number {
  if (duration <= 0) return 0;
  if (loop) {
    const w = t % duration;
    return w < 0 ? w + duration : w;
  }
  return Math.max(0, Math.min(duration, t));
}
