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

## Conditions and text {#conditions}

A few small nodes help you decide *whether* something should happen and *what* to
say:

- **If / Else** passes an event on to its **then** output when its condition is
  true, and to **else** otherwise. Wire any yes/no value into the condition.
- **Equals** tells you whether two values are the same (text is case-sensitive).
- **Chat Rank** checks whether a chatter is at least a subscriber, moderator or
  the broadcaster — wire in the matching outputs of a chat trigger and pick the
  minimum rank (`everyone`, `sub`, `mod`, `broadcaster`).
- **Regex Match** checks text against a pattern and pulls pieces out of it. Name
  a part of the pattern, like `(?<user>\w+)`, and it gets its own output, so a
  command such as `!so bob` can hand `bob` to the next node.
- **Format Text** builds a message from a template with `${placeholders}` — the
  same way **Send Chat** does — filled from its labeled inputs or from the named
  parts of a Regex Match.

## Variables and counters {#variables}

Variables remember a value between events — a death counter, the last person who
redeemed a reward, a running total. **Set Variable** stores a value, **Increment
Variable** adds to a number (by 1 unless you say otherwise), and **Get Variable**
reads it back.

Every automation in the project shares the same variables, so one automation can
count and another can show the count. To keep a variable to one automation, wire
the **This Logic** node into its **scope**. Tick **persistent** to keep the value
when vspark restarts; otherwise it starts over.

## Cooldowns and combos {#combos}

- **Cooldown** lets an event through at most once per number of seconds; events
  that arrive too soon come out of **blocked** instead. Give several cooldowns the
  same **group** name and they share one cooldown — handy when a few chat
  commands should not be spammed together.
- **Combo Threshold** counts events that arrive close together (within the
  **window**) and fires once when the count reaches the threshold — say, five
  chatters posting the same emote.
- **Combo Timeout** fires when a run of events stops, with the final **count**.
- Wire the chatter's name into a combo's **key** to count each person only once.

## Triggers between automations {#custom-triggers}

**Send Trigger** fires a named trigger, and every **On Trigger** node with the
same name — in any automation of this project — reacts to it. You can send some
data along as the **payload**. This lets one automation start another, for
example a chat command that sets off an alert built elsewhere. A trigger can't
set itself off again while it is still being handled, so loops stop on their
own.

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
