/**
 * Named delivery channels.
 *
 * A channel declares HOW a write travels and what happens to it: transport
 * reliability, HLC stamping (and with it per-path LWW + tombstones), retention
 * (stored in the replica, carried in snapshots, persisted by durable peers),
 * and ack guarding. Subscriptions select channels — a peer that doesn't
 * subscribe to an ephemeral channel never sees that traffic.
 *
 * Channels are delivery semantics, NOT data semantics: composition of multiple
 * sources driving one value (base / clip / override) is an app-level layer
 * convention on sub-paths, never a channel. See
 * dev-notes/plans/mesh-sync-refactor.md §8.3.
 */

export interface ChannelProps {
  transport: 'reliable' | 'lossy';
  /** HLC stamps + per-path LWW + tombstones. Required when `retained`. */
  stamped: boolean;
  /** Stored in the replica + snapshots; at most one retained channel per
   *  collection. Unretained channels are per-key ephemeral overlays. */
  retained: boolean;
  /** Writes are guarded by the collection authority's three-outcome ack.
   *  Only valid on a retained channel. */
  ack?: 'authority';
}

export const BUILTIN_CHANNELS: Readonly<Record<string, ChannelProps>> = {
  committed: { transport: 'reliable', stamped: true, retained: true, ack: 'authority' },
  preview: { transport: 'lossy', stamped: false, retained: false },
};

export class ChannelRegistry {
  private readonly map = new Map<string, ChannelProps>(
    Object.entries(BUILTIN_CHANNELS)
  );

  define(name: string, props: ChannelProps): void {
    if (props.retained && !props.stamped)
      throw new Error(
        `channel '${name}': retained channels must be stamped (LWW needs versions)`
      );
    if (props.ack && (!props.retained || props.transport !== 'reliable'))
      throw new Error(
        `channel '${name}': ack guarding requires a reliable retained channel`
      );
    this.map.set(name, props);
  }

  get(name: string): ChannelProps | undefined {
    return this.map.get(name);
  }

  /** Validate a collection's channel set; returns its retained channel (if any). */
  retainedOf(names: readonly string[]): string | undefined {
    let retained: string | undefined;
    for (const n of names) {
      const p = this.map.get(n);
      if (!p) throw new Error(`unknown channel '${n}'`);
      if (p.retained) {
        if (retained !== undefined)
          throw new Error(
            `collections allow at most one retained channel ('${retained}' and '${n}')`
          );
        retained = n;
      }
    }
    return retained;
  }
}
