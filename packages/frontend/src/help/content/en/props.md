# Props {#props}

**Props** are extra objects you place in your 3D scene alongside your avatar.
They are not characters — they are decoration, media, and interactive elements
that make your stream space feel alive.

## What are props? {#what}

A prop is any scene node that is not an avatar, camera, or light. You can place
as many props as you like, position them anywhere, parent them to bones (so a
prop follows a hand), and animate them with track clips or Logic.

Current prop types: image planes, video planes, audio sources, text labels,
particle emitters, and in-scene feed overlays.

## Image {#image}

An **image plane** (also called a **billboard**) displays a still image in
your 3D world. You can upload any PNG or JPG and it will appear as a flat,
textured rectangle.

- **Facing: Screen** — the image always rotates to face the camera, like a
  sprite. Good for logos, stickers, or flat decorations that should always be
  readable.
- **Facing: World** — the image has a fixed orientation in 3D space. Good for
  frames or signs placed at a specific angle.
- Adjust **width**, **height**, and **alpha** to resize or fade the image.

## Video {#video}

A **video plane** plays a video file in the scene. It works exactly like an
image plane but animates.

- Supports **autoplay**, **loop**, and a choice of what happens when the video
  ends (freeze on last frame or hide the plane).
- **Volume** and **mute** control the audio track of the video.
- **Chroma key** removes a background colour (e.g. green screen) so the video
  appears cut out against the scene.
- **Blend modes** (Normal, Additive, Multiply, Screen) control how the video
  composites over the scene behind it.

You can trigger playback and pause from Logic automations or track clips.

## Audio {#audio}

An **audio node** plays a sound file in the scene without showing any geometry.

- **Simple** audio plays the same volume everywhere in the scene — good for
  background music or global ambience.
- **Directional** audio falls off with distance from the node's position,
  creating a 3D spatial feel. Configure the falloff distance and cone angles to
  shape the sound zone.
- Supports **autoplay**, **loop**, and volume control.
- Audio is muted in the editor by default; it plays in the viewer output.

## Text {#text}

A **text node** renders a line or block of text directly in the 3D scene. Two
rendering engines are available:

- **Troika text** — high-quality SDF (smooth at any size) text. Best for short
  labels, names, and headings you want crisp at all sizes.
- **Canvas text** — rasterised text painted onto a plane. Supports **Allow
  HTML**, which lets you embed styled HTML (including emote images) that is
  sanitised and rendered into the texture.

Both support **Facing: Screen** (always readable, turns to camera) and
**Facing: World** (fixed in 3D space), colour, and font size.

## Particles {#particles}

A **particle emitter** spawns many small sprites and simulates their movement
over time. Common uses: fire, smoke, sparkles, confetti, rain.

Key settings:

- **Texture** — the sprite image used for each particle. Several built-in
  shapes are available; you can also use any image asset.
- **Emission rate** — how many particles spawn per second. Burst mode fires
  them all at once.
- **Lifetime** — how long each particle lives before disappearing.
- **Direction, speed, and spread** — where particles travel.
- **Size and colour over lifetime** — particles can shrink, grow, or shift
  colour as they age.
- **Gravity and turbulence** — bend the particle paths for naturalistic motion.

## Feed (in-scene overlay) {#feed}

A **feed node** places a live data overlay directly inside the 3D scene, as a
textured plane. This is the 3D equivalent of a feed layer in Compose.

- The content is driven by **data channels** — named fields sent from stream
  events (e.g. a subscriber alert, chat message, or custom Logic output).
- You write a small **template** (using `{{fieldName}}` placeholders) that
  vspark fills in whenever new data arrives.
- Custom **CSS** controls the visual styling.
- Like text nodes, feed nodes can face the camera or hold a world orientation.

For a full explanation of data channels and templates, see
[Logic](topic:logic).
