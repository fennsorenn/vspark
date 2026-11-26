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

- **Trigger** — what shows the alert: a **Donation**, **Tip**, **Bits**,
  **Sub**, **Gift subs**, **Follow** or **Raid** on your connected account, or
  a **Named trigger**. A named trigger is
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

## Stream widgets {#widgets}

Goal bars, timers and event lists for your overlay. They are 2D layers; each
shows its data on the page and only updates when something changes.

### Goal {#goal}

A bar filling up towards a target.

- **Goal from** — the channel's **Twitch goal** (pick which kind under **Twitch
  goal**), or **My own goal** with a **Label** and **Target**.
- For your own goal, **Count** picks the event that moves it forward (follows,
  subs, gifted subs, bits, the tip amount, raid viewers or a named trigger), or
  _Nothing_ to set it only by hand. **Current count** sets it by hand at any
  time.
- The count lives in a project **Variable** — `goal`, or `goal 2`, `goal 3`, …
  when that name is already taken, so two goals never share a count by accident.
  Actions and other logic can change it too; the box suggests the variable
  names already in use if you want two widgets to share one on purpose.
- **Keep** — reset the count when the stream starts (**This stream**), or keep
  counting (**Across streams**).

Twitch goals need your account to allow goal access: if a Twitch goal doesn't
show, reconnect the account once.

### Countdown {#countdown}

A timer counting down **a set time** or **to a time of day** (like `20:00`).
Use **Start**, **Pause**, **Resume** and **Reset** in its settings. The same
actions are named triggers — `countdown start`, `countdown pause`, … (change the
base name under **Trigger names**; a second countdown starts out as
`countdown 2 start`, … so one trigger never controls both) — so Actions,
hotkeys and other logic can control it. **At zero, send trigger** sends a named trigger when it runs out, for
example to switch scenes or show an alert.

A running timer keeps going after a restart of vspark.

### Subathon timer {#subathon}

A timer that support adds time to.

- **Starting time** — what **Start** sets the timer to.
- **Time added per** — how much time a sub, a gifted sub, 100 bits, one unit of
  tip money, or a follow adds. Gifted subs count once per gifted sub, not again
  as subs.
- **Hard cap** — the most the timer's total length (starting time plus
  everything added) can reach; `0` means no cap.
- **Soft limit stages** — past a total length, each addition counts less, for
  example past 12 hours ×0.5 and past 24 hours ×0.25. Enter the **Planned start**
  to see the end time each stage corresponds to — the timer reaches a stage when
  it would end at that time.

Control it like the countdown (`subathon start`, `subathon pause`, …).

### Recent events {#recent}

The latest follows, subs, gifted subs, bits, tips and raids, newest first. Turn
each kind on or off, change the text shown with it, and how many **Entries** are
shown. **Keep** clears the list when the stream starts, or keeps it across
streams.

### Top supporters {#top}

A leaderboard of who gave the most — **Ranked by** bits, tips, gifted subs, subs
or raid viewers — for **This stream** or **Across streams**.

### Ad break {#adbreak}

Appears while an ad break runs, with your **Message** and the time until it
ends, and disappears when it's over.

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
