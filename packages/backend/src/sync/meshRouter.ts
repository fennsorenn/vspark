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

/** A participant's transport link — sends one envelope to that participant. */
export type ParticipantLink = (env: SyncEnvelope) => void;

export class MeshRouter {
  private readonly hub: SubscriptionHub;
  private readonly links = new Map<string, ParticipantLink>();

  constructor(grantsFor: (participant: string) => Grant[], isDescendant: IsDescendant) {
    this.hub = new SubscriptionHub(grantsFor, isDescendant);
  }

  /** Register/replace a participant's transport link. */
  attach(participant: string, link: ParticipantLink): void {
    this.links.set(participant, link);
  }

  /** Drop a participant (link + all its subscriptions). */
  detach(participant: string): void {
    this.links.delete(participant);
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

  /** Fan an envelope out to every subscribed, attached participant. */
  publish(env: SyncEnvelope): void {
    for (const participant of this.hub.route(env.key))
      this.links.get(participant)?.(env);
  }

  subscriptionsOf(participant: string): Subscription[] {
    return this.hub.subscriptionsOf(participant);
  }

  /** Participants holding at least one admitted subscription. */
  participants(): string[] {
    return this.hub.participants();
  }
}
