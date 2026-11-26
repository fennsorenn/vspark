# API Controller (behavior)

REST-driven driver for VRM avatars. External systems can:

- trigger a single animation clip or push an ordered queue with a loop mode (`none` / `last` / `queue`)
- set blendshape expressions (preset shorthand or explicit weight map)
- read live state

It is the first behavior with a **public REST control surface** — its routes live under `/api/projects/:projectId/nodes/:nodeId/api-controller/...` rather than the generic behavior CRUD path.

## Files

- [packages/backend/src/behaviors/api_controller/manager.ts](../../packages/backend/src/behaviors/api_controller/manager.ts) — `ApiControllerManager`
- [packages/backend/src/behaviors/api_controller/graph.ts](../../packages/backend/src/behaviors/api_controller/graph.ts) — `API_CONTROLLER_TEMPLATE`
- [packages/backend/src/signal/nodes/api_controller_source.ts](../../packages/backend/src/signal/nodes/api_controller_source.ts) — graph entry node
- [packages/backend/src/behaviors/api_controller/register.ts](../../packages/backend/src/behaviors/api_controller/register.ts) — `@BehaviorKind` registration (decorator renamed from `@ComponentKind`)
- [packages/backend/src/routes/api-controller.ts](../../packages/backend/src/routes/api-controller.ts) — REST routes
- [packages/backend/src/routes/expressions.ts](../../packages/backend/src/routes/expressions.ts) — read-only expression + animation listings
- [packages/shared/src/schema.ts](../../packages/shared/src/schema.ts) — `apiControllerAnimationSchema`, `apiControllerAnimationQueueSchema`, `apiControllerBlendshapesSchema`
- [packages/frontend/src/components/editor/PropertiesPanel.tsx](../../packages/frontend/src/components/editor/PropertiesPanel.tsx) — `ApiControllerProps` (copy-URL UI)
- [packages/frontend/src/components/editor/Viewport.tsx](../../packages/frontend/src/components/editor/Viewport.tsx) — auto-registers FBX clip durations on VRM load; plays the avatar's `scheduled_animation` timeline via the clock-anchored driver (no longer consumes an `api_animation` message)

## Signal graph

**Decided** (user, 2026-11-15): behaviors publish to the broadcast bus only through graph broadcast nodes; manager-side publishing is a design error. (Breadcrumb: api_controller used to have no graph and call `broadcastBus.publishBlendshapes` from the manager; that design and its "a graph would be empty plumbing" rationale are superseded.)

The behavior runs a stored, editable signal graph like every other behavior (see [component-managers.md](component-managers.md#stored-editable-graphs)):

- **Template** `API_CONTROLLER_TEMPLATE` in [api_controller/graph.ts](../../packages/backend/src/behaviors/api_controller/graph.ts): `api_src` (`api_controller_source`) → `unpack_event` → `blendshapes_broadcast` (`bs_out`), with `behavior_id` and `scene_entity` feeding the broadcast's `behaviorId` / `nodeId`. Registered in `behaviors/templates.ts` with graph id prefix `api_controller:`.
- **Entry node** `api_controller_source` ([signal/nodes/api_controller_source.ts](../../packages/backend/src/signal/nodes/api_controller_source.ts)) — internal, one event output `blendshapes`. The manager fires it by node id `api_src`; a user-edited graph without that node receives nothing.
- **Running**: the manager runs the stored graph or the template (`behaviorDescriptorToRun`). When the stored graph changes structurally (`programChanged`), `syncBehaviors` disposes the running graph, releases its bus slot (`broadcastBus.removeBehavior`), builds the new one and re-fires the current weights.
- **Node state** is in-memory only; it is not persisted to `config._nodeState` as the other managers do.
- **Animation queueing is not in the graph** — it writes the `scheduled_animation` timeline (below), which has no bus output.
- **Existing behaviors** get their graph from the boot sync; migration 047 (which imports the current templates) also backfills them on a fresh migration.
- `routes/signal.ts` lists its descriptors and node states and strips the `api_controller:` prefix; the `fire` route does not special-case it. `/api/behavior-kinds` reports `hasGraph: true` for it (as for every kind), so the editor shows the graph controls.

Because its blendshapes leave through `blendshapes_broadcast`, the Tracking Mix lists it as a Face source by its graph, like any other behavior (see [animation.md](animation.md), Tracking Mix).

## State per behavior


```ts
interface BehaviorState {
  sceneNodeId: string
  queue:       ApiAnimationQueueEntry[]  // { animationId, sourceUrl, duration }[]
  loopMode:    'none' | 'last' | 'queue'
  startedAt:   number | null              // server Date.now() when queue was last set
  blendshapes: Blendshapes
}
```

`startedAt` is the server's wall-clock at the moment the queue was set. The in-memory queue/`startedAt` state is now kept **only for the REST `/state` read** — playback itself rides the synced `scheduled_animation` timeline, not this state.

### Projecting the queue onto the timeline

`_writeSchedule` PROJECTS the in-memory queue onto the avatar's `scheduled_animation` collection (see [animation.md](animation.md)): each clip gets a `startEpoch` from the running sum of durations/speed; the last clip loops under `loopMode` `last`/`queue`. The write replaces the avatar's prior entries; an empty queue clears them. Clients then resolve playback from the timeline against the synced clock, so all browsers (and collab peers) stay in phase without any per-frame push.

The old `api_animation` WS broadcast/relay path is **retired end-to-end**: the manager broadcast, the reconnect rebroadcast in `index.ts`, the multiplayer collab relay + clock-translate branch in `multiplayer/manager.ts`, the frontend `useWsSync` handler, and the `apiAnimationByNode` store slice are all gone. Clip switches now happen client-side at each entry's scheduled time (no "switch now" seam).

## Clip resolution

`setAnimationQueue` resolves each `{ animation: idOrName }` entry against the `animation_clips` table:

1. Try `id = idOrName AND source_node_id = sceneNodeId`
2. Fall back to `name = idOrName AND source_node_id = sceneNodeId`
3. Throw if neither matches

Scoping by `source_node_id` ensures a node can only reference clips owned by its own avatar. Clip durations come from the registered row; if `duration <= 0` the manager warns and falls back to `DEFAULT_DURATION_SEC = 5`. Real durations are populated by the frontend Viewport on VRM load — it probes each FBX asset and POSTs to `/api/scene-nodes/:nodeId/clips` (idempotent upsert on `(source_file_path, clip_index)`).

See [animation.md](animation.md) for the FBX retargeting pipeline that actually plays these clips client-side.

## Blendshape pipeline

`setBlendshapes` / `clearBlendshapes` update the in-memory `blendshapes` and fire them into the graph's `api_src` node; the graph's `blendshapes_broadcast` node publishes them to the broadcast bus under the behavior id. The broadcast bus additively composes weights across all blendshape sources for a node (lipsync, this behavior, …; each scaled by its Tracking Mix weight, default 1) and emits a single `vmc_blendshapes` WS frame per node, so api_controller weights coexist with lipsync output without overwriting it.

## Expression cache

The frontend, on VRM load, sends an `avatar_expressions_report` WS message listing the loaded model's expression names. The manager stores this in `_expressionsByNode` so `GET /api/projects/:projectId/nodes/:nodeId/expressions` can answer without having to load the model server-side. The response carries `reported: false` when the frontend hasn't reported yet.

## REST endpoints

See Swagger UI at `/api-docs` (tag: `api_controller` and `expressions`) for the canonical request/response schemas. Summary:

| Method + path | Effect |
|---|---|
| `GET .../api-controller/state` | Snapshot of `{ queue, loopMode, startedAt, blendshapes }` |
| `PUT .../api-controller/animation` | One-shot animation: replaces queue with single entry, forces `loopMode = 'last'` |
| `PUT .../api-controller/animation-queue` | Replace queue with ordered list, set explicit `loopMode` |
| `PUT .../api-controller/blendshapes` | Apply `{ preset }` (single shape @ 1.0) or `{ blendshapes: { name: weight } }` map |
| `DELETE .../api-controller/blendshapes` | Clear all weights |
| `GET .../expressions` | List VRM expression names (frontend-reported) |
| `GET .../animations` | List registered animation clips with playback metadata |

All routes return the structured error envelope `{ ok: false, error: { status, message, code } }` (schema: `Error`) on failure — codes include `NOT_READY` (503), `NOT_FOUND` (404), `VALIDATION_ERROR` (400), `CLIP_NOT_FOUND` (400).

## Dependencies on other modules

- **Signal graph engine** ([signal-graph.md](signal-graph.md)) — blendshapes run through the behavior's stored graph. Animation playback happens entirely on the frontend and is not part of the graph.
- **Animation clips** ([animation.md](animation.md)) — clip rows in the DB are the lookup target for queue resolution.
- **Broadcast bus** ([component-managers.md](component-managers.md)) — merges api_controller blendshape output (from the graph's broadcast node) with other sources.
- **Shared schema** ([shared-types.md](shared-types.md)) — request schemas are Zod, also exported as OpenAPI components.
