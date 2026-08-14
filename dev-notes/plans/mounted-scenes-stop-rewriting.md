# Mounted scenes: stop rewriting the author's documents

> **Status: proposed.** The decision in §3 is the user's; everything after it
> depends on which way it goes. Written while doing #27 in the mesh-frontend-writes
> branch, after #28 (the mount stamp) shipped.

## 1. What is wrong today

Mounting a collaborative scene copies the author's tree into the receiver's
project and **edits it on the way in** (`mountSharedScene`,
`packages/backend/src/multiplayer/collabScene.ts`):

```
project_id          := the RECEIVER's project      (author's value discarded)
root_scene_node_id  := the shared scene id         (fine — same on both peers)
```

So one document id has different content on two peers. That breaks core
principle 2 (a document has exactly one truth): "what is this document" is only
answerable if you also know who is asking.

It is not a cosmetic divergence — it propagates. Because the mounted rows carry
the receiver's `projectId`, an edit fanned back from the author carries the
AUTHOR's, and the frontend feeder has to defend itself:

```ts
// meshStoreFeeder.ts, scene_node observer
// Preserve our local structure (projectId/rootSceneNodeId), take the rest.
```

That is the same rewrite again, on the read path, and it exists only because of
the first one. Two per-client rewrites, each keeping the other necessary.

## 2. What principle 3 asks for instead

> Mounting is rendering, not merging. A shared tree stays whole and unmodified —
> the owner's ids, the owner's parent links. The receiver's tree holds a share
> container node, and the renderer walks into the foreign tree at that point.

The pattern already exists in this codebase for *placed objects*
(`packages/frontend/src/sync/sharedProjection.ts`): a receiver-owned container
node (`kind: 'remote_object'`, carrying `components.remoteRef`) with the owner's
subtree projected under it, the owner's ids kept verbatim, dropped and restocked
on (re)subscribe. Mounted SCENES are the case that never got converted.

So the shape of the fix is settled:

- the receiver keeps a **container** it owns (its project, its id);
- the author's scene documents are held **unmodified**, author's `projectId`
  included;
- `GET /projects/:id/scenes` stops being "everything with my project_id" and
  gains the mounted scenes from the `collab_scenes` links (which already record
  `scene_id`, `peer_id`, `role='mounted'`, `project_id`, and now `mounted_at`);
- the feeder's preservation of local `projectId`/`rootSceneNodeId` is deleted.

## 3. The open decision: where does a mounted tree live?

`scene_nodes.project_id` is `NOT NULL REFERENCES projects(id) ON DELETE CASCADE`
(migration 018). Keeping the author's value therefore means the author's project
row must exist locally, or the rows must not be persisted at all.

### Option A — replica-only

Do not persist a mounted tree. It lives in the mesh replica, fanned out to tabs,
and is re-fetched from the author on mount and on reconnect. The `persists`
predicate in `packages/backend/src/mesh/index.ts` already does exactly this for
placed-object projections, so the machinery exists.

- Truest to "mounting is rendering": the foreign tree is never the receiver's
  data, and there is no row to disagree with anybody.
- **Loses offline availability.** Today a receiver that restarts with the author
  offline still sees the last mounted content. Under A it sees an empty scene
  until the author is reachable.
- Receiver-side edits to a mounted scene persist at the author only. Arguably
  correct — it is the author's scene — but it is a behaviour change.

### Option B — persist, with a local row for the author's project

Keep persisting the tree, with the author's `project_id` intact, and insert a
placeholder `projects` row for the author's project (flagged as peer-owned, and
hidden from the project list) so the FK holds.

- Documents are byte-identical on both peers: principle 2 satisfied literally.
- Offline behaviour unchanged from today.
- Adds a concept: a project we hold but do not own. It has to be excluded from
  the project list, from deletion, and from anything that enumerates projects.

### Option C — persist with `project_id` NULL for foreign rows

Rejected, and worth recording why: it makes the document's `projectId` null on
the receiver and the author's value at the author, which is the same per-client
divergence as today wearing a different hat.

**Recommendation: B.** It satisfies the principle without taking away a
behaviour users have (a mounted scene surviving a restart), and the placeholder
row is a small, contained concept — one flag column and one filter in the
project list. A is cleaner in the abstract and can be revisited once mounted
scenes are re-fetched fast enough that nobody notices the empty window.

## 4. Work, once §3 is decided

1. Migration: `projects.owner_peer_id` (B), or the `persists` predicate change (A).
2. `mountSharedScene` stops rewriting `project_id`; registers the container.
3. Scene bundle: union of own scenes and mounted scenes from `collab_scenes`.
4. Feeder: delete the local-structure preservation; adopt by identity.
5. Frontend: mounted scenes render from the container, marked as foreign in the
   scene list (they are already visually distinguished as collab scenes).
6. Tests: a mounted document is byte-identical on both peers; an author's edit
   converges without either side rewriting a field; a receiver restart behaves
   as §3 decided.

## 5. What is already done

- **#28, shipped**: `MeshPeer.mount` / `collab_scenes.mounted_at`. The mount
  stamp is local metadata on the share, and documents in a mounted scope
  reconcile against `max(write stamp, mount stamp)`. That fix was deliberately
  built so it does not care which option §3 takes.
