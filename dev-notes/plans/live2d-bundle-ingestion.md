# Plan: Live2D bundle ingestion — zip support + incremental completion

> Branch: `feature/live2d-bundle-ingestion` (create from `dev`) ·
> Status: **step 1 shipped; steps 0/2/3/4 outstanding**
> This plan is the seed context for a cloud worker. It is a starting point, not an
> airtight spec — the worker is interactive and may ask to refine it.
>
> **Decisions taken** (step 0 and the step 1 open questions, settled with the user):
> zip expansion is **client-side** with **`fflate`**, feeding the existing bundle
> endpoint unchanged; an optional-missing bundle **uploads with a warning**; and
> partial state stays **client-side** — the backend rejects and writes nothing,
> the browser still holds the picked files and re-POSTs a complete bundle. No
> pending-bundle store, so no cleanup story for abandoned uploads.
>
> **Correction to "Acceptance / verification" below:** there are *no* Hiyori
> bundles under `packages/backend/uploads/` — that directory is gitignored, so a
> fresh clone has none. Step 1 was verified with synthetic bundles (unit, route
> and Playwright tiers); a real Cubism sample is still needed to confirm a model
> actually *renders* after upload.

## Goal

Make getting a Live2D model into vspark reliable regardless of how the user
obtained it. Today the only working path is "pick a folder with the OS folder
picker, and hope it is complete". Three things break that:

1. **Drag-and-drop flattens bundles.** The dock's drop handler reads
   `e.dataTransfer.files`, which does not descend into directories. Dropping a
   model folder yields either nothing or a pile of loose files with no relative
   paths — so the manifest's `hiyori_free_t08.2048/texture_00.png` can never
   resolve.
2. **Zips are not accepted at all.** Live2D models are distributed as zips
   essentially always (Booth, Cubism samples, marketplace downloads). The user
   must unzip first and know to keep the folder structure.
3. **Incomplete bundles upload "successfully" and then fail to render.** The
   only server-side check is *"some `*.model3.json` exists"*. Nothing reads that
   manifest to confirm its referenced files are present, so a truncated or
   flattened download is accepted, stored, registered as an asset, and only
   reveals itself as a blank placeholder in the viewport with no explanation.

(3) is not hypothetical — it is exactly how a real `hiyori-main` download failed:
a flat folder whose manifest referenced `hiyori_free_t08.2048/texture_00.png` and
`motion/*.motion3.json`, none of which existed at those paths. The app was
working correctly; the bundle was broken, and nothing said so.

The outcome we want: **drop a zip or a folder, and either it works, or vspark
tells you exactly which files are missing and lets you supply them.**

## Context — read these first

- [dev-notes/modules/live2d.md](../modules/live2d.md) — the adapter, scene node,
  and asset ingestion as built.
- `packages/backend/src/routes/assets.ts` — `POST /projects/:projectId/assets/bundle`,
  the whole current ingestion path (~90 lines). Note what it validates and what
  it does not.
- `packages/frontend/src/components/editor/AssetManager.tsx` —
  `handleUploadLive2dFolder` (the folder-picker path) and the dock's `onDrop`.

## What a manifest references

`*.model3.json` → `FileReferences`, all paths relative to the manifest:

```jsonc
{
  "Moc": "hiyori_free_t08.moc3",
  "Textures": ["hiyori_free_t08.2048/texture_00.png"],
  "Physics":  "hiyori_free_t08.physics3.json",
  "DisplayInfo": "hiyori_free_t08.cdi3.json",
  "Motions": { "Idle": [{ "File": "motion/hiyori_m01.motion3.json" }, …] },
  "Expressions": [{ "Name": "f01", "File": "exp/f01.exp3.json" }]
}
```

Required vs optional matters for the UX: **`Moc` and `Textures` are
load-blocking** — without them there is nothing to render. `Physics`,
`DisplayInfo`, `Motions`, `Expressions`, `UserData` and `Groups` are enhancements;
a model missing all its motions still renders standing still. The completion UI
must distinguish these, or it will demand files the user does not need and
cannot supply.

Treat this list as a starting point and verify it against the Cubism schema —
`Groups`/`UserData`/`HitAreas` are not file references at all, and there may be
keys this list omits.

## Constraints

- **Do not change the on-disk layout or the asset row shape.** Bundles stay at
  `uploads/{projectId}/live2d/{model}/…` with paths relative to the manifest, and
  one `asset_files` row points at the manifest with mime
  `application/x-live2d-model`. Existing bundles must keep working untouched.
- **Keep the existing folder-picker path working.** It is the one flow that
  works today; this adds routes onto it rather than replacing it.
- **`isSafeRelPath` applies to zip entries too, and matters more there.** A zip
  is attacker-supplied input containing arbitrary paths — this is Zip-Slip
  territory. The existing check (`assets.ts:19`, module-private) already rejects
  absolute paths, backslashes, NUL, and empty/`.`/`..` segments, which covers the
  path cases; if zips are expanded server-side it should be reused rather than
  reimplemented — promote it to `shared.ts` instead of copying it. It does **not**
  cover symlink entries, which a zip can carry and a folder upload cannot.
- **Decide where the zip is expanded (see step 0).** This is the one real
  architectural call in this plan.
- **The current transport is base64 JSON into a `150mb` express limit** —
  base64 inflates by ~33%, so a 13MB bundle (a realistic size; the Hiyori sample
  is 13MB on disk) becomes ~17MB in a single request, all buffered in memory on
  both sides. It works today, but zip support makes bigger uploads likelier.
  Flag it if you hit it; do not rewrite the transport as part of this plan.
- **i18n + help are part of done.** Every new string goes into both
  `en` and `de` namespaces; the completion window is a new UI concept and needs a
  help section plus a `HelpButton`. German curly quotes are `„ … "` — validate
  the JSON parses.
- **There is no Live2D help page.** `help/content/{en,de}/` has 20 pages and not
  one mentions Live2D, so the upload flow has no documentation to extend — the
  `HelpButton` for the completion window needs a page to point at. Creating a
  minimal `live2d.md` covering bundle upload (what a bundle is, why the folder
  structure matters, what to do when files are missing) is in scope; documenting
  the whole Live2D feature is not. Confirm the split with the user if it grows.

## Files in scope

- `packages/backend/src/routes/assets.ts` — manifest reference parsing, the
  completeness check, and (per step 0) zip expansion.
- `packages/backend/src/routes/shared.ts` — `isLive2dManifest`, `LIVE2D_SUBFOLDER`
  and `sanitizeStem` live here; a `parseLive2dManifest` helper belongs here too.
  (`isSafeRelPath` is module-private in `assets.ts` — promote it here if the zip
  path needs it.)
- `packages/frontend/src/components/editor/AssetManager.tsx` — drop handler
  directory traversal, zip acceptance, and the completion window.
- `packages/frontend/src/api/client.ts` — `uploadLive2dBundle` and whatever the
  completion flow needs.
- `packages/frontend/src/i18n/locales/{en,de}/*.json` and a **new**
  `help/content/{en,de}/live2d.md` (see the constraint above — it does not exist yet).
- Tests per the table in the repo `CLAUDE.md`.

## Out of scope

- Replacing base64-JSON upload with multipart/streaming (noted above; separate
  concern, affects all asset types).
- Fixing up *broken* bundles automatically — e.g. inferring that
  `texture_00.png` at the root satisfies a `foo.2048/texture_00.png` reference.
  Tempting, and it is what a human did manually for `hiyori-main`, but guessing
  at a user's file layout silently is how you get a model that loads wrong
  instead of not at all. Report; let the user supply.
- Live2D runtime/rendering behaviour, param mapping, the licence gate.
- Non-Live2D asset kinds. The bundle endpoint already rejects `kind !== 'live2d'`.

## Approach

### Step 0 — decide where zips are expanded (ask before building)

An architectural call the worker should **put to the user first**:

- **(a) Expand client-side.** Add a zip library to the frontend, unpack in the
  browser, and feed the existing bundle endpoint unchanged. The backend never
  learns zips exist, and the completion check runs on the same shape it does
  today. Costs a frontend dependency and does the work on the user's machine.
- **(b) Expand server-side.** Post the zip, unpack in the backend. Keeps the
  frontend thin and means any future client gets zip support for free, but adds
  a new endpoint, a backend dependency, and puts untrusted-archive handling on
  the server — where Zip-Slip actually matters.
- **(c) Both.** More surface than this feature justifies.

Neither is obviously right. (a) keeps the trust boundary where it already is and
touches less; (b) is better if a non-browser client is ever expected. Ask.

The library choice follows from step 0 — `fflate` (small, fast, works both
sides) and `jszip` (bigger, friendlier API) are the usual candidates. **Adding a
dependency is itself a decision the user wants to be asked about**, so name the
one you intend and why.

### Step 1 — manifest-driven completeness check (backend)

The foundation; do this first, independently of zip or drag-drop, because it is
what turns silent failure into a message.

Parse the `*.model3.json` and resolve every `FileReferences` path against the
uploaded file set. Split the result into **required-missing** (`Moc`, `Textures`)
and **optional-missing** (everything else).

Return the report rather than only accepting or rejecting — the UI needs the
list. Reject with a 400 naming the missing required files when the bundle cannot
render; accept with the optional-missing list attached when it can.

Two things to settle with the user here: whether an optional-missing bundle
should upload with a warning or block, and whether a partial upload should be
stored at all or held until complete. Storing partials means orphan directories
if the user abandons the flow; not storing them means re-uploading everything on
completion. **Prefer holding partial state server-side keyed by a pending-bundle
id, with the asset row only written once the bundle renders** — but confirm, as
it implies a cleanup story for abandoned uploads.

### Step 2 — directory-aware drag and drop (frontend)

Replace `e.dataTransfer.files` with `DataTransferItem.webkitGetAsEntry()` and
walk the tree recursively, building the same `{ relPath, file }[]` the folder
picker produces. `readEntries()` returns **at most 100 entries per call** and
must be called repeatedly until it returns empty — the single most common bug in
this API, and it silently truncates large bundles rather than erroring.

Keep the existing non-directory drop behaviour intact for ordinary assets: the
dock accepts images, video, audio and VRMs by drop today, and this handler is
shared.

### Step 3 — zip ingestion

Per step 0. Accept `.zip` on both the drop handler and the Upload Live2D button.
A zip usually contains a single top-level folder — strip that prefix so
`Model/foo.model3.json` becomes `foo.model3.json`, matching what the folder
picker produces. Handle both shapes (wrapped and bare), and the case of multiple
`*.model3.json` files in one archive (ask the user which model, or reject
clearly — do not silently pick the first).

### Step 4 — incremental completion window

When step 1 reports missing files, open a window listing them — required and
optional grouped separately, each showing the path the manifest expects. Let the
user supply them by drag-and-drop **and** file button, matching each dropped file
to its expected slot by filename, and let them retry as many times as it takes.

Match by basename, not full path: the user dropping `texture_00.png` almost
certainly means the `foo.2048/texture_00.png` slot, and requiring them to
reconstruct the directory structure by hand defeats the point of the window. When
a basename is ambiguous across slots, ask rather than guess.

The window should be dismissible without losing the upload, and reachable again
from the asset entry — a user who closes it should not have to start over.

## Acceptance / verification

Needs a real Live2D bundle. The Cubism sample models are the obvious source; the
project already has working Hiyori bundles under
`packages/backend/uploads/<projectId>/live2d/` to test against, and a
deliberately-broken flat copy is the ideal negative case.

- **A zip of a complete model uploads and renders**, from both the button and a
  drop, with no manual unzipping.
- **Dropping a model folder works** and preserves relative paths — verify a
  bundle whose textures live in a subdirectory, since that is what flattening
  destroys.
- **A bundle >100 files survives the drop path** (the `readEntries` truncation
  case). Duplicate a motions folder if no such model is handy.
- **An incomplete bundle reports which files are missing** instead of uploading
  a model that renders blank — the `hiyori-main` case.
- **Supplying the missing files through the window completes the bundle** and
  the model then renders.
- **A zip containing `../` or absolute paths is rejected**, and nothing is
  written outside the bundle directory.
- Existing bundles already on disk still load — this must not require re-upload.
- `pnpm lint` + `pnpm test` green; new tests per the repo testing table
  (backend route tests for the manifest check and path safety; a Playwright spec
  for the completion window, with `vs-` handles on its controls and
  `controls.mjs bless` re-run).

## Output

Open a PR into `dev` when done.

Step 1 is independently shippable and worth landing on its own if the rest grows
— turning silent breakage into a clear error is most of the user-visible value
here, and it is a prerequisite for step 4 anyway.
