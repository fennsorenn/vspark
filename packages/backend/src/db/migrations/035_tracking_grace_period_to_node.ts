// 035_tracking_grace_period_to_node: move the tracking-loss grace period from
// the per-behavior config onto the avatar node.
//
//   behaviors.config.poseTimeout  ->  scene_nodes.properties.trackingGracePeriod
//
// The value describes the avatar's behaviour ("how long do I hold the pose
// before falling back to idle"), not the receiver's, and it belongs next to
// `blendTransitionTime` — that one says how *fast* the transition runs, this one
// says *when* it starts. Keeping it per-behavior also allowed two tracking
// sources on one avatar to disagree, which the frontend had to paper over by
// taking the max across behaviors.
//
// Where several behaviors on the same node carry a value, the largest wins: the
// grace period is a tolerance, and the most forgiving setting is the safest
// merge (it never makes an avatar drop to idle sooner than the user asked).
//
// Note: `poseTimeout` was never read by anything before the grace period landed
// — it was written to the DB and ignored — so nothing here restores lost
// behaviour; it only preserves the intent of anyone who had set the field.
//
// Idempotent: the source key is deleted as it is lifted, so a re-run finds
// nothing. Nodes that already carry `trackingGracePeriod` are left alone.

interface Db {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): void;
  };
}

type Json = Record<string, unknown>;

function parseObj(raw: unknown): Json | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Json)
      : null;
  } catch {
    return null;
  }
}

export default function migrate(db: Db): void {
  let behaviors: Record<string, unknown>[];
  try {
    behaviors = db
      .prepare('SELECT id, node_id, config FROM behaviors')
      .all();
  } catch {
    return; // table absent on this DB — nothing to do
  }

  // node_id → the largest poseTimeout found across that node's behaviors.
  const perNode = new Map<string, number>();

  for (const row of behaviors) {
    const cfg = parseObj(row.config);
    if (!cfg || !('poseTimeout' in cfg)) continue;

    const value = cfg.poseTimeout;
    const nodeId = row.node_id;
    if (typeof value === 'number' && value > 0 && typeof nodeId === 'string') {
      perNode.set(nodeId, Math.max(perNode.get(nodeId) ?? 0, value));
    }

    // Strip the key regardless of whether it was usable — leaving a dead
    // setting behind is what made this ambiguous in the first place.
    delete cfg.poseTimeout;
    db.prepare('UPDATE behaviors SET config = ? WHERE id = ?').run(
      JSON.stringify(cfg),
      row.id
    );
  }

  if (perNode.size === 0) return;

  for (const [nodeId, seconds] of perNode) {
    let nodeRow: Record<string, unknown> | undefined;
    try {
      nodeRow = db
        .prepare('SELECT id, properties FROM scene_nodes WHERE id = ?')
        .all(nodeId)[0];
    } catch {
      continue;
    }
    if (!nodeRow) continue; // behavior outlived its node — nothing to write to

    const props = parseObj(nodeRow.properties) ?? {};
    if ('trackingGracePeriod' in props) continue; // already set — don't clobber
    props.trackingGracePeriod = seconds;
    db.prepare('UPDATE scene_nodes SET properties = ? WHERE id = ?').run(
      JSON.stringify(props),
      nodeId
    );
  }
}
