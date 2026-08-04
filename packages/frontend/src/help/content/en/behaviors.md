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

## Stylized tracking {#stylized}

Accurate tracking is not always flattering tracking. A camera or a VMC suit gives
you exactly what your body did — including the moments where it lost your elbow
for two frames and threw your arm across the room, and including the fact that a
head turn moves only your head while the rest of you stands there like a
mannequin.

Stylized tracking is a **post-processor**. It sits between whatever is producing
your motion and your avatar, and it reshapes the motion on the way through, the
way a 2D avatar is rigged: a handful of broad **drivers** are read off your
performance — where your head is pointing, where your torso is leaning, how high
your arms are — and those drivers are then fanned back out across your whole body.

That fixes both problems at once.

**It looks more alive.** A head turn no longer stops at the neck: it travels down
through the chest, the spine and the hips, each a little less than the one above
and each a little later, so your body reads as one connected performance. The
head also stays level when your body leans, your shoulders lag behind a turn, and
each shoulder lifts when you raise that arm — the small things a person does
without thinking, that tracking almost never captures.

**It stops breaking.** The bones the rig drives are *rebuilt* from the drivers
rather than copied from tracking, and the drivers are capped at a fixed range and
not allowed to move faster than a person can move. A tracker that glitches can at
worst nudge a driver, so a broken frame becomes a small wobble instead of a
snapped limb.

### Body vs head

2D rigs are built on one of two conventions, and this picks between them.

**Body follows head** — you turn your head, and the chest, spine and hips turn
with it. The whole body leans into the look. It reads as warm and engaged, and
it is the gentler of the two.

**Body counters head** — you turn your head, and the torso twists the other way.
This is the contrapposto or S-curve read: theatrical, posed, more of a
"character" silhouette. Note that it is not simply the first one reversed — the
head and neck carry noticeably more rotation to make up for the torso
subtracting instead of adding, so you still end up looking where you're looking.

Neither is more correct; they are different characters. Try both and keep the
one that looks like your avatar.

(There is a second, separate coupling that runs the other way: your head always
counter-rotates against your *body's* lean, so your gaze stays level. That one is
on in both, because it is what makes a body read as a performer rather than a
puppet.)

### The controls

**Amount** is the dial between the two worlds: 0 is your tracking untouched, 1 is
fully stylized. Anywhere in between is a blend, so you can keep some of your own
precision and still get the follow-through. Start at 1 and come down if it feels
too smooth.

**Follow-through** is how far the body trails behind the drivers, in seconds.
Larger is looser and more cartoon-like; 0 makes everything move together. If you
want the motion to *overshoot* and settle rather than just catch up, turn on
**Motion Snappiness** on the avatar itself — it layers on top of this.

**Rest bones the rig doesn't drive** sends everything outside the rig (fingers,
legs) back to its neutral pose instead of passing tracking through. Reach for it
when your hand tracking is the thing misbehaving.

### Response

The **Response** section decides how your movement becomes drivers. The three
*range* values are how far you have to move for a full-strength response — lower
them to get big stylized motion out of small movements, raise them if the avatar
feels twitchy.

The rest is conditioning. **Deadzone** is how much movement still counts as
holding still, which is what stops sensor noise from making the avatar shimmer.
**Max rate** is the speed limit that turns a tracking glitch into a short slide
instead of a pop — lowering it makes the avatar calmer and more forgiving.
**Smoothing** softens everything at the cost of a little delay.

### Response rig

The **Response rig** is the mapping itself, and you can edit every bone of it.
Each bone lists the drivers that move it and how many degrees each one
contributes at full strength, in X / Y / Z.

A bone is in one of two modes. **Replace** means the bone is built entirely from
the drivers and tracking is discarded — that is what makes it glitch-proof, and
it is the right choice for the spine, neck, head and shoulders. **Add** keeps
your tracked motion and layers the rig's contribution on top, which is what the
arms use so your own gestures survive.

Switching preset re-baselines the whole editor, but bones you have already
overridden keep your numbers — reset a bone (or the whole rig) to pick up the
new preset's values for it.

**Lag** is a per-bone multiplier on Follow-through. The stock rig staggers it
down the chain — the hips trail furthest, the head barely at all — which is what
produces the whip-and-settle feel. You can add drivers to a bone, add bones that
the stock rig ignores (legs, for a full-body swaying idle), and reset any bone or
the whole rig back to stock at any time.

One nice side effect: because replace-mode bones are synthesized rather than
copied, they are driven even if your tracker never sends them. A face-only
tracker will move your entire body through this rig.

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
