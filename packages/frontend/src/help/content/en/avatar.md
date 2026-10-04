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

## Tracking mix {#tracking-mix}

The **Tracking mix** controls how strongly each source moves your avatar. A
source is the **animation** (the base or idle clip) or one of the avatar's
tracking behaviors — VMC, iFacialMocap, webcam tracking, Breathing, Lip sync,
and so on. Use it to, for example, play a dance animation on the **legs** while
live tracking drives the **upper body**, or to let webcam tracking steer the
head while a VMC sender does the arms.

In the sidebar every source has one slider that sets its weight everywhere.
Click **Open mixer…** for the full editor:

- **Body** — a grid of body regions (**Head**, **Gaze**, **Body**, **Arms**,
  **Hands**, **Legs**) × sources. Click a region to expand it and set single
  bones.
- **Face** — the model's expressions, grouped into **Mouth**, **Eyes**,
  **Brows**, **Emotions** and **Other**, × the sources that send expressions.

Each weight runs from **0** to **2**:

- **1** — the source at full strength (the default everywhere).
- **0** — the source has no influence there.
- **Between 0 and 1** — the source is scaled down.
- **Above 1** — the source is amplified, e.g. to exaggerate a subtle sender.

Tracking **stacks on top of** the animation. A region starts at its rest pose,
the animation weight blends the clip in, and each tracking source's rotation is
added on top, scaled by its weight. Weights do **not** have to add up to 1: two
sources at 0.5 each roughly average out, while Breathing at 1 on top of full
tracking adds its motion to it. A part that every tracking source weighs 0
follows the animation alone; an expression that every source weighs 0 returns
to the default expression.

**Regions and single bones.** Moving a region (or face group, or the sidebar
slider) sets every bone in it. Once you change a single bone, the region shows
**Custom** instead of a slider. Its reset button sets all of the region's bones
to the value most of them already share (the higher one on a tie), or to 1 if
no value repeats.

> The animation weights only apply **while a tracking source is live**. With
> tracking lost — or no tracking source enabled at all — the **idle animation**
> plays at full strength, so a low animation weight never weakens your idle.

> The hips belong to the **Legs** region — both their rotation and their
> **position** (the root motion: the up/down bob and weight-shift a clip bakes
> in), since the hips lead the lower body. So an animation weight of 0 on the
> hips plants them in place, while the **Body** region covers the spine and
> chest.

### Source order {#tracking-mix-order}

The **Body** tab lists the tracking sources in the order they are applied, left
to right, on top of the animation. Use the arrows to move a source earlier or
later. Order only matters where two sources rotate the **same** bone in
**different** directions — rotations combine like turning a dial and then
tilting it, which ends somewhere different from tilting first. Expressions are
simply added, so their order doesn't matter.

### Base animation {#base-animation}

The **Base animation** (set in the Animation section) is the loop that tracking
stacks onto while a tracking source is connected — separate from the **Idle
animation**. When tracking drops, the avatar falls back to the idle. If you
don't set a base animation, the idle doubles as the base.

You can assign either loop straight from the **Assets** panel: with the avatar
selected, each animation clip shows **Set as idle** and **Set as base** buttons.

> Note: driving the **legs** from tracking needs a full-body tracking source
> (a full-body VMC sender). Webcam tracking doesn't send legs yet, so with a
> webcam the legs follow the animation — the **Tracking mix** can't add leg
> motion a source doesn't send.

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
