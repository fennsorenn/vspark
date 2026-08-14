# OBS Integration {#obs}

When you add vspark to OBS as a **Browser Source**, vspark can both *react to*
what OBS is doing and *control* OBS back — all from the **Logic** tab. No
plugins, passwords, or extra setup: the moment vspark runs inside an OBS Browser
Source, these nodes start working.

## How it works {#how}

OBS exposes a small control surface to the web page inside a Browser Source.
vspark bridges that surface into your Logic graph: OBS events become nodes you
can trigger automations from, and a few action nodes let you tell OBS what to
do. Everything is scoped to your project, so several browser sources stay in
sync without firing your automations twice.

## Reacting to OBS {#events}

These nodes fire when something changes in OBS:

- **OBS Scene Changed** — fires when you switch your active scene. Outputs the
  new scene's name and canvas size. Set a scene name in the node to react to
  only that scene.
- **OBS Output State** — fires when streaming, recording, the replay buffer, or
  the virtual camera starts or stops. Outputs which output changed, the
  transition (started / stopped / paused / saved …), and whether it is now on.
  A saved replay clip is a great trigger for a celebration animation.

## Controlling OBS {#actions}

These nodes tell OBS to do something when triggered:

- **OBS Set Scene** — switch the active program scene by name. This one goes
  over **obs-websocket** (see below), so it needs an OBS connection set up in
  **Accounts → OBS Connections** — but no Browser Source permission fiddling,
  and it tells you when something went wrong.
- **OBS Set Transition** — switch the active scene transition by name.
- **OBS Control** — start/stop streaming, recording (and pause/unpause), the
  replay buffer (including *save*), or the virtual camera.

> **Permissions.** Except for *OBS Set Scene*, control actions only work if the
> Browser Source's **Page Permissions** (in its OBS properties) are high enough
> — *Advanced* for transition changes, *All* for streaming / recording /
> virtual-camera control. OBS quietly ignores actions above the level you
> granted, so if a control node seems to do nothing, raise the permission level.

## Deeper control with obs-websocket {#obs-websocket}

The nodes above use OBS's built-in browser API, which can't touch audio. For
that — and more — vspark can also connect to OBS over **obs-websocket**, a
second, opt-in channel you enable in OBS under **Tools → WebSocket Server
Settings**. Copy the **Server Port** and **Server Password** shown there into
**Accounts → OBS Connections** in vspark. Because vspark runs on the same
machine as OBS, the host stays `localhost`.

Once connected, extra nodes light up:

- **OBS Set Volume** / **OBS Mute** — set an audio input's volume (in dB or as a
  linear multiplier) or mute / unmute / toggle it. Great for ducking music on a
  donation, or a boss-key mute.
- **OBS Volume Changed** / **OBS Mute Changed** — react when you move a fader or
  mute a source.
- **OBS Replay Path** — fetch the file path of the last saved replay clip (the
  browser API only tells you *that* a clip saved, not *where*).
- **OBS Connection State** — react when the OBS link connects or drops.

The connection lives on the backend and reconnects automatically. Its status is
shown as a pill next to the connection in the Accounts panel.

## Reacting to viewers appearing {#lifecycle}

The **Client Lifecycle** node fires whenever a render client — an OBS Browser
Source or an ordinary browser tab — showing your scene connects or disconnects.
Use it to play an entrance animation when your overlay appears on screen, or to
idle when it goes away. It also reports how many clients are currently
connected. This works outside OBS too. To tell several sources apart, give each
one a stable marker by adding `?obsTarget=name` to its URL and filtering on it
in the node.
