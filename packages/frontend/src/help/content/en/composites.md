# Composites {#composites}

A **composite** is a ready-made overlay — an alert, a chat overlay — placed as
**one object with its own settings**. Instead of hunting through layers, a
track clip and a logic graph to change the message or the sound, you set them
on the composite itself.

Composites sit in the **Create** palette next to the ordinary objects and layers,
marked with a small **composite** tag. The same tag shows on the composite's
row in the scene or compose tree.

## Settings {#settings}

Select a composite to see its **Settings** in the properties panel. Each setting
writes straight into the parts inside the composite — there is no separate copy
of the value. So you can also edit the parts directly (move the message, pick
another font on it), and the setting shows the change.

Every change is one undo step. If a setting points at something you removed
from the composite's logic, it shows as _not available_.

## Alert {#alert}

An alert shows a badge, a message and a sound when something happens, then fades
out. Alerts that arrive at once wait in a queue and play one after another.

- **Trigger** — what shows the alert: a **Donation**, **Tip**, **Sub** or
  **Raid** on your connected account, or a **Named trigger**. A named trigger is
  sent by an Action's _send trigger_ option or by a _Send Trigger_ node in any
  logic graph; set the same **Trigger name** here.
- **Message** — the text, with placeholders such as `${displayName}` filled from
  the event (for a raid also `${viewerCount}`; for a named trigger any field of
  what was sent with it, or `${payload}` for plain text).
- **Badge type** — a still **Image** or a **Video**, and which one to show.
- **Sound** and **Volume** — played each time the alert shows.
- **Show for** — how long the alert stays up, fades included.
- **Gap between** — how long the queue waits before the next alert.

## Chat overlays {#chat}

- **Chat Overlay** (2D) and **Chat Overlay (3D)** show the latest chat messages of
  an account. Set the **Account**, how many **Messages** are shown, and the
  **Font**, **Font size**, **Text colour** and **Bubble colour**.
- **Scrolling Chat (3D)** sends each message flying across the scene. Set the
  **Crossing time** and the range of heights and depths the messages fly at.

## Parts stay in place {#parts}

The objects inside a composite are its **parts**. You can select and edit them
like any other object, and change their order, but you can't move one out of
the composite, into a group inside it, or delete it on its own: the composite's
logic addresses them where they are. Deleting the whole composite removes its
parts with it.

## Dissolving {#dissolve}

**Dissolve composite** (in the Settings section and the tree's right-click menu)
turns a composite into a plain group. Nothing inside changes, but the settings
disappear and the parts can be moved and deleted freely — for when you want to
customise it beyond what the settings offer. Dissolving can be undone.
