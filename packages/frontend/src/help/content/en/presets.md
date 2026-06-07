# Presets {#presets}

Presets let you save a node or compose layer — along with all its settings —
as a reusable building block. Once saved, you can drop the same setup into any
scene with a single click, without having to configure everything from scratch
each time.

## What is a preset? {#what}

A preset is a snapshot of a scene node (such as an avatar, camera, or light)
or a Compose layer, including its components, animations, and property values.
Think of it as a template you can reuse across projects.

vspark ships with a set of **built-in presets** for common setups. You can
also build and save your own from anything you've already set up in a scene.

## Saving a preset {#saving}

1. Select the node or Compose layer you want to save in the scene graph.
2. Open the **Preset Library** panel and click **Save**.
3. Give the preset a name and an optional description.
4. If the preset references asset files (VRM models, audio clips, images),
   tick **Embed assets** to bundle them into the preset so it works when
   shared with other projects. Leave it unticked to keep file sizes small
   when you only use the preset within the same project.
5. Click **Save** to confirm.

The preset now appears in the **Project** section of the library.

You can also click **Copy** to copy the current selection to the clipboard
as a one-off transfer without saving a named preset.

## Adding a preset to your project {#using}

To drop a preset into the scene, click **Use** on any preset card in the
library. vspark places it:

- as a new node under the currently selected node, if it's a **scene node**
  preset.
- as a new layer under the currently selected layer, if it's a **Compose**
  preset.

Built-in presets work the same way — just click **Use** on the card.

You can also **Import** a `.json` file exported from another vspark project,
or **Paste** one you copied to the clipboard on another machine.
