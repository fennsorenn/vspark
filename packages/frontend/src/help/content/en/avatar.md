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

> Tip: if your avatar looks frozen, check that a motion-capture behavior is
> attached and connected — see [Behaviors](topic:behaviors).

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
