# Behaviors {#behaviors}

A **behavior** is something you attach to a node to make it do something on its
own. Behaviors are the bridge between the outside world (your camera, your
microphone, your tracking app) and your [avatar](topic:avatar).

You add behaviors from the **Behaviors** tab and attach them to a node. A single
avatar can have several behaviors running at once — for example tracking *and*
lip sync.

## VMC receiver {#vmc}

**VMC** is a common standard that motion-capture apps use to send pose data over
your network. Tools like phone face-trackers and full-body suits can broadcast
VMC; the VMC receiver behavior listens for it and feeds it to your avatar.

You just tell it which port to listen on (the sending app shows this), and the
motion flows in.

## iFacialMocap receiver {#ifacialmocap}

**iFacialMocap** is an iPhone/iPad app that uses Apple's face tracking to capture
your expressions. This behavior receives that stream and drives your avatar's
**head, eyes and facial blendshapes** — it is a face-only source, so arms, hands
and legs keep playing their animation.

Both devices have to be on the same network. There are two ways to connect:

- **Fill in Device IP** with the address the app shows on your phone. vspark then
  asks the phone to start streaming, and reconnects on its own if the app is
  restarted.
- **Leave Device IP empty** and type one of the listed machine addresses into the
  app instead, then start streaming from the phone.

Either way both ends talk on port **49983**, the port the app uses.

If your head moves the wrong way — nodding up when you nod down, for example —
flip the matching switch under **Head Axes**. Once the directions look right,
sit in a relaxed neutral pose and press **Capture** so your resting posture
becomes the avatar's resting posture.

Expressions are mapped exactly like the [VMC receiver](topic:behaviors#vmc)'s —
same three face mappers, same custom mapping editor.

## Camera tracking {#tracking}

Camera tracking uses an ordinary **webcam** to estimate your face, hands, and
body pose — no special hardware required. It runs in your browser and sends the
result to your avatar.

This is the easiest way to get started: attach the tracking behavior, allow
camera access, and calibrate once while standing in a neutral pose.

The **Face**, **Pose** and **Hands** toggles pick which parts are tracked.
**HQ face** controls how facial expressions are estimated: off (the default)
derives them cheaply from the face landmarks already being tracked, while on
runs a dedicated high-quality face model for more accurate expressions at the
cost of extra CPU — enable it only if your machine keeps a smooth framerate.

## Lip sync {#lipsync}

Lip sync listens to your **microphone** and turns speech into mouth shapes, so
your avatar's mouth moves in time with your voice. It works even without face
tracking, which is handy if you'd rather not be on camera.

You can calibrate it to your own voice for sharper vowel shapes.

## Breathing {#breathing}

Breathing adds a subtle, automatic rise-and-fall to the chest and shoulders so
your avatar feels alive even when you're holding still. The amount of chest and
shoulder movement is adjustable.

## Expression limits {#expression-limits}

Face tracking, lip sync and manually set expressions all land in the same frame,
and by default they simply add up. That is what produces the exaggerated or
outright broken faces you sometimes see: a full **joy** expression already
squints the eyes, so a blink stacked on top collapses the eyelids, and a
wide-open lip-sync vowel on top of a joy smile stretches the mouth past what the
model was built for.

The **Expression limits** behavior is a corrective pass that runs on the
finished expression frame, just before it reaches the avatar. Add it to an
avatar and it works immediately — the shipped defaults cover the common cases.

**Exclusive groups.** Expressions in a group cannot occur together. The strongest
one wins and the others fade out in proportion to how strong it is, so competing
emotions cross-fade instead of popping. By default all five emotion presets —
joy, angry, sad, relaxed and surprised — are in one group, so your avatar can
only be one thing at a time. *Normalise sum* is the gentler alternative: nothing
wins outright, but if the group's expressions add up past 1 they are all scaled
back until they fit.

**Clamp rules.** While a driver expression is active, a set of target shapes is
capped into a reduced range. The two shipped rules both use joy as the driver:
one holds back the eye-close and blink shapes, the other the mouth-open shapes
and lip-sync vowels. *Threshold* is how strong the driver must be before the
rule does anything, and with *fade in with driver* on, the cap tightens
gradually as the driver grows rather than snapping on.

**Naming.** Names are matched case-insensitively, and `*` works as a wildcard —
`Fcl_MTH_*` catches every VRoid mouth morph in one entry. That is how one rule
set covers models that spell the same expression `happy`, `Joy` or
`Fcl_ALL_Joy`. A member row holds several names precisely because they are all
the *same* expression to your model; the add-field suggests the names your
loaded avatar actually exposes. A rule naming a shape your model doesn't have
simply does nothing.

**Raw JSON.** The whole rule set is editable as JSON at the bottom of the panel,
which is the quickest way to copy a tuned configuration from one avatar to
another. **Reset to defaults** puts the shipped rules back.

## Camera & microphone setup {#devices}

The **Media** window is where you choose which webcam and microphone vspark
uses. Open it from the toolbar; it can also run in a separate browser tab so
it stays active while you switch windows.

**Choosing devices.** Use the drop-down menus to pick the camera or
microphone you want. The list is populated the first time a capture session
starts. If a device doesn't appear, check that it is connected and not in use
by another app.

**Browser permissions.** Capture runs entirely in the browser — no plugin or
driver is needed. The first time you start tracking or lip sync, the browser
will ask for permission to access your camera or microphone. Grant access and
the device will be remembered for the current session. If you accidentally
denied permission, open your browser's site-settings page for vspark and reset
the permission, then reload.

**Calibration.** After starting tracking, stand in a relaxed, neutral pose and
click **Calibrate** (where shown). This teaches vspark your default standing
position so offsets and proportions map correctly to the avatar. For lip sync,
speaking a few vowels while the meter is visible lets the system learn your
voice levels.

## API control {#api}

> **Advanced.** This behavior is intended for users who write scripts or use
> automation tools to control vspark externally.

The API control behavior exposes vspark's local HTTP API so that external
tools — scripts, stream-deck macros, or other software — can trigger
animations, set expressions, or adjust scene properties at runtime. You
configure the behavior once; the API is then available on the local network
at the port shown in the panel. Refer to the API reference (accessible from
the Help menu) for the full list of endpoints and payload formats.
