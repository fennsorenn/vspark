# Mounted scenes: stop rewriting the author's documents

> **Status: decided and shipped** (option B, migration 039). The user chose
> "persist + peer project row" over replica-only, to keep a mounted scene
> available when its author is offline. §4 is what was built; §3 is kept for the
> reasoning and for the option that was not taken.
>
> **Follow-up, 2026-08-15:** principle 3's share container — §2's first bullet,
> and the one part of §2 that never shipped — is now decided AGAINST for collab
> scenes. §5 records why.

## 1. What was wrong

Mounting a collaborative scene copied the author's tree into the receiver's
project and **edited it on the way in** (`mountSharedScene`,
`packages/backend/src/multiplayer/collabScene.ts`):

```
project_id          := the RECEIVER's project      (author's value discarded)
root_scene_node_id  := the shared scene id         (fine — same on both peers)
```

So one document id had different content on two peers. That breaks core
principle 2 (a document has exactly one truth): "what is this document" is only
answerable if you also know who is asking.

It was not a cosmetic divergence — it propagated. Because the mounted rows
carried the receiver's `projectId`, an edit fanned back from the author carried
the AUTHOR's, and the frontend feeder had to defend itself:

```ts
// meshStoreFeeder.ts, scene_node observer
// Preserve our local structure (projectId/rootSceneNodeId), take the rest.
```

That was the same rewrite again, on the read path, existing only because of the
first one. Two per-client rewrites, each keeping the other necessary.

## 2. What principle 3 asked for instead

> **Superseded on 2026-08-15** — the first bullet below (the container) was
> dropped by decision; the other three shipped. Kept because the reasoning is
> what §4 was built from. See §5.

> Mounting is rendering, not merging. A shared tree stays whole and unmodified —
> the owner's ids, the owner's parent links. The receiver's tree holds a share
> container node, and the renderer walks into the foreign tree at that point.

The pattern already exists in this codebase for *placed objects*
(`packages/frontend/src/sync/sharedProjection.ts`): a receiver-owned container
node (`kind: 'remote_object'`, carrying `components.remoteRef`) with the owner's
subtree projected under it, the owner's ids kept verbatim, dropped and restocked
on (re)subscribe. Mounted SCENES are the case that never got converted.

So the shape of the fix looked settled:

- ~~the receiver keeps a **container** it owns (its project, its id)~~ — not
  taken; see §5;
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

## 4. What was built

1. Migration 039: `projects.owner_peer_id` (NULL = ours). `ensurePeerProject`
   holds a row for the author's project; it never overwrites one of ours, so a
   peer announcing an id we already use cannot take it over.
2. `mountSharedScene` writes the author's `project_id` and `root_scene_node_id`
   verbatim, taken from the documents rather than from a parameter — it is their
   value, which is the point.
3. The `scene_node` mesh binding stops re-scoping `projectId` on incoming collab
   docs; it ensures the peer project row instead. `filePath` is still localized,
   and that is a different kind of thing: it names a file on the sender's disk,
   which is a pointer into a store we do not share rather than a fact about the
   document.
4. `persists` became "our own project, or a collab scene we keep". It could not
   stay "does a projects row exist" once peer rows exist — a placed-object
   projection from a peer whose scene we also mount would have started
   persisting.
5. Scene bundle: own scenes UNION scenes mounted into this project (via the
   links). Track clips gathered by scene rather than by project id alone.
6. Project list: peer-owned rows excluded.
7. Feeder: the local-structure preservation is deleted (the document is taken
   whole), and adoption asks whether the node's SCENE is one we hold rather than
   whether its project matches.

Not done, and — as of 2026-08-15 — **not going to be**: the **share container
node** of principle 3. A mounted scene stays a scene in the receiver's scene
list rather than becoming a node in their tree.

> **Decided by the user, 2026-08-15.** Collab scenes are co-edited by design:
> migration 031 draws the distinction in as many words ("object sharing's
> read-only ephemeral projection" versus "a real, persisted, editable scene in
> EACH peer's project"), and `mesh/collab.ts` backs it with a mutual RUCD grant
> on the scene subtree. A container node would mean either nesting a peer's
> scene inside one of yours instead of opening it, or — matching the
> placed-object path exactly — dropping co-editing. Principle 3 keeps its scope:
> placed objects, where `sync/sharedProjection.ts` already implements it.

What principle 2 needed was for the documents to stop being rewritten, and that
is what shipped — without the container, which is the evidence that principle 2
never depended on it.

## 5. What is already done

- **#28, shipped**: `MeshPeer.mount` / `collab_scenes.mounted_at`. The mount
  stamp is local metadata on the share, and documents in a mounted scope
  reconcile against `max(write stamp, mount stamp)`. That fix was deliberately
  built so it does not care which option §3 takes.
