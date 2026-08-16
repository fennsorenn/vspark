# Live2D models {#live2d}

vspark can use **Live2D Cubism** models as 2D avatars ("puppets") alongside 3D
VRM avatars. They react to the same face tracking, lip sync and motion capture
you would use on a 3D avatar.

This page covers getting a model *into* vspark. For driving it once it is in the
scene, see the behaviours attached to the model's object.

## A Live2D model is a folder, not a file {#bundle}

This is the single most important thing to know, and the cause of almost every
failed upload.

Where a VRM avatar is one self-contained `.vrm` file, a Live2D model is a
**bundle**: a set of files that only work together.

| File | What it is | Needed? |
| --- | --- | --- |
| `*.model3.json` | The **manifest** — lists every other file by name | Yes |
| `*.moc3` | The model data itself — the mesh and its deformations | Yes |
| Textures (`.png`) | How the model looks. Usually in a subfolder like `mymodel.2048/` | Yes |
| `*.physics3.json` | Hair and clothing sway | Optional |
| `*.motion3.json` | Motions, usually in a `motion/` subfolder | Optional |
| `*.exp3.json` | Expressions, usually in an `exp/` subfolder | Optional |
| `*.pose3.json`, `*.cdi3.json`, `*.userdata3.json` | Extra model information | Optional |

The manifest refers to the other files **by their path relative to itself** — so
it might ask for `mymodel.2048/texture_00.png`, meaning "a folder called
`mymodel.2048`, next to me, containing `texture_00.png`".

**That folder structure is part of the model.** If the files are moved around,
renamed, or pulled out of their subfolders, the manifest can no longer find them
and the model cannot load — even though every file is technically still there.

## Uploading a model {#uploading}

1. Open the **Assets** dock and switch to the **Models** tab.
2. Click **Upload Live2D**.
3. Pick the **folder** that contains the `*.model3.json` file — not an individual
   file inside it.

Most models are distributed as a `.zip`. Unpack it first, and keep the folder
structure exactly as it came out of the archive. If the archive contains a
folder like `Hiyori/runtime/`, that `runtime` folder — the one holding the
`*.model3.json` — is usually the one to pick.

Once uploaded, the model appears in the Models tab. Use **Add to Scene** to place
it, or select an existing Live2D object and use **Apply**.

Note that vspark uploads **one model at a time**. If a folder contains several
`*.model3.json` files, it will say so rather than guess which model you meant —
upload each model from its own folder.

## Missing files {#missing-files}

When you upload a model, vspark reads its manifest and checks that every file it
asks for is actually there. If something is missing, it tells you exactly which
files and where they were expected, instead of accepting a model that would
silently render as nothing.

Missing files come in two kinds.

### Required — the model cannot render {#required}

The **model data** (`.moc3`) and **textures** are load-blocking: without them
there is no shape and no picture, so there is nothing to draw. When these are
missing the upload is **rejected** and nothing is stored.

The usual cause is a **flattened folder** — every file sitting side by side at
the top level, while the manifest expects textures in a subfolder. Look at the
paths vspark lists: if it wants `mymodel.2048/texture_00.png` and your folder
just has `texture_00.png` loose at the top, the structure was lost somewhere
between the download and your disk.

To fix it:

- **Re-download or re-unpack the model**, making sure your unpacking tool keeps
  folders. Some tools flatten archives by default.
- **Recreate the folders by hand** if you know where the files belong: create the
  subfolder the manifest names and move the files into it.
- Then upload the folder again.

vspark deliberately does **not** guess. A loose `texture_00.png` might be the
file the manifest wants — or it might belong to a different texture set entirely.
Guessing wrong produces a model that loads looking wrong, which is harder to
notice and harder to debug than one that refuses to load.

### Optional — the model works, with something switched off {#optional}

Motions, expressions, physics, pose and display information are enhancements. A
model missing all of its motions still renders perfectly well; it simply stands
still.

When only these are missing the upload **succeeds** and you get a note listing
what was absent. You can ignore it — or, if you expected those motions to be
there, it is a sign your download was incomplete.

### Manifest problems {#manifest-problems}

Occasionally the manifest itself is broken rather than incomplete — it is not
valid JSON, it has no file list, or it points somewhere outside its own folder.
Supplying more files will not help here. Re-export the model from Cubism, or
download it again from its source.

## Licensing {#licensing}

Live2D rendering needs the proprietary **Cubism Core** runtime, which vspark does
not ship. The first time you use a Live2D model, you will be asked to accept
Live2D's terms; the runtime is then fetched directly from Live2D. Until you
accept, no Live2D code is downloaded.

Using a model also means respecting **its own** licence — many models restrict
commercial or streaming use. That is between you and the model's creator.
