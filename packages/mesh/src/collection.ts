/**
 * Collection — the typed, symmetric data API over one rtype's replica.
 *
 * Public surface: id + tree reads, channel-tagged writes (create / update /
 * set / remove), hydration puts, and observation. All wire concerns (routing,
 * acks, grants) live in the peer; the collection owns the replica, validation,
 * and observer notification.
 *
 * Documents must carry a string `id` field — it is the replica key.
 */
import type { HLC } from '@vspark/shared/sync';
import type { HlcClock } from './clock.js';
import type { ChannelRegistry } from './channels.js';
import { Replica, type AppliedChange, type ApplyMeta } from './replica.js';
import type { DocOp } from './wire.js';

export type WriteOutcome =
  | { status: 'acked' }
  | { status: 'corrected'; value: unknown }
  | { status: 'rejected'; reason: string; current?: unknown }
  | { status: 'reverted' }
  | { status: 'unguarded' };

export interface WriteHandle {
  ack: Promise<WriteOutcome>;
}

export interface WriteOpts {
  channel?: string;
}

export interface CollectionConfig<T extends object> {
  /** Containment feed for tree reads + descendant-scoped grants. */
  parent?: (doc: T) => { rtype: string; id: string } | null;
  /** Validates/normalizes INCOMING data (remote ops and local writes alike).
   *  Throw to reject. The RETURN VALUE is what gets applied — returning a
   *  transformed value (clamping, normalization) is how the authority issues
   *  ack corrections. */
  validate?: (data: unknown) => T;
  /** Allowed channels (default ['committed', 'preview']). At most one may be
   *  retained; a collection with none is a pure stream. */
  channels?: string[];
  /** Ack authority: 'self' on the home peer, the home's peer id elsewhere. */
  authority?: 'self' | string;
}

export type Selector = string | { subtree: string } | '**';

/** Local write descriptor handed to the peer for orchestration. */
export interface LocalWrite {
  op: DocOp;
  id: string;
  /** single-path patch target; undefined = merge-patch / whole-doc. */
  path?: string;
  data?: unknown;
  channel: string;
  /** hydration: apply with this restored stamp; never acked; taps skip it. */
  hydrateV?: HLC;
}

/** The slice of the peer a collection needs (implemented by MeshPeer). */
export interface PeerCore {
  readonly id: string;
  readonly clock: HlcClock;
  readonly channels: ChannelRegistry;
  localWrite<T extends object>(col: Collection<T>, w: LocalWrite): WriteHandle;
  connected(peerId: string): boolean;
  childrenIds(id: string, rtype: string): string[];
  subtreeIds(rootId: string): string[];
  parentIdOf(id: string): string | null;
  isDescendant(childId: string, ancestorId: string): boolean;
  indexUpsert(rtype: string, id: string, parentId: string | null): void;
  indexRemove(id: string): void;
}

interface Observer<T> {
  sel: Selector;
  cb: (change: AppliedChange<T>) => void;
}

export class Collection<T extends object> {
  /** @internal */
  readonly replica = new Replica<T>();
  /** @internal */
  readonly retainedChannel: string | undefined;
  /** @internal */
  readonly allowedChannels: readonly string[];
  private readonly observers: Observer<T>[] = [];
  private readonly taps: ((change: AppliedChange<T>) => void)[] = [];

  constructor(
    private readonly peer: PeerCore,
    readonly rtype: string,
    readonly cfg: CollectionConfig<T>
  ) {
    this.allowedChannels = cfg.channels ?? ['committed', 'preview'];
    this.retainedChannel = peer.channels.retainedOf(this.allowedChannels);
  }

  // --- reads -----------------------------------------------------------------

  get(id: string): T | undefined {
    return this.replica.get(id);
  }

  all(): T[] {
    return this.replica.ids().map((id) => this.replica.get(id) as T);
  }

  children(id: string): T[] {
    return this.peer
      .childrenIds(id, this.rtype)
      .map((cid) => this.replica.get(cid))
      .filter((d): d is T => d !== undefined);
  }

  /** Docs of THIS collection within the (cross-type) subtree under `rootId`,
   *  including the root itself when it belongs to this collection. */
  subtree(rootId: string): T[] {
    return this.peer
      .subtreeIds(rootId)
      .map((sid) => this.replica.get(sid))
      .filter((d): d is T => d !== undefined);
  }

  // --- writes ----------------------------------------------------------------

  create(doc: T, opts?: WriteOpts): WriteHandle {
    return this.peer.localWrite(this, {
      op: 'upsert',
      id: this.idOf(doc),
      data: doc,
      channel: this.writeChannel(opts),
    });
  }

  /** Merge-patch: leaves of `partial` are applied under one stamp. */
  update(id: string, partial: object, opts?: WriteOpts): WriteHandle {
    return this.peer.localWrite(this, {
      op: 'patch',
      id,
      data: partial,
      channel: this.writeChannel(opts),
    });
  }

  /** Dotted-path write. `path === ''` replaces the whole doc. */
  set(id: string, path: string, value: unknown, opts?: WriteOpts): WriteHandle {
    return this.peer.localWrite(this, {
      op: path === '' ? 'upsert' : 'patch',
      id,
      path: path === '' ? undefined : path,
      data: value,
      channel: this.writeChannel(opts),
    });
  }

  remove(id: string, opts?: WriteOpts): WriteHandle {
    return this.peer.localWrite(this, {
      op: 'remove',
      id,
      channel: this.writeChannel(opts),
    });
  }

  /** Hydrate one doc with its restored stamp (durable peers, boot). */
  put(doc: T, opts: { v: HLC }): void {
    this.peer.localWrite(this, {
      op: 'upsert',
      id: this.idOf(doc),
      data: doc,
      channel: this.requireRetained('put'),
      hydrateV: opts.v,
    });
  }

  /** Hydrate one tombstone with its restored stamp. */
  putTombstone(id: string, v: HLC): void {
    this.peer.localWrite(this, {
      op: 'remove',
      id,
      channel: this.requireRetained('putTombstone'),
      hydrateV: v,
    });
  }

  // --- observation -------------------------------------------------------------

  observe(sel: Selector, cb: (change: AppliedChange<T>) => void): () => void {
    const o: Observer<T> = { sel, cb };
    this.observers.push(o);
    return () => {
      const i = this.observers.indexOf(o);
      if (i >= 0) this.observers.splice(i, 1);
    };
  }

  /** Retained-channel applies that represent NEW committed state — the
   *  persistence tap. Skips hydration puts (data came FROM the store) and
   *  local reverts. Runs for local AND remote origins: on the authority a
   *  local (e.g. REST-initiated) write must persist exactly like a remote one.
   *  A throw here nacks the guarded write that caused it. */
  onCommitted(cb: (change: AppliedChange<T>) => void): () => void {
    this.taps.push(cb);
    return () => {
      const i = this.taps.indexOf(cb);
      if (i >= 0) this.taps.splice(i, 1);
    };
  }

  canWrite(): boolean {
    const a = this.cfg.authority ?? 'self';
    return a === 'self' || this.peer.connected(a);
  }

  // --- internal (peer-facing) ---------------------------------------------------

  /** @internal Apply one op to the replica; updates containment; notifies
   *  observers (NOT taps — the peer runs those to control ack ordering). */
  applyOp(
    op: DocOp,
    id: string,
    path: string | undefined,
    data: unknown,
    v: HLC | undefined,
    meta: ApplyMeta
  ): AppliedChange<T> | null {
    if (v === undefined) {
      const change = this.replica.ephemeral(id, path ?? '', data, meta);
      this.notify(change);
      return change;
    }
    let change: AppliedChange<T> | null;
    let preChain: string[] | undefined;
    if (op === 'remove') {
      preChain = this.ancestorChain(id);
      change = this.replica.remove(id, v, meta);
      if (change) this.peer.indexRemove(id);
    } else if (op === 'upsert') {
      change = this.replica.upsert(id, data as T, v, meta);
    } else {
      change =
        path !== undefined && path !== ''
          ? this.replica.patch(id, path, data, v, meta)
          : this.replica.mergePatch(id, data, v, meta);
    }
    if (!change) return null;
    if (op !== 'remove') {
      const doc = this.replica.raw(id);
      if (doc !== undefined)
        this.peer.indexUpsert(this.rtype, id, this.cfg.parent?.(doc)?.id ?? null);
    }
    this.notify(change, preChain);
    return change;
  }

  /** @internal Run persistence taps; a throw propagates to the caller (the
   *  peer turns it into a nack + rollback for guarded writes). */
  runTaps(change: AppliedChange<T>): void {
    if (
      change.channel !== this.retainedChannel ||
      change.op === 'ephemeral' ||
      change.hydrate ||
      change.restored
    )
      return;
    for (const tap of this.taps) tap(change);
  }

  /** @internal Validation hook; returns the (possibly transformed) value. */
  validateDoc(data: unknown): T {
    return this.cfg.validate ? this.cfg.validate(data) : (data as T);
  }

  /** @internal Notify observers of a (possibly restored) change. */
  notify(change: AppliedChange<T>, preChain?: string[]): void {
    for (const o of [...this.observers]) {
      if (o.sel === '**') o.cb(change);
      else if (typeof o.sel === 'string') {
        if (o.sel === change.id) o.cb(change);
      } else {
        const root = o.sel.subtree;
        const inSubtree = preChain
          ? preChain.includes(root)
          : change.id === root || this.peer.isDescendant(change.id, root);
        if (inSubtree) o.cb(change);
      }
    }
  }

  /** @internal `id` + its ancestor chain (for routing/observers of removes,
   *  captured before the containment entry disappears). */
  ancestorChain(id: string): string[] {
    const chain = [id];
    const seen = new Set<string>([id]);
    let cur: string | null = this.peer.parentIdOf(id);
    while (cur && !seen.has(cur)) {
      chain.push(cur);
      seen.add(cur);
      cur = this.peer.parentIdOf(cur);
    }
    return chain;
  }

  private idOf(doc: T): string {
    const id = (doc as { id?: unknown }).id;
    if (typeof id !== 'string')
      throw new Error(`${this.rtype}: documents must carry a string 'id'`);
    return id;
  }

  private writeChannel(opts?: WriteOpts): string {
    const ch = opts?.channel ?? this.retainedChannel;
    if (!ch)
      throw new Error(
        `${this.rtype}: no retained channel — pass an explicit { channel }`
      );
    if (!this.allowedChannels.includes(ch))
      throw new Error(`${this.rtype}: channel '${ch}' not allowed`);
    return ch;
  }

  private requireRetained(what: string): string {
    if (!this.retainedChannel)
      throw new Error(`${this.rtype}: ${what} requires a retained channel`);
    return this.retainedChannel;
  }
}
