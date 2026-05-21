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
- `UpdateStatus` — `{ version, latestVersion, releaseNotes, channel, downloadReady }`
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

### Port system

```ts
type PortKind = 'event' | 'value' | 'list'
type PortDecl = { name: string, type: keyof SignalTypeMap, kind: PortKind }
```

`SignalTypeMap` maps type strings to runtime types:
- `BoneRotations`, `NormalizedPose`, `Blendshapes`
- `Float`, `Bool`, `String`
- `InterceptorFrame`, `Landmark[]`

### Node class interface

```ts
interface SignalNodeClass {
  kind: string
  inputPorts: PortDecl[]
  outputPorts: PortDecl[]
  execute(inputs: Record<string, any>): Record<string, any>
}
```

The `@SignalNode({ label, description, tags, color })` decorator attaches display metadata and is read by `getAllNodeKindMeta()` for the UI.

### GraphDescriptor

Static template for building a `SignalGraph`:

```ts
interface GraphDescriptor {
  label: string
  readonly?: boolean
  nodes: Array<{ id: string, kind: string, position: {x,y}, defaultConfig: any }>
  edges: Array<{ fromNodeId: string, fromPort: string, toNodeId: string, toPort: string, kind?: PortKind }>
}
```

Managers create these via factory functions and pass them to `SignalGraph.fromDescriptor()`.
