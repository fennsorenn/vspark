# Sync Layer (unified state-replication)

**Status: Phases 0–2 + 4 implemented; Phase 3 API-surface-only; field-fold / live-stream migration / manager-fold deferred.**

A single abstraction for all replicated state — replacing the per-entity pattern of "one backend `broadcast` call + one frontend `else if` branch + duplicated snake↔camel mappers". Adding a syncable thing becomes **one descriptor (backend) + one binding (frontend)**. Designed to extend to server-to-server replication later without reworking producers/consumers.

Coexists with the legacy bespoke WS message kinds during the migration: anything not yet registered keeps riding its old message. See the design docs [unified-sync-layer.md](../plans/unified-sync-layer.md) and [unified-sync-layer-diagrams.md](../plans/unified-sync-layer-diagrams.md).

## Resource classes

A resource declares one of four **delivery classes** (`ResourceClass` in `packages/shared/src/sync.ts`):

| Class      | Ops                 | Persisted    | Snapshot                       | HLC | Use                                                                                  |
| ---------- | ------------------- | ------------ | ------------------------------ | --- | ------------------------------------------------------------------------------------ |
| `document` | `upsert` / `remove` | yes (SQLite) | (via REST load on mount today) | yes | CRUD entities — scene nodes, behaviors, camera effects, compose layers, track clips  |
| `field`    | `patch` / `remove`  | optional     | yes (planned)                  | yes | overlay/override params (runtime overrides, data channels) — **not yet implemented** |
| `stream`   | `frame`             | no           | no                             | no  | high-frequency lossy frames (pose, blendshapes, IK) — **API surface only**           |
| `event`    | `event`             | no           | no                             | no  | fire-and-forget commands (media control)                                             |

## The envelope

One wire shape for everything (`SyncEnvelope`), wrapped in a single WS message kind `SYNC_MESSAGE_KIND = 'sync'`:

```ts
interface SyncEnvelope {
  rtype: string; // resource type, e.g. 'scene_node'
  op: SyncOp; // upsert | remove | patch | frame | event
  scope?: string; // routing key for selective fan-out + snapshot grouping (e.g. sceneId)
  key: string; // entity id, composite field key, or stream key
  data?: unknown; // canonical DTO / value / frame (omitted for remove)
  v?: HLC; // ordering/convergence stamp (documents/fields; omitted for streams)
  origin?: string; // originating peer id — echo + loop suppression
}
```

## Dotted-path addressing

A value's identity is `<rtype>:<id>[:<subPath>]`. The first two `:`-segments are the identity (rtype + UUID id, both dot-free); an optional dotted sub-path (a paramPath like `position.x`) follows. Dots live **only** inside the sub-path, so splitting is unambiguous. Helpers in `sync.ts`:

- `makeKey(rtype, id, subPath?)` / `parseKey(key)` — build/split addresses.
- `keyMatches(key, prefix)` — prefix-subscription match for selective fan-out. `''`/`'*'`/`'**'` match everything; a trailing `.*`/`.**`/`*` means "this segment and below"; plain prefixes match on `:`/`.` boundaries so `scene_node:ab` doesn't match `scene_node:abc`.

It's a string convention, not a query engine.

## Backend — producer hub + registry

`packages/backend/src/sync/`:

- **`registry.ts`** — `defineResource(descriptor)` / `getResource(rtype)`. A `ResourceDescriptor` is the **only** place vspark-specific knowledge lives:
  - `rtype`, `cls` (the resource class)
  - `scope?(dto)` — routing scope (e.g. `rootSceneNodeId`); `undefined` = global fan-out
  - `load?(id)` — document only: read the row and map it to the canonical camelCase DTO (the same shape the REST `getScenes` mappers produce), or `undefined` if the row is gone.
- **`index.ts`** — the `sync` hub singleton. `init(ws)` from the server entrypoint. Each producer call looks up the descriptor, builds the envelope, and hands it to the transport (the shared `WSSync` bus). The hub holds the process `peerId` (`origin` + HLC tiebreak) and the HLC clock.
  - `sync.document.upsert(rtype, id)` — `load`s + maps the DTO, broadcasts an HLC-stamped `upsert`.
  - `sync.document.remove(rtype, id, scope?)` — broadcasts an HLC-stamped `remove` (the stamp doubles as a tombstone).
  - `sync.stream.publish(rtype, key, frame, scope?)` — one lossy frame, no HLC/persistence/snapshot.
  - `sync.event.emit(rtype, data, scope?)` — fire-and-forget command.
  - `sync.field.*` — not yet present (Phase 2 fold of the override/data-channel buses).
  - `sendSnapshotTo(send)` — currently a no-op; clients still hydrate documents via the REST load on mount. Field/stream snapshot providers land later.
- **`resources.ts`** — the descriptors. Imported for side effects from the server entrypoint. Registers `scene_node`, `behavior`, `camera_effect`, `compose_layer`, `track_clip` as `document`s, and `vmc_pose`, `vmc_blendshapes`, `pose_ik_targets` as `stream`s (names reserved; no `load`/`scope`).

## Frontend — apply dispatcher + bindings

`packages/frontend/src/sync/`:

- **`registry.ts`** — `bindResource(rtype, { apply })` + the single `applyRemote(env)` dispatcher. `useWsSync` routes every `'sync'` envelope through `applyRemote`, replacing the per-message if/else chain as resources migrate. Unknown rtypes are ignored (so the new path coexists with not-yet-migrated legacy messages).
- **`resources.ts`** — the client bindings. Each `apply(op, key, data, env)` writes one resource into the Zustand store. The server sends canonical camelCase DTOs, so bindings store them directly — **no per-message mapper**. `upsert` dedupes by id so the initiating client (which already added the entity from its REST response) doesn't double-insert. Imported for side effects by `useWsSync`.

`useWsSync.ts` wiring: `import { SYNC_MESSAGE_KIND } from '@vspark/shared/sync'; import { applyRemote } from '../sync/registry'; import '../sync/resources';` — the `'sync'` branch calls `applyRemote(msg.payload)`.

## HLC stale-drop (Phase 4)

Document emits carry a **hybrid logical clock** stamp (`HLC = { t: wall-ms, c: tiebreak counter, n: peer id }`) plus `origin`. `makeHlcClock(peerId)` guarantees strictly increasing `(t,c)` even if the wall clock stalls/jumps back. `compareHLC` gives a total order (wall-clock, then counter, then peer id).

The client keeps the last applied stamp per `rtype:key` in `lastVersion`. An incoming envelope whose stamp is **older-or-equal** to the recorded one is dropped (`compareHLC(env.v, prev) <= 0`) — this discards out-of-order / duplicate delivery and stops a stale `upsert` from resurrecting a removed entity (the removal's stamp stays recorded as a tombstone). Streams omit `v`, so they bypass this entirely (latest-wins by arrival). Multi-peer clock merge arrives with the server mesh (a later phase).

## Compositor (Phase 2 read-model)

`packages/frontend/src/compositor.ts` — `compositeScalars(base, layers)` centralises the clip > runtime > base precedence that was duplicated in Viewport's `useTransformWithOverride` and ComposeLayerStack's `layerStyle`. Today every layer is `replace` (highest present numeric field wins — applying the clip layer last means it wins); add/multiply/weighted blends and pose compositing layer on later. The two consumers were refactored onto it (behaviour-preserving). See [runtime-overrides.md](runtime-overrides.md) and [track-clips.md](track-clips.md) for the two override surfaces it folds.

## Adding a new syncable resource

For a CRUD document, two edits:

1. **Backend** — `defineResource({ rtype, cls: 'document', scope?, load })` in `packages/backend/src/sync/resources.ts`, where `load` reads the row and returns the canonical camelCase DTO. Then call `sync.document.upsert(rtype, id)` from the CREATE route and `sync.document.remove(rtype, id)` from the DELETE route.
2. **Frontend** — `bindResource(rtype, { apply })` in `packages/frontend/src/sync/resources.ts`, dedup-on-`upsert` and `remove`-on-remove into the right store slice.

No new WS message kind, no new `useWsSync` branch, no new mapper.

## Migrated vs. still on legacy WS kinds

**Migrated to sync (Phase 1):**

- **CREATE** of `scene_node`, `behavior`, `camera_effect`, `compose_layer`, `track_clip` → `sync.document.upsert` (routes `scene-nodes.ts`, `behaviors.ts`, `camera-effects.ts`, `compose-layers.ts`, `track-clips.ts`).
- **DELETE** of the same five → `sync.document.remove`.
- **Preset instantiation** (`routes/presets.ts`) emits created entities via `sync.document.upsert`.

**Still on legacy WS kinds:**

- **UPDATE** broadcasts — `node_updated`, `compose_layer_updated`, `camera_effect_updated`, `compose_layer_reordered`, etc. (smoothing-sensitive commits; deferred to the field/document-patch work).
- **Live pose pipeline** — `vmc_pose` / `vmc_blendshapes` / `ik_targets` still emit their legacy kinds at ~60–90 Hz; the stream rtypes are registered but `sync.stream.publish` is not yet on the hot path (deferred until runtime-verifiable).
- **Spawn manager** — still emits `node_added` / `compose_layer_added` / `track_clip_added` (and removals) inline with full data, so those legacy handlers are **kept** even for the migrated document types. See [spawn.md](spawn.md).
- **Runtime overrides** (`runtime_override_*`) and **data channels** (`data_channel_*`) — still on their own managers/messages; folding them into `sync.field.*` is deferred.

## Deferred / not yet done

- Folding `RuntimeOverrideManager` + `DataChannelManager` into `sync.field.*`.
- A unified dotted-path layered store on the client.
- Removing `suppressedOverrides`.
- Migrating the live pose pipeline onto `sync.stream.publish`.
- Field/stream snapshot providers in `sendSnapshotTo`.

## Cross-references

- [unified-sync-layer.md](../plans/unified-sync-layer.md) / [unified-sync-layer-diagrams.md](../plans/unified-sync-layer-diagrams.md) — design rationale, decisions, diagrams, use-case walkthroughs.
- [runtime-overrides.md](runtime-overrides.md) — the override bus that `sync.field.*` will eventually absorb; its read path now goes through the compositor.
- [data-channels.md](data-channels.md) — the data-channel bus, the other future `field` resource.
- [track-clips.md](track-clips.md) — track-clip overrides; the clip layer the compositor folds (clip wins on overlap).
- [compose.md](compose.md) — compose-layer CRUD now flows through sync; updates/reorder stay on legacy kinds.
- [spawn.md](spawn.md) — why the legacy `*_added`/`*_removed` handlers are kept.

## Files

- `packages/shared/src/sync.ts` — envelope, `ResourceClass`, addressing helpers, `HLC` + `compareHLC` + `makeHlcClock`, `SYNC_MESSAGE_KIND`
- `packages/backend/src/sync/registry.ts` — `defineResource` / `getResource` / `allResources`
- `packages/backend/src/sync/index.ts` — the `sync` producer hub
- `packages/backend/src/sync/resources.ts` — backend descriptors
- `packages/frontend/src/sync/registry.ts` — `bindResource` / `applyRemote` + HLC stale-drop
- `packages/frontend/src/sync/resources.ts` — client bindings
- `packages/frontend/src/compositor.ts` — `compositeScalars` read-model
- `packages/frontend/src/hooks/useWsSync.ts` — `'sync'` envelope routing
