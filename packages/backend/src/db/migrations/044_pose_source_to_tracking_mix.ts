// 044_pose_source_to_tracking_mix: replace the avatar's per-section
// "partial tracking" setting with the per-source Tracking Mix.
//
//   scene_nodes.properties.poseSource  ->  scene_nodes.properties.trackingMix
//
// poseSource held one { anim, track } pair per body section (head, gaze, body,
// arms, hands, legs). The Tracking Mix stores one weight per (source, bone):
//
//   - `anim`  becomes the `animation` source's weight on every bone of the
//             section (the animation layer stays a frontend concern);
//   - `track` scaled ALL tracking on the section, whichever behavior it came
//             from, so it becomes that weight on every bone of the section for
//             every bone-publishing behavior on the node.
//
// Only values other than 1 are written (1 is the mix default). A `track` value
// on a node with no bone-publishing behavior has nothing to attach to and is
// dropped — there was no tracking for it to scale.
//
// The section→bone map is frozen here rather than imported, so later changes
// to the live region map can't change what this migration did.
//
// Idempotent: poseSource is deleted as it is lifted. A node that already has a
// trackingMix keeps it (poseSource is still removed).

interface Db {
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): void;
  };
}

type Json = Record<string, unknown>;

const SECTION_BONES: Record<string, string[]> = {
  body: ['spine', 'chest', 'upperChest'],
  head: ['neck', 'head', 'jaw'],
  gaze: ['leftEye', 'rightEye'],
  arms: [
    'leftShoulder',
    'leftUpperArm',
    'leftLowerArm',
    'leftHand',
    'rightShoulder',
    'rightUpperArm',
    'rightLowerArm',
    'rightHand',
  ],
  legs: [
    'hips',
    'leftUpperLeg',
    'leftLowerLeg',
    'leftFoot',
    'leftToes',
    'rightUpperLeg',
    'rightLowerLeg',
    'rightFoot',
    'rightToes',
  ],
  hands: ['Thumb', 'Index', 'Middle', 'Ring', 'Little'].flatMap((f) =>
    ['left', 'right'].flatMap((side) =>
      (f === 'Thumb'
        ? ['Metacarpal', 'Proximal', 'Distal']
        : ['Proximal', 'Intermediate', 'Distal']
      ).map((seg) => `${side}${f}${seg}`)
    )
  ),
};

const BONE_SOURCE_KINDS = [
  'vmc_receiver',
  'ifacialmocap_receiver',
  'mediapipe_tracker',
  'breathing',
];

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

function weight(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const w = Math.max(0, Math.min(1, v));
  return Math.abs(w - 1) > 1e-6 ? w : null;
}

export default function migrate(db: Db): void {
  let nodes: Record<string, unknown>[];
  try {
    nodes = db.prepare('SELECT id, properties FROM scene_nodes').all();
  } catch {
    return;
  }

  for (const row of nodes) {
    const props = parseObj(row.properties);
    if (!props || !('poseSource' in props)) continue;
    const poseSource = props.poseSource as Json | null;
    delete props.poseSource;

    if (!props.trackingMix && poseSource && typeof poseSource === 'object') {
      let trackers: string[] = [];
      try {
        trackers = db
          .prepare(
            `SELECT id FROM behaviors WHERE node_id = ? AND kind IN (${BONE_SOURCE_KINDS.map(() => '?').join(',')}) ORDER BY rowid`
          )
          .all(row.id, ...BONE_SOURCE_KINDS)
          .map((r) => r.id as string);
      } catch {
        trackers = [];
      }

      const sources: Record<string, { bones: Record<string, number> }> = {};
      const put = (src: string, bones: string[], w: number) => {
        const s = (sources[src] ??= { bones: {} });
        for (const b of bones) s.bones[b] = w;
      };
      for (const [section, bones] of Object.entries(SECTION_BONES)) {
        const inf = poseSource[section] as Json | undefined;
        if (!inf || typeof inf !== 'object') continue;
        const anim = weight(inf.anim);
        if (anim !== null) put('animation', bones, anim);
        const track = weight(inf.track);
        if (track !== null) for (const id of trackers) put(id, bones, track);
      }
      if (Object.keys(sources).length) props.trackingMix = { sources };
    }

    db.prepare('UPDATE scene_nodes SET properties = ? WHERE id = ?').run(
      JSON.stringify(props),
      row.id
    );
  }
}
