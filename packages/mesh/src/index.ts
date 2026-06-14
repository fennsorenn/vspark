/**
 * @vspark/mesh — schema-agnostic replicated store.
 *
 * In-memory replica + pub/sub on every peer; no durability in the package
 * (durable peers hydrate via `put` and persist via `onCommitted` taps).
 * Design: dev-notes/plans/mesh-sync-refactor.md §8.
 */
export { createMeshPeer, MeshPeer, MeshValue } from './peer.js';
export type {
  MeshPeerConfig,
  MeshStatus,
  MeshSubscription,
} from './peer.js';
export { Collection } from './collection.js';
export type {
  CollectionConfig,
  Selector,
  WriteHandle,
  WriteOpts,
  WriteOutcome,
} from './collection.js';
export { ChannelRegistry, BUILTIN_CHANNELS } from './channels.js';
export type { ChannelProps } from './channels.js';
export { Replica } from './replica.js';
export type { AppliedChange, ApplyMeta, DocState } from './replica.js';
export { HlcClock } from './clock.js';
export type {
  MeshTransport,
  PeerLink,
  TransportHandlers,
} from './transport.js';
export type {
  AckMsg,
  DocOp,
  MeshMessage,
  OpEnvelope,
  SubscribeMsg,
  SubOkMsg,
} from './wire.js';
export { createLoopbackPair } from './loopback.js';
export type { LoopbackPair } from './loopback.js';
export {
  deepEqual,
  flattenToLeaves,
  getPath,
  setPath,
} from './paths.js';
// Re-exported for convenience — the grant/subscription model is shared.
export {
  compareHLC,
  type Grant,
  type HLC,
  type Subscription,
} from '@vspark/shared/sync';
