/**
 * Capture delivery metrics — the actual deliverable of the two-provider experiment.
 *
 * What matters is NOT internal inference fps. It is whether landmark frames keep
 * *arriving* at the behaviour manager while a game is running. The failure mode being
 * hunted is a multi-hundred-millisecond stall (Windows EcoQoS demoting a Chromium
 * renderer, priority inversion under load) and a mean would hide exactly that — a
 * provider that delivers 10 fps with a 700 ms hole every few seconds averages fine and
 * looks terrible on stream.
 *
 * So the headline numbers here are the **p95 and max inter-frame gap**, with median
 * alongside for context.
 */

import { appendFile } from 'fs/promises';
import type { CaptureKind, CaptureProviderId } from './types.js';

/** Rolling window of inter-frame gaps kept per stream. ~30s at 30fps. */
const WINDOW = 900;

export interface CaptureStreamMetrics {
  behaviorId: string;
  kind: CaptureKind;
  provider: CaptureProviderId;
  /** Frames delivered since this stream started. */
  frames: number;
  /** Frames per second over the retained window. */
  fps: number;
  medianGapMs: number;
  p95GapMs: number;
  maxGapMs: number;
  /** Gaps beyond this are counted as stalls — the viewer-visible failure. */
  stallThresholdMs: number;
  stalls: number;
  startedAt: number;
  lastFrameAt: number | null;
}

interface StreamState {
  behaviorId: string;
  kind: CaptureKind;
  provider: CaptureProviderId;
  gaps: number[];
  frames: number;
  startedAt: number;
  lastFrameAt: number | null;
  stalls: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank; on a short window this is less misleading than interpolating.
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export class CaptureMetrics {
  private readonly streams = new Map<string, StreamState>();
  /** Gap above which delivery is considered visibly broken rather than merely slow. */
  stallThresholdMs = 250;
  /** When set, every stream summary is appended here as CSV for offline comparison. */
  private csvPath: string | null = null;
  private csvHeaderWritten = false;

  begin(
    behaviorId: string,
    kind: CaptureKind,
    provider: CaptureProviderId
  ): void {
    this.streams.set(behaviorId, {
      behaviorId,
      kind,
      provider,
      gaps: [],
      frames: 0,
      startedAt: Date.now(),
      lastFrameAt: null,
      stalls: 0,
    });
  }

  end(behaviorId: string): void {
    this.streams.delete(behaviorId);
  }

  /** Call once per delivered frame, at the moment it reaches the behaviour manager. */
  record(behaviorId: string, at = Date.now()): void {
    const s = this.streams.get(behaviorId);
    if (!s) return;
    if (s.lastFrameAt !== null) {
      const gap = at - s.lastFrameAt;
      s.gaps.push(gap);
      if (s.gaps.length > WINDOW) s.gaps.shift();
      if (gap > this.stallThresholdMs) s.stalls++;
    }
    s.lastFrameAt = at;
    s.frames++;
  }

  snapshot(): CaptureStreamMetrics[] {
    return [...this.streams.values()].map((s) => this.summarise(s));
  }

  get(behaviorId: string): CaptureStreamMetrics | null {
    const s = this.streams.get(behaviorId);
    return s ? this.summarise(s) : null;
  }

  private summarise(s: StreamState): CaptureStreamMetrics {
    const sorted = [...s.gaps].sort((a, b) => a - b);
    const total = sorted.reduce((a, b) => a + b, 0);
    return {
      behaviorId: s.behaviorId,
      kind: s.kind,
      provider: s.provider,
      frames: s.frames,
      // Derived from the retained gaps rather than wall-clock since start, so a provider
      // that was idle before capture began isn't penalised.
      fps: total > 0 ? (sorted.length / total) * 1000 : 0,
      medianGapMs: percentile(sorted, 0.5),
      p95GapMs: percentile(sorted, 0.95),
      maxGapMs: sorted.length ? sorted[sorted.length - 1] : 0,
      stallThresholdMs: this.stallThresholdMs,
      stalls: s.stalls,
      startedAt: s.startedAt,
      lastFrameAt: s.lastFrameAt,
    };
  }

  setCsvPath(path: string | null): void {
    this.csvPath = path;
    this.csvHeaderWritten = false;
  }

  getCsvPath(): string | null {
    return this.csvPath;
  }

  /**
   * Append the current snapshot to the CSV, tagged with a free-text condition
   * ("idle", "obs", "obs+game") so runs can be compared afterwards.
   */
  async writeCsvSample(condition: string): Promise<number> {
    if (!this.csvPath) return 0;
    const rows = this.snapshot();
    if (rows.length === 0) return 0;
    let out = '';
    if (!this.csvHeaderWritten) {
      out +=
        'timestamp,condition,provider,kind,behaviorId,frames,fps,medianGapMs,p95GapMs,maxGapMs,stalls\n';
      this.csvHeaderWritten = true;
    }
    const ts = new Date().toISOString();
    for (const r of rows) {
      out +=
        `${ts},${JSON.stringify(condition)},${r.provider},${r.kind},${r.behaviorId},` +
        `${r.frames},${r.fps.toFixed(2)},${r.medianGapMs},${r.p95GapMs},${r.maxGapMs},${r.stalls}\n`;
    }
    await appendFile(this.csvPath, out, 'utf-8');
    return rows.length;
  }

  /** Drop retained gaps but keep the streams running — used between A/B legs. */
  reset(): void {
    for (const s of this.streams.values()) {
      s.gaps = [];
      s.frames = 0;
      s.stalls = 0;
      s.lastFrameAt = null;
      s.startedAt = Date.now();
    }
  }
}

export const captureMetrics = new CaptureMetrics();
