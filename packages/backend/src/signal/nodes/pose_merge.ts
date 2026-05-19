import { SignalNode, listPort, valuePort, NormalizedPose } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'

@SignalNode({
  label:       'Pose Merge',
  description: 'Merges multiple partial NormalizedPoses into one. Later inputs override earlier ones for any overlapping bones. Identity quaternions (0,0,0,1) from partial poses are skipped.',
  tags:        ['pose'],
  color:       '#5b7a3a',
})
export class PoseMerge {
  static readonly kind        = 'pose_merge'
  static readonly inputPorts  = [listPort('poses', 'NormalizedPose')] as const
  static readonly outputPorts = [valuePort('pose', 'NormalizedPose')] as const

  static execute(
    inputs:  InputsOf<typeof PoseMerge>,
    _config: unknown,
    _ctx:    NodeExecutionContext,
  ): OutputsOf<typeof PoseMerge> {
    const poses = inputs.poses as NormalizedPose[]
    if (!poses?.length) return { pose: new NormalizedPose() }

    const merged = new Map(poses[0].entries())
    for (let i = 1; i < poses.length; i++) {
      for (const [bone, q] of poses[i].entries()) {
        // Skip identity quaternions — they indicate "no data for this bone"
        if (q.magnitudeSquared > 1e-9 && !(q.x === 0 && q.y === 0 && q.z === 0 && q.w === 1)) {
          merged.set(bone, q)
        }
      }
    }
    return { pose: new NormalizedPose(merged) }
  }
}
