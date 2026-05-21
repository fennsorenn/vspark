# API Controller (node component)

REST-driven driver for VRM avatars. External systems can:

- trigger a single animation clip or push an ordered queue with a loop mode (`none` / `last` / `queue`)
- set blendshape expressions (preset shorthand or explicit weight map)
- read live state

It is the first node component with a **public REST control surface** — its routes live under `/api/projects/:projectId/nodes/:nodeId/api-controller/...` rather than the generic component CRUD path.

## Files

- [packages/backend/src/node_components/api_controller/manager.ts](../../packages/backend/src/node_components/api_controller/manager.ts) — `ApiControllerManager`
- [packages/backend/src/node_components/api_controller/register.ts](../../packages/backend/src/node_components/api_controller/register.ts) — `@ComponentKind` registration
- [packages/backend/src/routes/api-controller.ts](../../packages/backend/src/routes/api-controller.ts) — REST routes
- [packages/backend/src/routes/expressions.ts](../../packages/backend/src/routes/expressions.ts) — read-only expression + animation listings
- [packages/shared/src/schema.ts](../../packages/shared/src/schema.ts) — `apiControllerAnimationSchema`, `apiControllerAnimationQueueSchema`, `apiControllerBlendshapesSchema`
- [packages/frontend/src/components/editor/PropertiesPanel.tsx](../../packages/frontend/src/components/editor/PropertiesPanel.tsx) — `ApiControllerProps` (copy-URL UI)
- [packages/frontend/src/components/editor/Viewport.tsx](../../packages/frontend/src/components/editor/Viewport.tsx) — auto-registers FBX clip durations on VRM load; consumes `api_animation` to play queued clips

## Architecture choice — no signal graph

Unlike VMC, breathing, lipsync and tracking, this manager does **not** instantiate a signal graph. It keeps a plain `Map<componentId, ComponentState>` in memory and writes to the broadcast bus directly. There is no `_nodeState` persistence — state lives only as long as the process. Clients re-sync via `rebroadcastTo()` on WS reconnect.

This is intentional: there's no upstream data source to process — REST mutations and a clip lookup are all that's needed. A graph would be empty plumbing.

## State per component

```ts
interface ComponentState {
  sceneNodeId: string
  queue:       ApiAnimationQueueEntry[]  // { animationId, sourceUrl, duration }[]
  loopMode:    'none' | 'last' | 'queue'
  startedAt:   number | null              // server Date.now() when queue was last set
  blendshapes: Blendshapes
}
```

`startedAt` is the server's wall-clock at the moment the queue was set. Frontend playback uses `(now - startedAt)` together with each entry's `duration` to determine the current clip and offset, so multiple browsers see synchronized playback.

## Clip resolution

`setAnimationQueue` resolves each `{ animation: idOrName }` entry against the `animation_clips` table:

1. Try `id = idOrName AND source_node_id = sceneNodeId`
2. Fall back to `name = idOrName AND source_node_id = sceneNodeId`
3. Throw if neither matches

Scoping by `source_node_id` ensures a node can only reference clips owned by its own avatar. Clip durations come from the registered row; if `duration <= 0` the manager warns and falls back to `DEFAULT_DURATION_SEC = 5`. Real durations are populated by the frontend Viewport on VRM load — it probes each FBX asset and POSTs to `/api/scene-nodes/:nodeId/clips` (idempotent upsert on `(source_file_path, clip_index)`).

See [animation.md](animation.md) for the FBX retargeting pipeline that actually plays these clips client-side.

## Blendshape pipeline

`setBlendshapes` / `clearBlendshapes` publish to `broadcastBus.publishBlendshapes(sceneNodeId, componentId, blendshapes)`. The broadcast bus additively composes weights across all blendshape sources for a node (lipsync, this component, …) and emits a single `vmc_blendshapes` WS frame per node, so api_controller weights coexist with lipsync output without overwriting it.

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

- **Signal graph engine** is intentionally *not* used. Animation playback happens entirely on the frontend.
- **Animation clips** ([animation.md](animation.md)) — clip rows in the DB are the lookup target for queue resolution.
- **Broadcast bus** ([component-managers.md](component-managers.md)) — used to merge api_controller blendshape output with other sources.
- **Shared schema** ([shared-types.md](shared-types.md)) — request schemas are Zod, also exported as OpenAPI components.
