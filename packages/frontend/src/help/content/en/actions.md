# Actions {#overview}

**Actions** are ready-made automations for common stream moments — set one up
by filling in a form instead of wiring nodes. A hotkey that plays a clip, or one
that toggles an object on and off, is a single action.

Actions belong to the whole project and live on the **Actions** tab. Each
action is backed by a normal [Logic](topic:logic) graph that vspark builds for
you from the action's settings — you never have to look at it, but you can open
and change it any time.

## Adding an action {#add}

Click **+ Add** and pick a kind. The new action appears in the list, grouped
with the other actions of the same kind. Each row shows its most important
settings at a glance — for a hotkey, the key combination and what it does.

- The checkbox at the start of a row turns the action on or off without deleting
  it.
- **Settings** opens the form for that action.
- **✕** deletes the action and its graph (**Undo** brings both back).

## Hotkey {#hotkey}

A **Hotkey** action reacts to a key combination pressed anywhere on the computer
running vspark — even when vspark is not the focused window.

- **Shortcut**: click the button, then press the keys you want (for example
  `Ctrl + Shift + 1`). Press `Esc` to cancel.
- **Mode**:
  - *Single* — every press runs the same response.
  - *Toggle* — presses alternate between two responses (on / off).
  - *Cycle* — presses step through several responses in turn; **Positions**
    sets how many.
- **Response** (one per position): play a clip, spawn a clip, set an
  expression, set a property of an object or layer, or control a video or audio
  file. Pick the response, then fill in its details.

## Settings that rebuild the graph {#value-shape}

Most settings — the shortcut, which clip to play, a value to set — are read by
the graph while it runs. Changing them takes effect right away and never touches
the graph itself.

A few settings decide what the graph *looks like*: the **mode**, the number of
**positions**, and the **type** of each response. Changing one of these rebuilds
the graph. If you have edited the graph yourself, vspark asks first, because
the rebuild discards those edits.

## Modified and template updates {#modified}

- **Modified** means the action's graph was changed by hand and no longer
  matches what its settings would generate. Moving nodes around on the canvas
  does not count as a change.
- **Template update** means a newer version of vspark generates this kind of
  action differently. Unmodified actions are updated automatically when vspark
  starts; modified ones keep your edits and show this badge instead.

## Reset {#reset}

**Reset** throws away your edits to the graph and builds it again from the
action's current settings. vspark asks for confirmation first. **Undo** brings
the edited graph back.

## Opening the graph {#graph}

**Open graph** shows the action's graph on the Logic canvas, where you can
change it like any other Logic — add nodes, rewire, tweak values. The graph
reads the action's settings through **Settings** nodes, so the form keeps
working after you edit the graph.
