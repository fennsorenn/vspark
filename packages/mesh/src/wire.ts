/**
 * Wire protocol — the messages peers exchange. JSON-serializable; transports
 * carry them opaquely. Reuses the HLC + subscription shapes from
 * @vspark/shared/sync.
 */
import type { Grant, HLC, Subscription } from '@vspark/shared/sync';

export type DocOp = 'upsert' | 'patch' | 'remove';

/** One write. `op:'patch'` with a `path` sets that path; without a path it is
 *  a merge-patch (`data` is a partial flattened to leaves on apply, all leaves
 *  sharing one stamp). Unstamped (`v` absent) writes are ephemeral overlays. */
export interface OpEnvelope {
  t: 'op';
  rtype: string;
  op: DocOp;
  id: string;
  path?: string;
  data?: unknown;
  v?: HLC;
  /** originating participant (loop suppression; HLC tiebreak id). */
  origin: string;
  /** channel name. */
  ch: string;
  /** opId — present when the writer wants the authority's ack. */
  ack?: string;
  /** Unstamped ops only: the origin's instance epoch and a per-instance
   *  sequence number. Receivers drop an (origin, epoch, seq) they have already
   *  seen, so a message that reaches them over two paths applies once. */
  qe?: number;
  q?: number;
  /** Addressed delivery: the one participant this op is for. Routed toward it
   *  hop by hop and applied only there (unstamped channels only). */
  to?: string;
  /** Request id: the sender awaits a reply carrying it as `re`. */
  mid?: string;
  /** Reply to request `re`. Resolves the requester's pending request and is
   *  never applied to a replica. */
  re?: string;
  /** Reply only: why the request could not be answered (e.g. 'unreachable'). */
  err?: string;
}

/** Subscription interest + optional channel selection. Selecting an ephemeral
 *  channel implicitly includes the collection's retained channel. */
export type SubscriptionRequest = Subscription & {
  channels?: string[];
};

export interface SubscribeMsg {
  t: 'sub';
  subId: string;
  sub: SubscriptionRequest;
}

export interface SnapshotDoc {
  rtype: string;
  id: string;
  doc: unknown;
  /** The document's root stamp. */
  v?: HLC;
  /** Stamps of fields written after the root (per-path LWW). Without them a
   *  field edit newer than the root — one a subscriber missed while offline —
   *  would lose to the subscriber's copy of the whole document. */
  paths?: Record<string, HLC>;
}

export interface SnapshotTombstone {
  rtype: string;
  id: string;
  v: HLC;
}

export interface SubOkMsg {
  t: 'sub_ok';
  subId: string;
  docs: SnapshotDoc[];
  tombstones: SnapshotTombstone[];
  /** authority clock at snapshot time. */
  watermark: HLC;
}

export interface SubErrMsg {
  t: 'sub_err';
  subId: string;
  reason: string;
}

/** The subscription is held, not refused: no grant covers it yet. It is
 *  admitted — and answered with `sub_ok` — when one appears. */
export interface SubWaitMsg {
  t: 'sub_wait';
  subId: string;
}

/** A grant as delivered to the participant it concerns, with the peer that
 *  issued it. */
export type DeliveredGrant = Grant & {
  grantor: string;
  /** Issued by the recipient's own server to someone else: the recipient
   *  serves that participant on its server's behalf (a direct link). */
  delegated?: boolean;
};

/** Grant delivery: everything the sender knows that concerns the recipient,
 *  replacing what it delivered before. Sent when the link comes up and on
 *  every change. A peer delivers the grants it issued that cover the
 *  recipient; to its own participants also the grants it received from
 *  others that cover them, and (delegated) the grants it issued to others. */
export interface GrantsMsg {
  t: 'grants';
  grants: DeliveredGrant[];
}

export interface UnsubMsg {
  t: 'unsub';
  subId: string;
}

/** Three-outcome ack from the authority. `rejected` carries the authority's
 *  current value (+stamp) so the writer converges without a re-fetch;
 *  `corrected` carries the value the authority applied instead (it also
 *  broadcasts that correction as its own stamped write). */
export interface AckMsg {
  t: 'ack';
  opId: string;
  status: 'acked' | 'corrected' | 'rejected';
  value?: unknown;
  v?: HLC;
  reason?: string;
  /** The document the ack is about. Lets the egress filter project `value`
   *  down to what the requester may read (a rejected writer must not learn a
   *  value it has no read grant for). */
  rtype?: string;
  id?: string;
}

/** Clock-sync probe (NTP-style): the receiver answers immediately with a
 *  pong echoing `tSent` plus its own receive-time clock reading. */
export interface PingMsg {
  t: 'ping';
  seq: number;
  tSent: number;
}

export interface PongMsg {
  t: 'pong';
  seq: number;
  tSent: number;
  tRemote: number;
}

/** Link state: the participants the sender currently reaches over a direct
 *  link (principle 8). Sent to its home on every change, so the home stops
 *  relaying lossy traffic the sender already receives first-hand. */
export interface LinksMsg {
  t: 'links';
  peers: string[];
}

export type MeshMessage =
  | LinksMsg
  | GrantsMsg
  | SubWaitMsg
  | OpEnvelope
  | SubscribeMsg
  | SubOkMsg
  | SubErrMsg
  | UnsubMsg
  | AckMsg
  | PingMsg
  | PongMsg;

const encoded = new WeakMap<object, string>();

/** Serialize a message for a transport. Cached per message object: a fan-out
 *  hands the SAME envelope to every recipient whose grants let it see all of
 *  it (egress returns the message unchanged), so a frame sent to ten tabs is
 *  serialized once, not ten times. Transports should use this rather than
 *  calling JSON.stringify themselves. Messages are never mutated after
 *  sending, which is what makes the cache safe. */
export function encode(msg: MeshMessage): string {
  let s = encoded.get(msg);
  if (s === undefined) {
    s = JSON.stringify(msg);
    encoded.set(msg, s);
  }
  return s;
}
