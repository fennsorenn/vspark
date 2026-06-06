# Transform {#transform}

The Transform section controls where a node sits in the scene, how it is oriented, and how it appears — every node has one.

## Position {#position}

Position moves the node in 3D space along three axes, measured in scene units (roughly metres at default scale):

- **X** — left (negative) or right (positive)
- **Y** — down (negative) or up (positive)
- **Z** — forward, towards the camera (negative) or backward, away from the camera (positive)

Default: X 0, Y 0, Z 0 (the scene origin).

When a node is a child of another node, its position is relative to the parent — moving the parent moves the child with it.

## Rotation {#rotation}

Rotation tilts or spins the node around each axis, in degrees:

- **X** — tilt forward or backward (pitch)
- **Y** — turn left or right (yaw)
- **Z** — roll clockwise or counter-clockwise

Default: X 0°, Y 0°, Z 0° (no rotation).

Rotation is applied in X → Y → Z order. Like position, a child node's rotation is relative to its parent's orientation.

## Scale {#scale}

Scale stretches or shrinks the node independently on each axis:

- **X** — width (left-right)
- **Y** — height (up-down)
- **Z** — depth (front-back)

A value of 1 is the node's native size. Values below 1 shrink the node; values above 1 enlarge it. Setting all three axes to the same value produces a uniform resize; using different values stretches the node non-uniformly. Negative values mirror the node along that axis.

Default: X 1, Y 1, Z 1.

Children of a scaled parent are scaled along with it.

## Opacity {#opacity}

Opacity controls how transparent the node's meshes appear. The slider runs from 0 (fully transparent, invisible) to 1 (fully opaque). Intermediate values blend the node over whatever is behind it.

Default: 1 (fully opaque).

Opacity is applied uniformly to every mesh that belongs to the node, including child meshes. It does not affect shadows.
