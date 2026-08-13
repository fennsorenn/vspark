/**
 * MeshPeer — the orchestrator. Owns the collections, the containment index,
 * the grant store, incoming subscriptions (routing), outgoing subscriptions
 * (interest), pending guarded writes (acks), and the transport links.
 *
 * Identical on every peer; authority/durability are roles expressed through
 * collection config + app-side hydration/persistence taps, not different APIs.
 * See dev-notes/plans/mesh-sync-refactor.md §8.
 */
import {
  ContainmentIndex,
  evaluateAccess,
  grantCoversSubscription,
  granteeCandidates,
  makeKey,
  subscriptionMatches,
  compareHLC,
  type Grant,
  type HLC,
  type Right,
  type Subscription,
} from '@vspark/shared/sync';
import { ChannelRegistry, type ChannelProps } from './channels.js';
import { HlcClock } from './clock.js';
import {
  Collection,
  type CollectionConfig,
  type LocalWrite,
  type PeerCore,
  type WriteHandle,
  type WriteOutcome,
} from './collection.js';
import { deepEqual } from './paths.js';
import type { DocState } from './replica.js';
import type { MeshTransport, PeerLink } from './transport.js';
import type {
  AckMsg,
  MeshMessage,
  OpEnvelope,
  PongMsg,
  SnapshotDoc,
  SnapshotTombstone,
  SubOkMsg,
  SubscribeMsg,
} from './wire.js';

export interface MeshPeerConfig {
  identity: { peerId: string; displayName?: string };
  transports?: MeshTransport[];
  /** Guarded-write ack timeout (ms) before the recency-gated local revert. */
  ackTimeoutMs?: number;
  /** Outgoing-subscription handshake timeout (ms). */
  subscribeTimeoutMs?: number;
  /** Wall-clock source for the peer-clock sampler (tests inject skew). */
  now?: () => number;
  /** Undo/redo log config. `depth` caps the per-peer stack (default 100);
   *  `policy` 'guarded' (default) skips an inverse when the doc's current
   *  committed value diverged from what this peer last left it at (a
   *  collaborator edited it since), 'naive' always applies (last-writer-wins). */
  undo?: { depth?: number; policy?: UndoPolicy };
}

export type UndoPolicy = 'guarded' | 'naive';

/** Kind of committed action recorded in the undo-log. */
export type UndoOp = 'created' | 'removed' | 'modified';

/** One reversible committed action on one document (per-peer undo-log entry).
 *  `before`/`after` are the committed (retained-channel, overlay-free) doc
 *  values around the action — `before === undefined` ⇒ created,
 *  `after === undefined` ⇒ removed. */
export interface UndoEntry {
  rtype: string;
  id: string;
  op: UndoOp;
  before: unknown;
  after: unknown;
}

export interface UndoStatus {
  canUndo: boolean;
  canRedo: boolean;
}

/** One user-level action: the committed writes {@link MeshPeer.batch} grouped
 *  together, undone/redone as a unit. A write made outside a batch is its own
 *  group of one. `placed` flips when the group reaches the undo stack — a batch
 *  whose writes are all rejected never lands there.
 *
 *  Membership is fixed when the write is issued, not when it is logged: with a
 *  remote authority the entry is only pushed on ack, so acks that arrive late
 *  or out of order still land in the right group. */
interface UndoGroup {
  entries: UndoEntry[];
  placed: boolean;
}

export interface MeshStatus {
  peers: { id: string }[];
  pendingAcks: number;
}

export interface MeshSubscription {
  readonly peer: string;
  readonly sub: Subscription & { channels?: string[] };
  unsubscribe(): void;
}

type AnyCollection = Collection<Record<string, unknown>>;

interface PendingAck {
  col: AnyCollection;
  id: string;
  /** single-path patch target (corrections re-apply here). */
  path?: string;
  stamp: HLC;
  pre: DocState<Record<string, unknown>>;
  timer: ReturnType<typeof setTimeout>;
  resolve: (o: WriteOutcome) => void;
  /** Pending undo-log entry: pushed onto the undo stack only once the write is
   *  confirmed (acked/corrected), discarded on reject/timeout, so a rolled-back
   *  optimistic write never leaves a bogus undo action. */
  undo?: UndoEntry;
  /** The action this write belongs to (see `MeshPeer.batch`). */
  undoGroup?: UndoGroup | null;
}

interface OutSub {
  subId: string;
  peer: string;
  sub: Subscription & { channels?: string[] };
  status: 'pending' | 'active' | 'stale';
  resolve?: (s: MeshSubscription) => void;
  reject?: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface InSub {
  subId: string;
  sub: Subscription & { channels?: string[] };
}

interface GrantEntry extends Grant {
  gid: string;
}

interface ClockState {
  seq: number;
  samples: { offset: number; rtt: number }[];
  offset: number;
  rtt: number | undefined;
  timers: (ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>)[];
}

/** Connect-time convergence burst: N extra pings, this many ms apart. */
const CLOCK_BURST = 4;
const CLOCK_BURST_MS = 250;
/** Steady-state drift-tracking cadence. */
const CLOCK_INTERVAL_MS = 10_000;
/** Sliding sample window for the minimum-delay filter. */
const CLOCK_WINDOW = 8;

const uuid = (): string => globalThis.crypto.randomUUID();

export class MeshPeer implements PeerCore {
  readonly id: string;
  readonly clock: HlcClock;
  readonly channels = new ChannelRegistry();

  private readonly cfg: MeshPeerConfig;
  private readonly collections = new Map<string, AnyCollection>();
  private readonly index = new ContainmentIndex(() => ({
    parentField: 'p',
    parentTypes: [],
    canBeRoot: true,
  }));
  private readonly grantEntries: GrantEntry[] = [];
  private readonly grantObservers: ((grants: Grant[]) => void)[] = [];
  private readonly links = new Map<string, PeerLink>();
  /** participant → admitted incoming subscriptions (what we fan out to them). */
  private readonly inSubs = new Map<string, InSub[]>();
  private readonly outSubs = new Map<string, OutSub>();
  private readonly pendingAcks = new Map<string, PendingAck>();
  private readonly statusObservers: ((s: MeshStatus) => void)[] = [];
  private readonly transports: MeshTransport[];
  /** Per-link clock-sync state (offset/rtt estimates + sampler timers). */
  private readonly clocks = new Map<string, ClockState>();
  private readonly now: () => number;

  /** Per-peer undo/redo log (committed writes only), one entry per action. */
  private readonly undoStack: UndoGroup[] = [];
  private readonly redoStack: UndoGroup[] = [];
  /** The batch currently open on this peer, if any (see `batch`). */
  private currentGroup: UndoGroup | null = null;
  private readonly undoDepth: number;
  private readonly undoPolicy: UndoPolicy;
  /** While replaying an inverse (undo) or forward (redo), local committed
   *  writes are NOT recorded — the stacks are moved explicitly instead. */
  private replayMode: 'none' | 'undo' | 'redo' = 'none';
  private readonly undoObservers: ((s: UndoStatus) => void)[] = [];

  constructor(cfg: MeshPeerConfig) {
    this.cfg = cfg;
    this.id = cfg.identity.peerId;
    this.clock = new HlcClock(this.id);
    this.now = cfg.now ?? (() => Date.now());
    this.undoDepth = cfg.undo?.depth ?? 100;
    this.undoPolicy = cfg.undo?.policy ?? 'guarded';
    this.transports = [];
    for (const t of cfg.transports ?? []) this.addTransport(t);
  }

  /** Attach (and start) an additional transport — for links that only come up
   *  after peer creation (e.g. the WebRTC server mesh once signaling is configured). */
  addTransport(t: MeshTransport): void {
    this.transports.push(t);
    t.start({
      peerConnected: (peerId, link) => this.onPeerConnected(peerId, link),
      peerDisconnected: (peerId) => this.onPeerDisconnected(peerId),
      message: (peerId, msg) => this.onMessage(peerId, msg),
    });
  }

  // --- public API ----------------------------------------------------------------

  channel(name: string, props: ChannelProps): void {
    this.channels.define(name, props);
  }

  collection<T extends object>(
    rtype: string,
    cfg: CollectionConfig<T> = {}
  ): Collection<T> {
    if (this.collections.has(rtype))
      throw new Error(`collection '${rtype}' already defined`);
    const col = new Collection<T>(this, rtype, cfg);
    this.collections.set(rtype, col as unknown as AnyCollection);
    return col;
  }

  /** Single-cell sugar: a one-document collection of `{ id, value }` docs. */
  value<V>(rtype: string, id: string, cfg: CollectionConfig<{ id: string; value: V }> = {}): MeshValue<V> {
    let col = this.collections.get(rtype) as
      | Collection<{ id: string; value: V }>
      | undefined;
    if (!col) col = this.collection<{ id: string; value: V }>(rtype, cfg);
    return new MeshValue(col, id);
  }

  readonly grants = {
    grant: (g: Grant): string => {
      const gid = uuid();
      this.grantEntries.push({ ...g, gid });
      this.notifyGrants();
      return gid;
    },
    revoke: (gid: string): void => {
      const i = this.grantEntries.findIndex((g) => g.gid === gid);
      if (i < 0) return;
      this.grantEntries.splice(i, 1);
      this.revalidateInSubs();
      this.notifyGrants();
    },
    list: (): (Grant & { gid: string })[] => [...this.grantEntries],
    observe: (cb: (grants: Grant[]) => void): (() => void) => {
      this.grantObservers.push(cb);
      return () => {
        const i = this.grantObservers.indexOf(cb);
        if (i >= 0) this.grantObservers.splice(i, 1);
      };
    },
  };

  /** Declare interest at `peerId`; resolves once the snapshot is applied. */
  subscribe(
    peerId: string,
    sub: Subscription & { channels?: string[] }
  ): Promise<MeshSubscription> {
    const link = this.links.get(peerId);
    if (!link)
      return Promise.reject(new Error(`peer '${peerId}' is not connected`));
    const subId = uuid();
    return new Promise<MeshSubscription>((resolve, reject) => {
      const entry: OutSub = { subId, peer: peerId, sub, status: 'pending', resolve, reject };
      entry.timer = setTimeout(() => {
        this.outSubs.delete(subId);
        reject(new Error('subscribe timed out'));
      }, this.cfg.subscribeTimeoutMs ?? 10_000);
      this.outSubs.set(subId, entry);
      link.send({ t: 'sub', subId, sub });
    });
  }

  status(): MeshStatus {
    return {
      peers: [...this.links.keys()].map((id) => ({ id })),
      pendingAcks: this.pendingAcks.size,
    };
  }

  // --- undo / redo ------------------------------------------------------------
  //
  // Per-peer, committed-only. Every committed write this peer authors logs a
  // { before, after } entry (see localWrite). `undo()` re-emits the inverse as
  // a fresh committed write — so propagation, persistence, and collaboration-
  // safety fall out of the normal write path + HLC LWW, with no bespoke
  // protocol. Preview/ephemeral writes are never logged (the commit is the
  // action boundary), so gizmo-drag coalescing is a non-issue.

  /** Run `fn`, grouping every committed write it issues into ONE undo action.
   *
   *  For edits that are conceptually single but structurally several — deleting
   *  a node and its descendants, or reparenting a node's children before
   *  removing it — so the user undoes the action, not its individual writes.
   *  Nested batches join the outer one. Writes are still issued (and acked)
   *  independently; only the undo grouping is affected, and rejected writes
   *  simply never join the group. */
  batch<T>(fn: () => T): T {
    if (this.currentGroup) return fn(); // nested: join the open action
    const group: UndoGroup = { entries: [], placed: false };
    this.currentGroup = group;
    try {
      return fn();
    } finally {
      this.currentGroup = null;
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undoStatus(): UndoStatus {
    return { canUndo: this.canUndo(), canRedo: this.canRedo() };
  }

  /** Re-emit the inverse of this peer's last committed action as a fresh
   *  committed write. Returns false when there's nothing to undo, the target
   *  collection is gone, or (guarded policy) a collaborator has since changed
   *  the doc — in which case the action is consumed without applying. */
  undo(): boolean {
    const group = this.undoStack.pop();
    if (!group) return false;
    // All-or-nothing: a partially applied action would leave the graph in a
    // state the user never authored (half a deleted subtree restored).
    const resolved = group.entries.map((e) => ({
      e,
      col: this.collections.get(e.rtype),
    }));
    // Policy is checked on the action's NET effect, not every write: an action that
    // touched one doc twice leaves only its final value on that doc, and the
    // intermediate state it passed through was never the committed state.
    const ok = this.groupPolicyAllows(resolved, 'last');
    if (ok) {
      this.replay('undo', () => {
        // Reverse order: children were removed before their parent, so the
        // parent must come back first.
        for (let i = resolved.length - 1; i >= 0; i--)
          this.applyInverse(resolved[i].col!, resolved[i].e);
      });
      this.redoStack.push(group);
    }
    this.notifyUndoObservers();
    return ok;
  }

  /** Re-apply the last undone action (forward direction). Same policy gate as
   *  `undo`, checked against the value the undo restored. */
  redo(): boolean {
    const group = this.redoStack.pop();
    if (!group) return false;
    const resolved = group.entries.map((e) => ({
      e,
      col: this.collections.get(e.rtype),
    }));
    // Mirror of undo: the pre-action value of each doc is the FIRST entry's
    // `before`, whatever the action did to it afterwards.
    const ok = this.groupPolicyAllows(resolved, 'first');
    if (ok) {
      this.replay('redo', () => {
        for (const { e, col } of resolved) this.applyForward(col!, e);
      });
      this.undoStack.push(group);
    }
    this.notifyUndoObservers();
    return ok;
  }

  /** Drop the whole undo/redo history (e.g. on project/scene switch). */
  clearUndoHistory(): void {
    if (!this.undoStack.length && !this.redoStack.length) return;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.notifyUndoObservers();
  }

  /** Fire on every change to `canUndo`/`canRedo` (button enablement). */
  onUndoChange(cb: (s: UndoStatus) => void): () => void {
    this.undoObservers.push(cb);
    return () => {
      const i = this.undoObservers.indexOf(cb);
      if (i >= 0) this.undoObservers.splice(i, 1);
    };
  }

  /** Log one confirmed write into its action. A group reaches the stack on its
   *  first confirmed write, so a batch whose writes all fail leaves no action;
   *  later writes of the same batch append to the group already in place. */
  private pushUndo(entry: UndoEntry, group?: UndoGroup | null): void {
    const g = group ?? { entries: [], placed: false };
    g.entries.push(entry);
    if (!g.placed) {
      g.placed = true;
      this.undoStack.push(g);
      if (this.undoStack.length > this.undoDepth) this.undoStack.shift();
      // A new action invalidates the redo future — but only when the action
      // starts, not on every write that joins it.
      this.redoStack.length = 0;
    }
    this.notifyUndoObservers();
  }

  private replay(mode: 'undo' | 'redo', fn: () => void): void {
    this.replayMode = mode;
    try {
      fn();
    } finally {
      this.replayMode = 'none';
    }
  }

  /** created → remove; removed/modified → restore the prior committed doc. */
  private applyInverse(col: AnyCollection, e: UndoEntry): void {
    if (e.op === 'created') col.remove(e.id);
    else col.set(e.id, '', e.before);
  }

  /** created/modified → re-apply the new doc; removed → remove again. */
  private applyForward(col: AnyCollection, e: UndoEntry): void {
    if (e.op === 'removed') col.remove(e.id);
    else col.set(e.id, '', e.after);
  }

  /** Guarded policy for a whole action: every doc it touched must still hold
   *  the value this peer left it at. `edge` picks which end of the action to
   *  compare — 'last' (undo: the doc as the action left it) or 'first' (redo:
   *  the doc as it was before the action). Docs touched more than once are
   *  collapsed so the action's intermediate states are never compared. */
  private groupPolicyAllows(
    resolved: { e: UndoEntry; col: AnyCollection | undefined }[],
    edge: 'first' | 'last'
  ): boolean {
    const net = new Map<string, { e: UndoEntry; col: AnyCollection | undefined }>();
    for (const r of resolved) {
      const key = `${r.e.rtype}\u0000${r.e.id}`;
      if (edge === 'last' || !net.has(key)) net.set(key, r);
    }
    for (const { e, col } of net.values()) {
      if (!col) return false;
      if (!this.policyAllows(col, e.id, edge === 'last' ? e.after : e.before))
        return false;
    }
    return true;
  }

  /** Guarded policy: apply only if the doc's current committed value still
   *  matches what this peer left it at. 'naive' always applies. */
  private policyAllows(col: AnyCollection, id: string, expected: unknown): boolean {
    if (this.undoPolicy !== 'guarded') return true;
    return deepEqual(col.replica.raw(id), expected);
  }

  private notifyUndoObservers(): void {
    const s = this.undoStatus();
    for (const cb of [...this.undoObservers]) cb(s);
  }

  // --- peer clock translation ------------------------------------------------------
  //
  // NTP-style per-link sampler: a ping carries our send time; the pong echoes
  // it plus the peer's receive-time clock reading. Each sample estimates
  // `offset = tRemote + rtt/2 − now`; the estimate used is the sample with
  // the LOWEST rtt in a sliding window (minimum-delay filter — low-rtt
  // samples have the tightest asymmetry error bound). A short burst on
  // connect converges fast; a slow steady-state cadence tracks drift.
  // Consumers translate timestamps HOP-WISE: each relay rewrites a remote
  // timestamp into its own clock before forwarding, so only per-link offsets
  // are ever needed (no offset composition).

  /** Estimated `peerClock − localClock` for a connected peer (ms). Falls back
   *  to 0 (synchronized-clocks assumption) until the first sample lands or
   *  for unknown peers. */
  clockOffset(peerId: string): number {
    return this.clocks.get(peerId)?.offset ?? 0;
  }

  /** Best-sample round-trip time to a peer (ms), if measured. */
  clockRtt(peerId: string): number | undefined {
    return this.clocks.get(peerId)?.rtt;
  }

  /** Translate a timestamp taken on `peerId`'s clock into this peer's clock. */
  toLocalTime(peerId: string, remoteTs: number): number {
    return remoteTs - this.clockOffset(peerId);
  }

  /** Translate a local timestamp into `peerId`'s clock. */
  toPeerTime(peerId: string, localTs: number): number {
    return localTs + this.clockOffset(peerId);
  }

  private startClockSync(peerId: string): void {
    this.stopClockSync(peerId);
    const state: ClockState = {
      seq: 0,
      samples: [],
      offset: 0,
      rtt: undefined,
      timers: [],
    };
    this.clocks.set(peerId, state);
    const ping = (): void => {
      state.seq++;
      this.sendTo(peerId, { t: 'ping', seq: state.seq, tSent: this.now() });
    };
    ping();
    // Convergence burst, then steady-state drift tracking.
    for (let i = 1; i <= CLOCK_BURST; i++)
      state.timers.push(setTimeout(ping, i * CLOCK_BURST_MS));
    const interval = setInterval(ping, CLOCK_INTERVAL_MS);
    state.timers.push(interval);
    // Don't hold a Node process open for drift tracking (no-op in browsers).
    for (const t of state.timers)
      (t as { unref?: () => void }).unref?.();
  }

  private stopClockSync(peerId: string): void {
    const state = this.clocks.get(peerId);
    if (!state) return;
    for (const t of state.timers) clearTimeout(t as ReturnType<typeof setTimeout>);
    this.clocks.delete(peerId);
  }

  private handlePong(senderId: string, msg: PongMsg): void {
    const state = this.clocks.get(senderId);
    if (!state) return;
    const now = this.now();
    const rtt = now - msg.tSent;
    if (rtt < 0) return; // clock stepped mid-flight — discard
    state.samples.push({ offset: msg.tRemote + rtt / 2 - now, rtt });
    if (state.samples.length > CLOCK_WINDOW) state.samples.shift();
    let best = state.samples[0];
    for (const s of state.samples) if (s.rtt < best.rtt) best = s;
    state.offset = best.offset;
    state.rtt = best.rtt;
  }

  onStatus(cb: (s: MeshStatus) => void): () => void {
    this.statusObservers.push(cb);
    return () => {
      const i = this.statusObservers.indexOf(cb);
      if (i >= 0) this.statusObservers.splice(i, 1);
    };
  }

  close(): void {
    for (const t of this.transports) t.stop();
    for (const p of this.pendingAcks.values()) clearTimeout(p.timer);
    this.pendingAcks.clear();
    for (const peerId of [...this.clocks.keys()]) this.stopClockSync(peerId);
  }

  // --- PeerCore (collection-facing) -------------------------------------------------

  connected(peerId: string): boolean {
    return this.links.has(peerId);
  }

  childrenIds(id: string, rtype: string): string[] {
    return this.index.childrenOf(id, rtype);
  }

  subtreeIds(rootId: string): string[] {
    return this.index.subtree(rootId);
  }

  parentIdOf(id: string): string | null {
    return this.index.parentOf(id) ?? null;
  }

  isDescendant = (childId: string, ancestorId: string): boolean =>
    this.index.isDescendant('', childId, ancestorId);

  indexUpsert(rtype: string, id: string, parentId: string | null): void {
    this.index.upsert(rtype, id, { p: parentId });
  }

  indexRemove(id: string): void {
    this.index.remove(id);
  }

  localWrite<T extends object>(c: Collection<T>, w: LocalWrite): WriteHandle {
    const col = c as unknown as AnyCollection;
    const ch = this.channels.get(w.channel);
    if (!ch) throw new Error(`unknown channel '${w.channel}'`);
    const meta = { origin: this.id, channel: w.channel, hydrate: !!w.hydrateV };

    // Ephemeral: overlay locally, fan out lossily, never guarded.
    if (!ch.stamped) {
      const change = col.applyOp(w.op, w.id, w.path, w.data, undefined, meta);
      if (change)
        this.fanout(col, this.envelope(col, w, undefined), undefined, undefined);
      return done({ status: 'unguarded' });
    }

    // Validate local writes too (fail fast; corrections apply locally).
    // Only whole docs are validated; patches pass through (see §8 notes).
    let data = w.data;
    let corrected = false;
    if (w.op === 'upsert') {
      try {
        const validated = col.validateDoc(w.data, this.id);
        corrected = !deepEqual(validated, w.data);
        data = validated;
      } catch (e) {
        return done({ status: 'rejected', reason: errMsg(e) });
      }
    }

    const authority = col.cfg.authority ?? 'self';
    const guarded = ch.ack === 'authority' && !w.hydrateV;
    if (guarded && authority !== 'self' && !this.links.has(authority))
      return done({ status: 'rejected', reason: 'authority-offline' });

    const pre = guarded ? col.replica.captureState(w.id) : undefined;
    const v = w.hydrateV ?? this.clock.tick();

    // Undo-log: only genuine committed (retained-channel, non-hydrate) writes
    // that this peer authors directly — never previews, hydration, or the
    // inverse/forward replays of an undo/redo (those move the stacks by hand).
    //
    // `undo: false` opts a write out explicitly, for changes that are not
    // document edits at all (see WriteOpts.undo). It suppresses the entry only;
    // the write still replicates, persists and acks like any other.
    const loggable =
      w.undo !== false &&
      this.replayMode === 'none' &&
      guarded &&
      w.channel === col.retainedChannel;
    const before = loggable ? col.replica.raw(w.id) : undefined;

    // For removes, routing/ancestry must be resolved before the index entry dies.
    const preRecipients =
      w.op === 'remove' ? this.recipients(col, w.id, w.path, w.channel) : undefined;
    const preChain = w.op === 'remove' ? col.ancestorChain(w.id) : undefined;

    const change = col.applyOp(w.op, w.id, w.path, data, v, meta);
    if (!change) return done({ status: 'unguarded' }); // LWW no-op (stale hydrate)

    const undoEntry = loggable
      ? makeUndoEntry(col.rtype, w.id, before, col.replica.raw(w.id))
      : undefined;
    // Bound now, not at push time: with a remote authority the entry is logged
    // on ack, by which point the batch has long since closed.
    const undoGroup = undoEntry ? this.currentGroup : null;

    const opId = guarded && authority !== 'self' ? uuid() : undefined;
    const env = this.envelope(col, { ...w, data }, v, opId);
    this.fanout(col, env, preRecipients, preChain);

    if (!guarded) return done({ status: 'unguarded' });

    if (authority === 'self') {
      // We are the authority: tap = persistence; a throw rejects + rolls back.
      try {
        col.runTaps(change);
      } catch (e) {
        const restored = col.replica.restoreState(w.id, pre!, {
          origin: this.id,
          channel: w.channel,
        });
        col.notify(restored);
        return done({
          status: 'rejected',
          reason: errMsg(e),
          current: col.get(w.id),
        });
      }
      // Persisted locally — safe to log (or, if corrected, log the corrected
      // value the authority actually stored).
      if (undoEntry) {
        if (corrected) undoEntry.after = data;
        this.pushUndo(undoEntry, undoGroup);
      }
      return done(
        corrected ? { status: 'corrected', value: data } : { status: 'acked' }
      );
    }

    // Remote authority: register the pending guarded write. The undo entry
    // rides the pending record — pushed only once the authority confirms.
    const ack = new Promise<WriteOutcome>((resolve) => {
      const timer = setTimeout(
        () => this.expirePending(opId!),
        this.cfg.ackTimeoutMs ?? 4000
      );
      this.pendingAcks.set(opId!, {
        col,
        id: w.id,
        path: w.path,
        stamp: v,
        pre: pre!,
        timer,
        resolve,
        undo: undoEntry,
        undoGroup,
      });
    });
    return { ack };
  }

  // --- transport events ---------------------------------------------------------------

  private onPeerConnected(peerId: string, link: PeerLink): void {
    this.links.set(peerId, link);
    this.startClockSync(peerId);
    this.notifyStatus();
  }

  private onPeerDisconnected(peerId: string): void {
    this.links.delete(peerId);
    this.inSubs.delete(peerId);
    this.stopClockSync(peerId);
    for (const s of this.outSubs.values())
      if (s.peer === peerId && s.status === 'active') s.status = 'stale';
    this.notifyStatus();
  }

  private onMessage(senderId: string, msg: MeshMessage): void {
    switch (msg.t) {
      case 'op':
        return this.handleOp(senderId, msg);
      case 'sub':
        return this.handleSub(senderId, msg);
      case 'sub_ok':
        return this.handleSubOk(senderId, msg);
      case 'sub_err': {
        const entry = this.outSubs.get(msg.subId);
        if (entry?.status === 'pending') {
          clearTimeout(entry.timer);
          this.outSubs.delete(msg.subId);
          entry.reject?.(new Error(`subscription denied: ${msg.reason}`));
        }
        return;
      }
      case 'unsub': {
        const list = this.inSubs.get(senderId);
        if (list)
          this.inSubs.set(
            senderId,
            list.filter((s) => s.subId !== msg.subId)
          );
        return;
      }
      case 'ack':
        return this.handleAck(senderId, msg);
      case 'ping':
        // Answer immediately — any handling delay inflates the rtt estimate.
        return this.sendTo(senderId, {
          t: 'pong',
          seq: msg.seq,
          tSent: msg.tSent,
          tRemote: this.now(),
        });
      case 'pong':
        return this.handlePong(senderId, msg);
    }
  }

  // --- incoming ops ----------------------------------------------------------------------

  private handleOp(senderId: string, env: OpEnvelope): void {
    const col = this.collections.get(env.rtype);
    const ch = this.channels.get(env.ch);
    if (!col || !ch) return;
    if (env.origin === this.id) return; // loop suppression

    // Creates of unknown ids aren't in the containment index yet, so subtree
    // grants/subscriptions can't match them. Provisionally index the node from
    // the op's parent reference; rolled back if admission/validation/LWW
    // rejects the op (apply re-indexes it properly on success).
    let provisional = false;
    if (env.op === 'upsert' && !col.replica.has(env.id)) {
      try {
        const parentRef = col.cfg.parent?.(env.data as never);
        if (parentRef) {
          this.indexUpsert(env.rtype, env.id, parentRef.id);
          provisional = true;
        }
      } catch {
        /* malformed doc — admission/validation rejects it below */
      }
    }
    const dropProvisional = () => {
      if (provisional) this.indexRemove(env.id);
    };

    if (!this.opAllowed(senderId, env, col)) {
      dropProvisional();
      if (env.ack)
        this.sendTo(senderId, {
          t: 'ack',
          opId: env.ack,
          status: 'rejected',
          reason: 'denied',
          value: col.get(env.id),
          v: col.replica.rootStamp(env.id),
        });
      return;
    }

    // Ephemeral: overlay + relay, nothing else.
    if (!ch.stamped || !env.v) {
      const change = col.applyOp(env.op, env.id, env.path, env.data, undefined, {
        origin: env.origin,
        channel: env.ch,
      });
      if (change) this.relay(col, env, senderId, undefined, undefined);
      return;
    }

    this.clock.observe(env.v);

    // Validate whole-doc writes; the authority turns a transform into a correction.
    let data = env.data;
    let corrected = false;
    if (env.op === 'upsert') {
      try {
        const validated = col.validateDoc(env.data, env.origin);
        corrected = !deepEqual(validated, env.data);
        data = validated;
      } catch (e) {
        dropProvisional();
        if (env.ack)
          this.sendTo(senderId, {
            t: 'ack',
            opId: env.ack,
            status: 'rejected',
            reason: errMsg(e),
            value: col.get(env.id),
            v: col.replica.rootStamp(env.id),
          });
        return;
      }
    }

    const authority = col.cfg.authority ?? 'self';
    const guarded = !!env.ack && authority === 'self' && ch.ack === 'authority';

    const preRecipients =
      env.op === 'remove'
        ? this.recipients(col, env.id, env.path, env.ch)
        : undefined;
    const preChain = env.op === 'remove' ? col.ancestorChain(env.id) : undefined;
    const pre = guarded ? col.replica.captureState(env.id) : undefined;

    // A correction is the authority's own write: fresh stamp, fresh origin.
    const v = guarded && corrected ? this.clock.tick() : env.v;
    const meta = {
      origin: guarded && corrected ? this.id : env.origin,
      channel: env.ch,
    };
    const change = col.applyOp(env.op, env.id, env.path, data, v, meta);

    if (guarded) {
      if (change) {
        try {
          col.runTaps(change);
        } catch (e) {
          const restored = col.replica.restoreState(env.id, pre!, meta);
          col.notify(restored);
          this.sendTo(senderId, {
            t: 'ack',
            opId: env.ack!,
            status: 'rejected',
            reason: errMsg(e),
            value: col.get(env.id),
            v: col.replica.rootStamp(env.id),
          });
          return;
        }
      }
      this.sendTo(senderId, {
        t: 'ack',
        opId: env.ack!,
        status: corrected ? 'corrected' : 'acked',
        value: corrected ? data : undefined,
        v: corrected ? v : undefined,
      });
      if (change) {
        const fwd: OpEnvelope = corrected
          ? { ...env, data, v, origin: this.id, ack: undefined }
          : { ...env, ack: undefined };
        this.relay(col, fwd, senderId, preRecipients, preChain);
      } else dropProvisional();
      return;
    }

    if (!change) {
      dropProvisional();
      return;
    }
    // Non-authority peers persist remote committed state through taps too
    // (the symmetric-mount case); failures here can't nack, so they log.
    try {
      col.runTaps(change);
    } catch (e) {
      console.error(`[mesh] tap failed for ${env.rtype}:${env.id}:`, e);
    }
    // Relay the VALIDATED data, not the raw env: validate() localizes
    // per-server fields (e.g. a collab doc's projectId is re-scoped to OUR
    // link's project), and that localized doc is what our own subscribers —
    // notably this server's browser tabs, which trust our re-scoping and gate
    // on projectId — must receive. Downstream collab peers re-validate, so
    // they localize again regardless. Forwarding the raw env instead leaks
    // the sender's projectId and the tab's feeder silently drops the doc
    // (objects only appear on reload). data === env.data except for validated
    // upserts, so this is a no-op for patch/remove.
    this.relay(col, { ...env, data }, senderId, preRecipients, preChain);
  }

  /** Accept an op if it matches one of OUR active subscriptions to the sender,
   *  or the ORIGIN holds a write grant we issued. */
  private opAllowed(
    senderId: string,
    env: OpEnvelope,
    col: AnyCollection
  ): boolean {
    const key = makeKey(env.rtype, env.id, env.path || undefined);
    for (const s of this.outSubs.values()) {
      if (s.peer !== senderId || s.status !== 'active') continue;
      if (!this.channelOk(s.sub.channels, env.ch, col)) continue;
      if (subscriptionMatches(s.sub, key, this.index.isDescendant)) return true;
    }
    const need: Right =
      env.op === 'remove'
        ? 'delete'
        : env.op === 'upsert' && !col.replica.has(env.id)
          ? 'create'
          : 'update';
    return evaluateAccess(
      this.grantsFor(env.origin),
      key,
      need,
      this.index.isDescendant
    );
  }

  // --- subscriptions (incoming) ---------------------------------------------------------

  private handleSub(senderId: string, msg: SubscribeMsg): void {
    const grants = this.grantsFor(senderId);
    const admitted = grants.some((g) =>
      grantCoversSubscription(g, msg.sub, this.index.isDescendant)
    );
    if (!admitted) {
      this.sendTo(senderId, { t: 'sub_err', subId: msg.subId, reason: 'denied' });
      return;
    }
    const list = this.inSubs.get(senderId) ?? [];
    list.push({ subId: msg.subId, sub: msg.sub });
    this.inSubs.set(senderId, list);

    const docs: SnapshotDoc[] = [];
    const tombstones: SnapshotTombstone[] = [];
    for (const [rtype, col] of this.collections) {
      if (!col.retainedChannel) continue;
      if (msg.sub.entityRtype !== '*' && msg.sub.entityRtype !== rtype) {
        // Descendant subscriptions may still cover other rtypes via the tree.
        if (!msg.sub.includeDescendants) continue;
      }
      for (const id of col.replica.ids()) {
        const key = makeKey(rtype, id);
        if (!subscriptionMatches(msg.sub, key, this.index.isDescendant)) continue;
        docs.push({
          rtype,
          id,
          doc: col.replica.raw(id),
          v: col.replica.rootStamp(id),
        });
      }
      // Removed entities can't be matched through the (gone) tree — send the
      // collection's tombstones whenever the rtype could be covered. Coarse
      // but safe: receivers apply them through LWW.
      for (const t of col.replica.tombstones())
        tombstones.push({ rtype, id: t.id, v: t.v });
    }
    this.sendTo(senderId, {
      t: 'sub_ok',
      subId: msg.subId,
      docs,
      tombstones,
      watermark: this.clock.tick(),
    });
  }

  private handleSubOk(senderId: string, msg: SubOkMsg): void {
    const entry = this.outSubs.get(msg.subId);
    if (!entry || entry.peer !== senderId || entry.status !== 'pending') return;
    clearTimeout(entry.timer);
    entry.status = 'active';
    this.clock.observe(msg.watermark);

    // Snapshot state is new state for OUR subscribers too — relay each applied
    // change onward exactly like a live op (a tab subscribed before its server
    // reconciled would otherwise never see the snapshot's docs).
    for (const d of msg.docs) {
      const col = this.collections.get(d.rtype);
      if (!col?.retainedChannel) continue;
      let data = d.doc;
      try {
        data = col.validateDoc(d.doc, senderId);
      } catch {
        continue; // snapshot doc fails validation — skip it
      }
      const v = d.v ?? { t: 0, c: 0, n: senderId };
      const change = col.applyOp('upsert', d.id, undefined, data, v, {
        origin: senderId,
        channel: col.retainedChannel,
      });
      if (change) {
        try {
          col.runTaps(change);
        } catch (e) {
          console.error(`[mesh] snapshot tap failed for ${d.rtype}:${d.id}:`, e);
        }
        this.relay(
          col,
          this.snapshotEnv(col, 'upsert', d.id, data, v, senderId),
          senderId,
          undefined,
          undefined
        );
      }
    }
    for (const t of msg.tombstones) {
      const col = this.collections.get(t.rtype);
      if (!col?.retainedChannel) continue;
      // Snapshots ship the sender's WHOLE tombstone set per collection (the
      // sender can't tree-match a removed entity — its containment entry is
      // gone). Scope-filter on OUR side instead: only apply a tombstone whose
      // target we actually hold INSIDE this subscription's scope. Out-of-scope
      // docs (e.g. another scene that happens to share ids with something the
      // sender deleted — a previously-shared copy) must not be killed by an
      // unrelated subscription's snapshot; ids we don't hold are no-ops we
      // need not record (recording would re-export the foreign tombstone).
      if (
        !col.replica.has(t.id) ||
        !subscriptionMatches(
          entry.sub,
          makeKey(t.rtype, t.id),
          this.index.isDescendant
        )
      )
        continue;
      const preRecipients = this.recipients(col, t.id, undefined, col.retainedChannel);
      const preChain = col.ancestorChain(t.id);
      const change = col.applyOp('remove', t.id, undefined, undefined, t.v, {
        origin: senderId,
        channel: col.retainedChannel,
      });
      if (change) {
        try {
          col.runTaps(change);
        } catch (e) {
          console.error(`[mesh] snapshot tap failed for ${t.rtype}:${t.id}:`, e);
        }
        this.relay(
          col,
          this.snapshotEnv(col, 'remove', t.id, undefined, t.v, senderId),
          senderId,
          preRecipients,
          preChain
        );
      }
    }

    entry.resolve?.({
      peer: entry.peer,
      sub: entry.sub,
      unsubscribe: () => {
        this.outSubs.delete(msg.subId);
        this.sendTo(senderId, { t: 'unsub', subId: msg.subId });
      },
    });
    entry.resolve = undefined;
    entry.reject = undefined;
  }

  // --- acks --------------------------------------------------------------------------------

  private handleAck(senderId: string, msg: AckMsg): void {
    const p = this.pendingAcks.get(msg.opId);
    if (!p) return;
    this.pendingAcks.delete(msg.opId);
    clearTimeout(p.timer);

    if (msg.status === 'acked') {
      if (p.undo) this.pushUndo(p.undo, p.undoGroup);
      p.resolve({ status: 'acked' });
      return;
    }
    if (msg.status === 'corrected') {
      if (msg.v) {
        this.clock.observe(msg.v);
        const change = p.col.applyOp(
          p.path !== undefined ? 'patch' : 'upsert',
          p.id,
          p.path,
          msg.value,
          msg.v,
          { origin: senderId, channel: p.col.retainedChannel ?? 'committed' }
        );
        if (change) this.safeTaps(p.col, change);
      }
      // The authority stored a normalized value — log THAT as the action's
      // result so a later guarded undo matches the doc's real state.
      if (p.undo) {
        p.undo.after = p.col.replica.raw(p.id);
        this.pushUndo(p.undo, p.undoGroup);
      }
      p.resolve({ status: 'corrected', value: msg.value });
      return;
    }
    // rejected: roll back our optimistic write (recency-gated), then converge
    // on the authority's current value carried in the nack.
    this.revertPending(p);
    if (msg.value !== undefined && msg.v) {
      this.clock.observe(msg.v);
      const change = p.col.applyOp('upsert', p.id, undefined, msg.value, msg.v, {
        origin: senderId,
        channel: p.col.retainedChannel ?? 'committed',
      });
      if (change) this.safeTaps(p.col, change);
    }
    p.resolve({
      status: 'rejected',
      reason: msg.reason ?? 'rejected',
      current: msg.value,
    });
  }

  private expirePending(opId: string): void {
    const p = this.pendingAcks.get(opId);
    if (!p) return;
    this.pendingAcks.delete(opId);
    this.revertPending(p);
    p.resolve({ status: 'reverted' });
  }

  /** Recency gate: roll back only if our write is still the newest on the doc
   *  — otherwise someone built on top and the rollback would clobber them. */
  private revertPending(p: PendingAck): void {
    const newest = p.col.replica.newestStamp(p.id);
    if (!newest || compareHLC(newest, p.stamp) !== 0) return;
    const restored = p.col.replica.restoreState(p.id, p.pre, {
      origin: this.id,
      channel: p.col.retainedChannel ?? 'committed',
    });
    p.col.notify(restored);
  }

  // --- routing -------------------------------------------------------------------------------

  /** Participants whose admitted interest covers this key+channel. */
  private recipients(
    col: AnyCollection,
    id: string,
    path: string | undefined,
    channel: string
  ): string[] {
    const key = makeKey(col.rtype, id, path || undefined);
    const out: string[] = [];
    for (const [peerId, subs] of this.inSubs) {
      if (!this.links.has(peerId)) continue;
      for (const s of subs) {
        if (!this.channelOk(s.sub.channels, channel, col)) continue;
        if (subscriptionMatches(s.sub, key, this.index.isDescendant)) {
          out.push(peerId);
          break;
        }
      }
    }
    return out;
  }

  /** Fan a locally-originated env out: interested subscribers + (for remote-
   *  authority collections) always the authority — data flows home. */
  private fanout(
    col: AnyCollection,
    env: OpEnvelope,
    preRecipients: string[] | undefined,
    _preChain: string[] | undefined
  ): void {
    const targets = new Set(
      preRecipients ?? this.recipients(col, env.id, env.path, env.ch)
    );
    const authority = col.cfg.authority ?? 'self';
    if (authority !== 'self' && this.links.has(authority)) targets.add(authority);
    this.deliver(env, targets);
  }

  /** Forward a remote env onward (authority relays to its other subscribers). */
  private relay(
    col: AnyCollection,
    env: OpEnvelope,
    senderId: string,
    preRecipients: string[] | undefined,
    _preChain: string[] | undefined
  ): void {
    const targets = new Set(
      preRecipients ?? this.recipients(col, env.id, env.path, env.ch)
    );
    targets.delete(senderId);
    targets.delete(env.origin);
    this.deliver(env, targets);
  }

  private deliver(env: OpEnvelope, targets: Set<string>): void {
    const ch = this.channels.get(env.ch);
    const lossy = ch?.transport === 'lossy';
    for (const t of targets) {
      if (t === this.id) continue;
      const link = this.links.get(t);
      if (!link) continue;
      if (lossy && link.sendLossy) link.sendLossy(env);
      else link.send(env);
    }
  }

  /** Ephemeral channel selections implicitly include the retained channel —
   *  opting out of model updates is never what anyone means. */
  private channelOk(
    selected: string[] | undefined,
    channel: string,
    col: AnyCollection
  ): boolean {
    if (!selected || selected.length === 0) return true;
    if (selected.includes(channel)) return true;
    return channel === col.retainedChannel;
  }

  // --- helpers ----------------------------------------------------------------------------------

  /** Op envelope for relaying one snapshot-applied doc/tombstone onward. */
  private snapshotEnv(
    col: AnyCollection,
    op: 'upsert' | 'remove',
    id: string,
    data: unknown,
    v: HLC,
    origin: string
  ): OpEnvelope {
    return {
      t: 'op',
      rtype: col.rtype,
      op,
      id,
      data,
      v,
      origin,
      ch: col.retainedChannel!,
    };
  }

  private envelope(
    col: AnyCollection,
    w: LocalWrite,
    v: HLC | undefined,
    opId?: string
  ): OpEnvelope {
    return {
      t: 'op',
      rtype: col.rtype,
      op: w.op,
      id: w.id,
      path: w.path,
      data: w.op === 'remove' ? undefined : w.data,
      v,
      origin: this.id,
      ch: w.channel,
      ack: opId,
    };
  }

  private grantsFor(participant: string): Grant[] {
    const candidates = granteeCandidates(participant);
    return this.grantEntries.filter((g) => candidates.includes(g.grantee));
  }

  private revalidateInSubs(): void {
    for (const [peerId, subs] of [...this.inSubs]) {
      const grants = this.grantsFor(peerId);
      const kept = subs.filter((s) =>
        grants.some((g) =>
          grantCoversSubscription(g, s.sub, this.index.isDescendant)
        )
      );
      if (kept.length) this.inSubs.set(peerId, kept);
      else this.inSubs.delete(peerId);
    }
  }

  private safeTaps(col: AnyCollection, change: Parameters<AnyCollection['runTaps']>[0]): void {
    try {
      col.runTaps(change);
    } catch (e) {
      console.error('[mesh] tap failed:', e);
    }
  }

  private sendTo(peerId: string, msg: MeshMessage): void {
    this.links.get(peerId)?.send(msg);
  }

  private notifyStatus(): void {
    const s = this.status();
    for (const cb of [...this.statusObservers]) cb(s);
  }

  private notifyGrants(): void {
    const list = this.grants.list();
    for (const cb of [...this.grantObservers]) cb(list);
  }
}

/** Single addressable cell over a `{ id, value }` collection. Committed writes
 *  go whole-doc (create-or-replace); ephemeral writes overlay the root. */
export class MeshValue<V> {
  constructor(
    private readonly col: Collection<{ id: string; value: V }>,
    readonly id: string
  ) {}

  get(): V | undefined {
    return this.col.get(this.id)?.value;
  }

  set(value: V, opts?: { channel?: string }): WriteHandle {
    return this.col.set(this.id, '', { id: this.id, value }, opts);
  }

  observe(cb: (value: V | undefined) => void): () => void {
    return this.col.observe(this.id, (change) => cb(change.doc?.value));
  }
}

export function createMeshPeer(cfg: MeshPeerConfig): MeshPeer {
  return new MeshPeer(cfg);
}

function done(o: WriteOutcome): WriteHandle {
  return { ack: Promise.resolve(o) };
}

/** Classify a committed write by its before/after committed values. */
function makeUndoEntry(
  rtype: string,
  id: string,
  before: unknown,
  after: unknown
): UndoEntry {
  const op: UndoOp =
    before === undefined ? 'created' : after === undefined ? 'removed' : 'modified';
  return { rtype, id, op, before, after };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
