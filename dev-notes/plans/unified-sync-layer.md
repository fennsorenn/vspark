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
| Divergence possible offline | No | **Yes** |
| Reconciliation needed | None | Version vectors + tombstones + resync |
| Conflict resolution | n/a (clean) | LWW / op-log / host-wins (DECISION) |
| Shared plumbing | envelope · transport · registry · HLC/origin · snapshot — **both** |

- **DECISION — which to build, and order.** Recommend **Object share first** (no reconciliation,
  high value), Full sync later as a distinct effort.
- **DECISION — Strategy B conflict/reconciliation policy** (only if/when full sync is pursued):
  LWW+tombstones vs op-log/CRDT vs host-wins.
- **DECISION — authority granularity (Strategy A):** is "publisher owns content, subscriber owns
  wrapper" enough, or do publishers need a **capability model** (expose specific params as
  read-only/writable, e.g. "you may tint or emote my avatar, not move its bones")?
- **DECISION — discovery / signaling & bus:** how B finds and requests A's publication (directory
  service) and the relay transport: Redis pub/sub (pragmatic; adds presence + scale), NATS, or a
  direct WS peer mesh. Recommend Redis + a thin directory.

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
