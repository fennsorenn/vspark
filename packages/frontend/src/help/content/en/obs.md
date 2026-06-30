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

- **OBS Set Scene** / **OBS Set Transition** — switch the active scene or
  transition by name.
- **OBS Control** — start/stop streaming, recording (and pause/unpause), the
  replay buffer (including *save*), or the virtual camera.

> **Permissions.** Control actions only work if the Browser Source's **Page
> Permissions** (in its OBS properties) are high enough — *Advanced* for scene
> and transition changes, *All* for streaming/recording/virtual-camera control.
> OBS quietly ignores actions above the level you granted, so if a control node
> seems to do nothing, raise the permission level.

## Reacting to viewers appearing {#lifecycle}

The **Client Lifecycle** node fires whenever a render client — an OBS Browser
Source or an ordinary browser tab — showing your scene connects or disconnects.
Use it to play an entrance animation when your overlay appears on screen, or to
idle when it goes away. It also reports how many clients are currently
connected. This works outside OBS too. To tell several sources apart, give each
one a stable marker by adding `?obsTarget=name` to its URL and filtering on it
in the node.
