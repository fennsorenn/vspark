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

Logic can also talk back: the **Send Chat** action posts a message to your
channel when it fires. Its message is a template — write fixed text mixed with
`${placeholders}`, then wire a value into each named input to fill the blanks
(for example, greet a new follower by name). Sending requires reconnecting the
account once so it grants chat-write permission.

## System hotkeys {#hotkeys}

The **System Hotkey** trigger fires when you press a keyboard shortcut anywhere
on the computer running vspark — even when vspark is in the background and
another app is focused. It's perfect for hands-free moments while you stream:
hit a key to play an animation, swap an expression, or show an overlay.

Set the **key** (its name, e.g. `F8`, `A`, or `SPACE`) and tick any of the
modifier boxes — **ctrl**, **shift**, **alt**, **meta** (the Windows/Command
key) — to require them. The match is exact: a `Ctrl + S` hotkey won't fire on
`Ctrl + Shift + S`. Wire the node's event output into an action to react.

Because it watches the keyboard system-wide, this only works when the server
runs on your own machine. On a headless or remote server, or where the
operating system blocks global keyboard hooks, the hotkey simply never fires —
nothing else is affected.

## Macros {#macros}

The **Macros** tab is the easy way to set up a bunch of keyboard shortcuts
without touching the node canvas. Each macro reads as a sentence: *when I press
[shortcut] → [do action]*.

- Click **Add macro**, then click the shortcut button and press the keys you
  want (e.g. `Ctrl + Shift + 1`). Pick an action — play a clip, set an
  expression, show or hide something, control a video — and fill in its details.
- The **On** checkbox enables or disables a macro without deleting it.

Macros are just a friendly view of Logic: each one is really a *System Hotkey*
node wired to an action node behind the scenes. So anything you build on the
canvas that starts with a hotkey shows up here too, and edits stay in sync both
ways. When a macro does something the simple view can't show — a toggle, or a
hand-wired chain — the row says so and offers **Open in graph** to edit it with
full control.
