# Timeline / Track Clips {#track-clips}

A **Track Clip** is a short recorded animation you attach to an avatar, scene
node, or compose layer. When you play a clip, vspark smoothly moves or fades
the target according to the keyframes you placed — no live motion-capture needed.
Clips live in the **Clips** tab in the bottom dock and are created from the
node's or layer's Clips section in the left dock.

## What are Track Clips? {#what}

Think of a Track Clip like a short loop of choreography you save and replay
whenever you like. Inside each clip there are one or more **lanes** (tracks),
each driving a single property of your avatar or scene — for example the
X position of a camera or the opacity of a compose layer. The clip has a fixed
**duration** (in seconds), and you scatter **keyframes** along the timeline to
describe how that property changes over time.

You can stack several clips on the same node at once, and choose whether each
clip **replaces** the normal value or is **added on top** of it. Enabling
**loop** makes the clip restart automatically at the end; enabling **autoplay**
makes it start again whenever vspark boots up.

## Lanes {#lanes}

A **lane** targets exactly one property of one object. When you click
**+ Add Lane** you pick:

- **Target** — a scene node (avatar, camera, light, group) or a compose layer.
- **Parameter** — which property to animate. For scene nodes you can animate
  position X/Y/Z, rotation X/Y/Z, or scale X/Y/Z. For compose layers you can
  animate X, Y, and rotation.

Each lane shows its animated values as a curve in the timeline area. You can
remove a lane with the × button on its row; the other lanes in the same clip
are unaffected.

## Keyframes {#keyframes}

![Easing curves](/help/diagrams/easing-curves.svg)

*Easing shapes how a value moves between keyframes: green = linear (constant), yellow = step (jump), blue = bezier (smooth ease in/out).*

A **keyframe** marks a moment in time at which a property has a specific value.
Between two keyframes vspark interpolates (fills in the in-between values)
according to the **easing** you choose:

| Easing | What it does |
|--------|-------------|
| **linear** | Steady, constant change from one keyframe to the next. |
| **step** | Jumps instantly to the new value with no interpolation. |
| **bezier** | Smooth, organic curve you shape by dragging the handles. |

**To add a keyframe** drag the playhead (the vertical line) to the time you
want, then click on a lane's timeline area. **To move a keyframe** drag it left
or right along the lane. **To delete a keyframe** right-click it and choose
Delete, or select it and press the Delete keyframe button in the inspector
panel below the timeline.

Click any keyframe to select it and reveal the inspector, where you can type
an exact value, choose the easing mode, and drag the bezier handles to shape
the curve.

## Transport — play, pause, stop, resume {#transport}

The transport bar at the top of the timeline controls playback:

| Button | What it does |
|--------|-------------|
| **Play** | Starts the clip from the beginning (or from the current playhead position). |
| **Pause** | Freezes the playhead mid-clip; the avatar holds the current pose. |
| **Resume** | Continues from a paused position. |
| **Stop** | Stops playback and resets the avatar back to its resting pose. |

The **playhead** scrubber shows the current position in seconds. Drag it to
preview any moment in the clip without playing through to it.

If **loop** is on, the clip automatically starts over after the last keyframe.
This is useful for idle animations or looping overlays you want to run
continuously.

## Recording keyframes from the Properties panel {#recording}

The quickest way to add keyframes is to set the properties you want **while a
clip is selected** and then mark them with the **diamond (◆) buttons** in the
Properties panel:

1. Select the clip in the Clips section of the left dock (the clip name turns
   highlighted and the bottom dock switches to the Clips tab).
2. Drag the playhead in the timeline to the moment you want to record.
3. In the **Properties** panel on the right, adjust the value for the property
   you want (for example move the X position slider).
4. Click the **◆** button next to that property. vspark creates a lane for that
   property (if one doesn't exist yet) and drops a keyframe at the current
   playhead position with the value you set.

Repeat steps 2–4 at different times to build up the animation. You can always
drag the keyframes afterward to fine-tune timing.
