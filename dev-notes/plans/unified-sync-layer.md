# Plan: Unified state-replication layer

> Branch: `feature/unified-sync-layer` · Status: draft (design — needs decisions before implementation)
> Seed context for design discussion. Several forks (marked **DECISION**) need an
> answer before this is ready to build.
>
> 📊 Diagrams + use-case walkthroughs: [`unified-sync-layer-diagrams.md`](./unified-sync-layer-diagrams.md)

## Goal

Replace the hand-written, per-message sync code (one backend `broadcast` call +
one frontend `else if` branch + duplicated snake↔camel mappers per entity) with a
single abstraction that covers the **full spectrum** of synced state:

- **slow + persistent** — CRUD entities (scene nodes, behaviors, camera effects,
  compose layers, track clips)
- **fast + ephemeral** — pose/blendshape/IK streams (60–90 Hz, lossy-OK)
- **temporary override layers** — runtime overrides, data channels, and *live
  param edits* (the "tweak it while streaming, no reload" usecase)

…such that adding a new syncable thing is **one registry entry per side**, and the
same model extends to **server-to-server replication** (planned multiplayer) — supporting
both *full-scene mirroring* and *single-object/avatar sharing* — without reworking
producers/consumers.

## Why now

Three pain points converged:

1. The preset-sync bug we just fixed existed *only* because each entity needs sync
   wired by hand in 4 places; it's easy to forget one.
2. Live editing + the planned multiplayer feature both need real-time convergence,
   which the current "fire a bespoke message" approach doesn't give (no ordering, no
   conflict resolution, no cross-server story).
3. The codebase has **already** grown three near-identical managers
   (`RuntimeOverrideManager`, `DataChannelManager`, `trackClipPlayback`) — evidence
   the pattern wants to be a single primitive.

## What already exists (build on, don't replace)

| Existing piece | Role in the new model |
| --- | --- |
| `ws/index.ts` `WSSync` (`broadcast`/`sendTo`/`onMessage`/`onClientConnected`, `excludeWs`) | The **ClientHub transport**. Already origin-aware and bidirectional. |
| `runtime_overrides/manager.ts`, `data_channels/manager.ts` | Prototype **field/overlay resources** (scoped map → broadcast → snapshot). |
| `track_clips/playback.ts` `sendSnapshotTo` | Prototype **snapshot-on-connect**. |
| `shared/paramPaths.ts` (`ParamPathSpec`, `coerceParamValue`, `getParamPathSpec`) | The **typed field schema** — validation/coercion/defaults for addressable params. |
| `index.ts` `onClientConnected` fan-out to 4 managers | The **snapshot orchestration** point. |
| `node_transform_preview` → `node_updated` pair | Hand-rolled **fast-overlay + slow-commit** of the same field. |
| Backend `rowTo*`/`map*` + frontend `map*` (duplicated) | Collapse into **one DTO mapper per resource**, at the backend boundary. |

## Core model: the Replicated Resource

Every synced thing is a **resource** addressed by `(rtype, key)` within a `scope`,
carrying a `value`, governed by a declared **policy**. One wire envelope for all:

```ts
interface SyncEnvelope {
  rtype: string;                 // 'scene_node' | 'override' | 'vmc_pose' | ...
  op: 'upsert' | 'remove' | 'patch' | 'frame' | 'event';
  scope?: string;                // sceneId/projectId — selective fan-out + snapshot grouping
  key: string;                   // entity id | composite field key | stream key
  data?: unknown;                // canonical DTO / value / frame
  v?: HLC;                       // hybrid logical clock — ordering/convergence (omitted for streams)
  origin?: string;               // peer id — echo + loop suppression
}
```

### Four resource classes (one model, four policies)

1. **Document** — persistent CRUD entities.
   - durability: SQLite · granularity: whole-entity upsert/remove (track clip = aggregate
     with its lanes/keyframes/events) · delivery: reliable/ordered · conflict: per-entity
     LWW by `v` · snapshot: load from DB.
   - Producer: `sync.document.upsert('scene_node', id)` — loads the row, maps to the
     canonical DTO **once**, stamps `v`, persists already done by the route, broadcasts.
   - Consumer: registry routes the DTO to the store slice; drops if incoming `v` ≤ local `v`.

2. **Field / overlay** — param state and override layers.
   - address: `(targetKind, targetId, paramPath)` (today's override key), scene-scoped ·
     typed by `paramPaths` · delivery: reliable, **coalesced per key** · conflict:
     **LWW per paramPath** (so concurrent edits to *different* params of one node both
     survive — whole-entity LWW would clobber) · snapshot: all overlay entries on connect.
   - **Unifies** runtime overrides, data channels, and live edits: an *effective value*
     = persisted base ⊕ overlays in precedence order. A live drag writes a transient
     "edit" overlay (fast/coalesced); release **commits** to the base document
     (reliable/persisted). This is exactly the current preview→commit split, generalized.

3. **Stream** — high-frequency ephemeral frames (poses, blendshapes, IK).
   - durability: none (optionally hold last frame for snapshot) · delivery: **lossy,
     latest-wins, drop-under-load**, coalesced at the send tick · conflict: latest-by-time,
     no `v`, no history.
   - Consumer routes through the existing `previewSmoother`/pose store — smoothing stays a
     **render concern**, the layer only delivers "latest value for key."

4. **Event** — one-shot commands, *not* state (`track_clip_started`, `media_control`,
   `trigger_fire`).
   - fire-and-forget to current peers · no snapshot · no convergence. Called out explicitly
     so the abstraction doesn't pretend commands are state.

## Architecture (layers)

```
Producers  routes / managers / signal-graph nodes
           sync.document.upsert(rtype, id)
           sync.field.set(target, path, value, { layer, persist })
           sync.stream.publish(rtype, key, frame)
           sync.event.emit(rtype, payload)
                │  registry → policy (persist? version? coalesce? scope?)
Replication    resource registry · HLC stamping · origin tag · coalesce buffers
core           · per-scope snapshot assembly on peer join
                │
Transports     ClientHub (WSSync, today)   ──┐
               ServerMesh (future)           │ same envelope; HLC+origin =
               (Redis pub/sub / NATS / WS)  ──┘ loop-free, convergent multi-server
                │
Consumers      frontend applyRemote(envelope): registry → store slice;
               drop stale by v; stream/field-live → smoother
```

The **producer/consumer API and the envelope do not change** when ServerMesh is added —
multiplayer becomes a transport + reconciliation concern, not a rewrite.

## Conflict resolution

- Documents & fields: **per-key Last-Writer-Wins keyed by a Hybrid Logical Clock**
  (wall-clock ms + counter + peerId). Deterministic convergence across servers with no
  synchronized clocks; a consumer ignores any update with `v ≤ localV`. Field LWW is
  *per paramPath*; document LWW is *per entity* (field-level on documents can come later).
- Streams: latest-by-time; no clock needed.
- **DECISION — LWW vs CRDT.** LWW handles "set param = X" perfectly and is ~100× simpler
  than a CRDT. It does **not** merge concurrent character-level text edits. If
  collaborative rich-text/freeform editing is ever in scope, that subtree needs a CRDT
  (e.g. Yjs) bolted onto this layer. Recommendation: LWW now, leave a seam.

## Field value resolution: explicit override layers

**Today this exists but is implicit and duplicated.** A field's final value is already the
result of stacking sources with a fixed precedence — **track-clip > runtime override > base** —
but that rule is re-implemented in each consumer (`useTransformWithOverride` in `Viewport.tsx`,
`layerStyle` in `ComposeLayerStack.tsx`, plus the clip evaluator), and two sources sit *outside*
it entirely (VMC/pose on skeletons; data channels). The "user edits a field while a clip is
paused" case is faked with a bolt-on `suppressedOverrides` set that *mutes* the clip — a
workaround for not having an explicit "manual edit" layer that simply sits higher.

**Make it first-class: one compositor.** Model every field as an ordered **layer stack**; the
effective value is the layers folded low→high, each layer either replacing the accumulator or
composing onto it (add / multiply):

```
effective(target, paramPath) =
  fold LAYERS low→high:
    contribution = layer.read(target, paramPath)        // value | none
    if contribution: acc = layer.blend(acc, contribution)   // replace | add | multiply
```

Declared stack (single source of truth for precedence), low→high:

| Layer | Source (sync resource class) | Blend |
| --- | --- | --- |
| Base | Document (persisted) | replace (identity) |
| Pose / animation | Stream (VMC / clip pose) | replace or additive (skeleton-specific) |
| Runtime override | Field (signal-graph bus) | replace (or add) |
| Track-clip | clip Documents + playback Stream | replace (`override`) / add (`relative`) |
| Live edit / manual gesture | Field (fast overlay) | replace |

This is **more than LWW** — LWW picks one value; the compositor *stacks* them and can add or
multiply (today's `relative` clip mode adds; opacity multiplies). It generalizes the existing
`AnimationBlendMode` ('override'/'relative'/additive) idea to every param.

**But keep the common case simple.** With every layer in `replace` mode the fold degenerates to a
precedence coalesce — `effective = top ?? … ?? base` (nullish, *not* `||`: `0`/`''`/opacity `0`
are valid; "absent" means the layer doesn't touch this field). That's most scalar params, so the
scalar path should literally *be* an ordered coalesce. Add/multiply/weighted blends are an opt-in
**per-param `compose` rule in `paramPaths`** (relative clips, opacity, IK influence); only **poses**
need the full quaternion compositor. Don't build a heavyweight generic blend engine for the ~95%
that's just `??`. In the trivial case the abstraction's payoff is *organizational, not arithmetic*:
one declared precedence list (vs the chain copy-pasted across consumers, which is how the two
existing copies drift), dynamic layer presence fed by sync sources, and "manual edit = higher
layer" replacing the suppression hack.

Wins:
- **Precedence defined once.** Renderer, properties panel, and any future consumer call the same
  resolver instead of re-deriving the chain.
- **The suppression hack disappears.** "Manual edit beats a paused clip" becomes "the manual-edit
  layer is above the clip layer" — no muting set to keep in sync.
- **New sources = add a layer**, not edit every consumer. Data channels and pose fold in instead
  of being special cases.
- **It IS the sync read-model.** Each layer is fed by one of the four resource classes; the
  compositor is the single place those classes combine for display.
- **Multiplayer falls out:** the object-share **wrapper transform** (subscriber-owned) is just
  another layer above the publisher's intrinsic value — same machinery, no special case.

This is a read-model layered on top of sync — it doesn't change the transport or resource
classes, it consumes them.

### Staged compositing across the network boundary (where each layer folds)

Compositing is **not single-location**. One logical layer stack can be **cut at a contiguous
boundary** and folded in stages, the upstream segment shipped as a single pre-composited
contribution that becomes the *base layer* of the downstream stack. The current pose flow is
exactly this two-stage cut:

```
capture → behavior → mapping → [server compositor] ──vmc_pose Stream──▶ [client compositor: + clip + IK] → render
```

Each layer declares a **placement**, chosen by reconstructability/bandwidth:
- **`stream-result`** — input exists only upstream or is too costly to ship as source (live
  mocap @ 90 Hz): composite upstream, stream the *result*.
- **`sync-source`** — cheaply syncable and deterministically reconstructable downstream (a clip =
  asset synced once + a playhead timestamp via the existing `track_clip_*` messages): ship the
  *source*, composite locally. This is why keeping clips client-side is more stable — ~one
  timestamp instead of a frame stream.

Constraint: the cut must be a **single contiguous slice** (all `stream-result` layers below all
`sync-source` layers in the order) — the upstream partial composite is already folded when it
leaves. **Masks relax this**: layers over disjoint bone sets (clip=body, mocap=face) are
order-independent, so the cut sits freely between them.

Federation reuses the same knob: a subscriber with the clip **asset cached** + the playhead synced
reconstructs the clip layer downstream just like a local client (cut unchanged, ~one timestamp on
the wire); if it lacks the asset, the publisher moves the cut up and ships finished frames. "Two-
point" generalizes to "N-point" — any contiguous boundary, each chosen by the same test.

This refines the note below: poses are not simply "composited at the owner" — they're composited
in **stages**, with the live-capture segment necessarily `stream-result` and clips `sync-source`.

Caveats / decisions:
- **Blend semantics per layer/param must be explicit** (replace vs add vs multiply). Declare each
  param's compose rule in the `paramPaths` registry (the existing typed param schema).
- **Skeleton pose** is high-dimensional (per-bone quaternions, additive blends, bone masks) — it
  uses the *same compositor shape* with quaternion blend algebra, but composites in stages (see
  above) rather than scalar-per-paramPath.
- **Scalar fields composite at the consumer** (each layer synced individually, cheap + low-rate, so
  every client can hold its own live-edit/override layer). **Poses composite in stages** (live
  segment folded upstream and streamed; clip + client layers folded downstream). The general rule
  is per-layer placement, not per-value-type.

## Federation: two genuinely different replication strategies

The **plumbing is shared** — envelope, transports (ClientHub/ServerMesh), resource registry,
HLC/origin tagging, snapshot-on-connect, the four resource classes. But the two product modes
are **not** the same mechanism with a different field policy; they differ in the three things
that make distributed state hard: **persistence, authority, and reconciliation.**

### Strategy A — Object share (single-writer projection · *easy*)

A picks an object O to share. B receives a **"Shared" wrapper** — a real group node that B
**owns and persists** (placement, parenting, scale, lighting: B's presentation of O within
B's own scene). *Inside* the wrapper sits a **live, non-persisted projection** of O:

- **A is the sole authority** for O's intrinsic state + pose/expression streams.
- **B never writes and never persists** O's content — it renders the live projection and
  **caches assets only** (the VRM model, textures, audio), content-addressed by sha256.
  → reuse the preset asset path (`matchAssetByHash` / `materializeAsset`).
- On disconnect: B's **wrapper persists** (where O sat in B's scene); the projected content
  freezes on its last frame / clears, and re-streams when A returns.
- **No reconciliation, ever.** Single writer ⇒ no divergence is possible. This is the cheap,
  obvious VTuber-collab case — ship it first.

Resource-wise this is: a read-only **Document** projection (O's intrinsic tree, never written
to B's DB) + a **Stream** (O's pose) whose producer lives on A + a normal persisted Document
for B's wrapper. The proxy/`remote_avatar` node is the bridge, aliased to `(peerId, remoteId)`.
A remote avatar is literally a pose Stream with a remote producer — `Avatar.tsx`'s render path
is unchanged from a locally-mocap'd avatar.

### Strategy B — Full scene sync (multi-master replication · *hard*)

Both peers **own and persist the entire scene**; every edit is persisted in **both** DBs and
must land on the other side. While connected, per-entity/field LWW (HLC) converges fine.

The hard part is **offline divergence + reconciliation**, which Strategy A simply doesn't have:

- Both sides can edit independently while the link is down → on reconnect their DBs disagree.
- Needs **per-entity version vectors** (not a scalar clock) to tell *causal* from *concurrent*
  edits; **tombstones** for deletes (else a deleted entity gets resurrected from the peer's
  stale copy); and a **reconnect resync protocol** (exchange changes since last common version,
  apply a conflict policy).
- Conflict policy is a real decision with no free lunch:
  - *LWW per field + tombstones* — simplest workable; silently loses the losing side of a true
    concurrent edit.
  - *Operation log / CRDT* — preserves more intent; much heavier, and structural conflicts
    (A deletes node X while B edits X's child) still need explicit rules.
  - *Host-authoritative on reconnect* — one side wins wholesale; trivial but lossy.

This is genuine multi-master replication with its own failure modes; treat it as a separate
project, gated behind Strategy A.

### What's shared vs strategy-specific

| Concern | Object share (A) | Full sync (B) |
| --- | --- | --- |
| Receiver persists shared content | **No** (assets cached only) | **Yes** (full replica) |
| Authority over shared content | Publisher only | Both (concurrent) |
| On disconnect | shared object **dropped** (wrapper persists) | both keep editing own replica |
| Divergence possible offline | No | **Yes** |
| Reconciliation needed | None | **authority-coordinated** resync on reconnect |
| Conflict resolution | n/a (clean) | designated authority decides (see RESOLVED) |
| Shared plumbing | envelope · transport · registry · HLC/origin · snapshot — **both** |

- **RESOLVED — which to build, and order.** Object share first (no reconciliation, high value).
  Full sync **is in scope** (not optional): its symmetric ownership is wanted for *fault
  tolerance* — see below — so reconciliation must be designed, not deferred away.
- **RESOLVED — authority granularity (Strategy A): coarse.** Publisher owns the shared object's
  state **completely**; the subscriber can only influence its **transform via the wrapper**. No
  capability model, no subscriber writes to content. (Revisit only if a real need appears.)
- **RESOLVED — Strategy A on disconnect: drop the object.** When the link fails, the subscriber
  simply removes the projected object — no in-memory freeze/idle, no fallback to persist. The
  B-owned **wrapper persists** (empty), and the object re-projects when A reconnects. (Simplifies
  Strategy A: pure live projection.)
- **RESOLVED — Strategy B persistence + reconciliation: symmetric persistence, authority-
  coordinated reconnect.** *Both* peers persist a full replica so either can keep working
  standalone while the link is down (the fall-back state). On reconnect, **one designated server
  has reconciliation authority** and resolves divergence — i.e. authority-coordinated, not a
  symmetric per-field CRDT merge. This avoids version-vector machinery. Open sub-points:
  - *How the authority is chosen* — fixed (project owner/host) vs per-session/elected.
  - *What the authority does on conflict* — wholesale "authority wins" (simplest, discards the
    other side's offline edits) vs **apply both, authority breaks ties only on the same field**
    (recommended: keeps non-conflicting offline work cheaply; needs change-tracking since last
    sync, e.g. a dirty-since-sync marker per entity, but no full vector clocks).
- **DECISION — discovery / signaling & bus:** how B finds and requests A's publication (directory
  service) and the relay transport: Redis pub/sub (pragmatic; adds presence + scale), NATS, or a
  direct WS peer mesh. Recommend Redis + a thin directory.

### Fault tolerance: three things "ownership" was conflating

The requirement *"the stream must not break down at either end if the connection fails at one
end"* separates into three independent properties — only one of which is actually "ownership":

1. **Write authority** — who may mutate content. *Object share:* publisher only (resolved
   above). *Full sync:* **symmetric** — both write, and **both persist a fall-back replica** —
   which is what keeps each end working when the link drops (each keeps editing standalone,
   then an authority-coordinated resync runs on reconnect). This is why symmetric ownership is
   the right call for the scene-sync mode, and it is the thing that costs reconciliation.
2. **State retention** — who holds a usable copy when the link is down. *Full sync:* both keep
   the whole persisted replica (the explicit fall-back requirement). *Object share:* the
   subscriber keeps nothing — the object is **dropped on disconnect** (resolved) and re-projects
   on reconnect; only assets stay cached.
3. **Stream liveness** — new frames need the producer. If the producer is unreachable, **no
   ownership model conjures new motion**. For object share this is moot (the object is dropped);
   for a shared avatar that stays visible it would mean freeze / idle / extrapolate — a
   render-side policy, never something ownership can buy. So "doesn't break down" means *graceful
   degradation*, a render-side policy, not literal continuation of live motion.

Net: symmetric ownership **+ symmetric persistence** (property 1) gives editing resilience for
the persistent scene and is adopted for full sync, resolved on reconnect by a designated
authority. Object share stays a pure live projection — dropped on disconnect, re-projected on
reconnect — needing none of that machinery.

## Build vs. buy, and extractability

**No single dependency fits**, because the two most distinctive parts of this design are exactly
what off-the-shelf libraries don't provide:

- **Reconciliation:** we chose an authority-coordinated referee, *not* automatic merge — the
  opposite of what CRDT libraries (**Yjs**, **Automerge**) are built around. Adopting one means
  taking on a CRDT engine (and its imposed data model) for a feature we decided against.
- **The override-layer compositor:** no general JS package exists — this is animation-engine
  territory (Blender NLA strips, Unity animator layers). Three.js `AnimationMixer` does additive
  *clip* blending but not a general per-property compositor over arbitrary sources. Ours to build
  (small; well-trodden NLA semantics).

The broader "sync engine" / local-first frameworks (**Zero**, **ElectricSQL**, **PowerSync**,
**Replicache**, **Triplit**, **Instant**, **Jazz**, **Liveblocks**, **PartyKit**) are powerful but
are things you *build the app around*, are usually **coupled to a specific backend DB** (Postgres)
and/or **hosted/commercial**, and **none model our pose streams or the layer compositor**.
Retrofitting one into the existing Express + SQLite + Zustand + R3F app is a large inversion of
control. Transport (`ws`, Redis pub/sub, PartyKit) and the high-frequency stream channel are
commodity.

**Verdict: mostly build, selectively borrow.** Keep one door open — if *full-scene co-edit* ever
needs true offline auto-merge instead of a referee, slot **Yjs behind only the Document class for
that mode**. (Library landscape moves fast; re-verify before committing to any.)

**Designed to be extractable** — the seams are already right; it's a matter of discipline:
- **Core stays domain-agnostic** — envelope, resource registry, the four classes, HLC/versioning,
  snapshot protocol, compositor know nothing about `scene_node`/VRM. They work on generic
  `(rtype, key, value)` + policy + blend functions.
- **vspark specifics live at the edges as config** — resource descriptors (load/persist), the
  `paramPaths` + blend declarations, store-slice bindings.
- **Transport is a port, not a hard-wire** — an interface the core depends on; `ws` adapter now,
  Redis/PartyKit later. This is the biggest enabler of reuse.
- **No framework lock-in in the core** (plain TS); thin adapters for Zustand (client) and
  Express/SQLite (server); the compositor is pure functions.

Natural split: `sync-core` (isomorphic), `sync-server` (persistence/snapshot/mesh), `sync-client`
(store binding/reconnect). The pnpm monorepo makes the cheap path obvious: build as an internal
`packages/sync` with a clean public surface from day one; extract to its own repo once proven.
Stance: **"extraction-ready, not extracted"** — keep config-at-the-edges + transport-as-a-port,
but don't over-generalize or publish before a real second consumer exists.

## Migration path (each phase shippable on its own)

- **Phase 0** — Introduce `SyncEnvelope` + resource registry + `applyRemote` dispatcher
  *alongside* existing messages. No behavior change.
- **Phase 1** — Migrate Document/CRUD entities to `sync.document.*`; send canonical DTOs
  and **delete the duplicated frontend mappers**. Generically fixes the preset-sync bug class.
- **Phase 2** — Fold `RuntimeOverrideManager` + `DataChannelManager` into `sync.field.*`
  (≈90% there already). Add the live-edit overlay; unify preview→commit on it. **Introduce the
  layer compositor** (single effective-value resolver) and retire the duplicated merge chains
  (`useTransformWithOverride`, `layerStyle`) and the `suppressedOverrides` muting hack.
- **Phase 3** — Wrap pose/blendshape/IK in `sync.stream.*` with coalescing; centralize
  smoother routing. Mostly rename + consolidation.
- **Phase 4** — Add HLC + `origin` end-to-end (harmless pre-multiplayer; prerequisite for it).
- **Phase 5 — Object share (Strategy A).** `ServerMesh` transport + a thin directory;
  **publications**, **proxy/`remote_avatar` entities** (live read-only Document projection +
  remote Stream), B-owned persisted **wrapper group**, sha256 asset caching. No reconciliation.
- **Phase 6 — Full scene sync (Strategy B), separate effort.** Multi-master document
  replication: per-entity **version vectors**, **tombstones**, reconnect **resync protocol**,
  and the chosen conflict policy. Gated behind Phase 5 and its own design pass — this is the
  hard distributed-systems work.

## Out of scope (for the first build)

- Render-side smoothing/tweening (stays in `previewSmoother`).
- Concurrent character-level text editing (LWW only).
- Stream backpressure tuning beyond "drop stale frames."
- Auth/permissions on who may write which resource (separate concern).

## Files in scope (Phases 0–2, indicative)

- `packages/shared/src/sync.ts` *(new)* — `SyncEnvelope`, resource-class types, HLC.
- `packages/backend/src/sync/registry.ts` *(new)* — resource descriptors (loader, mapper,
  policy, scope) + producer API (`document`/`field`/`stream`/`event`).
- `packages/backend/src/sync/transport.ts` *(new)* — wraps `WSSync` as ClientHub; later ServerMesh.
- `packages/backend/src/ws/index.ts` — keep as low-level socket hub under the transport.
- `runtime_overrides/manager.ts`, `data_channels/manager.ts` — re-express as field resources.
- Routes (`scene-nodes`, `behaviors`, `camera-effects`, `compose-layers`, `track-clips`,
  `presets`) — replace manual `broadcast` with `sync.document.*`.
- `packages/frontend/src/hooks/useWsSync.ts` — collapse the if/else chain into one
  `applyRemote(envelope)` + a frontend resource→slice registry.
- `packages/frontend/src/api/client.ts` — drop per-entity WS mappers once DTOs are canonical.

## Acceptance / verification

- `pnpm lint` + frontend `tsc --noEmit` clean.
- Two browser clients: a preset instantiation, a CRUD edit, a live param drag, and a pose
  stream all reflect on the *other* client with no reload. Stale/out-of-order updates do
  not clobber newer ones.
- Adding a brand-new entity requires touching only its registry entries (proof the
  abstraction holds).

## Output

Phased PRs into `dev` (one per phase).
