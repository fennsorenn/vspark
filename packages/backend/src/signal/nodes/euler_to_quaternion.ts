import { SignalNode, Quaternion } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';

@SignalNode({
  label: 'Euler → Quaternion',
  description:
    'Converts pitch/yaw/roll angles (radians) to a unit quaternion using ZYX intrinsic convention. Connect per-axis sine waves to drive procedural rotations.',
  tags: ['math'],
  color: '#4a7a5a',
})
export class EulerToQuaternion extends Node {
  static readonly kind = 'euler_to_quaternion';

  @valueIn('pitch', 'Float') pitch!: () => number | undefined; // X-axis rotation (forward/back tilt)
  @valueIn('yaw', 'Float') yaw!: () => number | undefined; // Y-axis rotation (left/right turn)
  @valueIn('roll', 'Float') roll!: () => number | undefined; // Z-axis rotation (side tilt)

  @valueOut('quaternion', 'Quaternion')
  quaternion = (): Quaternion => {
    const pitch = this.pitch() ?? 0;
    const yaw = this.yaw() ?? 0;
    const roll = this.roll() ?? 0;

    // ZYX intrinsic: Rz(roll) * Ry(yaw) * Rx(pitch)
    const cx = Math.cos(pitch / 2),
      sx = Math.sin(pitch / 2);
    const cy = Math.cos(yaw / 2),
      sy = Math.sin(yaw / 2);
    const cz = Math.cos(roll / 2),
      sz = Math.sin(roll / 2);

    return new Quaternion(
      sx * cy * cz - cx * sy * sz,
      cx * sy * cz + sx * cy * sz,
      cx * cy * sz - sx * sy * cz,
      cx * cy * cz + sx * sy * sz
    ).normalize();
  };
}
