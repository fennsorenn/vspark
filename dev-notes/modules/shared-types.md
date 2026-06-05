# Shared Types

`packages/shared/src/` — consumed by both backend and frontend.

## `types.ts` — Domain types

**Node kinds**: `'avatar' | 'model' | 'light' | 'camera' | 'trigger' | 'particle' | 'sfx' | 'fx' | 'prop' | 'godray_caster' | 'billboard'`

**Key interfaces**:
- `SceneNode` — id, parentId, boneAttachment, name, kind, filePath, hidden, components (legacy JSON)
- `Scene` — id, projectId, name, createdAt, updatedAt, nodes
- `Project` — id, name, description, createdAt, updatedAt, scenes
- `AnimationClip` — id, name, sourceNodeId, sourceFilePath, clipIndex, label, startTime, endTime, duration, fps
- `AssetFile` — id, projectId, originalName, storedPath, mimeType, size, hash, isDeduplicated
- `NodeComponent` — id, nodeId, kind, enabled, config (any), sortOrder
- `Landmark` — `{ x, y, z, visibility? }` (MediaPipe format)
- `LipsyncInputMessage` — `{ kind: 'lipsync_input', componentId, visemes }`
- `TrackingInputMessage` — `{ kind: 'tracking_input', componentId, face?, leftHand?, rightHand?, pose? }`
- `ApiAnimationLoopMode` — `'none' | 'last' | 'queue'`
- `ApiAnimationQueueEntry` — `{ animationId, sourceUrl, duration }` (server-resolved playback entry)
- `ApiAnimationMessage` — `{ nodeId, componentId, queue, loopMode, startedAt }` — WS `api_animation` payload broadcast by `ApiControllerManager`
- `AvatarExpressionsReportMessage` — `{ kind: 'avatar_expressions_report', nodeId, expressions }` — frontend → backend on VRM load

**Update / config types**:
- `UpdateChannel` — `'stable' | 'recent' | 'experimental'`
- `UpdateStatus` — `{ updateAvailable, downloadReady, downloadedBytes, totalBytes, currentVersion, latestVersion, releaseNotes, channel }`
- `AppConfig` — shape of `config.json` on disk; includes `channel: UpdateChannel`
- `server_update` in `WSMessageKind` — payload carries update availability info; `reloadOnReconnect: true` triggers a page reload after server restart

## `schema.ts` — Zod validation schemas

Request body validation for all REST routes. All schemas are strict (no extra keys). Used in route handlers via `schema.parse(req.body)` (or `safeParse` + `z.prettifyError()` in newer handlers).

**Zod is on v4** (upgraded from 3.25). Validation error formatting uses `z.prettifyError(parsed.error)` instead of the raw `error.message`.

**Schemas double as OpenAPI components**. Every schema is tagged with `.openapi('Name')` via `@asteasolutions/zod-to-openapi`; the backend's `routes/openapi.ts` registers them in an `OpenAPIRegistry` and generates the `components.schemas` block at startup. Adding a new request schema means: (a) define + `.openapi('Name')` here, (b) register it in `routes/openapi.ts`'s `named` array. See [backend-api.md](backend-api.md#openapi-docs--routesopenapits).

**Registered OpenAPI schemas**:
`Error`, `EmptyOk`, `SceneNodeKind`, `CreateProject`, `UpdateProject`, `CreateScene`, `UpdateScene`, `CreateSceneNode`, `UpdateSceneNode`, `CreateAnimationClip`, `CreateAsset`, `CreateNodeComponent`, `UpdateNodeComponent`, `CreateCameraEffect`, `UpdateCameraEffect`, `FireGraphEvent`, `ApiControllerAnimation`, `ApiControllerAnimationQueue`, `ApiControllerBlendshapes`.

## `signal.ts` — Signal graph type system

### Core data types

**`Quaternion`**: Immutable unit quaternion with algebra methods: `multiply`, `invert`, `normalize`. All bone rotation values flow as Quaternions.

**`BoneRotations`**: `Map<string, Quaternion>` — bone name → rotation in source application's convention (Unity HumanBodyBones for VMC, etc.).

**`NormalizedPose`**: `Map<VRMBoneName, Quaternion>` — VRM-standard bone names. This is the canonical format after mapping. Mappers produce it; calibration and broadcast nodes consume it.

**`Blendshapes`**: `Map<string, number>` — expression name → weight [0, 1]. Both ARKit shapes and VRM expression names appear here depending on pipeline stage.

**`Event<T>`**: `{ payload: T, timestamp: number }` — push signal wrapper for event edges.

### VRM bone names

`VRM_BONE_NAMES`: array of 54 strings covering the full VRM humanoid skeleton — hips through all finger distal bones. These are the canonical keys for `NormalizedPose`.

### Port system (Phase 2 — transport folded into the type)

The old `PortKind` / `PortDecl.kind` / `portsCompatible` machinery is **deleted**. Transport (event / value / list) is no longer a separate field — it is **derived from the resolved type**.

`SignalTypeMap` still maps leaf type names (`SignalTypeName`, e.g. `BoneRotations`, `NormalizedPose`, `Blendshapes`, `Float`, `Bool`, `String`, `InterceptorFrame`, `Account`, `SpawnRef`, `Any`, `ComponentConfig`) to runtime types. The `Any` and `ComponentConfig` tags both map to the `unknown` wildcard.

The structural type AST and inference live in dedicated shared files:

- `signal_types.ts` — `ResolvedType` discriminated union (`primitive | record | event | list | unknown`). `transportOf(type)` derives transport (`event` → push, `list` → pull fan-in, else → pull). `isAssignable(source, target)` is structural width subtyping on records + `unknown` wildcard both directions + the `List<E>` accepts `E`-or-`List<E>` special case.
- `inference.ts` — `InferGraph`: `tryAddEdge` (forward propagation + transactional rollback), `removeEdge`, `setConfig`, `portsOf`.

Ports are now declared as **decorated members** on a `Node` subclass (`node.ts` + `node_decorators.ts`), not as static `PortDecl[]` arrays. See [signal-graph.md](signal-graph.md) for the decorator model and `inferPorts`. `getAllNodeKindMeta()` returns per-port `{ name, resolved, typeTag, transport }` plus a `dynamic` flag; the `@SignalNode({ label, description, tags, color })` decorator still attaches display metadata.

### GraphDescriptor

Static template for building a `SignalGraph`:

```ts
interface GraphDescriptor {
  label: string
  readonly?: boolean
  nodes: Array<{ id: string, kind: string, position: {x,y}, defaultConfig: any }>
  edges: Array<{ fromNodeId: string, fromPort: string, toNodeId: string, toPort: string }>
}
```

Edges no longer carry a `kind` — transport is inferred from the resolved port types at load time. Managers create these via factory functions and pass them to `SignalGraph.fromDescriptor()`, which replays the edges through `InferGraph.tryAddEdge`.
