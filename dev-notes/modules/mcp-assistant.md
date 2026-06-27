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
| `tools.ts` | `buildToolSpecs()` — the single source of truth for the tool catalog (60 tools). Each `ToolSpec` is `{ name, description, inputShape (zod raw shape), handler }`. |
| `server.ts` | `createMcpServer(client)` — builds an `@modelcontextprotocol/sdk` `McpServer` (^1.29) and registers every spec. Handlers run the spec, JSON-stringify the result, and map thrown errors to `{ isError: true, content: [...] }`. |
| `http.ts` | `createMcpHttpRouter(loopbackBaseUrl)` — mounts the server over the **stateless Streamable-HTTP** transport at `/mcp` (see `index.ts`). Each POST spins up a fresh server+transport pair (no session affinity); `GET`/`DELETE` return 405. |
| `stdio.ts` | Standalone **stdio** MCP server — the `vspark-mcp` bin. External AI clients (Claude Desktop / Code, Cursor) spawn it; it forwards tool calls to a *running* backend over HTTP, pointed by `VSPARK_BASE_URL` (default `http://localhost:3001`). stderr for logs, stdout is the JSON-RPC channel. |

### The tool catalog (60 tools)

Grouped by area (all defined in `tools.ts`):

- **Discovery / read:** `list_projects`, `list_scenes`, `list_scene_nodes`,
  `list_compose_scenes`, `list_compose_layers`, `list_project_logic`,
  `get_logic`, `list_node_kinds`, `lookup_node_kind`,
  `lookup_component_schema`, `list_ui_controls`.
- **Presets (prefer over building from scratch):** `list_presets`,
  `instantiate_preset`.
- **Scene (3D) writes:** `create_scene`, `create_scene_node`,
  `update_scene_node`, `delete_scene_node`.
- **Compose (2D overlay) writes:** `create_compose_scene`,
  `create_compose_layer`, `delete_compose_layer`, `update_compose_layer`.
- **Logic (signal graph) writes:** `create_project_logic`, `update_logic`,
  `delete_logic`, `set_logic_descriptor`.
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
  **`set_logic_descriptor` changes only the nodes/edges, not the name** —
  rename / enable-disable a graph with `update_logic(id, name?, enabled?)`.
- **Signal-node `kind` and port names come from the catalog**, not guesses —
  `list_node_kinds` then `lookup_node_kind` (ports + types/transport). A wrong
  port name is not validated server-side and yields a dead graph.
  `list_node_kinds` returns each kind's `description` (so the agent recognises
  e.g. `start_clip` = "plays a track clip when triggered" instead of inventing
  node names) and takes an optional `tag` filter (clips, overlive, scene, math,
  utility, input, output, mocap, calibration) to fetch just the relevant family
  and save context; `lookup_node_kind` also returns the node's label/description.

**Lean descriptions, bulk reference behind fetch tools.** Descriptions carry only
the gotchas a model gets wrong; long enumerations live in dedicated `lookup_*` /
`list_*` fetch tools the agent calls on demand, keeping the always-loaded schemas
small (it matters on a 16k window). Two such tools were split out:

- **`lookup_component_schema(component?)`** returns the flat field shapes for
  scene-node `components` entries (transform / light / camera / feed). The full
  shapes moved OUT of `create_scene_node`'s description (which now just calls this
  tool); the components-vs-properties + flat-position gotchas stay inline.
- **`list_ui_controls(area?)`** returns the real `vs-` control handles grouped by
  area (topbar, uploads, assets, scene, compose, clips, presets, tabs). The
  ~80-handle inline list moved OUT of `ui_highlight_control`, whose description now
  just says to call `list_ui_controls` for the exact handle.

For the same reason `list_presets` and `list_overlive_accounts` descriptions were
trimmed of strategy text the system prompt already carries.

When the REST API or these semantics change, **the tool descriptions are the
thing to update** — see [Adding / changing a tool](#adding--changing-a-tool).

## Assistant agent — `assistant/`

| File | Role |
|------|------|
| `llm.ts` | Minimal OpenAI-compatible chat client (`chatCompletion`). Dependency-free (global `fetch`), non-streaming, `temperature: 0`. Works against vLLM / Ollama / OpenAI. Posts to `<baseUrl>/v1/chat/completions` with optional `Authorization: Bearer <apiKey>`. |
| `agent.ts` | `AssistantAgent` — holds conversation state and the tool-calling loop. Also owns the **context-management** layer: lazy tool-loading with a per-turn group reset (`TOOL_GROUPS` + the `enable_tools` meta-tool, `activeTools()`), three-pass history compaction (`compactToolHistory`), and overflow recovery (`completeWithRecovery` → `pruneOldestGroups`). |
| `manager.ts` | `AssistantManager` — one agent per WS connection; routes inbound `assistant_*` messages and streams events back to that single socket. |

### The agent loop

`AssistantAgent.init()` connects an **in-process MCP `Client` to a real
`McpServer`** via the SDK's `InMemoryTransport.createLinkedPair()`. So the agent
genuinely consumes the MCP — exactly the same tool surface external clients use —
rather than calling the tool handlers directly. It then `listTools()` and adapts
each into an OpenAI `function` tool (the MCP `inputSchema` becomes the function
`parameters`), caching the **full** catalog in `allTools` — the LLM only ever
sees the lazy-loaded subset `activeTools()` returns (see [Context
management](#context-management)).

`runTurn(userText, events, signal?)`:
1. Clear `enabledGroups` (each turn starts lean — only the action families this
   turn needs get re-enabled), push the user message; loop up to `MAX_TOOL_ROUNDS`
   (24). Track two per-turn flags: `mutated` (set when a call's name is in
   `TOOL_TO_GROUP`, i.e. a grouped action tool ran) and `verifyRequested`.
2. Each round: `compactToolHistory(messages)`, then one completion over
   `activeTools()` via `completeWithRecovery` (retries once with a harder prune on
   a context-overflow error).
3. If the model returned no `tool_calls` it wants to finish — but if it `mutated`
   and hasn't verified yet (`!verifyRequested`), force a **read-back pass**: set
   `verifyRequested`, push a one-time `VERIFY_NUDGE` (user role) and continue the
   loop, **suppressing this premature finishing message** (its `content` is NOT
   emitted) so the user only ever sees the verified summary. Otherwise emit the
   assistant text (`onText`) and the turn is done. (Read-only / navigational turns
   never set `mutated`, so they finish with no verification pass.)
4. Otherwise, for each call: parse args, mark `mutated` if its name is a grouped
   action tool, `onToolCall`, dispatch through `callTool` (which handles the
   `enable_tools` meta-tool agent-side and routes everything else to the MCP
   client), `onToolResult`, and push a `role: 'tool'` message (truncated to 4000
   chars).
5. After 24 rounds without finishing, emit a "stopped at max steps" notice.

A `system` prompt seeds the conversation with the same discover-before-mutate
discipline the tool descriptions enforce, plus a **PREFER PRESETS OVER BUILDING
FROM SCRATCH** instruction: when a request matches a common building block
(chat/feed overlay, event alert, particle effect, lighting rig), call
`list_presets` first and `instantiate_preset` the closest match, then adjust only
what the user asked; only build from scratch when no preset fits. It also tells
the model that action tools are **lazy-loaded** — call `enable_tools(group)` for
the family it needs before mutating — and to **verify changes by reading them back
before claiming success** (a tool returning ok does not prove the right thing
landed). `reset()` clears history back to the system prompt **and clears
`enabledGroups`**. `busy` guards against overlapping turns on one socket.

### Read-back verification

A tool call returning `ok` does **not** mean the right thing landed — a wrong
target id or the wrong tool can still "succeed" — so the agent used to over-claim.
The loop now forces a verification pass: it tracks whether the turn `mutated`
(any grouped action tool from `TOOL_TO_GROUP` ran). When the model wants to finish
(no `tool_calls`) but has mutated and not yet verified, the loop injects a one-time
`VERIFY_NUDGE` (user-role message: read the affected entities back —
`list_track_clips`, `get_logic`, `list_scene_nodes`, `list_camera_effects`,
`list_compose_layers` — confirm they match the request, fix anything wrong, then
summarise claiming only what was confirmed) and continues. **The premature
finishing message is suppressed** (its `content` is never emitted), so the user
only ever sees the verified summary. Read-only / navigational turns (only `ui_*` /
`list_*` / `lookup_*` calls) never set `mutated`, so they skip verification
entirely. `MAX_TOOL_ROUNDS` is 24 (raised from 16) to leave room for a build
(which alone can use ~16 rounds) plus the verify pass.

### Context management

The target deployment is a 16k-context model (`gemma`), where the 60 tool
schemas alone were ~half the window. Agent-side mechanisms keep both a long
single turn and a long multi-turn conversation inside the budget. All live in
`agent.ts`; the MCP server is untouched, so **standalone MCP clients still see the
full 60-tool catalog** — the gating is in-app only.

**Additive lazy tool-loading (#1).** The LLM does not see all 60 tools every
call. A small always-on **core** — everything *not* in a group, i.e. all
`list_*`/`lookup_*` discovery + `ui_*` pointing tools — stays loaded. The
mutation/action families are hidden until the agent calls the agent-side
meta-tool **`enable_tools(group)`**. The groups (`TOOL_GROUPS`, exported) are:
`objects` (scene nodes), `compose` (2D layers), `presets`
(`instantiate_preset`), `logic` (project logic + `set_logic_descriptor` +
`delete_logic`), `timeline` (track clips), `behaviors` (avatar drivers +
animation playback), `effects` (camera post-FX). `activeTools()` returns core +
enabled groups + the `enable_tools` loader. `enable_tools` is handled directly in
`callTool` (not routed to MCP); if the model calls an action tool whose family is
not yet enabled, that group **auto-enables** and the call proceeds. Measured
savings: default active tool-schema ~6.9k → ~3.3k tokens (~52%); each
one/two-family build adds ~0.3–0.8k back. **`enabledGroups` resets at the start of
every turn** (`runTurn`), so a long multi-feature conversation doesn't keep every
action family loaded — each turn re-enables only what it needs.

**Selective history compaction (#4).** Before each completion the loop calls the
exported pure function `compactToolHistory(messages)`. It bounds context growth
**without breaking the assistant↔tool pairing**, in three passes:

- **Pass 1 — shorten stale tool *results*.** The most recent `RECENT_TOOL_RESULTS`
  (=8) results stay verbatim; older `list_*`/`lookup_*`/`get_*` **reference**
  fetches (what the agent reasons on) are kept but capped at `REFERENCE_CAP`
  (=1800 chars); older **action** results (create/update/set/…) collapse to just
  their `id`/`ok` via `stubActionResult`.
- **Pass 2 — stub stale action-tool-call *arguments*** to `'{}'` (e.g. a full
  graph descriptor the model emitted is dead weight once executed), leaving the
  last `KEEP_LAST_MESSAGES` (=12) and reference/`enable_tools` calls alone.
- **Pass 3 — hard cap** on total history (`HISTORY_CHAR_BUDGET` ≈ 24000 chars):
  drop the oldest complete assistant+tool-result groups atomically via
  `dropOldestGroup` until under budget — never touching the system message, user
  turns, or the last `KEEP_LAST_MESSAGES`, so tool-call pairing stays valid.

It is idempotent.

**Recovery on overflow.** `completeWithRecovery` wraps the completion: if the LLM
still reports a context-length overflow, it prunes harder (`pruneOldestGroups`,
dropping oldest groups down to ~half the messages) and retries once, so a long
conversation degrades gracefully instead of dying. Motivation: an 8-turn session
previously overflowed gemma's 16k window on turn 5 and then failed every later
turn; with the per-turn group reset + hard cap + recovery it now completes with
zero context errors and later turns can still reference and summarise earlier work.

**`max_tokens`.** `llm.ts`'s default completion budget is **1024** (lowered from
1500) to reserve more of the small window for input; raise per-call via
`opts.maxTokens` when a genuinely large output is needed.

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

The in-app agent is told **its own editor session id and the currently-open
project id** so its `ui_*` tools drive the user's tab and not someone else's, and
so it acts on the right project without guessing from `list_projects`:
`AssistantAgent`'s constructor takes optional `sessionId` + `projectId`
(`agent.ts`), and `manager.ts` passes `wsSync.sessionIdFor(ws)` + the open project
when it builds the agent. When set, the system prompt gains lines stating each id
(pass the session id to any `ui_*` tool; use the project id for everything).

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
- `resolveAssistantConfig()` merges `config.json` over env defaults. The endpoint
  is any OpenAI-compatible base URL (vLLM, llama.cpp, Ollama's `/v1`, OpenAI
  itself). Env vars, in precedence order: the provider-neutral
  `ASSISTANT_BASE_URL` → baseUrl, `ASSISTANT_API_KEY` → apiKey,
  `ASSISTANT_MODEL` → model (default `google/gemma-4-12B-it-qat-w4a16-ct`); the
  legacy `VLLM_HOST` / `VLLM_AUTH` are still honored as a fallback, but the
  generic vars win when both are set. `enabled` defaults to "has a baseUrl". Used
  by both the API and the manager.
- `GET /api/config` returns a **redacted** assistant view (`hasApiKey`, never the
  raw key).
- `PUT /api/assistant-config` updates the settings; `apiKey` is only overwritten
  when a non-empty string is supplied (change model/endpoint without resending
  the secret).
- `config.json` lives at `getInstallDir()/config.json`; the path is overridable
  via `VSPARK_CONFIG_PATH` (tests, custom installs). Its shape
  (`{ channel, assistant: { enabled, baseUrl, apiKey, model } }`) is documented
  by `config.example.json` at the repo root.

New `WSMessageKind` values: `assistant_user_message`, `assistant_reset`,
`assistant_text`, `assistant_tool_call`, `assistant_tool_result`,
`assistant_error`, `assistant_done`. See [shared-types.md](shared-types.md).

## Frontend — Assistant window

| File | Role |
|------|------|
| `store/assistantStore.ts` | Standalone Zustand store (mirrors `helpStore`'s self-contained pattern). Flat `entries` transcript (`user` / `assistant` / `tool` / `error`), plus `open`, `streaming`, and `available` (null until `/api/config` is probed). |
| `components/editor/AssistantWindow.tsx` | Draggable floating chat window (mirrors `HelpWindow`), mounted in `Editor.tsx`. Renders the transcript + a tool-activity trace; probes `/api/config` **on mount** for availability (`available` ← `assistant.enabled && assistant.baseUrl`). |
| `hooks/useWsSync.ts` | `sendAssistantMessage` / `sendAssistantReset` helpers + inbound `assistant_*` handlers that feed `assistantStore`. |
| `components/editor/TopBar.tsx` | `🤖 Assistant` toggle (`AssistantToggle`, `vs-topbar-assistant`). |

**The whole AI surface stays hidden until an LLM endpoint is configured.**
`AssistantWindow` probes `/api/config` once on mount (not on first open), and
`AssistantToggle` renders nothing unless `available === true` (i.e.
`assistant.enabled && assistant.baseUrl`). With no endpoint set,
`resolveAssistantConfig()` reports `enabled: false`, so the 🤖 button is absent
entirely rather than disabled.

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

- `packages/backend/test/api.mcp.test.ts` — tool catalog (asserts the
  catalog includes `list_presets` + `instantiate_preset` and has length ≥ 60),
  create + read-back of a scene node, the tool-error path, two-step logic wiring,
  config redaction, **env precedence** for `resolveAssistantConfig()` (none →
  disabled, legacy `VLLM_HOST`/`VLLM_AUTH` fallback, generic
  `ASSISTANT_BASE_URL`/`ASSISTANT_API_KEY` wins when both set), and a **drift
  test** asserting every `TOOL_GROUPS` name is a real, non-core action tool in
  the catalog (and that no name is in two groups).
- `packages/backend/test/assistant.compact.test.ts` (6 tests) — `compactToolHistory`:
  recent results kept verbatim with no message dropped, older reference fetches
  capped (not stubbed), stale action-call argument stubbing, the hard cap dropping
  oldest groups with pairing + system message intact, `pruneOldestGroups`, and
  idempotence.
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
