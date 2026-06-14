# Plan: Vocabulary / naming refactor

> Branch: `claude/compassionate-bell-Eo89L` · Status: in-progress
> Goal: make the words the end user reads describe what things *do*, and remove
> jargon / ambiguous overloads, without destabilising the persisted data model.

## Goal

The app's user-facing vocabulary grew organically and leaks implementation terms
("graph", "node component", "broadcast", "viseme passthrough", "Fcl_*", "SDF /
troika") and overloads words across unrelated concepts ("scene", "node", "clip").
Relabel the UI and the signal-node palette so terms are descriptive, and rename the
*safe* (type-checked) code identifiers so code and UI don't drift. Persisted
`kind`-string renames (DB enum values + signal-node `kind`s embedded in stored graph
descriptors) are explicitly **deferred** to a later phase — the user OK'd deferring
those, and they are the only part that needs data migrations.

## Agreed conceptual model

| Word (UI) | Meaning | Code identifier (unchanged) |
|-----------|---------|------------------------------|
| **3D Scene** / **Compose Scene** | the two top-level containers; kept parallel & prefixed rather than inventing a vague "Output" | `scene` / `compose_scene` |
| **Object** | a 3D scene item (NOT renamed in code — `Object` is a reserved global; stays `SceneNode`/`scene_node` internally) | `scene_node` / `SceneNode` |
| **Layer** | a compose item | `compose_layer` / `ComposeLayer` |
| **Entity** | umbrella over Object \| Layer | `SceneEntity` |
| **Target** | the Entity a clip / logic / behavior / scope applies to | `targetKind`/`targetId` |
| **Logic** | a user-built signal graph | `graph` |
| **Behavior** | a packaged driver attached to an object (a Behavior is an Logic with a friendly wrapper) | `component` / `node_component` |
| **Clip** | a timeline keyframe recording (entity); the *feature* is the **Timeline** | `track_clip` |
| **Animation** | an imported motion asset | `animation_clip` |

## Constraints

- **No test runner** — `pnpm lint` (type-check) is the only safety net. This drives the
  tiering: changes the compiler fully verifies are safe; stringly-typed changes it
  can't see (persisted `kind`s, WS message kinds) are higher risk.
- User-facing vocabulary ≠ code identifier in every case. Display/identifier
  separation is acceptable and expected (e.g. UI "Logic" while code says `graph`,
  UI "Object" while type stays `SceneNode`). This is not the "drift" we're avoiding —
  the drift to avoid is *inconsistent* identifiers, not a clean label↔id mapping.
- Do NOT rename persisted `kind` string values or signal-node `kind`s in this pass
  (would require migrating `graphs.descriptor` / `node_state` JSON + DB enum columns).
- Keep `display.label` the single source of truth for node names (users never see `kind`).

## Phases

### Phase 1 — User-facing labels (THIS pass; no persistence impact, lint-verified)

**1a. Signal-node `display.label` renames** (`packages/backend/src/signal/nodes/**`):

| Current label | New label |
|---------------|-----------|
| Pose Broadcast | Send Pose |
| Blendshapes Broadcast | Send Blendshapes |
| IK Broadcast | Send IK Targets |
| On Pose Broadcast | Intercept Pose |
| Pose Interceptor Broadcast | Send Intercepted Pose |
| Blendshapes Sum | Combine Blendshapes |
| Viseme Passthrough | Visemes → Blendshapes |
| Scene Entity | This Entity |
| Component Config | Behavior Settings |
| Component ID | This Behavior |
| Component Trigger | Behavior Trigger |
| Set Scene Node Param | Set Object Property |
| Set Compose Layer Param | Set Layer Property |

Kept intentionally technical (advanced/converter nodes): `ARKit → VRM Mapper`,
`RhyLive Bone Mapper`, `Pack/Unpack/Queue Events`, `Pose → Arm Bones`, etc.

**1b. Frontend UI strings**:

- Left-dock **Graphs** tab → **Logic**; `+ Add Graph` → `+ Add Logic`.
- `Project Graphs` header → **Global Logic**; `Component Graphs` → **Behavior Logic**.
- Per-object/layer **Graphs** sub-section (`GraphsSection`) → **Logic**.
- **Components** → **Behaviors** everywhere shown: `+ Add Component` → `+ Add Behavior`,
  `No components` → `No behaviors`, AssetManager `Components` tab → `Behaviors`.
- AssetManager **Clips** tab → **Timeline** (per-object `ClipsSection` keeps "Clips" — the entity).
- TrackClipTimeline: `dur` → `Duration`; `mode` (override/relative) → `Blend` (Replace/Add).
- TopBar: `ver` → `Version`.
- Scene add-node menu: `Godray Caster` → `Light Rays`; `Text (SDF / troika)` → `Plain Text`;
  `Text (canvas, HTML-capable)` → `Rich Text`.
- PropertiesPanel: ALL_CAPS blend-mode names → Sentence case; `VRoid (Fcl_*)` → `VRoid Blendshapes`.
- ComposeLayerProperties: `Scope Label` / "Animation Scope" → **Target**.

### Phase 2 — Code-identifier renames (DONE)

Type-checked-safe identifier renames so code matches the new vocabulary; no data
migrations. Shipped in two commits, `pnpm lint` + frontend `tsc` green:

- **2a `node-component driver → behavior`**: `NodeComponent(Record)`→`Behavior(Record)`,
  `ComponentKind(Meta)`→`BehaviorKind(Meta)`, store `nodeComponents`/`componentKinds`/
  `selectedComponentId`/etc.→behavior equivalents, routes `/…/components`→`/…/behaviors`,
  `/component-kinds`→`/behavior-kinds`, scene-bundle field, OpenAPI schemas.
- **2b `standalone-graph feature → logic`**: `interface Graph`→`Logic`,
  `GraphOwnerKind`→`LogicOwnerKind`, `ProjectGraphManager`→`LogicManager`,
  `GraphRow`/`GraphRecord`→`Logic*`, feature routes `/…/graphs`→`/…/logic`,
  `GraphsSection.tsx`→`LogicSection.tsx`.

**Kept as substrate (intentionally still "graph"):** `SignalGraph(Canvas)`,
`GraphDescriptor`/`GraphNode`/`GraphEdgeDescriptor`, `GraphStateSnapshot`,
`getGraphDescriptor`, the `/signal/graphs` monitoring API, `SceneGraph.tsx` (3D tree).

**`componentId` → `behaviorId` (DONE):** the runtime/WS instance id of the producing
behavior (`PoseFrame`, broadcast bus, lipsync/tracking WS fields, managers, frontend) was
renamed in its own commit. The persisted port name + behavior-context node kinds
(`component_id`/`component_config`) followed in follow-up 1 with descriptor migration 023.

### Phase 2.5 — Docs follow-up (DONE)

ARCHITECTURE.md + all affected module docs were refreshed to the new vocabulary
(behavior / logic), including the table/route/kind/port renames and the
source-dir + route-file renames.

### Phase 3 — Persisted `kind` renames (DEFERRED)

DB enum values + signal-node `kind`s inside stored descriptors. Needs numbered
migrations that rewrite both columns and nested descriptor JSON (`graphs.descriptor`,
`node_state`, `track_clip` `target_kind`, preset payloads, clipboard, sample JSONs).
**Open question to resolve before starting:** is persisted dev data disposable
(clean cutover, no migration) or must it survive (write + verify migrations)?

## Out of scope

- Phase 2 & 3 (this pass is Phase 1 only).
- Effects-panel graphics jargon (SSAO, tone-mapping names, Bokeh) — acceptable for the
  photography-literate target audience; left as-is.
- Icon rework (the shared 🎬 for compose_scene/scene_include).

## Acceptance / verification

- `pnpm lint` passes.
- No `kind` string values, WS message kinds, routes, or DB columns changed in Phase 1.
- Node palette and editor panels render the new labels.
