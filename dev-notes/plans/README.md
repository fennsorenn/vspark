# Plans — index and status

Every file in this directory carries a status header directly under its title:

```
> **Status:** design-only | in progress | shipped | superseded by <file> | unclear
> **Supersedes / superseded by / follows:** …
```

Read that header before reading the plan. Most of these files are **historical**: they
record what someone intended at the time, often for an architecture that has since been
replaced. A plan is not a description of running code.

**The live plan is [`mesh-frontend-writes.md`](./mesh-frontend-writes.md)** — migrating
frontend UI writes off REST onto the tab's own mesh peer. Everything else is either
shipped, superseded, or (in two cases) shipped-but-with-a-named-blocker.

**If you only read one historical file, read [`mesh-sync-refactor.md`](./mesh-sync-refactor.md).**
It is the plan that was actually executed, and the code cites its section numbers (`§8`
core, `§9` cutovers, `§10` REST write-through, `§11` frontend bindings, `§12` the
analysis that _declines_ migrating Phase-6 writes). The prettier, longer, more
architectural documents — `unified-sync-layer.md`, `permissioned-sync-mesh.md` — are
**not** what got built.

---

## The mesh / sync chain, in order

Design → executed → follow-ups. Each supersedes roughly what came before it.

| Plan                                                                       | Status                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`unified-sync-layer.md`](./unified-sync-layer.md)                         | shipped as the `SyncEnvelope` layer, then superseded by the mesh                            |
| [`unified-sync-layer-diagrams.md`](./unified-sync-layer-diagrams.md)       | superseded — draws the envelope layer, not the mesh                                         |
| [`live-mesh.md`](./live-mesh.md)                                           | partly shipped (browser P2P mesh, asset transfer), design superseded                        |
| [`permissioned-sync-mesh.md`](./permissioned-sync-mesh.md)                 | **design-only** — a design-alignment doc with no implementation slices                      |
| [`mesh-sync-refactor.md`](./mesh-sync-refactor.md)                         | **shipped — the executed plan.** Cited by the code                                          |
| [`mesh-native-undo.md`](./mesh-native-undo.md)                             | shipped — engine in `packages/mesh/src/peer.ts` (+ `batch()`, added later than this design) |
| [`mesh-drop-legacy-sync-and-undo.md`](./mesh-drop-legacy-sync-and-undo.md) | in progress — undo (B) shipped; envelope retirement (A) blocked at A4/A5                    |
| [`mesh-frontend-writes.md`](./mesh-frontend-writes.md)                     | **in progress — LIVE**                                                                      |

## Multiplayer

| Plan                                                             | Status                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [`multiplayer-phase5.md`](./multiplayer-phase5.md)               | shipped — rendezvous, WebRTC meshes, object share, Connections UI                                       |
| [`multiplayer-phase6.md`](./multiplayer-phase6.md)               | shipped — owner-authoritative writes; `_share_write` deliberately kept, per `mesh-sync-refactor.md` §12 |
| [`collaborative-scene-share.md`](./collaborative-scene-share.md) | shipped — live ops + reconcile now ride the mesh (`§9` step B)                                          |

## Feature plans (all shipped)

| Plan                                               | Status                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`asset-vrm-metadata.md`](./asset-vrm-metadata.md) | shipped — migration `034`                                                            |
| [`avatar-animation.md`](./avatar-animation.md)     | shipped — migration `033`, clock-anchored schedule                                   |
| [`face-calibration.md`](./face-calibration.md)     | shipped — config-driven ARKit heuristic + dev tuning window                          |
| [`forearm-twist-bone.md`](./forearm-twist-bone.md) | shipped — see [`../modules/twist-bones.md`](../modules/twist-bones.md)               |
| [`material-editor.md`](./material-editor.md)       | shipped — see [`../modules/material-overrides.md`](../modules/material-overrides.md) |
| [`phase3-data-feeds.md`](./phase3-data-feeds.md)   | shipped — data channels + template feed layer                                        |
| [`video-audio-assets.md`](./video-audio-assets.md) | shipped — `video`/`audio` node kinds, media bus, clip event lane                     |

## Cross-cutting / process

| Plan                                                               | Status                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| [`automated-testing-strategy.md`](./automated-testing-strategy.md) | in progress — mechanism shipped, breadth + CI wiring open                                |
| [`batch-4a-phase67.md`](./batch-4a-phase67.md)                     | shipped — the execution batch for the above                                              |
| [`i18n-help-migration.md`](./i18n-help-migration.md)               | shipped; superseded as reference by [`../modules/i18n-help.md`](../modules/i18n-help.md) |
| [`field-help-wiring.md`](./field-help-wiring.md)                   | shipped mechanism; its field→anchor map is a work list, not coverage                     |
| [`vocabulary-rename.md`](./vocabulary-rename.md)                   | in progress — phase 3 (persisted `kind` renames) deliberately deferred                   |
| [`plan-template.md`](./plan-template.md)                           | template                                                                                 |

---

## Findings that cost real time to derive — do not re-derive them

### The ordering model for compose layers is a string fractional key

Migration `036_compose_layer_order_key` replaced the integer `scene_order`/`camera_order`
pair with a single string `order_key` (`packages/shared/src/fracIndex.ts`).

- Sort is **`(orderKey, id)` ascending = back-to-front**. The `id` breaks ties because
  two peers inserting into the same gap can generate the same key, and every peer has to
  break that tie identically.
- Order is **per sibling set**, scoped to `(rootComposeSceneId, parentId)`.
- Why: a move writes **one row**, so concurrent moves commute. The integer model
  renumbered every sibling on one drag, which LWW merged into a stack neither peer asked
  for.
- `camera_order` was deleted, not migrated: it was only a tie-break within a `scene_order`
  slot, and `moveComposeLayer` flattened it to 0 on every reorder.

**Three ordering models have existed and all three left residue in comments and tests:**
(a) a _signed axis_ where `scene_order` 0 was the 3D render slot, negative painted in
front, positive behind, with a pinned `[3D Scene]` tree row; (b) a plain ascending
integer index with the 3D output as an ordinary `camera_view` layer; (c) today's
fractional key. Anything you read describing (a) or (b) is dead. Two live bugs came from
(a)'s logic surviving the model change — a re-anchoring branch that silently corrupted
unrelated layers, and a hit-test whose "front = smaller order" comment inverted when the
model flipped, so clicks picked the wrong layer.

### `fracIndex` was written long before it was reachable

`packages/shared/src/fracIndex.ts` and its unit tests were written for the
`permissioned-sync-mesh` design and then sat **unreachable** — absent from
`@vspark/shared`'s package.json exports map, from the frontend tsconfig paths, and from
the vite and vitest aliases. It appears in that plan only as a one-line clause in a
"semantics and invariants" section, never in an implementation slice. Compose-layer
ordering adopted it in 2026-08. Passing unit tests are not evidence a module is wired in.

### Undo logs on the peer that _authors_ a committed write

- A UI write that goes through REST is authored by the **server**, so it lands on
  nobody's undo stack. This is the entire reason the ↶/↷ buttons were inert for months
  while the engine and its 17-test matrix were complete.
- `peer.batch(fn)` groups writes into **one** undo action. Grouping is bound when a write
  is **issued**, not when it is logged — with a remote authority the entry is only pushed
  on ack.
- A subtree delete must remove descendants **explicitly, children before parents**.
  Leaning on the server's SQL FK cascade tombstones only the root, so undo would restore
  a parent whose children are gone from the database for good.

### The channel is the discriminator for previews

In-flight gesture values ride the mesh `preview` channel as per-key ephemeral overlays
composed over the retained doc. An ephemeral op **is** an in-flight gesture by
construction and a retained op **is** model state — which is why a cold page load cannot
animate, with no flag to get wrong. Two rules:

- Write **one overlay per field**. A pathless ephemeral write is a _root_ overlay: it
  clears the per-path ones and replaces the composed doc wholesale.
- Previews are never persisted and never undoable, which is what keeps a gizmo drag to
  one undo entry instead of sixty.

### Comments claiming a legacy path is deliberate are usually debt

"Deliberately legacy", "kept on purpose", "low value" in this repo generally means _nobody
got to it_, not _we decided_. Judge a path by whether a mesh-native equivalent **exists
and is wired**, by reading the code. Confirmed-false comments found so far:

- `backend/src/routes/scene-nodes.ts:184-185` calls the `node_updated` broadcast
  "smoothing-aware". It is not: `useWsSync.ts:159` is a plain `updateNode`, and nothing
  routes it through `previewSmoother`. Same false claim on `camera-effects.ts:117` and
  `scenes.ts:409-411`.
- The claim that clip transforms must be streamed because "clip evaluation is
  frontend-local" is self-contradicting: if evaluation is local, sync the **inputs** (the
  clip doc plus playback state), not evaluated frames.

The one genuine "keep it" decision with an argument behind it is `mesh-sync-refactor.md`
§12 on Phase-6 `_share_write`: a placed write is two hops (tab → own backend → owner
backend) and the mesh's guarded-write ack protocol is single-hop. Read §12 before
reopening that.

### Still on a non-mesh transport (verified, as of 2026-08-13)

Not a plan — a standing list, so the next reader does not re-inventory it.

- **Double-apply, mesh already wired.** `node_updated`, `camera_effect_updated`,
  `track_clip_updated`, `track_clip_keyframes_replaced`, `track_clip_events_replaced`,
  `track_clip_lane_removed`: each route calls `col.set(...)` and _then_ `_ws.broadcast`
  the same data (e.g. `routes/track-clips.ts` — `col.set` at 313/436/466/531/735,
  broadcast at 317/440/470/538/737). The feeder and the WS handler write the same store
  fields.
- **Mesh delivers the doc but the feeder mis-routes it.** `scene_updated` /
  `scene_removed`: a Scene is a `scene_nodes` row, and `meshStoreFeeder`'s `scene_node`
  observer writes only the `nodes` slice, never `scenes`. These kinds are load-bearing
  until the feeder projects `kind === 'scene'` docs into the `scenes` slice.
- **Retained state on an unretained transport.** `runtime_override_*` and
  `data_channel_*` are durable per-key state held in an in-memory map and replayed to
  every freshly-connected client as a snapshot (`runtime_overrides/manager.ts:200-213`,
  `data_channels/manager.ts:132-141`). That is what a _retained_ mesh channel gives for
  free; the mesh's existing `control` channel is `retained: false`, so porting them
  as-is would delete the late-joiner guarantee.
- **Frontend writes still on REST.** `behavior`, `camera_effect`, `track_clip` and
  `logic` — the remaining slices of the live plan. `scene_node` and `compose_layer` are
  done.
- **Node transform previews still on `/ws`** (`node_transform_preview` +
  `previewSmoother`), while compose-layer previews have moved to the mesh `preview`
  channel.

**Staying off the mesh, with a reason that survived review.** A 38-path adversarial sweep
left exactly four:

- `_blob_request` / `_blob_begin` / `_blob_chunk` / `_blob_end` / `_blob_error` /
  `_blob_meta` — content-addressed **binary** asset transfer. Chunked bulk bytes are not
  document state, and framing them as LWW document writes buys nothing.
- The three legs of the Phase-6 relay fallback — `mp_share_write`,
  `mp_shared_write_nak`, and the authoritative echo — for the two-hop reason in
  `mesh-sync-refactor.md` §12. Note the review **corrected §12's own argument**: the real
  blocker is not that the core cannot thread acks across a relay, it is that the
  tab→own-backend leg has no truthful authority story (the tab's backend is
  `authority: 'self'` for `scene_node` and acks locally before forwarding anything), so
  the tab would have to converge on the owner's echo rather than on an ack. That is a
  semantics downgrade, not a core-extension cost.

Everything else in the sweep — all 34 other paths — is _migrate_.
