# VRoid sample models

Three stock VRoid Studio sample avatars, used as test fixtures for avatar /
pose / twist-bone work. Served by Vite at `/samples/AvatarSample_{A,B,C}.vrm`.

All three are **VRM 0.x**, rig topology `UpperArm → LowerArm → Hand` with **no
forearm twist bones** — the canonical case the synthesized-twist-bone feature
targets.

## Source

Vendored from [madjin/vrm-samples](https://github.com/madjin/vrm-samples)
(`vroid/stable/`), originally Pixiv's VRoid Studio sample models.

## License / conditions of use

`AvatarSample_A`, `_B`, `_C` may be used freely subject to VRoid's sample-model
conditions of use (copyright is **not** waived):

- https://vroid.pixiv.help/hc/en-us/articles/4402394424089
- https://vroid.pixiv.help/hc/en-us/articles/4402614652569

These are bundled solely as development/test fixtures.
