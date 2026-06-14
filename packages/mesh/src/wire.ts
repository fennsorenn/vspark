/**
 * Wire protocol — the messages peers exchange. JSON-serializable; transports
 * carry them opaquely. Reuses the HLC + subscription shapes from
 * @vspark/shared/sync.
 */
import type { HLC, Subscription } from '@vspark/shared/sync';

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
}

/** Subscription interest + optional channel selection. Selecting an ephemeral
 *  channel implicitly includes the collection's retained channel. */
export interface SubscribeMsg {
  t: 'sub';
  subId: string;
  sub: Subscription & { channels?: string[] };
}

export interface SnapshotDoc {
  rtype: string;
  id: string;
  doc: unknown;
  v?: HLC;
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

export type MeshMessage =
  | OpEnvelope
  | SubscribeMsg
  | SubOkMsg
  | SubErrMsg
  | UnsubMsg
  | AckMsg
  | PingMsg
  | PongMsg;
