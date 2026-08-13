import { getDb } from '../db/index.js';

/** Fallback when the avatar node carries no `trackingGracePeriod`. */
export const DEFAULT_TRACKING_GRACE_MS = 2000;

/**
 * How long a tracking dropout is tolerated before the source reports a loss and
 * the avatar falls back to its idle animation.
 *
 * The value lives on the avatar node (`scene_nodes.properties.trackingGracePeriod`,
 * in seconds), not on the behavior: it describes the avatar's behaviour, sits next
 * to `blendTransitionTime` (when the transition starts vs. how fast it runs), and
 * being per-node means two tracking sources on one avatar cannot disagree about
 * it. Moved there from the per-behavior config in migration 035.
 *
 * Read through rather than cached — tracking sources call this from their timeout
 * sweep (a few times a second, per receiver), and a stale cache would silently
 * ignore edits made while a source is live. Revisit if the sweep ever gets hot.
 */
export function trackingGraceMs(
  sceneNodeId: string | undefined,
  fallbackMs = DEFAULT_TRACKING_GRACE_MS
): number {
  if (!sceneNodeId) return fallbackMs;
  try {
    const row = getDb()
      .prepare('SELECT properties FROM scene_nodes WHERE id = ?')
      .get(sceneNodeId) as { properties: string } | undefined;
    if (!row?.properties) return fallbackMs;
    const parsed = JSON.parse(row.properties) as {
      trackingGracePeriod?: number;
    };
    const secs = parsed.trackingGracePeriod;
    return typeof secs === 'number' && secs > 0 ? secs * 1000 : fallbackMs;
  } catch {
    return fallbackMs; // node gone or properties unparseable — use the default
  }
}
