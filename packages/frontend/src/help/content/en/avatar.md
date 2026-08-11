# Avatar {#avatar}

An **avatar** is the 3D character you control. vspark uses the open **VRM**
format, so any `.vrm` file — whether you made it yourself or downloaded it —
will work. Once an avatar is on the [Stage](topic:scene), behaviors and motion
data drive it in real time.

## Loading a character {#loading}

Add an avatar node to your scene, then pick a `.vrm` file to load into it. The
file is stored with your project, so it loads again automatically next time.

A freshly loaded avatar stands in a neutral rest pose. It only starts moving
once a [behavior](topic:behaviors) feeds it motion — for example webcam
tracking or a VMC connection.

## Animation {#animation}

Animation is movement applied to the avatar's skeleton over time. It comes from
two main sources:

- **Live motion** — captured from your webcam, phone, or tracking hardware and
  applied frame by frame. This is what makes the avatar mirror you.
- **Animation clips** — pre-recorded movements (idle, waving, dancing) that you
  can trigger. These are useful for moments when you aren't actively tracking.

The **idle animation** is a base loop that plays continuously whenever nothing
else is driving the avatar. It is timed against a shared clock, so every viewer
— including collaborators — sees it at the same point in the loop.

When both are active, vspark blends them so the transition looks smooth rather
than snapping. The blend time is adjustable per avatar.

Tracking is rarely perfect: the signal can freeze for a moment, or a few packets
can go missing, without the connection actually dropping. **Idle after** sets how
long such a gap is tolerated before the avatar gives up and returns to its idle
animation. Raise it if your avatar drops to idle during brief dropouts; lower it
if it keeps holding a frozen pose too long after you stop tracking. It pairs with
the blend time: this setting decides *when* the return to idle starts, the blend
time decides *how fast* it runs. Every tracking source on the avatar (VMC,
camera tracking) shares the one setting.

> Tip: if your avatar looks frozen, check that a motion-capture behavior is
> attached and connected — see [Behaviors](topic:behaviors).

## Motion snappiness {#snappiness}

Motion-capture data is usually smoothed before it reaches vspark, and vspark
smooths it again to ride out network hiccups. That keeps movement stable, but it
can also make it feel a little soft or floaty. **Motion snappiness** adds back a
sense of crispness without reintroducing jitter.

Turn it on per avatar, then tune three dials:

- **Frequency** — how quickly the avatar reacts. Higher feels snappier; very high
  can look twitchy.
- **Damping** — how much it settles versus bounces. Around 1 stops cleanly with
  no overshoot; below 1 adds a lively little overshoot (the "snap"); above 1
  feels heavy and sluggish.
- **Response** — how eagerly it leads into a movement. 0 is neutral; higher
  values make the avatar anticipate and accelerate into motion for extra punch.

> Tip: start with the defaults, then nudge **Damping** down slightly for more
> snap. If motion starts to wobble or buzz, raise **Damping** or lower
> **Frequency**.

## Partial tracking {#partial-tracking}

**Partial tracking** lets you drive different parts of the body from different
sources at the same time — for example, play a looping dance animation on the
**legs** while your live tracking drives the **upper body**.

The body is split into six sections: **Head**, **Gaze** (eyes), **Body**
(torso), **Arms**, **Hands** (fingers), and **Legs**. Each section has two
sliders:

- **Anim** — how strongly the **base animation** drives that section.
- **Track** — how strongly live tracking (VMC or camera) drives it.

Tracking **stacks on top of** the base animation, and each slider scales its
layer independently. The section starts at its rest pose, **Anim** blends the
base animation in, and **Track** adds the live tracking on top:

- **Anim 1 / Track 1** — the base animation with full tracking stacked on it.
- **Anim 1 / Track 0** — animation only (e.g. legs following a clip).
- **Anim 0 / Track 1** — tracking only.
- **Anim 0 / Track 0** — the section rests.
- Values in between scale each layer, so both sliders always affect the pose.

Sections you never touch stay at the default (**Anim 1 / Track 1**), so you only
need to adjust the parts you want to change.

> These sliders only apply **while a tracking source is live**. With tracking
> lost — or no tracking source enabled at all — the **idle animation** plays at
> full strength and the sliders are ignored, so a low **Anim** value never
> weakens your idle.

> The hips belong to the **Legs** section — both their rotation and their
> **position** (the root motion: the up/down bob and weight-shift a clip bakes
> in), since the hips lead the lower body. So **Legs Anim 0** plants the hips in
> place and rests them along with the legs, while the **Body** section covers the
> spine and chest.

### Base animation

The **Base animation** (set in the Animation section) is the loop that tracking
stacks onto while a tracking source is connected — separate from the **Idle
animation**. When tracking drops, the avatar falls back to the idle. If you
don't set a base animation, the idle doubles as the base.

You can assign either loop straight from the **Assets** panel: with the avatar
selected, each animation clip shows **Set as idle** and **Set as base** buttons.

> Note: driving the **legs** from tracking needs a full-body tracking source
> (a full-body VMC sender). Webcam tracking doesn't send legs yet, so with a
> webcam use **Anim** for the legs and **Track** for the upper body.

## Expressions {#expressions}

Expressions are facial poses defined inside the VRM, such as smiling, blinking,
or vowel mouth shapes. They are driven separately from body motion:

- **Lip sync** turns your microphone audio into mouth shapes.
- **Face tracking** copies your real expressions from the webcam.
- **Default expression** lets you set a resting face the avatar holds when
  nothing else is overriding it.

## Materials {#materials}

Materials control how the avatar's surface looks under light. Each material on
the model can use one of a few styles:

- **Toon** — flat, anime-style shading that ignores most scene lighting.
- **Realistic** — responds to your scene's lights and reflections for a more
  physical look.

You can switch styles per material and reset back to how the model was authored
at any time.

## Calibration {#calibration}

Calibration corrects differences between your body and the avatar's proportions
so the motion lines up naturally — for example matching your arm length to the
character's. Most tracking behaviors include a calibration step; follow the
on-screen prompt while standing in a neutral pose.

## Forearm twist {#twist}

When the avatar rotates its wrist (pronation/supination), a standard VRM has only
one forearm bone, so the whole twist lands at the elbow — the forearm looks like
a wrung-out cloth. **Force twist bone** adds a hidden helper bone partway down
each forearm and re-weights the forearm so the rotation spreads smoothly from the
elbow to the wrist, the way a real arm twists. The hand keeps the exact same
orientation; only the surface in between is smoothed.

If the model was authored with its own forearm twist bones, those are used
automatically and this toggle is unnecessary. The toggle has no effect on the
rest pose — you only see the difference while the wrist is rotating.

**Exclude sleeves** keeps the twist off loose sleeve and cuff geometry, so a
baggy sleeve bends with the arm without spiralling like skin. It works by
keeping the twist only on surfaces that connect back to the hand, so separate
clothing shells are left out. Turn it off if a fitted sleeve should twist along
with the arm, or if a sleeve is the only forearm geometry the model has.
