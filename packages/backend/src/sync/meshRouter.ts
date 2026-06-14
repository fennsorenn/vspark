/**
 * Mesh pub/sub router (transport slice). Composes the grant store + the
 * {@link SubscriptionHub} + a per-participant transport registry into the
 * namespace pub/sub the permissioned-sync-mesh plan describes:
 *
 *   - participants `attach` a transport link (WS for a local client, the
 *     ServerMesh for a remote backend, WebRTC for a remote browser) — the router
 *     is transport-agnostic; it only knows `send(participant, env)`.
 *   - `subscribe(participant, namespace)` is admitted iff a read grant covers it
 *     (source-side admission, no per-write recheck).
 *   - `publish(env)` fans an envelope out to exactly the participants whose
 *     admitted interest matches its key.
 *   - `revalidate` evicts subscriptions whose covering grant was revoked.
 *
 * Additive: this is the routing core the WebRTC edge + the object-share
 * migration plug into. See dev-notes/plans/permissioned-sync-mesh.md.
 */
import {
  SubscriptionHub,
  type Grant,
  type IsDescendant,
  type Subscription,
  type SyncEnvelope,
} from '@vspark/shared/sync';

/** A participant's reliable transport link — sends one envelope. */
export type ParticipantLink = (env: SyncEnvelope) => void;
/** A participant's lossy transport link — sends one stream frame (dropped if the
 *  channel can't keep up; used for high-frequency pose/transform). */
export type StreamLink = (frame: Record<string, unknown>) => void;

export class MeshRouter {
  private readonly hub: SubscriptionHub;
  private readonly links = new Map<string, ParticipantLink>();
  private readonly streamLinks = new Map<string, StreamLink>();

  constructor(grantsFor: (participant: string) => Grant[], isDescendant: IsDescendant) {
    this.hub = new SubscriptionHub(grantsFor, isDescendant);
  }

  /** Register/replace a participant's transport links (reliable + optional lossy). */
  attach(participant: string, link: ParticipantLink, streamLink?: StreamLink): void {
    this.links.set(participant, link);
    if (streamLink) this.streamLinks.set(participant, streamLink);
  }

  /** Drop a participant (links + all its subscriptions). */
  detach(participant: string): void {
    this.links.delete(participant);
    this.streamLinks.delete(participant);
    this.hub.removeParticipant(participant);
  }

  /** Admit a subscription iff a read grant covers it. Returns whether admitted. */
  subscribe(participant: string, sub: Subscription): boolean {
    return this.hub.subscribe(participant, sub);
  }

  unsubscribe(participant: string, sub: Subscription): void {
    this.hub.unsubscribe(participant, sub);
  }

  /** Re-check a participant's subscriptions against current grants; evict any no
   *  longer covered (call on grant revoke). Returns the dropped subscriptions. */
  revalidate(participant: string): Subscription[] {
    return this.hub.revalidate(participant);
  }

  /** Fan a reliable envelope out to every subscribed, attached participant. */
  publish(env: SyncEnvelope): void {
    for (const participant of this.hub.route(env.key))
      this.links.get(participant)?.(env);
  }

  /** Fan a lossy stream frame out to every participant subscribed to `key`, over
   *  their lossy link (high-frequency pose / transform). */
  publishStream(key: string, frame: Record<string, unknown>): void {
    for (const participant of this.hub.route(key))
      this.streamLinks.get(participant)?.(frame);
  }

  subscriptionsOf(participant: string): Subscription[] {
    return this.hub.subscriptionsOf(participant);
  }

  /** Participants holding at least one admitted subscription. */
  participants(): string[] {
    return this.hub.participants();
  }
}
