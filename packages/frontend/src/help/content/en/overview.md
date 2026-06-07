# Welcome to vspark {#overview}

vspark turns live motion into a 3D character on screen. You bring in movement
(from a webcam, a phone, or tracking gear), point it at a virtual avatar, and
vspark streams the result to a viewport you can put on stream or record.

You don't need to know any of the technical details to get started — this guide
explains each part in plain language. Look for the small **?** buttons around
the app: hover for a quick hint, click for the full explanation.

## The main pieces {#pieces}

vspark is organised into a few areas. The tabs on the left switch between them.

- **[Stage](topic:scene)** — the 3D world. Your avatar, cameras, and lights all
  live here. This is what gets shown to your audience.
- **[Avatar](topic:avatar)** — the character itself: how it loads, moves,
  shows expressions, and looks.
- **[Behaviors](topic:behaviors)** — the "drivers" that make things move, such
  as reading your webcam or your microphone.
- **[Logic](topic:logic)** — optional automation: make things happen in
  response to events (for example, a chat message or a channel reward).
- **Compose** — a 2D layer layout on top of the 3D scene (overlays, images,
  webcam frames) for your final stream look.

## A typical first session {#first-session}

1. Add an **avatar** to the Stage and load a `.vrm` character file.
2. Attach a **behavior** that captures your movement (webcam tracking or VMC).
3. Watch your avatar come to life in the viewport.
4. Optionally add **Logic** and **Compose** layers to react to your stream.

Each of those steps has its own page in this guide — use the topic list on the
left, or the **?** buttons next to the controls in the app.

## Changing the language {#language}

Use the language selector in the top bar to switch between **English** and
**Deutsch**. Your choice is remembered the next time you open vspark.

## Updating vspark {#updates}

vspark checks for updates automatically in the background. When a new version
is available, a notification appears in the top bar. Open the **Updates** panel
(click the version number or the notification badge) to see what has changed and
install the update.

**How it works.** vspark downloads the new version in the background while you
keep working. When the download is complete, click **Update Now** to apply it.
vspark restarts automatically and your projects are preserved — no manual
file-moving is needed.

**Release channels.** You can choose how cutting-edge your updates are:

- **Stable** — thoroughly tested releases recommended for everyday use.
- **Recent** (beta) — finished features that are still being polished. Mostly
  reliable, but occasional rough edges are possible.
- **Experimental** (alpha) — the latest work-in-progress builds. Great for
  trying new things early, but expect occasional instability.

Switch channels in the **Updates** panel at any time. vspark will check for the
newest release on the selected channel straight away.
