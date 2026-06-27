# MCP Server + AI Assistant

**Status: Implemented.**

Two linked features that let an LLM drive a vspark project through its REST API:

1. **MCP server** — `packages/backend/src/mcp/` — exposes the vspark REST surface
   as a catalog of [Model Context Protocol](https://modelcontextprotocol.io)
   tools, served over three transports (in-process HTTP, standalone stdio, and an
   in-memory pair).
2. **AI Assistant** — `packages/backend/src/assistant/` + the frontend Assistant
   window — an in-app agent that consumes that same MCP catalog (via the
   in-memory transport) and runs a tool-calling loop against any
   OpenAI-compatible LLM endpoint.

Motivation: an empirical evaluation showed a mid-size local model
(`gemma-4-12B`) can drive the vspark REST API reliably **when the
non-discoverable API semantics are spelled out**. The tool *descriptions* encode
those lessons — they are the load-bearing part of this module, not the wiring.

## MCP tool layer — `mcp/`

| File | Role |
|------|------|
| `client.ts` | `VsparkClient` — a thin HTTP wrapper over the vspark REST API. Injectable `baseUrl` + optional `fetchImpl` (tests). Unwraps the `{ ok, data, error }` envelope; throws `VsparkApiError` on `!ok`/non-2xx. The tool layer talks to the backend *exclusively* through this, so the same tool code works for every transport — each just points the client at a base URL. |
| `tools.ts` | `buildToolSpecs()` — the single source of truth for the tool catalog (54 tools). Each `ToolSpec` is `{ name, description, inputShape (zod raw shape), handler }`. |
| `server.ts` | `createMcpServer(client)` — builds an `@modelcontextprotocol/sdk` `McpServer` (^1.29) and registers every spec. Handlers run the spec, JSON-stringify the result, and map thrown errors to `{ isError: true, content: [...] }`. |
| `http.ts` | `createMcpHttpRouter(loopbackBaseUrl)` — mounts the server over the **stateless Streamable-HTTP** transport at `/mcp` (see `index.ts`). Each POST spins up a fresh server+transport pair (no session affinity); `GET`/`DELETE` return 405. |
| `stdio.ts` | Standalone **stdio** MCP server — the `vspark-mcp` bin. External AI clients (Claude Desktop / Code, Cursor) spawn it; it forwards tool calls to a *running* backend over HTTP, pointed by `VSPARK_BASE_URL` (default `http://localhost:3001`). stderr for logs, stdout is the JSON-RPC channel. |

### The tool catalog (54 tools)

Grouped by area (all defined in `tools.ts`):

- **Discovery / read:** `list_projects`, `list_scenes`, `list_scene_nodes`,
  `list_compose_scenes`, `list_compose_layers`, `list_project_logic`,
  `get_logic`, `list_node_kinds`, `lookup_node_kind`.
- **Presets (prefer over building from scratch):** `list_presets`,
  `instantiate_preset`.
- **Scene (3D) writes:** `create_scene`, `create_scene_node`,
  `update_scene_node`, `delete_scene_node`.
- **Compose (2D overlay) writes:** `create_compose_scene`,
  `create_compose_layer`, `delete_compose_layer`, `update_compose_layer`.
- **Logic (signal graph) writes:** `create_project_logic`, `delete_logic`,
  `set_logic_descriptor`.
- **Timeline / track clips:** `lookup_param_paths`, `list_track_clips`,
  `create_track_clip`, `update_track_clip`, `delete_track_clip`,
  `add_track_clip_lane`, `delete_track_clip_lane`, `set_track_clip_keyframes`,
  `control_track_clip`.
- **Behaviors (avatar/scene-node drivers):** `list_behavior_kinds`,
  `list_behaviors`, `attach_behavior`, `update_behavior`, `delete_behavior`.
- **Assets, expressions, animation playback:** `list_assets`,
  `list_avatar_expressions`, `list_avatar_animations`, `play_animation`,
  `set_animation_queue`, `set_blendshapes`, `clear_blendshapes`.
- **Camera effects (post-processing):** `list_camera_effect_kinds`,
  `list_camera_effects`, `add_camera_effect`, `update_camera_effect`,
  `delete_camera_effect`.
- **UI control (drive the user's editor):** `list_ui_sessions`,
  `ui_select_entity`, `ui_open_panel`, `ui_open_help`, `ui_open_window`,
  `ui_highlight_control`.

### Timeline / track clips

Wrap the track-clips REST API (a clip owns lanes; a lane owns keyframes;
transport is separate). The owner is a scene node or a compose layer
(`ownerKind` + `ownerId`; `ownerBase()` routes to `/api/scene-nodes/:id` or
`/api/compose-layers/:id`). The agent builds a clip in steps: `create_track_clip`
(container; `mode` "override" replaces / "relative" adds onto the target) →
`add_track_clip_lane` (one scalar `paramPath` on one target) →
`set_track_clip_keyframes` (REPLACES all keyframes on a lane; each `{t, value,
easing?}`) → `control_track_clip` (transport `trigger` / `stop` / `pause` /
`resume` / `seek`). **`lookup_param_paths({targetKind})`** returns the shared
`@vspark/shared/paramPaths` registry (`{path, type, animatable, kinds?}`) so the
agent animates only valid animatable Float targets — the paths are not validated
server-side. See [track-clips.md](track-clips.md) and [paramPaths.md](paramPaths.md).

### Behaviors + avatar drivers

`list_behavior_kinds` returns each behavior kind with its `defaultConfig` (and
`applicableTo`) for discovery; `list_behaviors` / `attach_behavior` /
`update_behavior` / `delete_behavior` are CRUD over a scene node's behaviors
(`/api/scene-nodes/:id/behaviors`, `/api/behaviors/:id`). The asset/expression/
playback tools read a project's assets and an avatar's VRM expressions /
animation clips, then drive the avatar: `play_animation`, `set_animation_queue`,
`set_blendshapes`, `clear_blendshapes`. **The api-controller tools
(`play_animation` / `set_animation_queue` / `set_blendshapes` /
`clear_blendshapes`) require an `api_controller` behavior on the node** — their
tool descriptions say so, and the agent attaches one first via `attach_behavior`.
See [component-managers.md](component-managers.md),
[api-controller.md](api-controller.md), and [animation.md](animation.md).

### Camera effects

`list_camera_effect_kinds` returns the shared `CAMERA_EFFECT_KINDS` catalog
(`{kind, label, description, defaultConfig}`, kinds prefixed `fx_`) directly from
`@vspark/shared/cameraEffects` — it does not hit REST. `list_camera_effects` /
`add_camera_effect` / `update_camera_effect` / `delete_camera_effect` are CRUD
over a camera node's effects (`/api/scene-nodes/:id/effects`,
`/api/camera-effects/:id`); `config` REPLACES on update.

The effect catalog is a **single source of truth in shared**: it moved from the
frontend store (`packages/frontend/src/store/editorStore.ts`) into the new
`packages/shared/src/cameraEffects.ts` (exported via the
`@vspark/shared/cameraEffects` subpath, added to `shared/package.json` exports,
the frontend `tsconfig` paths, and the `vite.config` alias). The frontend now
re-exports `CAMERA_EFFECT_KINDS` / `CameraEffectKind` from there (no behaviour
change), so the picker, the PropertiesPanel, and this tool share one list (19
`fx_` kinds). See [camera-effects.md](camera-effects.md) and
[shared-types.md](shared-types.md).

### UI-control channel — drive the user's editor

These tools let the agent (and external MCP clients) **drive a specific editor
tab**, not just mutate data: select an entity, open a panel, open help, toggle
the assistant window, or pulse-highlight a button. They are **REST-backed**
(`POST /api/ui-actions`), so they work identically for the in-app assistant and a
standalone MCP client. Each targets one open editor tab by `sessionId`:

- **`list_ui_sessions`** → `GET /api/ui-sessions`: the active editor sessions
  (`{sessionId, projectId, connectedAt}`). The in-app assistant is told its own
  sessionId; external clients pick the session for the project they want to drive.
- **`ui_select_entity({sessionId, entityKind, id})`** — select a `scene_node` /
  `compose_layer` / `scene` (also switches to the matching left tab).
- **`ui_open_panel({sessionId, dock, tab})`** — open a left
  (`scene|compose|graphs`) or bottom (`create|models|…|clips|presets`) dock tab
  (the bottom tab also pulses).
- **`ui_open_help({sessionId, topic, anchor?})`** — open the in-app help window.
- **`ui_open_window({sessionId, window, open?})`** — open/close the `assistant`
  window.
- **`ui_highlight_control({sessionId, handle})`** — scroll to and pulse-highlight
  a `vs-` control by handle.

The channel architecture is documented in [The UI-control
channel](#the-ui-control-channel) below.

### Presets — prefer over from-scratch

The empirical eval showed the model is **least reliable at hand-building feed
templates and logic wiring**. The preset tools let the agent instantiate a
prewired, tested subtree instead — far more robust than rebuilding it port by
port. They sit right after the discovery tools in the catalog, and the agent's
system prompt instructs it to reach for them first (see [Assistant
agent](#assistant-agent--assistant)).

- **`list_presets({projectId})`** — merges the shipped built-in presets
  (`GET /api/presets/builtin`) with the project's saved presets
  (`GET /api/projects/:projectId/presets`); each entry is
  `{id, name, description, rootKind, builtin}`. `rootKind` (`compose_layer` or
  `scene_node`) tells the agent how to target instantiation.
- **`instantiate_preset({presetId, projectId, rootSceneNodeId?, rootComposeSceneId?, parentId?, boneAttachment?})`**
  — fetches the full payload server-side (builtin ids start with `builtin:` →
  `GET /api/presets/builtin/:id`, otherwise `GET /api/presets/:id`) and POSTs
  `/api/presets/instantiate`. Creates the **entire** prewired subtree (objects,
  compose layers, feed templates, logic graphs, track clips) in one step with
  freshly minted ids; returns `{rootId, idMap, missingAssets}`. Target by
  `rootKind`: a `compose_layer` preset takes `rootComposeSceneId` (a compose
  scene id), a `scene_node` preset takes `rootSceneNodeId` (a scene id);
  `parentId` nests the result, `boneAttachment` attaches a scene-node preset to
  an avatar bone.

E.g. the built-in `builtin:chat-overlay-layer` is a feed layer already wired to
an `overlive_chat_feed → set_data` graph — exactly the kind of thing the model
struggles to wire by hand. The preset library (18 shipped builtins) is
documented in [presets.md](presets.md).

### Why the descriptions matter

The catalog deliberately encodes the API semantics an agent **cannot discover by
introspection and that the API does NOT validate**. Getting these wrong silently
produces a broken-but-accepted result. The encoded rules:

- **`components` vs `properties` are two separate bags** on a scene node.
  Transform/light/feed config live in `components` (ECS, keyed by type, *flat*
  fields — `x/y/z`, not nested `{position:{…}}`); node-level settings
  (`blendTransitionTime`, `poseDynamics`, …) live in `properties`.
- **`update_scene_node` REPLACES the whole `components` bag** but shallow-merges
  `properties` — resend every component you want to keep.
- **`update_compose_layer` `config` is REPLACED wholesale**, not merged — resend
  the complete config (template + css + everything) on any change.
- **Logic graphs are created empty**, then wired in a second step with
  `set_logic_descriptor` (`create_project_logic` returns only an id).
- **Signal-node `kind` and port names come from the catalog**, not guesses —
  `list_node_kinds` then `lookup_node_kind` (ports + types/transport). A wrong
  port name is not validated server-side and yields a dead graph.

When the REST API or these semantics change, **the tool descriptions are the
thing to update** — see [Adding / changing a tool](#adding--changing-a-tool).

## Assistant agent — `assistant/`

| File | Role |
|------|------|
| `llm.ts` | Minimal OpenAI-compatible chat client (`chatCompletion`). Dependency-free (global `fetch`), non-streaming, `temperature: 0`. Works against vLLM / Ollama / OpenAI. Posts to `<baseUrl>/v1/chat/completions` with optional `Authorization: Bearer <apiKey>`. |
| `agent.ts` | `AssistantAgent` — holds conversation state and the tool-calling loop. |
| `manager.ts` | `AssistantManager` — one agent per WS connection; routes inbound `assistant_*` messages and streams events back to that single socket. |

### The agent loop

`AssistantAgent.init()` connects an **in-process MCP `Client` to a real
`McpServer`** via the SDK's `InMemoryTransport.createLinkedPair()`. So the agent
genuinely consumes the MCP — exactly the same tool surface external clients use —
rather than calling the tool handlers directly. It then `listTools()` and adapts
each into an OpenAI `function` tool (the MCP `inputSchema` becomes the function
`parameters`).

`runTurn(userText, events, signal?)`:
1. Push the user message; loop up to `MAX_TOOL_ROUNDS` (8).
2. Each round: one `chatCompletion`. Emit any assistant text (`onText`).
3. If the model returned no `tool_calls`, the turn is done.
4. Otherwise, for each call: parse args, `onToolCall`, dispatch through the MCP
   client (`callTool`), `onToolResult`, and push a `role: 'tool'` message
   (truncated to 4000 chars).
5. After 8 rounds without finishing, emit a "stopped at max steps" notice.

A `system` prompt seeds the conversation with the same discover-before-mutate
discipline the tool descriptions enforce, plus a **PREFER PRESETS OVER BUILDING
FROM SCRATCH** instruction: when a request matches a common building block
(chat/feed overlay, event alert, particle effect, lighting rig), call
`list_presets` first and `instantiate_preset` the closest match, then adjust only
what the user asked; only build from scratch when no preset fits. `reset()` clears
history back to the system prompt. `busy` guards against overlapping turns on one
socket.

### Manager + WS wiring

`AssistantManager` (`assistant/manager.ts`) keeps a `Map<WebSocket,
AssistantAgent>`. On the first `assistant_user_message` for a socket it resolves
the assistant config (`resolveAssistantConfig()`); if disabled / unconfigured it
replies `assistant_error` + `assistant_done`. Otherwise it builds an agent whose
MCP tools hit the loopback backend (`http://127.0.0.1:${PORT}`), then forwards
the agent's events to that one socket via `wsSync.sendTo` as the `assistant_text
/ assistant_tool_call / assistant_tool_result / assistant_error /
assistant_done` WS kinds.

`index.ts`: `app.use('/mcp', createMcpHttpRouter(...))`, `AssistantManager`
instantiated with a new top-level `PORT` constant, and `assistantManager.handle`
is tried **first** in the `wsSync.onMessage` switch (`assistant_user_message` /
`assistant_reset`).

The in-app agent is told **its own editor session id** so its `ui_*` tools drive
the user's tab and not someone else's: `AssistantAgent`'s constructor takes an
optional `sessionId` (`agent.ts`), and `manager.ts` passes
`wsSync.sessionIdFor(ws)` when it builds the agent. When set, the system prompt
gains a line stating the session id and instructing the agent to pass it to any
`ui_*` tool.

## The UI-control channel

A channel that lets the in-app agent **and** external MCP clients drive a
specific editor tab (select an entity, open a panel/help/window, pulse-highlight
a control) — not just mutate data. It is REST-backed end to end so it works
identically for both callers.

### Backend — WS session tracking + REST push

`ws/index.ts` (`WSSync`) now assigns every connection a `sessionId` (`randomUUID`)
on upgrade, registers it in a `sessions` map (+ a `wsToSession` `WeakMap`), and
immediately sends the client a **`session_hello`** with its id. It tracks UI
sessions, tagging each with its project when the client replies **`ui_register`**
`{projectId}`, and drops the session on socket close. New public surface:

- `sessionIdFor(ws)` — the id assigned to a socket (used by the agent manager).
- `listSessions()` — open sessions as `{sessionId, projectId, connectedAt}`.
- `sendUiAction(sessionId, action)` — push a **`ui_action`** over that session's
  socket; returns `false` if the session is gone.

`routes/ui.ts` exposes this over REST: `GET /api/ui-sessions` →
`listSessions()`, and `POST /api/ui-actions {sessionId, action}` →
`sendUiAction()` (404 if no open session with that id). The six `ui_*` MCP tools
call these two routes — that is what makes them work for the in-app assistant and
a standalone MCP client alike.

### Frontend — register + dispatch

`hooks/useWsSync.ts` handles the inbound side: on **`session_hello`** it replies
with **`ui_register`** carrying the open project id; on **`ui_action`** it calls
`editorStore.dispatchUiAction(action)`. `dispatchUiAction` (`editorStore.ts`)
switches on the action type:

- `select_entity` — `selectNode` / `selectComposeLayer` / `setActiveScene` and
  `setLeftTab` to the matching tab.
- `open_panel` — `setLeftTab` (left dock) or `flashBottomTab` (bottom dock, which
  pulses).
- `open_help` — `useHelpStore.openHelp(topic, anchor)`.
- `open_window` — toggle the assistant window.
- `highlight_control` — `highlightControl(handle)` from `lib/uiHighlight.ts`:
  pure-DOM scroll-to + add the `.vs-ai-highlight` pulse class (animation in
  `App.css`), targeting any `vs-` handle without each control opting in.

## Config

`AppConfig` (`packages/shared/src/types.ts`) gains an optional
`assistant?: AssistantConfig { enabled, baseUrl, apiKey, model }`, plus an
`AssistantConfigPublic` (apiKey replaced by `hasApiKey: boolean`).

`routes/config.ts`:
- `resolveAssistantConfig()` merges `config.json` over env defaults
  (`VLLM_HOST` → baseUrl, `VLLM_AUTH` → apiKey, `ASSISTANT_MODEL` → model;
  `enabled` defaults to "has a baseUrl"). Used by both the API and the manager.
- `GET /api/config` returns a **redacted** assistant view (`hasApiKey`, never the
  raw key).
- `PUT /api/assistant-config` updates the settings; `apiKey` is only overwritten
  when a non-empty string is supplied (change model/endpoint without resending
  the secret).
- Config file path is overridable via `VSPARK_CONFIG_PATH` (tests, custom
  installs).

New `WSMessageKind` values: `assistant_user_message`, `assistant_reset`,
`assistant_text`, `assistant_tool_call`, `assistant_tool_result`,
`assistant_error`, `assistant_done`. See [shared-types.md](shared-types.md).

## Frontend — Assistant window

| File | Role |
|------|------|
| `store/assistantStore.ts` | Standalone Zustand store (mirrors `helpStore`'s self-contained pattern). Flat `entries` transcript (`user` / `assistant` / `tool` / `error`), plus `open`, `streaming`, and `available` (null until `/api/config` is probed). |
| `components/editor/AssistantWindow.tsx` | Draggable floating chat window (mirrors `HelpWindow`), mounted in `Editor.tsx`. Renders the transcript + a tool-activity trace; probes `/api/config` for availability. |
| `hooks/useWsSync.ts` | `sendAssistantMessage` / `sendAssistantReset` helpers + inbound `assistant_*` handlers that feed `assistantStore`. |
| `components/editor/TopBar.tsx` | `🤖 Assistant` toggle button (`vs-topbar-assistant`). |

i18n: new `assistant` namespace (en + de). Help: new `assistant.md` page (en +
de) with `{#how-to-use}`, `{#setup}`, `{#capabilities}`, `{#limits}` anchors;
`'assistant'` added to `TOPIC_ORDER` in `help/docs.ts`; a
`HelpButton(topic=assistant, anchor=how-to-use)` in the window. See
[i18n-help.md](i18n-help.md).

New `vs-` control handles (controls-manifest blessed): `vs-topbar-assistant`,
`vs-assistant-input`, `vs-assistant-send`, `vs-assistant-close`,
`vs-assistant-clear`, `vs-assistant-reset`.

## Packaging

- `package.json`: `bin.vspark-mcp` → `dist/mcp-stdio.cjs`; dev script
  `mcp:stdio` → `tsx src/mcp/stdio.ts`.
- `bundle.mjs`: a second esbuild entry bundles `src/mcp/stdio.ts` to
  `dist/mcp-stdio.cjs` alongside the main server bundle.
- Dependency: `@modelcontextprotocol/sdk` ^1.29.

## Tests

- `packages/backend/test/api.mcp.test.ts` (6 tests) — tool catalog (asserts the
  catalog includes `list_presets` + `instantiate_preset` and has length ≥ 54),
  create + read-back of a scene node, the tool-error path, two-step logic wiring,
  and config redaction.
- `packages/frontend/test/assistantStore.test.ts` (5 tests).

## The three transports at a glance

| Transport | Entry | Who uses it | Backend reached via |
|-----------|-------|-------------|---------------------|
| Streamable-HTTP | `mcp/http.ts` → `/mcp` | External MCP clients over HTTP; future in-app callers | loopback `http://127.0.0.1:${PORT}` |
| stdio | `mcp/stdio.ts` (`vspark-mcp` bin) | External AI clients that spawn a process (Claude Desktop/Code, Cursor) | `VSPARK_BASE_URL` (default `:3001`) |
| in-memory | `InMemoryTransport` in `assistant/agent.ts` | The in-app Assistant agent | loopback (the `VsparkClient` the manager injects) |

All three build the identical server via `createMcpServer(client)`; they differ
only in the transport and the base URL the `VsparkClient` points at.

## Adding / changing a tool

1. Add (or edit) a `ToolSpec` in `mcp/tools.ts`: `name`, a `description` that
   **spells out any non-validated / non-discoverable semantics**, a zod
   `inputShape`, and a `handler(client, args)` that drives the REST API through
   `VsparkClient`.
2. That's it for all three transports and the agent — they all read
   `buildToolSpecs()`.
3. Update `api.mcp.test.ts` if the tool has interesting semantics (read-back,
   error path, multi-step wiring).
4. If the tool surfaces a new user-facing capability, mention it in the
   `assistant` help page (`{#capabilities}`) so non-technical users learn it.

## Cross-references

- [backend-api.md](backend-api.md) — REST surface the tools drive; `/mcp` mount;
  `routes/config.ts` (`/api/config`, `/api/assistant-config`);
  `routes/ui.ts` (`/api/ui-sessions`, `/api/ui-actions`).
- [frontend.md](frontend.md) — Assistant window, store, `useWsSync` helpers,
  TopBar toggle, `ui_action` dispatch + `lib/uiHighlight.ts`.
- [shared-types.md](shared-types.md) — `AssistantConfig` / `AssistantConfigPublic`,
  the `assistant_*` and `session_hello` / `ui_register` / `ui_action`
  `WSMessageKind` values, and the shared `cameraEffects.ts` catalog.
- [i18n-help.md](i18n-help.md) — `assistant` namespace + help page.
- [project-graphs.md](project-graphs.md) — Logic graphs the `*_logic` tools
  create and wire.
- [compose.md](compose.md) — compose scenes/layers the compose tools target.
- [track-clips.md](track-clips.md) — timeline clips/lanes/keyframes the
  `*_track_clip*` tools build and drive.
- [paramPaths.md](paramPaths.md) — the shared paramPath registry
  `lookup_param_paths` returns for track-clip lanes.
- [component-managers.md](component-managers.md) — the behavior kinds the
  `*_behavior` tools attach and configure.
- [api-controller.md](api-controller.md) — the `api_controller` behavior the
  `play_animation` / `set_blendshapes` tools require.
- [animation.md](animation.md) — avatar animation clips / expressions the
  playback tools drive.
- [camera-effects.md](camera-effects.md) — the camera-effect pipeline the
  `*_camera_effect*` tools manage; catalog now in shared.
- [presets.md](presets.md) — the preset library + the 18 shipped builtins the
  `list_presets` / `instantiate_preset` tools surface and instantiate.
