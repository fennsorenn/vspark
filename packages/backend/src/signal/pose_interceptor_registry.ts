import type { NormalizedPose } from '@vspark/shared/signal';

export interface InterceptorEntry {
  priority: number;
  /** Stable secondary sort key — component registration order. */
  registeredAt: number;
  fire: (nodeId: string, pose: NormalizedPose, priority: number) => void;
}

/**
 * Registry of active pose interceptors, keyed by scene node ID.
 *
 * PoseBroadcast queries this before sending; if interceptors exist it hands
 * off to the highest-priority one instead of broadcasting directly.
 * PoseInterceptorBroadcast calls advance() to continue or terminate the chain.
 */
class PoseInterceptorRegistry {
  private readonly _chains = new Map<string, InterceptorEntry[]>();
  private _seq = 0;

  register(
    nodeId: string,
    entry: Omit<InterceptorEntry, 'registeredAt'>
  ): () => void {
    const full: InterceptorEntry = { ...entry, registeredAt: this._seq++ };
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
   * Start the chain for a given nodeId + pose.
   * Returns true if at least one interceptor was fired (caller should NOT broadcast).
   * Returns false if no interceptors are registered (caller should broadcast normally).
   */
  start(nodeId: string, pose: NormalizedPose): boolean {
    const chain = this._chains.get(nodeId);
    if (!chain || chain.length === 0) return false;
    chain[0].fire(nodeId, pose, chain[0].priority);
    return true;
  }

  /**
   * Called by PoseInterceptorBroadcast to advance to the next interceptor in
   * the chain after `currentPriority`, or perform the final WebSocket broadcast.
   */
  advance(
    nodeId: string,
    currentPriority: number,
    pose: NormalizedPose,
    broadcast: (nodeId: string, pose: NormalizedPose) => void
  ): void {
    const chain = this._chains.get(nodeId);
    // Find first entry with strictly lower priority than currentPriority.
    const next = chain?.find((e) => e.priority < currentPriority);
    if (next) {
      next.fire(nodeId, pose, next.priority);
    } else {
      broadcast(nodeId, pose);
    }
  }
}

function _byPriorityDesc(a: InterceptorEntry, b: InterceptorEntry): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return a.registeredAt - b.registeredAt;
}

export const poseInterceptorRegistry = new PoseInterceptorRegistry();
