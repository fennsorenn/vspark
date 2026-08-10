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

### Nothing arrives, but the app says it is connected {#ifacialmocap-firewall}

This is almost always the **firewall** on your computer.

The app tells you it is connected as soon as it starts *sending*. It has no way
to know whether anything reaches vspark, so a blocked incoming port looks exactly
like a healthy connection from the phone's side — while vspark sits with a dark
connection dot and a motionless avatar.

Allow incoming **UDP on port 49983** and it starts working immediately, with no
restart needed. On Windows the prompt usually appears the first time vspark
opens the port; if you dismissed it once, the rule has to be added by hand.

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

### Presets

A preset is a starting point for the whole behavior — the body mapping, and
sometimes how much you have to move and how far the body trails. Everything after
it is yours to adjust; switching preset re-baselines anything you haven't
personally changed.

**Body follows head** *(default)* — you turn your head, and the chest, spine and
hips turn with it. The whole body leans into the look. Warm and engaged, and the
gentler of the two conventions.

**Body counters head** — you turn your head, and the torso twists the other way.
The contrapposto or S-curve read: theatrical, posed, more of a "character"
silhouette. It is not simply the first one reversed — the head and neck carry
noticeably more rotation to make up for the torso subtracting instead of adding,
so you still end up looking where you're looking.

**Head-driven, body follows** — your head is the *only* thing steering the
avatar. Torso and arm tracking are ignored completely. Reach for it in two
situations: you're using a face-only tracker (a phone or webcam face tracker
gives head rotation and nothing else — this makes that drive a whole body), or
your body tracking is too noisy to trust and the head is the one clean signal.
The body turns noticeably more per unit of head movement to make up for having no
other input.

**Head-driven, body counters** — the same, with the contrapposto twist: your head
steers, and the torso turns against it. Pick between these two the same way you'd
pick between the first pair; it's the same choice of character, on a head-only
signal.

In both head-driven presets, **nodding stays in your head and neck** rather than
travelling down the spine. That's deliberate: turning and tilting are whole-body
gestures — you pivot from the hips to look behind you — but a nod spread through
the spine stops reading as a nod and starts reading as a *bow*, which means
something else entirely.

**Expressive** — the same mapping as *Body follows head*, but it takes far less
movement to reach full strength, and the body trails further behind. For
performers who stay fairly still and want the avatar to read as animated anyway.
Note this one deliberately **amplifies**: your avatar rotates about 1½× as far as
you do. If you want faithful tracking with a livelier body, stay on *Body follows
head* and turn Amount up instead.

Neither of the first two is more correct; they are different characters. Try them
and keep the one that looks like your avatar.

(There is a second, separate coupling that runs the other way: your head always
counter-rotates against your *body's* lean, so your gaze stays level. That one is
on in every preset, because it is what makes a body read as a performer rather
than a puppet.)

### The controls

**Blend** is the dial between the two worlds: 0 is your tracking untouched, 1 is
fully stylized. Anywhere in between is a mix, so you can keep some of your own
precision and still get the follow-through. Start at 1 and come down if it feels
too smooth.

**Strength** is the quick overall adjustment: a multiplier on how far the
stylized motion travels. 1 is the rig as designed, below 1 tones the whole thing
down, and above 1 exaggerates it — up to double.

The two are easy to confuse, so: **Blend asks how much of the styling you want,
Strength asks how big it should be.** Turning Blend down lets more of your real
tracking show through. Turning Strength down keeps the styling in full control
but makes it move less. Notably, Strength can go *above* 1 to push past the
authored rig, which Blend cannot — it stops at "fully stylized". If the motion
feels right but too big or too small, reach for Strength; if you want more of
your own precision back, reach for Blend.

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

The **Response rig** is the mapping itself, and there are two ways to edit it.

**Simplified** (the default) treats you as a head and a body. Six motions — the
head turns, tilts and nods; the body turns, sways and leans — laid out as a grid.
Each cell says how far one of those motions moves that part, in degrees. Reading
down the *Body turn* row tells you what makes the body turn: itself, or your head,
or both.

The last three rows are the **body shift**: instead of turning, they slide your
whole body sideways, up or forward. Rotation alone pivots you around a fixed
pelvis, which looks stiff — letting the hips actually travel a little is most of
what turns a lean into real weight. These are measured as a share of your
avatar's hip height rather than in degrees, so the same setting looks right on a
tall model and a small one.

Change a cell and the whole chain rescales together, keeping the shape the preset
gave it — the hips still move less than the chest, the falloff is preserved. Two
things follow along on their own: the arms keep counteracting the body by the same
proportion, and the head keeps counter-rotating so your gaze stays level. Those
counter-motions are the negative cells in the grid, so you can see and change them.

A tip for reading a preset: if the *Body turn* row is empty in its own column but
has a value under *Head turn*, you're looking at a head-driven preset — the body
is moving entirely because your head is.

**Per bone** opens the full table: every bone lists the drivers that move it and
how many degrees each contributes at full strength, in X / Y / Z.

A bone is in one of two modes. **Replace** means the bone is built entirely from
the drivers and tracking is discarded — that is what makes it glitch-proof, and
it is the right choice for the spine, neck, head and shoulders. **Add** keeps
your tracked motion and layers the rig's contribution on top, which is what the
arms use so your own gestures survive.

**You can move between them freely.** Switching carries your setup across
unchanged — your avatar will not so much as twitch. Going to *Per bone* writes out
exactly what the simplified view was producing, so you can start fine-tuning from
there; going back collapses to the section totals again.

**Lag** is a per-bone multiplier on Follow-through. The stock rig staggers it
down the chain — the hips trail furthest, the head barely at all — which is what
produces the whip-and-settle feel. You can add drivers to a bone, add bones that
the stock rig ignores (legs, for a full-body swaying idle), and reset any bone or
the whole rig back to stock at any time.

One nice side effect: because replace-mode bones are synthesized rather than
copied, they are driven even if your tracker never sends them. A face-only
tracker will move your entire body through this rig.

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
