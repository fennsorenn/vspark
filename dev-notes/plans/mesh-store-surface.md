# Plan: The mesh as a store

> **Status:** in progress — steps 1 and 2 done (branches `feature/mesh-store-models`,
> `feature/mesh-store-grants`, not merged). Open questions settled with the user 2026-10-04.
> **Sequences:** the remaining workstreams of [`mesh-sole-channel.md`](./mesh-sole-channel.md).
> That plan still lists what has to move onto the mesh, and its principles 7–9 stand.
> This plan decides what the mesh surface has to look like first, so that each later
> move is "declare a model, put documents", not another round of app-side glue.
> **Builds on:** [`mesh-sync-refactor.md`](./mesh-sync-refactor.md) §8 (the agreed
> interface) and [`permissioned-sync-mesh.md`](./permissioned-sync-mesh.md) (the
> original grant and topology contract).

> Branch: one `feature/mesh-store-<step>` branch per step below, each merged into `dev`.
> This plan is the seed context for a worker. It is a starting point, not an
> airtight spec. Ask when something isn't covered.

## Goal

App code uses the mesh like a store. In the user's words (2026-10-04):

> Put a doc into the store, all peers (with grants) see it enter the store. Bind a doc
> to a form, changes are synced between all peers (with different channels to account
> for individual transport needs, like lossy for preview channel). Anything beyond
> that should be simple declarations, like: declare channel types once. Declare model
> types once. A simple surface to do the wiring and grant declarations.

The target, as app code:

```ts
// shared — declared once, imported by backend and frontend
export const channels = defineChannels({
  committed: { transport: 'reliable', stamped: true, retained: true },
  preview:   { transport: 'lossy' },
  control:   { transport: 'reliable' },
});
export const models = defineModels({
  scene_node: { schema: SceneNodeDoc, parent: (d) => ... },
  behavior:   { schema: BehaviorDoc,  parent: (d) => ({ rtype: 'scene_node', id: d.nodeId }) },
});

// wiring — once per side
const mesh = createMeshPeer({ identity, models, channels, transports });
mesh.grants.grant(ownServerId, { entityRtype: '*', entityId: '*', rights: RUCD });
// backend only: hydrate on boot, persist in a tap

// everywhere else
mesh.collection('scene_node').create(doc);
const [name, setName] = useMeshField(nodes, id, 'name');   // preview while typing, commit on blur
```

## Constraints

- **[decided, user 2026-10-04]** The vision above is the acceptance test for every
  mesh API change. Something that makes app code know about peers, paths, roles or
  transports is a defect in the mesh, not a reason for glue.
- **[decided, user 2026-10-04]** The mesh is project-agnostic. Tab↔server is not a
  blank check: it is defined by grants like any other link, just very permissive ones.
  No collection- or peer-level flag may stand in for a grant.
- **[decided, design session 2026-06-11, mesh-sync-refactor.md §8]** API symmetry,
  role asymmetry: identical read/write API on every peer. `mesh.subscribe(...)` takes
  no peer argument. The replica becomes the store for synced state
  (`@vspark/mesh-react`); Zustand keeps local UI state only. No durability in the
  package (hydrate via `put`, persist via taps). One ack authority per collection.
- **[decided, permissioned-sync-mesh.md]** A client takes grants from one source, its
  own server. Admission happens at the source against its grant table. There is no
  `if (owner) bypass`: a server's own edits pass the same grant-checked path.
  Validate on receive everywhere. A rejected or corrected committed write is repaired
  by the authority re-broadcasting the canonical value as an ordinary stamped write.
- **[decided, user, mesh-sole-channel.md principles 7–9]** The mesh is the only
  client↔server channel. Every subscription takes the most direct path, and server
  hops are only the fallback. All participants authenticate, and grants are a
  whitelist. Relays are trusted (no end-to-end encryption). Control and command are
  one channel. REST stays as an edge adapter that writes through the mesh.
- **[decided, user]** A co-located server counts as direct: tabs of one server meet
  through it. Relays are limited to the endpoints' own servers.
- **[observed]** Undo is mesh-native (`meshBatch`, per-tab undo stack in
  `MeshPeer`, `removeTree` as one action). The user listed undo among the
  capabilities to cover in tests (2026-10-04); it has to keep working through every
  step.
- **[observed]** The app-side mesh glue is about 5,200 lines. Models are declared
  twice: `backend/src/mesh/index.ts` (`BINDINGS`) and `frontend/src/mesh/peer.ts`
  (`RTYPES`, `PARENTS`, `CHANNELS`). The editor loads synced state from REST
  (`api.getScenes`). `sync/meshStoreFeeder.ts` mirrors the replica into Zustand.
  `mesh/writes.ts` plus the `layer`/`clip`/`logic` write helpers carry a REST
  fallback ladder.
- **[observed]** Policy currently lives in config flags and code paths instead of
  grants: `home` and `authority` egress exemptions, the subscription shortcut in
  `admitOp`, `CollectionConfig.clients`, `relay: false`, `exact`, and the
  `peer_grant` collection the app mirrors by hand. `relay`, `exact` and `peer_grant`
  were added for direct links (F6, merged 2026-10-04) as a stopgap. Steps 2 and 4
  replace them.

## Steps

Each step lists the app code it removes. A step is done when that code is gone, not
merely unused.

**Order (decided, user 2026-10-04): 1 → 2 → 3 → 4.** Step 2 changes semantics that
step 3 builds on: rejects become canonical re-broadcasts, `canWrite()` stops
depending on the authority exemptions, and a subscription waits for its grant
instead of failing. The generic form binding in step 3 has to handle exactly those
cases, so it is written once, against the final semantics. Steps 1 and 2 touch
mostly different files (shared declarations vs. core admission and grants) and may
run side by side. Step 4 needs step 2.

### Step 1: Models and channels declared once

✅ Done (4fb3aed; bundle fix fd6670a). One deviation from the text below: clock
translation could not stay inside `validate`. Run on the composed document it
would translate `startEpoch` again on every field edit, so clock fields became
a declaration (`clockFields`) that the core translates per hop. This is a call
I made, recorded for review.

Move what both sides declare about a document type into one shared module: rtype,
runtime schema, parent function, channels. `createMeshPeer` takes `models` and
`channels`, and `mesh.collection(rtype)` is typed from them. What only a server
does (persistence, side effects, guards) stays in backend code, attached by rtype.

- `packages/mesh/src/peer.ts`, `collection.ts`: accept declarations, typed
  collection access.
- `packages/shared/src/` (new module): the vspark model and channel declarations.
  Runtime schemas exist only as request schemas today (`schema.ts`); the document
  schemas are new.
- `backend/src/mesh/index.ts`: bindings keep only `table`, persistence and hooks.
- `frontend/src/mesh/peer.ts`: `RTYPES`, `PARENTS`, `CHANNELS` deleted.

**One validator (decided, user 2026-10-04).** Today `validate` runs only on
whole-document upserts (patches skip it, `packages/mesh/src/peer.ts` "Only whole
docs are validated"), and the backend's `guard` runs on the composed document in
the persistence tap. A check placed in `validate` is bypassed by a field edit. For
example, a scene instance created with `sourceSceneId` set to its own scene is
rejected, but setting that one field afterwards
(`set(id, 'properties.sourceSceneId', ownScene)`) skips the check. They merge into
one `validate` that receives the composed result of any op (create, whole
document or single path) and may correct or reject it. Schema and structural
checks come from the shared declaration and run on every peer. Checks that need
the database are added by the backend. Previews are not composed and checked; an
invalid preview is visible only briefly. `guard` disappears.

**Known oddity, not solved here:** `validate` also re-scopes a collab document's
`projectId` onto the receiving server's own project, which is a per-server rewrite,
not validation. It is why relays forward the rewritten data.

**Removes:** the duplicated parent functions and channel lists, `guard`.

### Step 2: Subscriptions without a target, grants instead of flags

✅ Done (9ed50c6). Calls made beyond the text below, recorded for review:
- **A tab is recognised by its participant id** (`server#tab`, assigned by the
  server; permissioned-sync-mesh.md §2). That replaces the `home` and `relay`
  flags: a participant's own server decides its writes, and it forwards
  nothing. Grants still gate everything.
- **Delegation:** a server delivers to its own tabs the grants it issued to
  others, so a tab can admit a direct subscriber on its server's behalf. That
  is what replaced `peer_grant`.
- **Authority is derived** (config override, else the tab's server, else the
  grantor of a write grant we hold, else self). The plan text kept a
  per-collection `authority` config; nothing in vspark sets it any more.
- **Delivered grants outlive a dropped link**, so a shared space stays the
  sharer's (read-only) while they are offline.
- **A write no grant allows fails fast** with `denied` instead of timing out.
- **Asymmetry left open:** with one-way sharing the author's tabs serve the
  mounting server's tabs directly, but not the reverse (the mounting server
  grants the author nothing). For step 4.

`mesh.subscribe(sub)` as agreed. A peer learns where it can subscribe from the
grants issued to it: each peer sends a linked participant the grants it holds for
that participant, on link setup and on change (permissioned-sync-mesh.md §3, the
client-side grant view), and each delivered grant carries its grantor. A tab
receives its server's grants that way, including those its server got from remote
servers. The source of a subscription is the grantor; the path is the most direct
live link to it, else the tab's own server.

Tab↔server becomes explicit grants. The server grants its own id (which covers its
tabs, `granteeCandidates`) broad rights; the tab grants its server the same. Then
the special cases go:

- `home` and `authority` egress exemptions, the subscription shortcut in `admitOp`
  (including the `isClientParticipant` check added in F6).
- `CollectionConfig.clients`: becomes the server's grant to its tabs.
- `peer_grant` and its mirroring in the tab: replaced by core grant delivery.
- A subscription that arrives before its grant is held as pending and admitted
  when the grant appears, instead of a final denial. This removes the retry loops
  in `backend/src/mesh/collab.ts` and in the tab.
- A rejected or corrected committed write is re-broadcast as the canonical value to
  every subscriber, not only nacked to the author.

**Collab is one-way (decided, user 2026-10-04).** This reverses mesh-sync-refactor.md
§9 decision 1 (a mutual RUCD grant, mutual subscription, unguarded server↔server
writes). Today two servers each decide for a shared scene, so a write the scene's
server would refuse is accepted on the other server, logged as an error on the
scene's server, kept in its replica but not its database, and never reported to
the author. Now only the scene's server grants, and it is the authority: the other
server's writes reach it as guarded writes and are acked, corrected or rejected,
with the canonical value re-broadcast. While the scene's server is offline the
shared scene is read-only on the other side, consistent with §8.5 (writes gated
while the authority is unreachable, no offline write queue). Working on a shared
scene without its server is the job of "Create local copy" (follow-up below).

### Step 3: The replica is the store

The editor opens a project by subscribing to it and renders from the replica. The
REST scene bundle stops being the load path for synced rtypes. Components read
through `@vspark/mesh-react` hooks, and forms bind with `useMeshField` (generic
over collection, preview while editing, commit on release, one undo step per
commit), which moves into `mesh-react`.

Migrate one rtype at a time, smallest first (`camera_effect` as the pilot, then
`behavior`, compose layers, clips, `scene_node` last), deleting its feeder branch
and its write wrappers as it goes.

- `packages/mesh-react`: `useMeshField`, plus whatever a migrated panel needs.
- `frontend/src/pages/Editor.tsx`: load via subscription snapshot.
- `frontend/src/sync/meshStoreFeeder.ts`: shrinks per rtype, then deleted.
- `frontend/src/mesh/writes.ts`, `layerWrites.ts`, `clipWrites.ts`,
  `logicWrites.ts`: the REST fallback ladder goes (the mesh is the only channel;
  `canWrite()` gates controls, per §8.5). Plain `set`/`remove` wrappers go. Real
  domain operations stay as app functions over a batch: promoting a layer to a
  node, pasting a graph, sibling order keys.
- `frontend/src/store/editorStore.ts`: synced slices removed.

**Removes:** the feeder, the fallback ladder, the load-race mitigations
(`withoutRemoved`, `pruneStale`), which have nothing left to guard.
**Watch:** the preview smoothing done in the feeder (`previewSmoother`) becomes a
read-side hook. Placed remote objects (`sync/meshProjection.ts`,
`sharedProjection.ts`) are already in the replica; check how much projection code
survives once panels read it directly.

### Step 4: Direct links as a transport

A WebRTC transport in `packages/mesh-transports` (the `browserPeerTransport` from
§8.9), signaling over addressed `control` messages through each side's server.
With step 2 in place, a direct link is just a better path for subscriptions that
already exist. Committed writes travel it too, since step 2's canonical
re-broadcast covers rejects.

- Deleted: `frontend/src/mesh/directTransport.ts`, the direct-subscription loop in
  `frontend/src/mesh/peer.ts`, `relay` and `exact` in the core (unless step 2 finds
  another use), and the mesh frames in `clientMesh.ts`. The legacy
  `clientMesh`/`browserMesh` stacks go once nothing else rides them (mesh-sole-
  channel W7).
- `MeshStatus` reports the path each subscription takes, so the two-server e2e can
  assert the direct path without temporary logging.

## Follow-up: Create local copy (decided, user 2026-10-04)

A utility that copies a shared (mounted) scene into a project of one's own: the
copy belongs to the local server, which is its authority, so it is editable
offline. It replaces offline editing of shared scenes, which step 2 disallows.
Expected building blocks: the preset save/instantiate path (it already copies a
node subtree, and the cross-scene move uses it), new ids with references remapped
(camera views → camera ids, scene instances → `sourceSceneId`, logic graphs →
node ids), and assets copied to the local server (touches mesh-sole-channel W5).
Not designed yet; it gets its own plan once step 2 has landed.

## Out of scope

- Moving the remaining resources and streams onto the mesh (mesh-sole-channel W1,
  W3–W5, W7). They follow this plan, and each is the first real test of the surface:
  if one needs glue, the surface is missing something.
- Securing REST and MCP beyond local-only (flagged for later, user decision).
- Extracting the mesh packages into a separate repository.

## Acceptance

For each step:

- The "Removes" list is gone from the codebase.
- `pnpm lint`, `pnpm test`, the main e2e suite and the two-server suite (`e2e:mp`)
  pass. Multi-client sync and undo specs pass unchanged or are extended.
- A short before/after of one representative app-code flow goes into the step's PR
  description (for example adding a field to a form, or creating a document).

Overall: adding a synced document type means one declaration in shared, one
persistence binding in the backend, and nothing in the frontend beyond the
component that shows it.
