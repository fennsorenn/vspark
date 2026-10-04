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
  makeKey,
  participantServer,
  subscriptionMatches,
  compareHLC,
  granteeCandidates,
  randomUUID,
  type Grant,
  type HLC,
  type Right,
} from '@vspark/shared/sync';
import {
  allows,
  GrantStore,
  grantSelectsEntity,
  grantOverlapsSubscription,
  projectOp,
  projectValue,
  readScope,
  scopeTouches,
  type ReadScope,
} from './grants.js';
import { ChannelRegistry, type ChannelProps } from './channels.js';
import { HlcClock } from './clock.js';
import {
  Collection,
  type CollectionConfig,
  type ModelDecl,
  type LocalWrite,
  type PeerCore,
  type RequestOutcome,
  type WriteHandle,
  type WriteOutcome,
} from './collection.js';
import { deepEqual, flattenToLeaves, getPath, setPath } from './paths.js';
import type { DocState } from './replica.js';
import type { MeshTransport, PeerLink } from './transport.js';
import type {
  AckMsg,
  DeliveredGrant,
  DocOp,
  MeshMessage,
  OpEnvelope,
  PongMsg,
  SnapshotDoc,
  SnapshotTombstone,
  SubOkMsg,
  SubscribeMsg,
  SubscriptionRequest,
} from './wire.js';

export interface MeshPeerConfig {
  identity: { peerId: string; displayName?: string };
  /** Document types, declared once and shared by every peer (typically from
   *  app-wide shared code). `collection(rtype)` opens a declared type; what a
   *  peer passes there is added on top (its authority, its own checks). */
  models?: Record<string, ModelDecl<any>>;
  /** Channels beyond the built-in four, declared once like the models. */
  channels?: Record<string, ChannelProps>;
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
  readonly sub: SubscriptionRequest;
  /** The peers currently serving this subscription. */
  sources(): string[];
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

/** One `subscribe()` call: what the caller wants, served by every source
 *  that holds it (see `sourcesFor`). The set of sources follows the grants
 *  and links this peer has; the caller keeps one handle throughout. */
interface Interest {
  id: string;
  sub: SubscriptionRequest;
  legs: Map<string, OutSub>;
  handle: MeshSubscription;
  /** Resolves the `subscribe()` promise once the first source answers. */
  resolve?: (s: MeshSubscription) => void;
}

/** The subscription as sent to one source. `waiting`: the source holds it
 *  until a grant covers it. */
interface OutSub {
  subId: string;
  peer: string;
  sub: SubscriptionRequest;
  interest: Interest;
  status: 'pending' | 'waiting' | 'active';
  timer?: ReturnType<typeof setTimeout>;
}

interface InSub {
  subId: string;
  sub: SubscriptionRequest;
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

const uuid = (): string => randomUUID();

/** Does `g` let its grantee write document (rtype, id) in any way? The
 *  grantor checks each leaf of a write itself; this only says whether writes
 *  to the document are its to decide. */
function writesEntity(
  g: Grant,
  rtype: string,
  id: string,
  isDescendant: (rtype: string, id: string, ancestor: string) => boolean
): boolean {
  return (
    (g.rights.update === true ||
      g.rights.create === true ||
      g.rights.delete === true) &&
    grantSelectsEntity(g, rtype, id, isDescendant)
  );
}

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
  private readonly grantStore = new GrantStore(uuid);
  /** Removed id → [id, ...ancestors] as they were at removal. The containment
   *  index forgets a removed entity; grants scoped to a subtree still need to
   *  know whether a tombstone falls inside it. */
  private readonly tombChains = new Map<string, string[]>();
  private readonly links = new Map<string, PeerLink>();
  /** participant → admitted incoming subscriptions (what we fan out to them). */
  private readonly inSubs = new Map<string, InSub[]>();
  /** Subscription legs we sent, by subId. */
  private readonly outSubs = new Map<string, OutSub>();
  private readonly interests = new Map<string, Interest>();
  /** Subscriptions we hold until a grant covers them, by sender. */
  private readonly pendingIn = new Map<string, SubscribeMsg[]>();
  /** Grants delivered to us, by the peer that delivered them. */
  private readonly received = new Map<string, DeliveredGrant[]>();
  /** Acks we wait for on behalf of the writer we forwarded a write for. */
  private readonly forwardedAcks = new Map<
    string,
    { to: string; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly pendingAcks = new Map<string, PendingAck>();
  private readonly statusObservers: ((s: MeshStatus) => void)[] = [];
  private readonly transports: MeshTransport[];
  /** Per-link clock-sync state (offset/rtt estimates + sampler timers). */
  private readonly clocks = new Map<string, ClockState>();
  private readonly now: () => number;

  /** Unstamped-op identity: this instance's epoch + a running sequence. */
  private readonly epoch = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  private seq = 0;
  /** Per origin: the (epoch, seq) window already applied (see alreadySeen). */
  private readonly seen = new Map<
    string,
    { qe: number; max: number; ids: Set<number> }
  >();
  /** Per participant whose home we are: who it reaches directly. */
  private readonly directLinks = new Map<string, Set<string>>();
  /** Requests awaiting a reply, by request id. */
  private readonly pendingRequests = new Map<
    string,
    {
      to: string;
      resolve: (o: RequestOutcome) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

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
    for (const [name, props] of Object.entries(cfg.channels ?? {}))
      this.channels.define(name, props);
    this.grantStore.observe(() => this.grantsChanged());
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

  /** Open the collection for `rtype`. A type declared in `models` brings its
   *  declaration; `local` adds what only this peer contributes. A local
   *  `validate` runs after the declared one, on its result. */
  collection<T extends object>(
    rtype: string,
    local: CollectionConfig<T> = {}
  ): Collection<T> {
    if (this.collections.has(rtype))
      throw new Error(`collection '${rtype}' already defined`);
    const model = this.cfg.models?.[rtype] as ModelDecl<T> | undefined;
    const cfg: CollectionConfig<T> = { ...model, ...local };
    if (model?.validate && local.validate) {
      const shared = model.validate;
      const own = local.validate;
      cfg.validate = (doc, ctx) => own(shared(doc, ctx), ctx);
    }
    const col = new Collection<T>(this, rtype, cfg);
    this.collections.set(rtype, col as unknown as AnyCollection);
    return col;
  }

  /** Single-cell sugar: a one-document collection of `{ id, value }` docs. */
  value<V>(
    rtype: string,
    id: string,
    cfg: CollectionConfig<{ id: string; value: V }> = {}
  ): MeshValue<V> {
    let col = this.collections.get(rtype) as
      | Collection<{ id: string; value: V }>
      | undefined;
    if (!col) col = this.collection<{ id: string; value: V }>(rtype, cfg);
    return new MeshValue(col, id);
  }

  /** The whitelist. Nothing is readable or writable by another participant
   *  without a grant (principle 9). */
  readonly grants = {
    grant: (g: Grant): string => this.grantStore.add(g),
    revoke: (gid: string): void => {
      this.grantStore.remove(gid);
    },
    list: (): (Grant & { gid: string })[] => this.grantStore.list(),
    observe: (cb: (grants: Grant[]) => void): (() => void) =>
      this.grantStore.observe(cb),
  };

  /** Declare interest in what `sub` selects. The mesh serves it from every
   *  peer that granted us read on it — over the most direct link there is —
   *  and keeps doing so as grants and links change. Resolves once the first
   *  source has sent its snapshot; a subscription no grant covers yet waits. */
  subscribe(sub: SubscriptionRequest): Promise<MeshSubscription> {
    const id = uuid();
    return new Promise<MeshSubscription>((resolve) => {
      const interest: Interest = {
        id,
        sub,
        legs: new Map(),
        resolve,
        handle: {
          sub,
          sources: () =>
            [...interest.legs.values()]
              .filter((l) => l.status === 'active')
              .map((l) => l.peer),
          unsubscribe: () => {
            this.interests.delete(id);
            for (const leg of interest.legs.values()) this.dropLeg(leg, true);
          },
        },
      };
      this.interests.set(id, interest);
      this.reconcileInterest(interest);
    });
  }

  /** Bring an interest's legs in line with its current sources. */
  private reconcileInterest(interest: Interest): void {
    const want = this.sourcesFor(interest.sub);
    for (const leg of [...interest.legs.values()])
      if (!want.has(leg.peer)) this.dropLeg(leg, true);
    for (const peer of want) {
      if (interest.legs.has(peer)) continue;
      const leg: OutSub = {
        subId: uuid(),
        peer,
        sub: interest.sub,
        interest,
        status: 'pending',
      };
      leg.timer = setTimeout(
        () => this.dropLeg(leg, true),
        this.cfg.subscribeTimeoutMs ?? 10_000
      );
      interest.legs.set(peer, leg);
      this.outSubs.set(leg.subId, leg);
      this.transmit(peer, { t: 'sub', subId: leg.subId, sub: leg.sub });
    }
  }

  private reconcileInterests(): void {
    for (const interest of this.interests.values())
      this.reconcileInterest(interest);
  }

  private dropLeg(leg: OutSub, tellSource: boolean): void {
    clearTimeout(leg.timer);
    this.outSubs.delete(leg.subId);
    leg.interest.legs.delete(leg.peer);
    if (tellSource) this.transmit(leg.peer, { t: 'unsub', subId: leg.subId });
  }

  /** The linked peers that can serve `sub`: those that granted us read on any
   *  of it, and their own participants (who serve on their server's behalf
   *  over a direct link). Never another tab of our own server: we meet those
   *  through it. */
  private sourcesFor(sub: SubscriptionRequest): Set<string> {
    const out = new Set<string>();
    const ownServer = participantServer(this.id);
    for (const g of this.receivedGrants()) {
      if (!g.rights.read) continue;
      if (!grantOverlapsSubscription(g, sub, this.isDescendantOrWas)) continue;
      for (const peer of this.links.keys()) {
        if (peer === this.id) continue;
        if (peer === g.grantor) out.add(peer);
        else if (
          participantServer(peer) === g.grantor &&
          participantServer(peer) !== ownServer
        )
          out.add(peer);
      }
    }
    return out;
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

  /** Remove `rootId` and every document under it in the (cross-type)
   *  containment tree — children before parents — as ONE undo action.
   *
   *  Behaviors, effects, clips and graphs hang off the node they belong to, so
   *  removing a node through this removes them too, each with its own
   *  tombstone, and a single undo brings the whole tree back. Removing only
   *  the root would leave its dependents alive in every replica with nothing
   *  to delete them.
   *
   *  Only document collections take part (a retained channel with authority
   *  acks); runtime state is cleaned up by whoever authored it. A root this
   *  peer no longer holds is skipped, so this also sweeps the dependents of a
   *  document that was just removed. */
  removeTree(rootId: string): WriteHandle[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const walk = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const c of this.index.childrenOf(id)) walk(c);
      order.push(id);
    };
    walk(rootId);
    return this.batch(() => {
      const handles: WriteHandle[] = [];
      for (const id of order) {
        const rtype = this.index.rtypeOf(id);
        const col = rtype ? this.collections.get(rtype) : undefined;
        if (!col?.retainedChannel || !col.replica.has(id)) continue;
        if (!this.channels.get(col.retainedChannel)?.ack) continue;
        handles.push(col.remove(id));
      }
      return handles;
    });
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
    const net = new Map<
      string,
      { e: UndoEntry; col: AnyCollection | undefined }
    >();
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
  private policyAllows(
    col: AnyCollection,
    id: string,
    expected: unknown
  ): boolean {
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
    for (const t of state.timers) (t as { unref?: () => void }).unref?.();
  }

  private stopClockSync(peerId: string): void {
    const state = this.clocks.get(peerId);
    if (!state) return;
    for (const t of state.timers)
      clearTimeout(t as ReturnType<typeof setTimeout>);
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
    for (const r of this.pendingRequests.values()) clearTimeout(r.timer);
    this.pendingRequests.clear();
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
    this.tombChains.delete(id);
  }

  noteRemoved(id: string, chain: string[]): void {
    this.tombChains.set(id, chain);
  }

  /** Containment check that also places tombstoned ids where they were. */
  private readonly isDescendantOrWas = (
    rtype: string,
    childId: string,
    ancestorId: string
  ): boolean =>
    this.index.isDescendant(rtype, childId, ancestorId) ||
    (this.tombChains.get(childId)?.includes(ancestorId) ?? false);

  // --- mounts ------------------------------------------------------------------
  //
  // A MOUNT is not a reconnect. Reconnecting peers share history and comparable
  // clocks, so ordinary LWW reconciles them. Mounting brings in a tree this peer
  // has no history with — and if it once held those ids and deleted them, its
  // tombstones out-stamp the author's live documents: the mount lands empty, and
  // the mutual subscription then propagates those tombstones back and deletes
  // the author's scene.
  //
  // So a mount records WHEN it happened, and documents in the mounted scope
  // reconcile against `max(write stamp, mount stamp)`.
  //
  // The stamp is LOCAL METADATA on the mount, never written to the documents.
  // Re-stamping them would work and would break "a document has exactly one
  // truth" — the same document would carry a different stamp here than at its
  // author. Keeping it beside them has two consequences that fall out for free:
  // nothing can leak back (the documents are untouched, so this peer can never
  // appear as the author of someone else's scene), and it expires by itself
  // (once a document's own writes pass the mount stamp, `max` is the write
  // stamp and ordinary LWW resumes — no flag to clear).

  private readonly mounts = new Map<string, HLC>();

  /** Record a mount of the subtree rooted at `rootId`. `v` defaults to now.
   *  Idempotent per root: re-mounting moves the stamp forward, which is the
   *  point — a second mount is a second deliberate act. */
  mount(rootId: string, v?: HLC): void {
    this.mounts.set(rootId, v ?? this.clock.tick());
  }

  /** Forget a mount. Documents in the scope reconcile by ordinary LWW again. */
  unmount(rootId: string): void {
    this.mounts.delete(rootId);
  }

  /** The mount stamp covering `id`, if any — the doc itself or an ancestor.
   *
   *  `parentHint` is the parent the INCOMING document declares, which is the
   *  only way to place a document the index has never seen or has forgotten.
   *  That is the ordinary case here, not an edge one: the receiver deleted this
   *  subtree, so removing it from the index is exactly what happened, and the
   *  arriving document has to be placed by what it says about itself. */
  mountStampFor(id: string, parentHint?: string | null): HLC | undefined {
    if (this.mounts.size === 0) return undefined; // hot path: no mounts, no walk
    const own = this.mounts.get(id);
    if (own) return own;
    for (const [rootId, v] of this.mounts) {
      if (this.index.isDescendant('', id, rootId)) return v;
      if (parentHint === rootId) return v;
      if (parentHint && this.index.isDescendant('', parentHint, rootId))
        return v;
    }
    return undefined;
  }

  /** `v`, or the mount stamp if this doc is in a mounted scope and the mount is
   *  newer. Applied on the way INTO the replica only; what this peer relays
   *  onward still carries the origin's own stamp. */
  effectiveStamp(id: string, v: HLC, parentHint?: string | null): HLC {
    const m = this.mountStampFor(id, parentHint);
    return m && compareHLC(m, v) > 0 ? m : v;
  }

  indexRemove(id: string): void {
    this.index.remove(id);
  }

  /** The committed document a write would leave behind, or undefined when
   *  there is nothing to compose with: a patch to a document this peer does
   *  not hold yet is parked by the replica, not applied. */
  private composeCandidate(
    col: AnyCollection,
    op: DocOp,
    id: string,
    path: string | undefined,
    data: unknown
  ): unknown {
    if (op === 'upsert') return data;
    const cur = col.replica.raw(id);
    if (cur === undefined) return undefined;
    if (path) return setPath(cur, path, data);
    let doc: unknown = cur;
    for (const [p, v] of flattenToLeaves(data)) doc = setPath(doc, p, v);
    return doc;
  }

  /** Run the collection's validator on the document a retained write would
   *  leave behind. Returns the data to apply: the write's own data, or — when
   *  the validator corrected the document — the corrected whole document
   *  (`corrected: true`, to be applied as an upsert). Undefined when there is
   *  nothing to check (see composeCandidate). Throws when rejected. */
  private checkWrite(
    col: AnyCollection,
    op: DocOp,
    id: string,
    path: string | undefined,
    data: unknown,
    origin: string
  ): { data: unknown; corrected: boolean } | undefined {
    if (!col.cfg.validate) return undefined;
    const candidate = this.composeCandidate(col, op, id, path, data);
    if (candidate === undefined) return undefined;
    const validated = col.validateDoc(candidate, origin, id);
    if (deepEqual(validated, candidate))
      return { data: op === 'upsert' ? validated : data, corrected: false };
    return { data: validated, corrected: true };
  }

  /** Translate the collection's declared clock fields in incoming data from
   *  the sender's clock onto ours. Applied per hop, so data on a link is
   *  always in its sender's clock. */
  private localizeClocks(
    col: AnyCollection,
    path: string | undefined,
    data: unknown,
    senderId: string
  ): unknown {
    const fields = col.cfg.clockFields;
    if (!fields?.length || data === null || typeof data !== 'object') {
      if (fields?.includes(path ?? '') && typeof data === 'number')
        return Math.round(this.toLocalTime(senderId, data));
      return data;
    }
    if (path) return data; // a nested branch: clock fields are top-level
    let out = data as Record<string, unknown>;
    for (const f of fields) {
      const v = out[f];
      if (typeof v === 'number')
        out = { ...out, [f]: Math.round(this.toLocalTime(senderId, v)) };
    }
    return out;
  }

  // --- grant knowledge ------------------------------------------------------------------
  //
  // A peer knows the grants it issued (`grantStore`) and the grants delivered
  // to it (`received`): what others let it do, with who issued each. A server
  // delivers to its own participants the grants it issued to others too
  // (`delegated`), so a tab can serve them on its server's behalf.

  /** A participant's own server, if this peer is one (an endpoint: it reaches
   *  everyone else through that server, which decides its writes). */
  private get upstream(): string | undefined {
    const server = participantServer(this.id);
    return server === this.id ? undefined : server;
  }

  /** Non-delegated grants delivered to us: what others let us do. */
  private receivedGrants(): DeliveredGrant[] {
    const out: DeliveredGrant[] = [];
    for (const list of this.received.values())
      for (const g of list) if (!g.delegated) out.push(g);
    return out;
  }

  /** What `participant` may do here: the grants we issued, plus those our
   *  server issued and delegated to us. */
  private grantsFor(participant: string): Grant[] {
    const own = this.grantStore.for(participant);
    const up = this.upstream;
    const delegated = up ? this.received.get(up) : undefined;
    if (!delegated?.length) return own;
    const candidates = granteeCandidates(participant);
    const extra = delegated.filter(
      (g) => g.delegated && candidates.includes(g.grantee)
    );
    return extra.length ? [...own, ...extra] : own;
  }

  /** Is `sender` a source for document (rtype, id): the grantor of a read
   *  grant we hold on it, or one of that grantor's own participants? Per
   *  document, not per path: a source projects what it sends to what we may
   *  read before it sends it. */
  private isSourceFor(sender: string, rtype: string, id: string): boolean {
    const server = participantServer(sender);
    return this.receivedGrants().some(
      (g) =>
        g.rights.read === true &&
        (g.grantor === sender || g.grantor === server) &&
        grantSelectsEntity(g, rtype, id, this.isDescendantOrWas)
    );
  }

  /** Did `peer` (or the server it belongs to) grant us a write on `key`? A
   *  write may always travel to whoever lets us make it. */
  private grantorOfWrite(peer: string, rtype: string, id: string): boolean {
    const server = participantServer(peer);
    return this.receivedGrants().some(
      (g) =>
        (g.grantor === peer || g.grantor === server) &&
        writesEntity(g, rtype, id, this.isDescendantOrWas)
    );
  }

  /** Who decides a write to `id`: the collection's configured authority; for
   *  an endpoint, its server; otherwise whoever granted us a write on it (a
   *  space shared with us); otherwise this peer. */
  authorityFor(col: Collection<any>, id?: string): string {
    const configured = col.cfg.authority;
    if (configured !== undefined) return configured;
    const up = this.upstream;
    if (up) return up;
    if (id !== undefined)
      for (const g of this.receivedGrants())
        if (
          g.grantor !== this.id &&
          writesEntity(g, col.rtype, id, this.isDescendantOrWas)
        )
          return g.grantor;
    return 'self';
  }

  /** What we deliver to `peer`: the grants we issued that cover it; to our own
   *  participants also the grants we received that cover them, and the grants
   *  we issued to others (delegated). */
  private grantsDeliveredTo(peer: string): DeliveredGrant[] {
    const own = participantServer(peer) === this.id && peer !== this.id;
    const candidates = granteeCandidates(peer);
    const out: DeliveredGrant[] = [];
    for (const { gid: _gid, ...g } of this.grantStore.list()) {
      if (candidates.includes(g.grantee)) out.push({ ...g, grantor: this.id });
      else if (own) out.push({ ...g, grantor: this.id, delegated: true });
    }
    if (own)
      for (const g of this.receivedGrants())
        if (candidates.includes(g.grantee)) out.push(g);
    return out;
  }

  private deliverGrants(peer: string): void {
    this.transmit(peer, { t: 'grants', grants: this.grantsDeliveredTo(peer) });
  }

  /** Our grants changed: tell everyone it concerns, admit what is now covered,
   *  drop what no longer is. */
  private grantsChanged(): void {
    for (const peer of this.links.keys()) this.deliverGrants(peer);
    this.admitPending();
    this.revalidateInSubs();
  }

  private handleGrants(senderId: string, grants: DeliveredGrant[]): void {
    this.received.set(senderId, grants);
    // Our own participants hear about what we were granted.
    for (const peer of this.links.keys())
      if (participantServer(peer) === this.id && peer !== this.id)
        this.deliverGrants(peer);
    if (senderId === this.upstream) {
      this.admitPending();
      this.revalidateInSubs();
    }
    this.reconcileInterests();
  }

  localWrite<T extends object>(c: Collection<T>, w: LocalWrite): WriteHandle {
    const col = c as unknown as AnyCollection;
    const ch = this.channels.get(w.channel);
    if (!ch) throw new Error(`unknown channel '${w.channel}'`);
    const meta = { origin: this.id, channel: w.channel, hydrate: !!w.hydrateV };

    // Unstamped (preview / control): never guarded. Every op gets an
    // (epoch, seq) identity so a receiver applies it once however many paths
    // it arrives over.
    if (!ch.stamped) {
      const env = this.envelope(col, w, undefined);
      env.qe = this.epoch;
      env.q = ++this.seq;
      // Addressed: routed toward its one recipient, applied only there.
      if (w.to !== undefined && w.to !== this.id) {
        const hop = this.nextHop(w.to);
        if (!hop) return done({ status: 'rejected', reason: 'unreachable' });
        this.transmit(hop, env, ch.transport === 'lossy');
        return done({ status: 'unguarded' });
      }
      const change = col.applyOp(w.op, w.id, w.path, w.data, undefined, meta);
      if (change) this.fanout(col, env, undefined, undefined);
      return done({ status: 'unguarded' });
    }

    // Validate local writes too (fail fast; corrections apply locally). A
    // corrected write becomes a whole-document upsert of the corrected doc.
    let data = w.data;
    let corrected = false;
    if (w.op !== 'remove' && w.channel === col.retainedChannel) {
      try {
        const checked = this.checkWrite(
          col,
          w.op,
          w.id,
          w.path,
          w.data,
          this.id
        );
        if (checked) {
          ({ data, corrected } = checked);
          if (corrected) w = { ...w, op: 'upsert', path: undefined, data };
        }
      } catch (e) {
        return done({ status: 'rejected', reason: errMsg(e) });
      }
    }

    const authority = this.authorityFor(col, w.id);
    const guarded = ch.ack === 'authority' && !w.hydrateV;
    if (guarded && authority !== 'self') {
      if (!this.links.has(authority))
        return done({ status: 'rejected', reason: 'authority-offline' });
      // Nobody let us make this write: it would never leave this peer. A
      // create isn't in the containment index yet, so place it by the parent
      // it declares for the check (applying indexes it for real).
      let placed = false;
      if (w.op === 'upsert' && !col.replica.has(w.id)) {
        const parentRef = col.cfg.parent?.(w.data as never);
        if (parentRef) {
          this.indexUpsert(col.rtype, w.id, parentRef.id);
          placed = true;
        }
      }
      if (!this.grantorOfWrite(authority, col.rtype, w.id)) {
        if (placed) this.indexRemove(w.id);
        return done({
          status: 'rejected',
          reason: 'denied',
          current: col.get(w.id),
        });
      }
    }

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
      w.op === 'remove'
        ? this.recipients(col, w.id, w.path, w.channel)
        : undefined;
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

  /** A link came up: tell the peer what it may do here. Our subscriptions
   *  reach it once it has told us the same (handleGrants); the snapshot that
   *  answers each reconciles whatever changed while the link was down, so
   *  callers subscribe once and keep their handle. */
  private onPeerConnected(peerId: string, link: PeerLink): void {
    this.links.set(peerId, link);
    this.startClockSync(peerId);
    this.deliverGrants(peerId);
    this.announceLinks();
    this.reconcileInterests();
    this.notifyStatus();
  }

  /** Tell our home which participants we reach directly (see LinksMsg). */
  /** Tell our home which participants we get data from directly: a link
   *  with an ACTIVE subscription over it. A link alone isn't enough — if the
   *  subscription was refused, nothing flows over it, and our home must keep
   *  relaying. */
  private announceLinks(): void {
    const home = this.upstream;
    if (!home || !this.links.has(home)) return;
    const peers = new Set<string>();
    for (const s of this.outSubs.values())
      if (s.peer !== home && s.status === 'active' && this.links.has(s.peer))
        peers.add(s.peer);
    this.transmit(home, { t: 'links', peers: [...peers] });
  }

  private onPeerDisconnected(peerId: string): void {
    this.links.delete(peerId);
    this.inSubs.delete(peerId);
    this.pendingIn.delete(peerId);
    this.directLinks.delete(peerId);
    this.stopClockSync(peerId);
    for (const leg of [...this.outSubs.values()])
      if (leg.peer === peerId) this.dropLeg(leg, false);
    // What it granted us stays known (the next delivery replaces it): a space
    // someone shared with us is still theirs to decide while they are away —
    // read-only, not ours.
    this.announceLinks();
    this.reconcileInterests();
    this.notifyStatus();
  }

  private onMessage(senderId: string, msg: MeshMessage): void {
    switch (msg.t) {
      case 'links':
        this.directLinks.set(senderId, new Set(msg.peers));
        return;
      case 'grants':
        return this.handleGrants(senderId, msg.grants);
      case 'sub_wait': {
        const leg = this.outSubs.get(msg.subId);
        if (leg?.peer === senderId && leg.status === 'pending') {
          clearTimeout(leg.timer);
          leg.status = 'waiting';
        }
        return;
      }
      case 'op':
        return this.handleOp(senderId, msg);
      case 'sub':
        return this.handleSub(senderId, msg);
      case 'sub_ok':
        return this.handleSubOk(senderId, msg);
      case 'sub_err': {
        const leg = this.outSubs.get(msg.subId);
        if (leg?.peer === senderId) this.dropLeg(leg, false);
        return;
      }
      case 'unsub': {
        const list = this.inSubs.get(senderId);
        if (list)
          this.inSubs.set(
            senderId,
            list.filter((s) => s.subId !== msg.subId)
          );
        const waiting = this.pendingIn.get(senderId);
        if (waiting)
          this.pendingIn.set(
            senderId,
            waiting.filter((s) => s.subId !== msg.subId)
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
    if (!ch.stamped && this.alreadySeen(env)) return; // arrived over another path

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

    const admitted = this.admitOp(senderId, env, col);
    if (!admitted) {
      dropProvisional();
      // A forwarder may already have applied it: the deciding peer restates
      // what stands.
      if (env.v && this.authorityFor(col, env.id) === 'self')
        this.issueCanonical(col, env.id);
      if (env.ack)
        this.sendTo(senderId, {
          t: 'ack',
          opId: env.ack,
          status: 'rejected',
          reason: 'denied',
          value: col.get(env.id),
          v: col.replica.rootStamp(env.id),
          rtype: env.rtype,
          id: env.id,
        });
      return;
    }
    // A partial-view writer's upsert arrives as the merge-patch it may make.
    env = admitted;
    // Declared clock fields arrive on the sender's clock; from here on (apply,
    // relay, forward) they are on ours.
    if (col.cfg.clockFields && env.data !== undefined)
      env = {
        ...env,
        data: this.localizeClocks(col, env.path, env.data, senderId),
      };

    // Addressed to someone else: pass it on toward them, apply nothing here.
    if (env.to !== undefined && env.to !== this.id) {
      const hop = this.nextHop(env.to, senderId);
      if (hop) this.transmit(hop, env, ch.transport === 'lossy');
      else if (env.mid !== undefined)
        this.transmit(
          senderId,
          this.replyEnvelope(env, undefined, 'unreachable')
        );
      return;
    }
    // A reply to one of our requests: resolves it, never touches the replica.
    if (env.re !== undefined) {
      this.handleReply(env);
      return;
    }

    // Ephemeral: overlay + relay, nothing else. A request is surfaced to
    // observers with what they need to answer it.
    if (!ch.stamped || !env.v) {
      const change = col.applyOp(
        env.op,
        env.id,
        env.path,
        env.data,
        undefined,
        {
          origin: env.origin,
          channel: env.ch,
          request:
            env.mid !== undefined
              ? { mid: env.mid, from: env.origin }
              : undefined,
        }
      );
      // Delivered to us specifically: nobody else is meant to see it.
      if (env.to === this.id) return;
      if (change) this.relay(col, env, senderId, undefined, undefined);
      return;
    }

    this.clock.observe(env.v);
    const authority = this.authorityFor(col, env.id);
    const decides = authority === 'self';

    // Validate the document the write would leave behind; a corrected write
    // becomes an upsert of the corrected document (the authority issues it as
    // its own write below).
    let data = env.data;
    let corrected = false;
    if (env.op !== 'remove' && env.ch === col.retainedChannel) {
      try {
        const checked = this.checkWrite(
          col,
          env.op,
          env.id,
          env.path,
          env.data,
          env.origin
        );
        if (checked) {
          ({ data, corrected } = checked);
          if (corrected) env = { ...env, op: 'upsert', path: undefined, data };
        }
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
            rtype: env.rtype,
            id: env.id,
          });
        if (decides && (senderId !== env.origin || !env.ack))
          this.issueCanonical(col, env.id);
        return;
      }
    }

    const guarded = !!env.ack && decides && ch.ack === 'authority';
    // Not ours to decide: pass the write on toward whoever does (relay adds
    // them as a target) and carry their ack back to the writer.
    if (
      env.ack &&
      !decides &&
      ch.ack === 'authority' &&
      authority !== senderId &&
      this.links.has(authority)
    )
      this.forwardAck(env.ack, senderId);

    const preRecipients =
      env.op === 'remove'
        ? this.recipients(col, env.id, env.path, env.ch)
        : undefined;
    const preChain =
      env.op === 'remove' ? col.ancestorChain(env.id) : undefined;
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
            rtype: env.rtype,
            id: env.id,
          });
          if (senderId !== env.origin) this.issueCanonical(col, env.id);
          return;
        }
      }
      this.sendTo(senderId, {
        t: 'ack',
        opId: env.ack!,
        status: corrected ? 'corrected' : 'acked',
        value: corrected ? data : undefined,
        v: corrected ? v : undefined,
        rtype: env.rtype,
        id: env.id,
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

  /** Admission for an incoming op. Accepted if the sender is a source of the
   *  data (it granted us read on it), or the ORIGIN holds the grants for it. Returns the op to apply — possibly
   *  narrowed — or null when it is refused.
   *
   *  Writes are checked per leaf, so field-level update grants work: a
   *  merge-patch passes when every leaf it sets is writable. A whole-document
   *  upsert from an origin that may not write the whole document is applied as
   *  a merge-patch of the leaves it may write — a peer with a partial view
   *  never overwrites what it cannot see. */
  private admitOp(
    senderId: string,
    env: OpEnvelope,
    col: AnyCollection
  ): OpEnvelope | null {
    // Data from where we may read it: the grantor of our read grant (or one
    // of its own participants) is the source of what it sends.
    if (this.isSourceFor(senderId, env.rtype, env.id)) return env;
    const grants = this.grantsFor(env.origin);
    const can = (need: Right, path?: string): boolean =>
      allows(
        grants,
        makeKey(env.rtype, env.id, path || undefined),
        need,
        this.isDescendantOrWas
      );
    if (env.op === 'remove') return can('delete') ? env : null;
    if (env.op === 'upsert') {
      if (!col.replica.has(env.id)) return can('create') ? env : null;
      if (can('update')) return env;
      const writable = flattenToLeaves(env.data).filter(
        ([p]) => p !== '' && can('update', p)
      );
      if (writable.length === 0) return null;
      let partial: unknown = {};
      for (const [p, v] of writable) partial = setPath(partial, p, v);
      return { ...env, op: 'patch', path: undefined, data: partial };
    }
    if (env.path) return can('update', env.path) ? env : null;
    return flattenToLeaves(env.data).every(([p]) => can('update', p))
      ? env
      : null;
  }

  // --- subscriptions (incoming) ---------------------------------------------------------

  /** Admitted when some read grant overlaps the subscription; what it then
   *  receives — snapshot included — is projected per message at egress. One
   *  no grant covers yet is held, and admitted when one appears. */
  private handleSub(senderId: string, msg: SubscribeMsg): void {
    if (this.admitSub(senderId, msg)) return;
    const waiting = this.pendingIn.get(senderId) ?? [];
    waiting.push(msg);
    this.pendingIn.set(senderId, waiting);
    this.sendTo(senderId, { t: 'sub_wait', subId: msg.subId });
  }

  /** Admit the held subscriptions a grant now covers. */
  private admitPending(): void {
    for (const [peerId, waiting] of [...this.pendingIn]) {
      const left = waiting.filter((msg) => !this.admitSub(peerId, msg));
      if (left.length) this.pendingIn.set(peerId, left);
      else this.pendingIn.delete(peerId);
    }
  }

  private admitSub(senderId: string, msg: SubscribeMsg): boolean {
    const admitted = this.grantsFor(senderId).some((g) =>
      grantOverlapsSubscription(g, msg.sub, this.isDescendantOrWas)
    );
    if (!admitted) return false;
    const list = this.inSubs.get(senderId) ?? [];
    list.push({ subId: msg.subId, sub: msg.sub });
    this.inSubs.set(senderId, list);

    const docs: SnapshotDoc[] = [];
    const tombstones: SnapshotTombstone[] = [];
    for (const [rtype, col] of this.collections) {
      if (!col.retainedChannel) continue;
      if (!this.channelOk(msg.sub, col.retainedChannel, col)) continue;
      if (msg.sub.entityRtype !== '*' && msg.sub.entityRtype !== rtype) {
        // Descendant subscriptions may still cover other rtypes via the tree.
        if (!msg.sub.includeDescendants) continue;
      }
      for (const id of col.replica.ids()) {
        const key = makeKey(rtype, id);
        if (!subscriptionMatches(msg.sub, key, this.index.isDescendant))
          continue;
        docs.push({
          rtype,
          id,
          doc: col.replica.raw(id),
          v: col.replica.rootStamp(id),
          paths: col.replica.pathStampsOf(id),
        });
      }
      // Removed entities are placed where they were (tombChains), so only the
      // tombstones inside the subscription's scope go out; egress then drops
      // any the subscriber's grants don't cover.
      for (const t of col.replica.tombstones()) {
        const key = makeKey(rtype, t.id);
        if (!subscriptionMatches(msg.sub, key, this.isDescendantOrWas))
          continue;
        tombstones.push({ rtype, id: t.id, v: t.v });
      }
    }
    this.sendTo(senderId, {
      t: 'sub_ok',
      subId: msg.subId,
      docs,
      tombstones,
      watermark: this.clock.tick(),
    });
    return true;
  }

  private handleSubOk(senderId: string, msg: SubOkMsg): void {
    const entry = this.outSubs.get(msg.subId);
    if (!entry || entry.peer !== senderId || entry.status === 'active') return;
    clearTimeout(entry.timer);
    entry.status = 'active';
    if (senderId !== this.upstream) this.announceLinks();
    this.clock.observe(msg.watermark);

    // Snapshot state is new state for OUR subscribers too — relay each applied
    // change onward exactly like a live op (a tab subscribed before its server
    // reconciled would otherwise never see the snapshot's docs).
    for (const d of msg.docs) {
      const col = this.collections.get(d.rtype);
      if (!col?.retainedChannel) continue;
      let data = col.cfg.clockFields
        ? this.localizeClocks(col, undefined, d.doc, senderId)
        : d.doc;
      try {
        data = col.validateDoc(data, senderId, d.id);
      } catch {
        continue; // snapshot doc fails validation — skip it
      }
      const v = d.v ?? { t: 0, c: 0, n: senderId };
      const meta = { origin: senderId, channel: col.retainedChannel };
      const applied = (
        change: ReturnType<AnyCollection['applyOp']>,
        env: OpEnvelope
      ): void => {
        if (!change) return;
        try {
          col.runTaps(change);
        } catch (e) {
          console.error(
            `[mesh] snapshot tap failed for ${d.rtype}:${d.id}:`,
            e
          );
        }
        this.relay(col, env, senderId, undefined, undefined);
      };
      applied(
        col.applyOp('upsert', d.id, undefined, data, v, meta),
        this.snapshotEnv(col, 'upsert', d.id, data, v, senderId)
      );
      // Then each field written after the root, under its own stamp — the
      // root stamp alone loses to a copy we already hold, which would drop a
      // field edit made while we were away.
      for (const [path, pv] of Object.entries(d.paths ?? {})) {
        const value = getPath(data, path);
        applied(col.applyOp('patch', d.id, path, value, pv, meta), {
          ...this.snapshotEnv(col, 'upsert', d.id, value, pv, senderId),
          op: 'patch',
          path,
        });
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
      const preRecipients = this.recipients(
        col,
        t.id,
        undefined,
        col.retainedChannel
      );
      const preChain = col.ancestorChain(t.id);
      const change = col.applyOp('remove', t.id, undefined, undefined, t.v, {
        origin: senderId,
        channel: col.retainedChannel,
      });
      if (change) {
        try {
          col.runTaps(change);
        } catch (e) {
          console.error(
            `[mesh] snapshot tap failed for ${t.rtype}:${t.id}:`,
            e
          );
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

    const interest = entry.interest;
    interest.resolve?.(interest.handle);
    interest.resolve = undefined;
  }

  // --- acks --------------------------------------------------------------------------------

  private handleAck(senderId: string, msg: AckMsg): void {
    const fwd = this.forwardedAcks.get(msg.opId);
    if (fwd) {
      this.forwardedAcks.delete(msg.opId);
      clearTimeout(fwd.timer);
      const col =
        msg.rtype !== undefined ? this.collections.get(msg.rtype) : undefined;
      const value =
        msg.value !== undefined && col?.cfg.clockFields
          ? this.localizeClocks(col, undefined, msg.value, senderId)
          : msg.value;
      // We applied the write as it was; a correction replaces it here and
      // for our subscribers too. (A refusal arrives as the deciding peer's
      // restatement, see issueCanonical.)
      if (
        msg.status === 'corrected' &&
        col?.retainedChannel &&
        msg.id !== undefined &&
        msg.v &&
        value !== undefined
      ) {
        this.clock.observe(msg.v);
        const env: OpEnvelope = {
          t: 'op',
          rtype: col.rtype,
          op: 'upsert',
          id: msg.id,
          data: value,
          v: msg.v,
          origin: senderId,
          ch: col.retainedChannel,
        };
        const change = col.applyOp('upsert', msg.id, undefined, value, msg.v, {
          origin: senderId,
          channel: col.retainedChannel,
        });
        if (change) {
          this.safeTaps(col, change);
          this.relay(col, env, senderId, undefined, undefined);
        }
      }
      this.transmit(fwd.to, value === msg.value ? msg : { ...msg, value });
      return;
    }
    const p = this.pendingAcks.get(msg.opId);
    if (!p) return;
    this.pendingAcks.delete(msg.opId);
    clearTimeout(p.timer);

    if (msg.status === 'acked') {
      if (p.undo) this.pushUndo(p.undo, p.undoGroup);
      p.resolve({ status: 'acked' });
      return;
    }
    // The authority's document is on its clock, like any incoming data.
    if (msg.value !== undefined && p.col.cfg.clockFields)
      msg = {
        ...msg,
        value: this.localizeClocks(p.col, undefined, msg.value, senderId),
      };
    if (msg.status === 'corrected') {
      // A correction carries the whole corrected document, whatever shape
      // the write had.
      if (msg.v) {
        this.clock.observe(msg.v);
        const change = p.col.applyOp(
          'upsert',
          p.id,
          undefined,
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
      const change = p.col.applyOp(
        'upsert',
        p.id,
        undefined,
        msg.value,
        msg.v,
        {
          origin: senderId,
          channel: p.col.retainedChannel ?? 'committed',
        }
      );
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
  /** Remember to carry the ack for `opId` back to `writer`. */
  private forwardAck(opId: string, writer: string): void {
    const timer = setTimeout(
      () => this.forwardedAcks.delete(opId),
      (this.cfg.ackTimeoutMs ?? 4000) * 2
    );
    this.forwardedAcks.set(opId, { to: writer, timer });
  }

  /** Restate what stands for `id` after refusing a write others may already
   *  hold (one that came through a forwarder): the current document — or its
   *  removal — re-issued under a fresh stamp to every subscriber. */
  private issueCanonical(col: AnyCollection, id: string): void {
    const ch = col.retainedChannel;
    if (!ch) return;
    const doc = col.replica.raw(id);
    const op = doc === undefined ? 'remove' : 'upsert';
    const targets = new Set(this.recipients(col, id, undefined, ch));
    const v = this.clock.tick();
    col.applyOp(op, id, undefined, doc, v, { origin: this.id, channel: ch });
    this.deliver(
      { t: 'op', rtype: col.rtype, op, id, data: doc, v, origin: this.id, ch },
      targets
    );
  }

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
        if (!this.channelOk(s.sub, channel, col)) continue;
        if (subscriptionMatches(s.sub, key, this.index.isDescendant)) {
          out.push(peerId);
          break;
        }
      }
    }
    return out;
  }

  /** Fan a locally-originated env out: interested subscribers, plus whoever
   *  decides the write (our server, or the grantor of the space). */
  private fanout(
    col: AnyCollection,
    env: OpEnvelope,
    preRecipients: string[] | undefined,
    _preChain: string[] | undefined
  ): void {
    const targets = new Set(
      preRecipients ?? this.recipients(col, env.id, env.path, env.ch)
    );
    const authority = this.authorityFor(col, env.id);
    if (authority !== 'self' && this.links.has(authority))
      targets.add(authority);
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
    // An endpoint (a tab) forwards nothing: a direct subscriber gets from it
    // only what it authors.
    if (this.upstream) return;
    const targets = new Set(
      preRecipients ?? this.recipients(col, env.id, env.path, env.ch)
    );
    // A write in a space someone granted us goes on to them.
    const up = this.authorityFor(col, env.id);
    if (up !== 'self' && this.links.has(up) && env.v) targets.add(up);
    targets.delete(senderId);
    targets.delete(env.origin);
    // Send once per path: a recipient that reaches the origin directly
    // already has this lossy op first-hand. Reliable traffic is still
    // relayed — it is the path that survives a direct link dropping silently.
    if (this.channels.get(env.ch)?.transport === 'lossy')
      for (const t of [...targets])
        if (this.directLinks.get(t)?.has(env.origin)) targets.delete(t);
    this.deliver(env, targets);
  }

  private deliver(env: OpEnvelope, targets: Set<string>): void {
    const lossy = this.channels.get(env.ch)?.transport === 'lossy';
    for (const t of targets) if (t !== this.id) this.transmit(t, env, lossy);
  }

  // --- egress ---------------------------------------------------------------------------------
  //
  // THE choke point: every message this peer sends goes through `transmit`,
  // which projects it through the recipient's grants. Field-level read grants
  // are only safe because nothing can bypass this.

  private transmit(peerId: string, msg: MeshMessage, lossy = false): void {
    const link = this.links.get(peerId);
    if (!link) return;
    const out = this.egress(peerId, msg);
    if (!out) return;
    if (lossy && link.sendLossy) link.sendLossy(out);
    else link.send(out);
  }

  /** What `peerId` may receive of `msg`, or null for nothing. */
  private egress(peerId: string, msg: MeshMessage): MeshMessage | null {
    switch (msg.t) {
      case 'op':
        // A write goes to whoever let us make it, whole; everything else is
        // what the recipient may read.
        if (this.grantorOfWrite(peerId, msg.rtype, msg.id)) return msg;
        return projectOp(msg, this.scopeFor(peerId, msg.rtype, msg.id));
      case 'sub_ok': {
        const docs: SnapshotDoc[] = [];
        for (const d of msg.docs) {
          const scope = this.scopeFor(peerId, d.rtype, d.id);
          const doc = projectValue(d.doc, scope);
          if (doc === undefined) continue;
          // Field stamps go with the fields: none for a path it can't read.
          const paths =
            d.paths &&
            Object.fromEntries(
              Object.entries(d.paths).filter(([p]) => scopeTouches(scope, p))
            );
          docs.push(
            doc === d.doc && paths === d.paths ? d : { ...d, doc, paths }
          );
        }
        const tombstones = msg.tombstones.filter(
          (t) => this.scopeFor(peerId, t.rtype, t.id).kind !== 'none'
        );
        return { ...msg, docs, tombstones };
      }
      case 'ack': {
        if (msg.value === undefined) return msg;
        // A rejected writer must not learn a value it cannot read.
        const value =
          msg.rtype !== undefined && msg.id !== undefined
            ? projectValue(msg.value, this.scopeFor(peerId, msg.rtype, msg.id))
            : undefined;
        return value === undefined
          ? { ...msg, value: undefined, v: undefined }
          : { ...msg, value };
      }
      default:
        return msg;
    }
  }

  private scopeFor(peerId: string, rtype: string, id: string): ReadScope {
    return readScope(this.grantsFor(peerId), rtype, id, this.isDescendantOrWas);
  }

  /** Ephemeral channel selections implicitly include the retained channel —
   *  opting out of model updates is never what anyone means. */
  private channelOk(
    sub: SubscriptionRequest,
    channel: string,
    col: AnyCollection
  ): boolean {
    const selected = sub.channels;
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
      to: w.to,
      mid: w.mid,
      re: w.re,
    };
  }

  // --- addressed delivery + request/reply ------------------------------------------------
  //
  // The routing seam: `nextHop` is where a destination participant becomes a
  // link. Today that is the participant itself, else its server, else our
  // home; direct links (principle 8) slot in here without changing callers.

  private nextHop(to: string, exclude?: string): string | undefined {
    for (const c of [to, participantServer(to), this.upstream])
      if (c && c !== exclude && c !== this.id && this.links.has(c)) return c;
    return undefined;
  }

  /** Has this unstamped op already been applied (it came over another path)?
   *  Tracks, per origin, its current instance epoch and a window of sequence
   *  numbers. Ops from an older instance of the origin are dropped too. */
  private alreadySeen(env: OpEnvelope): boolean {
    if (env.q === undefined || env.qe === undefined) return false;
    let s = this.seen.get(env.origin);
    if (!s || s.qe !== env.qe) {
      if (s && env.qe < s.qe) return true;
      s = { qe: env.qe, max: 0, ids: new Set() };
      this.seen.delete(env.origin); // re-insert: Map order = recency
      this.seen.set(env.origin, s);
      if (this.seen.size > SEEN_ORIGINS) {
        const oldest = this.seen.keys().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
    }
    if (env.q <= s.max - SEEN_WINDOW || s.ids.has(env.q)) return true;
    s.ids.add(env.q);
    if (env.q > s.max) s.max = env.q;
    if (s.ids.size > SEEN_WINDOW)
      for (const q of s.ids) if (q <= s.max - SEEN_WINDOW) s.ids.delete(q);
    return false;
  }

  /** PeerCore: send `w` to `w.to` and await its reply. */
  request<T extends object>(
    c: Collection<T>,
    w: LocalWrite,
    timeoutMs: number
  ): Promise<RequestOutcome> {
    const to = w.to!;
    if (!this.nextHop(to)) return Promise.resolve({ status: 'unreachable' });
    const mid = uuid();
    return new Promise<RequestOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(mid);
        resolve({ status: 'timeout' });
      }, timeoutMs);
      this.pendingRequests.set(mid, { to, resolve, timer });
      this.localWrite(c, { ...w, mid });
    });
  }

  private handleReply(env: OpEnvelope): void {
    const p = this.pendingRequests.get(env.re!);
    // Only the addressee answers; a hop on the way may only report failure.
    if (!p || (env.origin !== p.to && env.err === undefined)) return;
    this.pendingRequests.delete(env.re!);
    clearTimeout(p.timer);
    p.resolve(
      env.err === 'unreachable'
        ? { status: 'unreachable' }
        : env.err !== undefined
          ? { status: 'error', reason: env.err }
          : { status: 'replied', data: env.data }
    );
  }

  private replyEnvelope(
    req: OpEnvelope,
    data: unknown,
    err?: string
  ): OpEnvelope {
    return {
      t: 'op',
      rtype: req.rtype,
      op: 'upsert',
      id: req.id,
      data,
      origin: this.id,
      ch: req.ch,
      to: req.origin,
      re: req.mid,
      err,
      qe: this.epoch,
      q: ++this.seq,
    };
  }

  private revalidateInSubs(): void {
    for (const [peerId, subs] of [...this.inSubs]) {
      const grants = this.grantsFor(peerId);
      const kept = subs.filter((s) =>
        grants.some((g) =>
          grantOverlapsSubscription(g, s.sub, this.isDescendantOrWas)
        )
      );
      if (kept.length) this.inSubs.set(peerId, kept);
      else this.inSubs.delete(peerId);
    }
  }

  private safeTaps(
    col: AnyCollection,
    change: Parameters<AnyCollection['runTaps']>[0]
  ): void {
    try {
      col.runTaps(change);
    } catch (e) {
      console.error('[mesh] tap failed:', e);
    }
  }

  private sendTo(peerId: string, msg: MeshMessage): void {
    this.transmit(peerId, msg);
  }

  private notifyStatus(): void {
    const s = this.status();
    for (const cb of [...this.statusObservers]) cb(s);
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

/** Dedup window per origin, and how many origins are tracked. */
const SEEN_WINDOW = 1024;
const SEEN_ORIGINS = 4096;

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
    before === undefined
      ? 'created'
      : after === undefined
        ? 'removed'
        : 'modified';
  return { rtype, id, op, before, after };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
