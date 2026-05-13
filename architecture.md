# vSpark — Architecture Specification

## 1. Overview
A real-time 3D avatar streaming and scene composition engine. Designed for live production workflows (OBS integrations, VTubing, remote performances), it provides a browser-first rendering pipeline, server-side motion capture processing, and a reactive signal graph for complex behaviors. The system prioritizes spatial correctness, low-latency sync, and clean separation between persistent state, reactive execution, and visual rendering.

## 2. Core Concepts
| Concept | Description |
|---------|-------------|
| **Project** | Top-level workspace/profile. All entities are strictly project-scoped. No default project; users explicitly select or create one. |
| **Scene** | Spatial container with a monotonically incrementing logical clock. Scenes compose hierarchically via mount nodes. |
| **Node** | Spatial entity in the scene graph (VRM, camera, light, group, mount). Globally unique ID, transform inheritance, type-specific payload. |
| **Component** | Behavioral driver attached to a node (VMC receiver, filter, animation controller). Stored as a flat sibling list per node, backed by signal graph templates. |
| **Signal Graph** | Reactive execution engine for streaming data, actions, and event chains. Uses push-based events and pull-based values. |
| **Action** | Named event bus trigger. Exposed via REST/WebSocket, internally fires a named event that any subscribed signal node can react to. |
| **PoseFrame** | High-frequency, sparse bone override payload. Broadcast server-to-client for VMC/procedural overlays. |

## 3. Rendering Pipeline
- **Browser-first**: Three.js + `@pixiv/three-vrm` + GLTF/FBX loaders.
- **Animation Evaluation**: Client-side. Animation clips are tracked via `{ clipId, startedAt }`. The client evaluates poses locally using timestamps.
- **VMC Overlay**: Server processes VMC → produces sparse `PoseFrame`. Client blends against local animation per-bone:
  - `override`: Server value completely replaces animation.
  - `additive`: Server value applied as delta rotation on top of animation.
- **Scene Composition**: Mount nodes carry `{ childSceneId }`. Client maintains a flat node map, computes world transforms by walking up to mount nodes, and handles multiple instances of the same sub-scene natively.
- **Physics**: Client-side cosmetic only (hair, cloth, secondary motion). Server-side physics coupling is declarative but dormant until future implementation.

## 4. Networking & Sync
- **Transport**: WebSocket per project context. REST for bulk/state mutations.
- **Clock Topology**: Per-scene logical clock. Client maintains a clock map `{ sceneId: clock }`.
- **Sync Protocol**:
  1. Connect → server sends full snapshot of composed scene graph + current clocks.
  2. Patches carry `{ sceneId, clock, patches: JsonPatch[] }`.
  3. Client reconnects with clock map → receives diffs or full resync per stale scene.
- **PoseFrame Channel**: Separate high-frequency message type. Decoupled from state sync to avoid clogging logical clocks with 60Hz motion data.
- **Property Writes**: Direct DB write → increment scene clock → fan-out. Bypasses signal graph entirely. Opt-in `property_change` events fire post-write if signal nodes subscribe.

## 5. Signal Graph & Execution
- **Execution Model**: Hybrid push/pull.
  - `event` connections: Push-based. Source fires, payload travels, destination executes.
  - `value` connections: Pull-based. Destination requests current value synchronously during execution.
  - Every active subgraph must have at least one event source (VMC frame, timer, webhook, property change). Pure value chains are dead until pulled by an event-driven node.
- **Component Instantiation**: Frontend adds components via API. Server expands templates into signal subgraphs, links root node, and caches config for UI reads. Config values are exposed as pull nodes; changes are naturally picked up on next execution tick.
- **Actions**: `POST /api/actions/:id/trigger` fires a named event on the project-scoped event bus. Multiple signal nodes can subscribe to the same event name. Scene filtering is handled by explicit filter nodes downstream.
- **Constraints**: Cycle detection enforced at connection creation. Cross-project references blocked by FK constraints. Cross-scene connections permitted but not explicitly optimized for v1.

## 6. Data Model (SQLite)
All tables include `project_id` FK for strict workspace isolation.

```sql
projects          (id, name, description, created_at, updated_at)
assets            (id, project_id, name, type, url, size_bytes, namespace, meta_json, uploaded_at)
asset_skeletons   (asset_id, bones_json, extracted_at)
scenes            (id, project_id, name, description, clock, created_at, updated_at)
nodes             (id, project_id, scene_id, parent_node_id, type, name, visible, sort_order, created_at, updated_at)
node_transforms   (node_id, px, py, pz, rx, ry, rz, rw, sx, sy, sz)
node_data         (node_id, data_json)
scene_overrides   (id, project_id, mount_node_id, target_node_id, property, value_json, mode)
node_components   (id, project_id, node_id, kind, signal_root_id, config_json, enabled, sort_order)
vmc_sources       (id, project_id, name, port, host)
signal_nodes      (id, project_id, scene_id, kind, name, config_json, enabled, editor_x, editor_y)
signal_connections(id, project_id, from_node_id, from_port, to_node_id, to_port, kind)
actions           (id, project_id, name, description, event_name, webhook_slug, cooldown_ms)
physics_couplings (id, project_id, scene_a_id, scene_b_id)
component_presets (id, project_id, kind, name, config_json)
```

### Key Schema Notes
- `nodes.type` includes `mount` for scene composition. Mount node transform = sub-scene root transform.
- `scene_overrides` target specific mount instances, enabling per-instance behavioral/spatial overrides.
- `signal_nodes.kind` covers event sources, value providers, processors, and effects.
- Asset skeleton extraction occurs server-side on upload (GLTF/VRM JSON parsing, no renderer required).

## 7. Implementation Roadmap
1. **Frontend Rendering Spike** (Priority 1)
   - Static Express server
   - File drop for VRM + FBX animation
   - VRM renders with basic lighting + bloom
   - FBX retargeted & played on VRM
   - OrbitControls for inspection
2. **Core Backend**
   - SQLite schema + migration system
   - Project/Scene/Node REST API
   - WebSocket sync layer (clocks, snapshots, patches)
3. **Signal Graph Engine**
   - Push/pull execution runtime
   - Template instantiation → component wiring
   - Named event bus + action triggers
4. **VMC Pipeline**
   - UDP listener → server processor chain → sparse PoseFrame broadcast
   - Client additive/override blending
5. **Editor UI**
   - Scene graph inspector, component panel, mount/override controls
   - Project selector gateway
