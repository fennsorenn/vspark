# OBS Integration {#obs}

vspark can both *react to* what OBS is doing and *control* OBS back — all from
the **Logic** tab. Switch scenes on a timer, start the replay buffer when a
viewer appears, duck your music while you talk, celebrate a saved clip.

## Connecting vspark to OBS {#obs-websocket}

All of this runs over **obs-websocket**, which ships with OBS. Turn it on once:

1. In OBS, open **Tools → WebSocket Server Settings** and enable the server.
2. Copy the **Server Port** and **Server Password** shown there.
3. In vspark, open **Accounts → OBS Connections** and paste them in. Because
   vspark runs on the same machine as OBS, the host stays `localhost`.

The connection lives on the backend and reconnects on its own. Its state is
shown as a pill next to the connection in the Accounts panel, and the **OBS
Connection State** node lets your graph react when the link drops or returns.

Without a connection, the OBS nodes below do nothing — and say so in the
backend log, naming the node and the reason.

## Reacting to OBS {#events}

These nodes fire when something changes in OBS:

- **OBS Scene Changed** — fires when the active program scene changes. Outputs
  the new scene's name and canvas size. Set a scene name in the node to react to
  only that scene.
- **OBS Output State** — fires when streaming, recording, the replay buffer, or
  the virtual camera starts or stops. Outputs which output changed, the
  transition (started / stopped / paused / saved …), and whether it is now on.
  A saved replay clip is a great trigger for a celebration animation.
- **OBS Volume Changed** / **OBS Mute Changed** — react when you move a fader or
  mute a source.
- **OBS Connection State** — react when the OBS link connects or drops.

## Controlling OBS {#actions}

These nodes tell OBS to do something when triggered:

- **OBS Set Scene** / **OBS Set Transition** — switch the active program scene or
  the active transition, by name.
- **OBS Control** — start/stop streaming, recording (and pause/unpause), the
  replay buffer (including *save*), or the virtual camera.
- **OBS Set Volume** / **OBS Mute** — set an audio input's volume (in dB or as a
  linear multiplier) or mute / unmute / toggle it. Great for ducking music on a
  donation, or a boss-key mute.
- **OBS Replay Path** — fetch the file path of the last saved replay clip, so you
  can do something with the file itself.

> **Browser Source page permissions no longer matter.** Earlier versions of
> vspark sent scene and output control through the OBS Browser Source, where OBS
> quietly ignored anything above the source's permission level — actions could
> fail with nothing to show for it. Everything now goes over obs-websocket, which
> has no such gate and reports every failure. You can leave the Browser Source's
> page permissions alone.

## Reacting to viewers appearing {#lifecycle}

The **Client Lifecycle** node fires whenever a render client — an OBS Browser
Source or an ordinary browser tab — showing your scene connects or disconnects.
Use it to play an entrance animation when your overlay appears on screen, or to
idle when it goes away. It also reports how many clients are currently
connected. This one needs no OBS connection at all. To tell several sources
apart, give each one a stable marker by adding `?obsTarget=name` to its URL and
filtering on it in the node.
