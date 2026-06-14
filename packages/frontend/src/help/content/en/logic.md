# Logic {#logic}

**Logic** lets you make things happen automatically in response to events,
without writing code. It's optional — many setups never need it — but it's how
you build interactive moments, like reacting to your chat or a channel reward.

You work with Logic on the **Logic** tab, by connecting boxes together on a
canvas.

## Automations {#automations}

An **automation** is a single logic setup: a canvas of connected nodes that does
one job. You can have several automations, each handling a different scenario.
Automations can belong to the whole project, to one scene node, or to a layer.

## Nodes and wires {#nodes}

![Event and value wires](/help/diagrams/logic-wire.svg)

*Nodes are wired output → input. Orange wires carry events (a moment, flowing → with the arrow); blue wires carry values (data read when needed).*

A logic canvas is built from **nodes** (the boxes) joined by **wires** (the
lines between them). Each node does a small thing — wait for an event, pick a
random number, play an animation — and the wires carry information from one node
to the next, left to right.

To build something, drag nodes from the palette onto the canvas and connect an
output of one node to an input of another.

## Events and values {#events}

Wires carry two kinds of information:

- **Events** are moments — "a message arrived", "the timer fired". They flow
  through the graph and make things happen.
- **Values** are data — a number, some text, a name. Nodes read values when they
  need them.

Matching colours and shapes on the connection points tell you what can plug into
what.

## Stream triggers {#triggers}

Logic can react to live stream events from connected [accounts](topic:overview)
— a new follower, a subscription, a chat command, a channel-point redemption,
and more. Pair a trigger node with an action node (play an animation, show an
overlay, spawn an effect) to create automated reactions for your audience.
