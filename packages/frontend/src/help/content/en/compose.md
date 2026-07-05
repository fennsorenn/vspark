# Compose {#compose}

**Compose** is the 2D layout view for your stream. While the [Scene](topic:scene)
handles your 3D world — avatar, lights, cameras — Compose lets you place flat
layers on top of (or behind) that 3D render to build the final on-screen look
your viewers see. Think of it like a stack of transparent slides sitting in
front of your camera.

## Overview {#overview}

Open the **Compose** tab to see the layer tree on the left and a live preview
of the output in the centre. Each **Compose Scene** is a named layout you can
switch between — for example one layout for face-cam and another for a full-body
shot. Layers within a scene stack on top of each other; the order you arrange
them determines what appears in front.

## Layers {#layers}

A layer is one flat element in your Compose Scene. There are four kinds:

- **Image** — a still picture from your assets. Use it for frames, logos, or
  any static graphic that sits over the 3D render.
- **Video** — a video file that plays back in the layout. Supports autoplay,
  looping, and chroma-key (green-screen removal).
- **Browser source** — a live webpage rendered inside a layer. Useful for
  alert boxes, donation tickers, or any web-based overlay tool.
- **Template / feed** — a dynamic layer powered by data from your stream (see
  [Feed layers](#feed) below).

Select a layer in the tree to edit its settings in the Properties panel on
the right.

## Layer ordering {#ordering}

![Layer stacking order](/help/diagrams/compose-order.svg)

_Layers stack in front of or behind the 3D render (highlighted) relative to the viewer on the right._

Layers are arranged in a list from top (front) to bottom (back). Drag a layer
**between** two rows (or to the top or bottom of a level) to reorder it there, or
drop it **onto** another layer to nest it as a child — a blue line shows a
reorder, a highlighted row shows nesting. Drop onto the empty area of a compose
scene to move a layer back to its top level, or onto **another** compose scene to
move it there. Hold **Ctrl** (**⌘** on Mac) while dropping to drop a **copy**
instead of moving. In addition, each layer has a **stack order** number that
controls whether it appears in front of or behind the 3D scene:

- A negative stack order puts the layer **in front of** the 3D render.
- Zero places it at the same level as the 3D scene.
- A positive stack order sends it **behind** the 3D render.

Layers can also be scoped: a **scene-wide** layer appears across every camera,
while a **camera** layer is specific to one [Camera](topic:scene#cameras) and
only shows when that camera is active.

## Positioning layers {#positioning}

Select a layer and use the **Properties** panel to set its position, size, and
rotation. All values default to pixels, but you can switch to percentage units
to make a layer scale with the output resolution.

The **Anchor** setting controls which corner or edge of the layer is treated as
its reference point when you type a position. For example, anchoring to the
bottom-right corner and setting X/Y to zero snaps the layer to the bottom-right
of the canvas.

When you drag **or resize** a layer in the preview it **snaps** to the centre and
edges of its parent (the whole canvas, for a top-level layer): the layer's own
edges and centre — or the edge you're resizing — pull onto the parent's edges and
centre, and a pink guide line shows each active snap. Hold **Alt** while dragging
to move freely without snapping, or toggle snapping off entirely with the magnet
button in the compose toolbar (top-right).

You can lock a layer in 2D so it cannot be accidentally dragged in the preview,
or lock its 3D interaction if it overlaps the 3D viewport.

When an image or video layer overlaps a **camera view** layer, right-clicking it
(in the layer list **or** in the preview) offers **Send to 3D**: this creates a
matching billboard (or video plane) inside that camera's 3D scene, positioned and
sized so it lines up with where the 2D layer sat in the camera's view, then
removes the flat 2D layer — the new 3D object shows through the camera view in its
place. Handy for promoting a flat overlay into the 3D scene so it can be parented,
animated, or lit like any other object. You stay in the compose view.

## Attach to a bone {#attach-bone}

Inside a **camera view** layer you can drag the 3D objects it shows. Turn on
**Attach mode** with the bone button next to the snap toggle in the compose
toolbar (or hold **Shift** while dragging), then drag an object onto a model and
release it over the body part you want. The object binds to the bone that drives
that part — the one with the strongest influence there — so drop it on a hand and
it follows the hand, drop it on the head and it follows the head. Its on-screen
position is preserved, and from then on its Transform is measured relative to that
bone. Drop it clear of any model and it returns to the scene's top level, again
keeping its position. This is the quickest way to put a sword in a hand or a hat
on a head without hunting through the scene tree.

## Template / feed layers {#feed}

A **template** layer is a live, data-driven layer. It uses a small snippet of
markup (JSX-style htm syntax) that can reference data published by your logic
graph — for example a running list of chat messages, a subscriber alert, or a
current song name.

You do not need to write code to use basic templates: the built-in presets
cover common use cases like chat overlays and alert boxes. For custom layouts,
the template field accepts standard HTML elements and can reference any field
that a **set_data** node publishes into the layer's scope.

Static visual styles can be added in the **Styles (CSS)** field; dynamic styles
(colours or sizes that change with the data) go inline inside the template
markup itself.
