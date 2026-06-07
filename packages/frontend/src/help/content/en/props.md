# Props {#props}

Props are extra objects you place in your 3D scene alongside your avatar: image planes, video planes, audio sources, text labels, particle emitters, and in-scene feed overlays. Select a prop node to see and edit its parameters in the Properties panel.

## Image (billboard) {#image}

An image plane displays a still image as a flat rectangle in the 3D world. Upload any PNG or JPG via the Assets panel, then assign it here.

**Image (texture URL)** — the file or URL of the image to display. Use the Pick button to browse uploaded assets, or paste a URL directly. Leaving this empty shows a plain white rectangle.

**Facing** — how the plane is oriented relative to the camera:

- `Screen` — the plane always rotates to face the viewer, like a sprite. The image is always readable regardless of where the camera is. Good for logos, icons, and flat decorations.
- `World` — the plane has a fixed orientation in 3D space. Rotate it using the Transform controls. Good for picture frames, signs, or any surface that should stay at a specific angle.

**Backface** — what is shown on the back side of the plane (the side facing away from the front):

- `None` — no back face; the plane is invisible when viewed from behind.
- `Mirror` — the image is shown horizontally flipped on the back. Good for signs that should be readable from both sides.
- `Unmirrored` — the image is shown unflipped on the back. Good for double-sided posters where mirroring would look wrong.

**Width** — the plane's width in world units. Default: 1. One world unit is roughly the height of an average avatar. Increase to make the image larger; decrease for small stickers.

**Height** — the plane's height in world units. Default: 1. Adjust independently from Width to match your image's aspect ratio.

**Alpha** — overall opacity of the plane, from 0 (invisible) to 1 (fully opaque). Default: 1. Lowering this fades the image uniformly, useful for subtle background layers.

## Video {#video}

A video plane plays a video file in the scene. The plane geometry works identically to the image billboard, with added playback and compositing controls.

**Source** — the video file or URL to play. Use the Pick button to choose an uploaded video asset.

### Playback {#video-playback}

**Autoplay** — when enabled, the video starts playing as soon as the scene loads. Default: on. Disable to start playback from a Logic automation or track clip.

**Loop** — when enabled, the video restarts from the beginning when it reaches the end. Default: on.

**On end** — what happens when the video reaches its last frame and Loop is off:

- `Freeze` — the video pauses on the last frame. The plane stays visible. Default.
- `Hide` — the plane disappears when the video ends.

**Muted** — when enabled, the video's audio track is silenced. Default: on. Unmute to allow the video's own audio to play; use Volume to set the level.

**Volume** — the playback level of the video's audio track, from 0 to 1. Default: 1. Only audible when Muted is off.

### Chroma key {#video-chroma}

Chroma keying removes a specific background color from the video, making that color transparent. Use this to composite green-screen or blue-screen video directly in the 3D scene.

**Chroma key (enabled)** — checkbox that activates the chroma key shader. The controls below only have effect when this is on.

**Key color** — the color to remove. Click the swatch to open the color picker. Default: pure green (#00ff00). Set this to match the background color of your video footage.

**Similarity** — how close a pixel's color needs to be to the key color before it is made transparent, from 0 to 1. Default: 0.4. Lower values only remove pixels that closely match the key color (less spill removed, harder edge). Higher values remove a broader range of colors (more background removed, but may also cut into subject edges).

**Smoothness** — controls the softness of the edge between keyed-out and kept areas, from 0 to 1. Default: 0.08. At 0 the edge is a hard cut. Increase to feather edges and reduce jagged outlines — useful when the subject has fine hair or soft edges.

**Spill** — how aggressively green (or key-color) tinting is removed from the edges of the subject, from 0 to 1. Default: 0.1. When a subject is lit near a green screen, their edges often pick up a green tinge. Increasing Spill desaturates that fringe color. Set too high and skin tones near the edge may lose saturation.

**Plane controls** — the video plane shares the same Facing, Backface, Width, Height, and Alpha controls as the image billboard. See the [image](#image) section above for their descriptions. The defaults differ: Facing defaults to `World` and dimensions default to 1.6 × 0.9 (16:9 aspect ratio).

**Blend mode** — how the video frame composites over the scene:

- `Normal` — standard alpha compositing. The video covers what is behind it according to its alpha. Default.
- `Additive` — the video's color is added to the scene. Transparent or dark areas of the video let the scene show through and accumulate brightness. Good for glows or light effects.
- `Multiply` — the video's color is multiplied against the scene. Darkens what is behind it; white in the video is transparent. Good for shadow overlays.
- `Screen` — a soft-light blend that brightens the scene without the harshness of additive. Good for fog, haze, or subtle brightening.

## Audio {#audio}

An audio node plays a sound file in the scene. It has no visible geometry.

**Source** — the audio file or URL to play. Use the Pick button to choose an uploaded audio asset.

**Type** — how the audio is spatialized:

- `Simple` — the sound plays at the same volume everywhere in the scene, regardless of camera or listener position. Use for background music, ambient loops, or any sound that should be globally audible. Default.
- `Directional` — the sound falls off with distance and can be shaped into a cone. Requires the Spatial section to be configured. Use for in-scene speakers, character voices, or sound sources that should feel positioned in 3D space.

### Playback

**Autoplay** — when enabled, playback begins as soon as the scene loads. Default: on.

**Loop** — when enabled, the audio restarts when it reaches the end. Default: off.

**Volume** — playback level from 0 to 1. Default: 1.

### Spatial (directional only) {#audio-spatial}

These controls only appear when Type is set to `Directional`. They use the Web Audio API's `PannerNode` model.

**Reference distance** — the distance (in world units) at which the sound plays at its set Volume with no falloff. Default: 1. When the listener is closer than this distance, the volume does not increase further. Set this to a small value (0.5 – 1) for a tight source; raise it to have the full volume audible at a wider radius.

**Rolloff factor** — how quickly the volume decreases beyond the reference distance. Default: 1. Higher values (2 – 3) cause the sound to fade out sharply with distance. Lower values (0.1 – 0.5) make the sound carry much further before becoming inaudible. Set to 0 for no distance attenuation at all.

**Max distance** — the distance at which volume reaches its minimum level and does not decrease further. Default: 100 world units. At very large values sound remains just barely audible even very far away. Reduce to create a sound that goes fully silent at a defined radius.

**Cone inner angle** — the angle (0 – 360°) of the inner cone in which the sound plays at full volume. Default: 360°. At 360° the cone covers all directions — the sound is equally loud all around. Reduce (e.g. to 60°) to make the sound loudest only directly in front of the node. The node's orientation (set via Transform) determines which direction is „forward."

**Cone outer angle** — the angle (0 – 360°) of the outer cone beyond which the Cone outer gain level is applied. Default: 360°. Must be greater than or equal to Cone inner angle. Set to a value larger than the inner angle to create a gradual fade zone between full and outer gain.

**Cone outer gain** — the volume multiplier applied to sound heard outside the outer cone, from 0 to 1. Default: 0. At 0 the sound is completely silent outside the cone. At 0.5 it plays at half volume outside. Raise slightly if you want listeners behind the source to still hear something faint.

## Text {#text}

A text node renders a string directly in the 3D scene. Two rendering engines are available; the node kind (text_troika vs text_canvas) is selected when you add the node.

**Content** — the text string to display. For troika text this is plain text. For canvas text, if Allow HTML is enabled, you may include HTML tags (they are sanitised before rendering).

**Facing** — `Screen` keeps the text always turned toward the camera; `World` gives it a fixed orientation in 3D space (same as billboard Facing described above).

**Color** — the text color. Click the swatch to pick a color. Default: white.

**Font size** — the size of the text. For troika text this is in world units (default 0.2, roughly label-sized). For canvas text this is in pixels on the internal canvas (default 48 px). Increase to make the text larger.

**Padding** *(canvas only)* — space in pixels between the text and the edges of the rendered texture. Default: 16 px. Increase to prevent letters from being clipped at the edge.

**Width** *(canvas only)* — the width of the plane in world units. Default: 2. Resize to match your content length.

**Height** *(canvas only)* — the height of the plane in world units. Default: 0.5.

**Allow HTML** *(canvas only)* — when enabled, the content string is parsed as HTML, allowing tags like `<b>`, `<span style="...">`, or `<img>` for inline images. The HTML is sanitised before rendering. Default: off.

**Anchor X** *(troika only)* — horizontal alignment of the text block relative to the node's position: `left`, `center` (default), or `right`. Controls where the text origin sits horizontally.

**Anchor Y** *(troika only)* — vertical alignment: `top`, `middle` (default), or `bottom`. Controls where the text origin sits vertically.

**Max width** *(troika only)* — if greater than 0, long lines are wrapped to fit within this width in world units. Default: 0 (no wrapping). Set to a value like 1.5 to make multi-line paragraphs.

## Particles {#particles}

For the full parameter reference for particle emitters, see [Particles](topic:particles).

## Feed (in-scene overlay) {#feed}

A feed node renders live data as HTML inside the 3D scene, displayed on a textured plane. The content updates whenever new data arrives on the linked data channel.

**Billboard** — when enabled, the plane always faces the camera (same as image Facing: Screen). Default: on. Disable to give the feed a fixed world orientation.

**Color** — default text color applied to the template content. Default: white. This can be overridden by CSS.

**Font size** — the base font size in pixels used when rendering the HTML template to the internal canvas. Default: 28 px.

**Padding** — space in pixels between the content and the edges of the canvas. Default: 16 px.

**Width** — the plane width in world units. Default: 2.

**Height** — the plane height in world units. Default: 1.2.

**Template** — an HTML snippet with `{{fieldName}}` placeholders. When a data event arrives, vspark substitutes the placeholders with the corresponding values and re-renders the canvas. Example: `<div>{{username}} just subscribed!</div>`.

**CSS** — additional CSS rules injected into the rendered document, scoped to the template output. Use to customize fonts, layout, animations, and colors beyond what inline styles provide. Leave empty to use only the Color and Font size controls above.

For a full explanation of data channels and how to send data from Logic, see [Logic](topic:logic).
