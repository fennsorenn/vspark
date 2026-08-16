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

There are three ways, and all of them keep the folder structure intact:

- **Upload Live2D** (Models tab) — opens a folder picker. Choose the **folder**
  containing the `*.model3.json`, not an individual file inside it.
- **Live2D Zip** (Models tab) — choose the `.zip` exactly as you downloaded it.
  vspark unpacks it for you; there is no need to extract it first.
- **Drag and drop** — drag the model **folder**, or its `.zip`, onto the Assets
  dock. Dropping a folder works: vspark walks into it and keeps every file's
  place inside the model.

Archives usually wrap everything in one top-level folder (`Hiyori/…`). That
wrapper is removed automatically, so you do not need to dig into the archive to
find the right level.

Once uploaded, the model appears in the Models tab. Use **Add to Scene** to place
it, or select an existing Live2D object and use **Apply**.

vspark uploads **one model at a time**. If a folder or archive contains several
`*.model3.json` files, it asks which model you meant rather than guessing — pick
one from the list, and only that model's files are stored.

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

To fix it, **supply the missing files in the window itself**. Drop them onto the
box at the bottom, or use **Choose files…**. You only need to add what is listed
— everything you already picked is still held, so nothing gets re-selected — and
then press the upload button to finish.

You do **not** have to recreate the folders. Files are matched by name, so
dropping a bare `texture_00.png` fills the `mymodel.2048/texture_00.png` slot.
If a name could fill more than one slot, vspark asks which one instead of
choosing for you: a wrong guess produces a model that loads *looking* wrong,
which is harder to notice and harder to debug than one that refuses to load.

If you would rather start over — for example because the download itself was
incomplete — close the window, re-download or re-unpack the model (making sure
your unpacking tool keeps folders; some flatten archives by default), and upload
it again.

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
