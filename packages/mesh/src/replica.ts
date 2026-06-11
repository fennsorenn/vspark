/**
 * Per-collection in-memory replica.
 *
 * Holds retained documents with hierarchical per-path LWW (HLC-stamped),
 * tombstones, ephemeral overlays (unstamped channels), and orphan parking for
 * patches that arrive before their document. Pure data structure — no IO, no
 * transport, no observers; the Collection layers notification on top.
 *
 * LWW rules:
 *  - a write to `path` applies iff its stamp beats the effective stamp at that
 *    path (max of the root stamp and every ancestor/own path stamp);
 *  - a whole-doc upsert beats older path stamps but PRESERVES path values whose
 *    stamps are newer than it (a concurrent field edit survives a doc replace);
 *  - a remove tombstones the id; only a strictly newer upsert resurrects it.
 *
 * Ephemeral overlays are latest-arrival per (id, path), composed over the
 * retained doc on read, and cleared by any retained write at/above their path
 * (the landing write supersedes the preview).
 */
import { compareHLC, type HLC } from '@vspark/shared/sync';
import {
  flattenToLeaves,
  getPath,
  pathAtOrAbove,
  setPath,
} from './paths.js';
import type { DocOp } from './wire.js';

export interface ApplyMeta {
  origin: string;
  channel: string;
  /** restoring already-persisted state (boot) — persistence taps skip it. */
  hydrate?: boolean;
  /** local rollback of an unacked optimistic write — taps skip it too. */
  restored?: boolean;
}

export interface AppliedChange<T> {
  op: DocOp | 'ephemeral';
  id: string;
  /** patch/ephemeral: dotted path ('' = whole doc). */
  path?: string;
  /** composed (overlay-aware) doc after the change; undefined after remove. */
  doc?: T;
  v?: HLC;
  origin: string;
  channel: string;
  hydrate?: boolean;
  restored?: boolean;
}

interface ParkedPatch {
  path: string;
  value: unknown;
  v: HLC;
}

/** Captured pre-write LWW state of one doc (see {@link Replica.captureState}). */
export interface DocState<T> {
  doc: T | undefined;
  root: HLC | undefined;
  paths: Map<string, HLC>;
  tomb: { v: HLC; at: number } | undefined;
}

const MAX_PARKED_PER_ID = 256;

export class Replica<T extends object> {
  private readonly docs = new Map<string, T>();
  private readonly rootStamps = new Map<string, HLC>();
  private readonly pathStamps = new Map<string, Map<string, HLC>>();
  private readonly tombs = new Map<string, { v: HLC; at: number }>();
  /** id → path → value. Channel identity is routing-only; overlays merge. */
  private readonly overlays = new Map<string, Map<string, unknown>>();
  private readonly parked = new Map<string, ParkedPatch[]>();
  /** Composed-read cache: keeps `get()` referentially stable between changes
   *  (React's useSyncExternalStore requires stable snapshots). Invalidated on
   *  every mutation of the id. */
  private readonly composed = new Map<string, T>();

  // --- reads -----------------------------------------------------------------

  /** Retained doc composed with ephemeral overlays (overlay wins). Stable
   *  reference until the next change to this id. */
  get(id: string): T | undefined {
    const hit = this.composed.get(id);
    if (hit) return hit;
    const ov = this.overlays.get(id);
    let base = this.docs.get(id) as T | undefined;
    let out: T | undefined;
    if (!ov || ov.size === 0) out = base;
    else {
      if (ov.has('')) base = ov.get('') as T;
      if (base === undefined) return undefined;
      out = base;
      const paths = [...ov.keys()]
        .filter((p) => p !== '')
        .sort((a, b) => a.split('.').length - b.split('.').length);
      for (const p of paths) out = setPath(out, p, ov.get(p));
    }
    if (out !== undefined) this.composed.set(id, out);
    return out;
  }

  /** Retained doc only (no overlays). */
  raw(id: string): T | undefined {
    return this.docs.get(id);
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  ids(): string[] {
    return [...this.docs.keys()];
  }

  rootStamp(id: string): HLC | undefined {
    return this.rootStamps.get(id);
  }

  /** Effective stamp guarding `path`: max of root + ancestor + own stamps. */
  effectiveStamp(id: string, path: string): HLC | undefined {
    let best = this.rootStamps.get(id);
    const stamps = this.pathStamps.get(id);
    if (stamps && path !== '') {
      const segs = path.split('.');
      for (let i = 1; i <= segs.length; i++) {
        const s = stamps.get(segs.slice(0, i).join('.'));
        if (s && (!best || compareHLC(s, best) > 0)) best = s;
      }
    }
    return best;
  }

  /** The stamp recorded exactly at `path` ('' = root) — recency gate for reverts. */
  stampAt(id: string, path: string): HLC | undefined {
    if (path === '') return this.rootStamps.get(id);
    return this.pathStamps.get(id)?.get(path);
  }

  // --- retained writes ---------------------------------------------------------

  upsert(id: string, doc: T, v: HLC, meta: ApplyMeta): AppliedChange<T> | null {
    const tomb = this.tombs.get(id);
    if (tomb && compareHLC(v, tomb.v) <= 0) return null;
    const root = this.rootStamps.get(id);
    if (root && compareHLC(v, root) <= 0) return null;

    // Preserve concurrent field edits newer than this doc replace.
    const old = this.docs.get(id);
    const stamps = this.pathStamps.get(id);
    let next = doc;
    if (old && stamps) {
      for (const [p, pv] of [...stamps]) {
        if (compareHLC(pv, v) > 0) next = setPath(next, p, getPath(old, p));
        else stamps.delete(p);
      }
      if (stamps.size === 0) this.pathStamps.delete(id);
    }

    this.docs.set(id, next);
    this.composed.delete(id);
    this.rootStamps.set(id, v);
    this.tombs.delete(id);
    this.overlays.delete(id);
    this.replayParked(id, meta);
    return { op: 'upsert', id, doc: this.get(id), v, ...metaFields(meta) };
  }

  /** Single-path patch. Parks (returns null) if the doc isn't here yet. */
  patch(
    id: string,
    path: string,
    value: unknown,
    v: HLC,
    meta: ApplyMeta
  ): AppliedChange<T> | null {
    const tomb = this.tombs.get(id);
    if (tomb && compareHLC(v, tomb.v) <= 0) return null;
    if (!this.docs.has(id)) {
      this.park(id, { path, value, v });
      return null;
    }
    if (!this.applyLeaf(id, path, value, v)) return null;
    this.clearOverlaysBelow(id, path);
    return { op: 'patch', id, path, doc: this.get(id), v, ...metaFields(meta) };
  }

  /** Merge-patch: flatten `partial` to leaves, apply each under one stamp.
   *  Null when nothing won LWW (or the doc isn't here — leaves are parked). */
  mergePatch(
    id: string,
    partial: unknown,
    v: HLC,
    meta: ApplyMeta
  ): AppliedChange<T> | null {
    const tomb = this.tombs.get(id);
    if (tomb && compareHLC(v, tomb.v) <= 0) return null;
    const leaves = flattenToLeaves(partial);
    if (!this.docs.has(id)) {
      for (const [p, val] of leaves) this.park(id, { path: p, value: val, v });
      return null;
    }
    let applied = false;
    for (const [p, val] of leaves) {
      if (this.applyLeaf(id, p, val, v)) {
        this.clearOverlaysBelow(id, p);
        applied = true;
      }
    }
    if (!applied) return null;
    return { op: 'patch', id, path: '', doc: this.get(id), v, ...metaFields(meta) };
  }

  remove(id: string, v: HLC, meta: ApplyMeta): AppliedChange<T> | null {
    const root = this.rootStamps.get(id);
    if (root && compareHLC(v, root) <= 0) return null;
    const tomb = this.tombs.get(id);
    if (tomb && compareHLC(v, tomb.v) <= 0) return null;
    this.docs.delete(id);
    this.composed.delete(id);
    this.rootStamps.delete(id);
    this.pathStamps.delete(id);
    this.overlays.delete(id);
    this.parked.delete(id);
    this.tombs.set(id, { v, at: Date.now() });
    return { op: 'remove', id, v, ...metaFields(meta) };
  }

  // --- ephemeral writes --------------------------------------------------------

  ephemeral(
    id: string,
    path: string,
    value: unknown,
    meta: ApplyMeta
  ): AppliedChange<T> {
    let ov = this.overlays.get(id);
    if (!ov) this.overlays.set(id, (ov = new Map()));
    if (path === '') ov.clear(); // root overlay supersedes partial ones
    ov.set(path, value);
    this.composed.delete(id);
    return {
      op: 'ephemeral',
      id,
      path,
      doc: this.get(id),
      ...metaFields(meta),
    };
  }

  // --- reverts (bypass LWW; local rollback of optimistic writes) ----------------

  /** Snapshot one doc's full LWW state before a guarded write, so a nack /
   *  timeout can roll it back wholesale. Docs are immutable in the replica
   *  (writes copy the spine), so holding references is safe. */
  captureState(id: string): DocState<T> {
    const tomb = this.tombs.get(id);
    return {
      doc: this.docs.get(id),
      root: this.rootStamps.get(id),
      paths: new Map(this.pathStamps.get(id) ?? []),
      tomb: tomb ? { ...tomb } : undefined,
    };
  }

  /** The newest stamp anywhere on the doc (root, paths, tombstone) — the
   *  recency gate: revert only if our write is still the last one. */
  newestStamp(id: string): HLC | undefined {
    let best = this.rootStamps.get(id);
    for (const s of this.pathStamps.get(id)?.values() ?? [])
      if (!best || compareHLC(s, best) > 0) best = s;
    const tomb = this.tombs.get(id);
    if (tomb && (!best || compareHLC(tomb.v, best) > 0)) best = tomb.v;
    return best;
  }

  /** Wholesale rollback to a captured state. Bypasses LWW (the caller gated
   *  on `newestStamp`); emits a restored change for observers. */
  restoreState(id: string, s: DocState<T>, meta: ApplyMeta): AppliedChange<T> {
    this.composed.delete(id);
    if (s.doc === undefined) {
      this.docs.delete(id);
      this.rootStamps.delete(id);
      this.pathStamps.delete(id);
    } else {
      this.docs.set(id, s.doc);
      if (s.root) this.rootStamps.set(id, s.root);
      else this.rootStamps.delete(id);
      if (s.paths.size) this.pathStamps.set(id, new Map(s.paths));
      else this.pathStamps.delete(id);
    }
    if (s.tomb) this.tombs.set(id, { ...s.tomb });
    else this.tombs.delete(id);
    return s.doc === undefined
      ? { op: 'remove', id, ...metaFields(meta), restored: true }
      : {
          op: 'upsert',
          id,
          doc: this.get(id),
          v: s.root,
          ...metaFields(meta),
          restored: true,
        };
  }

  // --- snapshots / tombstones ----------------------------------------------------

  tombstones(): { id: string; v: HLC }[] {
    return [...this.tombs].map(([id, t]) => ({ id, v: t.v }));
  }

  applyTombstone(id: string, v: HLC, meta: ApplyMeta): AppliedChange<T> | null {
    return this.remove(id, v, meta);
  }

  pruneTombstones(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs;
    for (const [id, t] of [...this.tombs])
      if (t.at < cutoff) this.tombs.delete(id);
  }

  // --- internals -------------------------------------------------------------------

  private applyLeaf(id: string, path: string, value: unknown, v: HLC): boolean {
    const eff = this.effectiveStamp(id, path);
    if (eff && compareHLC(v, eff) <= 0) return false;
    this.docs.set(id, setPath(this.docs.get(id) as T, path, value));
    this.composed.delete(id);
    let stamps = this.pathStamps.get(id);
    if (!stamps) this.pathStamps.set(id, (stamps = new Map()));
    // This write covers descendants with older stamps.
    for (const [p, pv] of [...stamps])
      if (p !== path && pathAtOrAbove(path, p) && compareHLC(pv, v) <= 0)
        stamps.delete(p);
    if (path === '') {
      this.rootStamps.set(id, v);
      stamps.clear();
    } else stamps.set(path, v);
    return true;
  }

  private clearOverlaysBelow(id: string, path: string): void {
    const ov = this.overlays.get(id);
    if (!ov) return;
    for (const p of [...ov.keys()])
      if (pathAtOrAbove(path, p) || pathAtOrAbove(p, path)) ov.delete(p);
    if (ov.size === 0) this.overlays.delete(id);
    this.composed.delete(id);
  }

  private park(id: string, p: ParkedPatch): void {
    let list = this.parked.get(id);
    if (!list) this.parked.set(id, (list = []));
    list.push(p);
    if (list.length > MAX_PARKED_PER_ID) list.shift();
  }

  private replayParked(id: string, meta: ApplyMeta): void {
    const list = this.parked.get(id);
    if (!list) return;
    this.parked.delete(id);
    for (const p of list) {
      if (!this.docs.has(id)) break;
      this.applyLeaf(id, p.path, p.value, p.v);
    }
  }
}

function metaFields(meta: ApplyMeta): {
  origin: string;
  channel: string;
  hydrate?: boolean;
  restored?: boolean;
} {
  return {
    origin: meta.origin,
    channel: meta.channel,
    hydrate: meta.hydrate,
    restored: meta.restored,
  };
}
