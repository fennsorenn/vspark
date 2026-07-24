# Assets {#assets}

The **Assets** dock at the bottom of the editor is where you bring your own
files into vspark. Upload once, use everywhere: the same file can be applied
to multiple objects in your scene without being re-uploaded.

## What are assets? {#what}

Assets are files you add to a project so vspark can use them. They stay stored
inside the project and are always available across your sessions. The kinds of
files vspark accepts are:

- **3D models / VRM** — your avatar or any other 3D object (`.vrm`, `.glb`, `.gltf`).
- **Animations** — movement data you apply to an avatar or model (`.fbx`, `.bvh`).
- **Images** — stills used as textures, overlays, or scene backgrounds (`.png`, `.jpg`, `.webp`, `.gif`, and more).
- **Videos** — video clips placed in the scene or in the Compose view (`.mp4`, `.webm`, `.mov`, and more).
- **Audio** — sound files played as part of the scene (`.mp3`, `.wav`, `.ogg`, and more).

## Uploading files {#uploading}

There are two ways to add files to the Assets dock:

1. **Drag and drop** — drag one or more files from your file manager and drop
   them anywhere onto the Assets dock. vspark detects the file type
   automatically and switches to the right tab when the upload finishes.
2. **Upload button** — switch to the tab you want (for example **Models**),
   then click the upload button in the top-right corner of the dock. A file
   picker opens so you can choose the file.

A progress indicator appears while the file is uploading. If a file fails to
upload, a message will tell you which file could not be added.

You can also **drop image files straight onto the 3D viewport** — each image is
uploaded and added to the scene as a billboard (image plane) in one step.

## Asset categories {#kinds}

The dock is split into tabs, one per file type:

| Tab | What it holds | What it is for |
|-----|---------------|----------------|
| **Models** | `.vrm`, `.glb`, `.gltf` | Your avatar and any other 3D props |
| **Animations** | `.fbx`, `.bvh` | Motion clips to drive an avatar |
| **Images** | `.png`, `.jpg`, `.webp`, `.gif`, … | Overlays, textures, scene backgrounds |
| **Videos** | `.mp4`, `.webm`, `.mov`, … | Video props or Compose layers |
| **Audio** | `.mp3`, `.wav`, `.ogg`, … | Background music or sound effects |

You can also search within a tab using the search bar on the right — useful
when you have many files.

## Using an asset in your scene {#using}

Once a file is uploaded, you can put it to work in several ways:

- **Drag into the scene** — drag an asset card from the dock onto the scene
  tree on the left or onto the 3D viewport. A new object is created for you
  automatically.
- **Add to Scene / Add as Billboard / Add as Video** — click the button on an
  asset card to instantly add it to your current scene as the appropriate type
  of object.
- **Apply to a selected object** — select an object in the scene first, then
  click **Apply to [name]** on an asset card to swap out its model, texture, or
  animation.
- **Set as background** — select a camera, then click **Set as BG** on an image
  to use it as that camera's background.

If a button does not appear on a card, check that the right kind of object is
selected in the scene. For example, the **Apply** button for an animation only
shows up when an avatar or model is selected.
