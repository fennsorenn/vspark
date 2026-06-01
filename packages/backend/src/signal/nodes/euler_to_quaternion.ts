import { SignalNode, valuePort, Quaternion } from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
} from '@vspark/shared/signal';

@SignalNode({
  label: 'Euler → Quaternion',
  description:
    'Converts pitch/yaw/roll angles (radians) to a unit quaternion using ZYX intrinsic convention. Connect per-axis sine waves to drive procedural rotations.',
  tags: ['math'],
  color: '#4a7a5a',
})
export class EulerToQuaternion {
  static readonly kind = 'euler_to_quaternion';
  static readonly inputPorts = [
    valuePort('pitch', 'Float'), // X-axis rotation (forward/back tilt)
    valuePort('yaw', 'Float'), // Y-axis rotation (left/right turn)
    valuePort('roll', 'Float'), // Z-axis rotation (side tilt)
  ] as const;
  static readonly outputPorts = [
    valuePort('quaternion', 'Quaternion'),
  ] as const;

  static execute(
    inputs: InputsOf<typeof EulerToQuaternion>,
    _config: unknown,
    _ctx: NodeExecutionContext
  ): OutputsOf<typeof EulerToQuaternion> {
    const pitch = (inputs.pitch as number | undefined) ?? 0;
    const yaw = (inputs.yaw as number | undefined) ?? 0;
    const roll = (inputs.roll as number | undefined) ?? 0;

    // ZYX intrinsic: Rz(roll) * Ry(yaw) * Rx(pitch)
    const cx = Math.cos(pitch / 2),
      sx = Math.sin(pitch / 2);
    const cy = Math.cos(yaw / 2),
      sy = Math.sin(yaw / 2);
    const cz = Math.cos(roll / 2),
      sz = Math.sin(roll / 2);

    const quaternion = new Quaternion(
      sx * cy * cz - cx * sy * sz,
      cx * sy * cz + sx * cy * sz,
      cx * cy * sz - sx * sy * cz,
      cx * cy * cz + sx * sy * sz
    ).normalize();

    return { quaternion };
  }
}
