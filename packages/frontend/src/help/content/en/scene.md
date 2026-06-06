# Scene {#scene}

The **scene** is your 3D world, shown on the **Stage** tab. Everything your
audience sees lives here: your [avatar](topic:avatar), the camera that frames
it, lights, and any props or effects.

## Nodes {#nodes}

Every item in a scene is a **node**. Common kinds include:

- **Avatar** — a VRM character.
- **Camera** — defines the viewpoint that gets streamed.
- **Light** — illuminates the scene.
- **Group** — an empty node used to organise or move several items together.
- **Props** — images, video, text, and particle effects.

Select a node to edit it in the **Properties** panel on the right.

## Hierarchy {#hierarchy}

Nodes are arranged in a tree. A node can have children, and children follow
their parent: move or rotate the parent and everything under it comes along.
This is how you attach a prop to a hand, or move a whole set at once.

You can drag nodes in the scene list to re-parent them.

## Cameras {#cameras}

The camera decides what your viewers see. You can position it, point it at your
avatar, and create more than one for different shots. Each camera can also have
its own visual effects, such as bloom or depth of field.

## Lights {#lights}

Lights set the mood. Realistic [materials](topic:avatar#materials) react to
them, while toon-style materials mostly ignore them. Try a key light plus a
softer fill light for a flattering look.

## Compose {#compose}

The **Compose** view places 2D layers — overlays, images, browser sources, your
webcam frame — in front of or behind the 3D render. This is where you build the
final framing for your stream, independent of the 3D scene itself.
