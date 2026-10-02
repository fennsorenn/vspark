import type { Blendshapes } from '@vspark/shared/signal';

export interface BlendshapeInterceptorEntry {
  priority: number;
  /** Stable secondary sort key — behavior registration order. */
  registeredAt: number;
  fire: (nodeId: string, blendshapes: Blendshapes, priority: number) => void;
}

/**
 * Registry of active blendshape interceptors, keyed by scene node ID.
 *
 * The exact mirror of `poseInterceptorRegistry`, for the blendshape half of the
 * broadcast frame. The BroadcastBus queries this after composing a scene node's
 * blendshape slots; if interceptors exist it hands the merged frame to the
 * highest-priority one instead of emitting directly, and
 * `BlendshapesInterceptorBroadcast` calls `advance()` to continue or terminate
 * the chain.
 */
class BlendshapeInterceptorRegistry {
  private readonly _chains = new Map<string, BlendshapeInterceptorEntry[]>();
  private _seq = 0;

  register(
    nodeId: string,
    entry: Omit<BlendshapeInterceptorEntry, 'registeredAt'>
  ): () => void {
    const full: BlendshapeInterceptorEntry = {
      ...entry,
      registeredAt: this._seq++,
    };
    let chain = this._chains.get(nodeId);
    if (!chain) {
      chain = [];
      this._chains.set(nodeId, chain);
    }
    chain.push(full);
    chain.sort(_byPriorityDesc);
    return () => {
      const c = this._chains.get(nodeId);
      if (!c) return;
      const idx = c.indexOf(full);
      if (idx !== -1) c.splice(idx, 1);
      if (c.length === 0) this._chains.delete(nodeId);
    };
  }

  /**
   * Start the chain for a given nodeId + blendshapes.
   * Returns true if at least one interceptor was fired (caller should NOT broadcast).
   * Returns false if no interceptors are registered (caller should broadcast normally).
   */
  start(nodeId: string, blendshapes: Blendshapes): boolean {
    const chain = this._chains.get(nodeId);
    if (!chain || chain.length === 0) return false;
    chain[0].fire(nodeId, blendshapes, chain[0].priority);
    return true;
  }

  /**
   * Called by BlendshapesInterceptorBroadcast to advance to the next interceptor
   * in the chain after `currentPriority`, or perform the final broadcast.
   */
  advance(
    nodeId: string,
    currentPriority: number,
    blendshapes: Blendshapes,
    broadcast: (nodeId: string, blendshapes: Blendshapes) => void
  ): void {
    const chain = this._chains.get(nodeId);
    const next = chain?.find((e) => e.priority < currentPriority);
    if (next) {
      next.fire(nodeId, blendshapes, next.priority);
    } else {
      broadcast(nodeId, blendshapes);
    }
  }
}

function _byPriorityDesc(
  a: BlendshapeInterceptorEntry,
  b: BlendshapeInterceptorEntry
): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return a.registeredAt - b.registeredAt;
}

export const blendshapeInterceptorRegistry =
  new BlendshapeInterceptorRegistry();
