# Test assets

Sample avatar + animation files for manually exercising the viewport, the
FBX→VRM retargeter, and the avatar-animation pipeline (idle loop + scheduled
timeline). The binaries are **downloaded on demand**, not committed — see
[`seed.mjs`](seed.mjs). They land in `.cache/` (git-ignored).

## Usage

```bash
# Just populate the local cache (test-assets/.cache/{avatars,animations}/):
node test-assets/seed.mjs

# Download AND drop into a running backend project so it auto-discovers them
# (files go to packages/backend/uploads/<projectId>/{avatars,animations}/):
node test-assets/seed.mjs --project <projectId>
```

After seeding a project, open it in the editor — the backend's `discoverAssets`
scan registers the dropped files, so they appear in the Assets panel. Pick a
`.vrm` for an avatar node and use `SambaDancing.fbx` as an idle / queued clip.

## Contents & licensing

| File | Source | License / terms |
|------|--------|-----------------|
| `AvatarSample_A.vrm`, `_B.vrm`, `_C.vrm` | [madjin/vrm-samples](https://github.com/madjin/vrm-samples) (`vroid/stable/`) | VRoid Studio sample models — free to use under VRoid's [conditions of use](https://vroid.pixiv.help/hc/en-us/articles/4402394424089). |
| `SambaDancing.fbx` | [three.js](https://github.com/mrdoob/three.js) (`examples/models/fbx/`) | Mixamo-rigged (`mixamorig:*` bones) sample shipped with three.js. Mixamo content is free for use with an Adobe account; redistributed here only as a download reference. |

These are third-party assets pulled from upstream at seed time; vspark does not
vendor or relicense them. Use them for local development/testing only.
