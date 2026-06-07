# Plan: Unified state-replication layer

> Branch: `feature/unified-sync-layer` · Status: draft (design — needs decisions before implementation)
> Seed context for design discussion. Several forks (marked **DECISION**) need an
> answer before this is ready to build.

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

## Federation, sharing modes & multi-server

Two product modes, **one mechanism**:

- **Full-scene sync** — peers mirror the same scene; documents + fields + streams all
  replicate; concurrent edits converge (per-key LWW).
- **Object / avatar sharing** — a peer *publishes* an object (e.g. an avatar subtree + its
  pose/expression streams); other peers *subscribe* and embed it into their own, different
  scene, controlling its placement / lighting / composition locally.

**Unifying insight:** full-sync is just object-sync where the published object is the whole
scene and presentation is shared too. Both are the same primitive — a **publication** (a
scoped set of resources a peer offers) that subscribers **project** into local state under a
**presentation overlay**. (Decided: **per-server DB**; sharing whole scenes vs single
objects still open — see DECISION below.)

New concepts (extend, don't replace, the resource model):

- **Publication** — a named, scoped bundle of resources. The envelope's `scope` generalizes
  from `sceneId` to a publication id. Local-only resources use a local scope that never
  crosses the transport.
- **Authority split (per field-class)** — the base⊕overlay split with a network boundary:
  - *Intrinsic* state (which avatar/model, pose/tracking stream, expressions) → owned by the
    **publisher**, replicated read-only to subscribers.
  - *Presentation / extrinsic* state (transform in MY scene, parenting, scale, lighting,
    layer order) → owned by the **subscriber**, a **local overlay that is never sent back**.
  - In embed mode authority is clean, so there are almost no write conflicts — **LWW only
    really bites in full co-edit mode.**
- **Proxy entity** — subscribing mints a local `remote_avatar`/proxy node aliased to
  `(peerId, remoteEntityId)`; it renders the replicated intrinsic state + remote pose stream
  and carries the local presentation overlay. A **live link, not a copy** (contrast preset
  instantiation, which mints independent copies).

**Big reuse:** a remote avatar is just a **Stream** whose producer lives on another peer.
Today a `vmc_pose` stream keyed by nodeId is produced by a local UDP VMC receiver and
rendered by `Avatar.tsx`; swap the producer for a remote peer and the *render path is
unchanged*. Federation rides on the Stream class built in Phase 3.

Per-server DB is fine for this: you replicate **publications** (curated projections), not
whole databases. A subscriber stores a proxy + its own presentation, so cross-server
*document* replication is scoped to published subtrees — not a full-DB sync problem.

- **DECISION — sharing modes:** object-sharing only, full-scene only, or both. Recommend
  designing the publication/authority model now (it subsumes both) and shipping
  **object-sharing first** (cleaner authority; the obvious VTuber-collab usecase), with full
  co-edit as a later publication policy.
- **DECISION — authority granularity:** is the intrinsic/presentation split sufficient, or
  do publishers need a **capability model** (expose specific params as read-only / writable
  to subscribers, e.g. "you may tint my avatar but not move its bones")?
- **DECISION — discovery / signaling & bus:** how a subscriber finds and requests a
  publication (directory service). For the relay/transport: Redis pub/sub (pragmatic, adds
  presence + scale), NATS (richer), or direct WS peer mesh (no infra, worse at scale).
  Recommend Redis + a thin directory.

## Migration path (each phase shippable on its own)

- **Phase 0** — Introduce `SyncEnvelope` + resource registry + `applyRemote` dispatcher
  *alongside* existing messages. No behavior change.
- **Phase 1** — Migrate Document/CRUD entities to `sync.document.*`; send canonical DTOs
  and **delete the duplicated frontend mappers**. Generically fixes the preset-sync bug class.
- **Phase 2** — Fold `RuntimeOverrideManager` + `DataChannelManager` into `sync.field.*`
  (≈90% there already). Add the live-edit overlay; unify preview→commit on it.
- **Phase 3** — Wrap pose/blendshape/IK in `sync.stream.*` with coalescing; centralize
  smoother routing. Mostly rename + consolidation.
- **Phase 4** — Add HLC + `origin` end-to-end (harmless pre-multiplayer; prerequisite for it).
- **Phase 5** — Federation: `ServerMesh` transport, **publications** (scope generalization),
  **authority split** (publisher-intrinsic vs subscriber-presentation overlay), and
  **proxy/`remote_avatar` entities**. Object-sharing first (a published avatar = a remote
  Stream + read-only intrinsic doc), full-scene co-edit as a later publication policy.

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
