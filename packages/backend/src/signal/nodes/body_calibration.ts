import {
  SignalNode, eventPort, valuePort,
  NormalizedPose, Quaternion,
} from '@vspark/shared/signal'
import type { VRMBoneName, InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'

interface CalibrationState {
  bodyOffsets: Record<string, [number, number, number, number]>
}

const EMPTY_STATE: CalibrationState = { bodyOffsets: {} }

export interface BodyCalibConfig {
  /**
   * Optional whitelist of VRM bone names this node captures and corrects.
   * When set, capture only stores offsets for listed bones, and apply only
   * corrects those bones — others pass through unchanged.
   * When absent, all bones are captured and corrected.
   */
  boneFilter?: readonly string[]
}

/**
 * Removes neutral-pose bias from a configurable set of bones.
 *
 * Triggers:
 *   capture — snapshot the current incoming pose as the neutral reference
 *   reset   — clear all offsets, pass through pose unmodified
 *
 * Correction formula: q_out = offset⁻¹ × q_in
 *
 * Multiple instances can be chained in the graph for independent per-region
 * calibration (e.g. head chain, left arm, right arm) by setting boneFilter.
 */
@SignalNode({
  label:       'Body Calibration',
  description: 'Removes neutral-pose bias. Use capture/reset triggers to calibrate.',
  tags:        ['calibration'],
  color:       '#4a5a9f',
})
export class BodyCalibration {
  static readonly kind        = 'body_calibration'
  static readonly inputPorts  = [
    valuePort('pose',    'NormalizedPose'),
    eventPort('capture', 'Trigger'),
    eventPort('reset',   'Trigger'),
  ] as const
  static readonly outputPorts = [valuePort('pose', 'NormalizedPose')] as const

  static execute(
    inputs:  InputsOf<typeof BodyCalibration>,
    config:  BodyCalibConfig,
    ctx:     NodeExecutionContext,
  ): OutputsOf<typeof BodyCalibration> {
    const { triggeredPort } = ctx
    const filter = config.boneFilter ? new Set(config.boneFilter) : null
    const pose   = inputs.pose as NormalizedPose | undefined

    // ── Capture ────────────────────────────────────────────────────────────────
    if (triggeredPort === 'capture') {
      if (!pose) return {} as OutputsOf<typeof BodyCalibration>
      const bodyOffsets: Record<string, [number, number, number, number]> = {}
      for (const [bone, q] of pose.entries()) {
        if (filter && !filter.has(bone as string)) continue
        if (!q.isValid) continue
        bodyOffsets[bone as string] = q.toArray()
      }
      ctx.setState({ bodyOffsets })
      console.log(`[BodyCalibration] Captured ${Object.keys(bodyOffsets).length} bone offsets`)
      return {} as OutputsOf<typeof BodyCalibration>
    }

    // ── Reset ──────────────────────────────────────────────────────────────────
    if (triggeredPort === 'reset') {
      ctx.setState(EMPTY_STATE)
      return {} as OutputsOf<typeof BodyCalibration>
    }

    // ── Normal pose (triggered or pulled) ────────────────────────────────────
    if (!pose) return {} as OutputsOf<typeof BodyCalibration>
    const { bodyOffsets } = (ctx.getState<CalibrationState>() ?? EMPTY_STATE)
    if (!bodyOffsets || Object.keys(bodyOffsets).length === 0) return { pose }

    const corrected = pose.map((q, bone: VRMBoneName) => {
      const raw = bodyOffsets[bone as string]
      if (!raw) return q
      const offset = Quaternion.fromArray(raw as [number, number, number, number])
      return offset.isValid ? offset.invert().multiply(q) : q
    })
    return { pose: corrected }
  }
}
