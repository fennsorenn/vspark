# Avatar animation — shared, scheduled, content-addressed playback

**Status:** planned (2026-06-13). Replaces the unsynchronized idle-animation
playback and the bespoke `api_animation` WS relay with a proper, collab-shared
avatar animation model.

## Problem

An avatar's animation has no shared playback state. The idle loop
(`components.animation.idleUrl`) free-runs on each client's local render clock
(`Viewport.tsx` `mixer.update(delta)`), so collab clients are never in phase;
the panel's pause/seek/stop controls poke the local THREE.js mixer directly and
never propagate. The `api_controller` animation queue rides a one-off
`api_animation` WS broadcast that's separate from all of this. Net: model
animations "just start when loaded and run from there," and controls don't
cross.

Two architectural corrections from the design discussion:
- Playback state belongs on the **avatar node's own state** (`properties`),
  not in the badly-named `components` blob (now that "component" means a
  behavior — a graph-backed driver in the `behaviors` table).
- Switching clips on the *backend* and pushing "switch now" creates seams; the
  switch must happen **client-side at a scheduled time**, with upcoming clips
  visible ahead of time so they can be preloaded (and blended, later).

## Model

The avatar has two layers, both content-addressed by `animation_clip` id (the
clip's source FBX/BVH already transfers by hash via the asset follow-up; clip
ids are universal across peers, so references need no per-server localization;
the clip row carries `duration` for scheduling).

**Idle (base loop)** — avatar node state:
```
properties.animation = { idle?: { clipId, speed } }
```

**Schedule (priority timeline)** — a parallel doc collection (NOT scene_nodes —
same pattern as `track_clip`/`animation_clip`: parents to the avatar, rides its
subtree subscription, never appears in the tree):
```
scheduled_animation = {
  id, avatarNodeId,        // parent → scene_node (containment)
  clipId,                  // → animation_clip (universal id, hash-transferred asset)
  startEpoch,              // mesh-clock start; LOCALIZED on receive via toLocalTime
  speed, loop,
}
```

Resolution (every client, anchored to the mesh clock):
- The active entry is the latest one whose `startEpoch ≤ syncedNow` (and, for a
  non-loop finite entry, whose `startEpoch + duration/speed > syncedNow`); else
  fall back to idle.
- `action.time = (syncedNow − activeStartEpoch) · speed`, mod duration (loop) or
  clamped (non-loop hold). The same formula keeps the idle loop phase-synced.
- Upcoming entries (`startEpoch > syncedNow`) are preloaded; past entries are
  dropped from local render state and pruned from the shared collection by the
  appender.

This solves the seams: the switch is performed locally at `startEpoch` from a
preloaded clip, not on receipt of a remote message. Blends are a later, local
change (both clips are already in context).

## Steps (keep green + verify per step)

1. **Schema + sync plumbing.** Migration `033_scheduled_animations` (id,
   avatar_node_id FK→scene_nodes ON DELETE CASCADE, clip_id, start_epoch,
   speed, loop, created_at). `animation_clip`-style resource descriptor
   (load/save/remove) + mesh binding (parent → scene_node:avatarNodeId,
   persists when the avatar row exists; validate translates `startEpoch` via
   `toLocalTime` for foreign docs — needs the sender peer id at validate time,
   so thread it or translate in handleOp). Frontend PARENTS entry + feeder
   slice + RTYPES. Idle moves to `properties.animation.idle = {clipId, speed}`;
   migrate existing `components.animation.idleUrl` → resolve/create the matching
   `animation_clip`, write `properties.animation.idle`.
2. **Frontend driver.** Replace the free-running mixer advance + single seek in
   `Viewport.tsx` with a clock-anchored two-layer resolver: read idle +
   scheduled entries for the node, compute the active layer from `syncedNow`,
   preload upcoming, drive `action.time` from the anchor each frame, GC past.
   Idle is the base when no schedule entry is active. Source the synced clock
   from the tab's mesh peer (hop: tab→own backend; backend stamps a serverNow
   the tab offsets against — reuse the api_animation translation result, or
   expose the tab-peer `clockOffset`).
3. **api_controller + transport.** `setAnimationQueue` appends
   `scheduled_animation` docs (compute each `startEpoch` from the running sum of
   durations/speed) instead of broadcasting `api_animation`; prune finished
   entries. Retire the `api_animation` WS path + its relay/clock-translate code.
   Panel transport buttons write schedule/idle state instead of poking the
   mixer (pause/seek over the timeline can come in the same step or defer).
4. **Verify** (two backends + real frontend): idle phase-synced across clients;
   schedule entry appended on A activates at the same instant on B (clock
   sync); model swap keeps the playhead (already fixed); clip-id reference
   resolves to each side's localized asset; pruning bounds the collection.

## Out of scope (deferred)
- Blend/crossfade transitions between clips (the schedule makes this a localized
  later change — both clips are in context).
- Pause/seek *transport* over the whole timeline (a global time control on the
  avatar) — can layer on after the schedule lands.
- Renaming the `components` node-config blob to a non-deprecated name (separate
  migration; this feature deliberately stays out of `components`).
