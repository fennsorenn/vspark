# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (run from repo root)
pnpm dev              # All packages in parallel
pnpm dev:backend      # Backend only (tsx watch, port 3001)
pnpm dev:frontend     # Frontend only (Vite, port 5173)

# Build
pnpm build            # All packages
pnpm build:backend    # TypeScript compile
pnpm build:frontend   # TypeScript + Vite

# Quality
pnpm lint             # TypeScript type-check all packages
pnpm format           # Prettier format all packages
```

No test runner is configured — type-checking via `pnpm lint` is the primary correctness check.

## Architecture

**vspark** is a 3D avatar/scene streaming system: it receives motion capture data (VMC protocol over UDP), processes it through a reactive signal graph, and streams pose updates to a Three.js viewport where VRM avatars are rendered in real time.

### Monorepo Layout

```
packages/
  backend/    Node.js/Express server — signal graph engine, SQLite persistence, VMC UDP listener
  frontend/   React + React Three Fiber — 3D viewport, node graph editor UI, Zustand state
  shared/     TypeScript types, Zod schemas, signal graph type definitions
```

### Core Abstractions

- **Project** → **Scene** → **Node** (VRM avatar, camera, light, group) — persistent hierarchy in SQLite
- **Component** — behavioral driver attached to a node (e.g. `vmc_receiver`), stored in `node_components`
- **Signal Graph** — reactive execution engine instantiated per component; hybrid push (events) / pull (values) model
- **PoseFrame** — sparse bone rotation payload produced by the graph and broadcast over WebSocket

### Backend Data Flow

1. `node_components` CRUD (via `/api/node-components`) triggers `VmcManager` to instantiate/destroy signal graphs
2. `VmcManager` opens a UDP socket; incoming OSC packets fire into the graph's `vmc_packet_source` node
3. Graph executes through bone mappers → calibration nodes → `pose_broadcast` node
4. `pose_broadcast` emits `vmc_pose` / `vmc_blendshapes` messages over the shared WebSocket

Key backend files:
- [packages/backend/src/index.ts](packages/backend/src/index.ts) — entry point, HTTP + WebSocket setup
- [packages/backend/src/routes/api.ts](packages/backend/src/routes/api.ts) — all REST routes
- [packages/backend/src/signal/engine.ts](packages/backend/src/signal/engine.ts) — graph runtime (typed ports, value cache, cycle detection)
- [packages/backend/src/signal/registry.ts](packages/backend/src/signal/registry.ts) — registered signal node kinds
- [packages/backend/src/vmc/manager.ts](packages/backend/src/vmc/manager.ts) — VMC component lifecycle

### Frontend Data Flow

1. `Editor.tsx` loads project/scene/nodes from REST API → populates Zustand store (`editorStore.ts`)
2. `useWsSync()` maintains WebSocket connection and writes incoming `vmc_pose` / `vmc_blendshapes` into the store
3. `Viewport.tsx` renders a React Three Fiber canvas; `Avatar.tsx` reads pose from the store and applies it to the loaded VRM

Key frontend files:
- [packages/frontend/src/App.tsx](packages/frontend/src/App.tsx) — router (Home `/` + Editor `/:projectId`)
- [packages/frontend/src/store/editorStore.ts](packages/frontend/src/store/editorStore.ts) — Zustand store (scene graph, VRM skeletons, VMC state)
- [packages/frontend/src/components/editor/Viewport.tsx](packages/frontend/src/components/editor/Viewport.tsx) — Three.js canvas
- [packages/frontend/src/components/editor/Avatar.tsx](packages/frontend/src/components/editor/Avatar.tsx) — VRM loader + pose application
- [packages/frontend/src/hooks/useWsSync.ts](packages/frontend/src/hooks/useWsSync.ts) — WebSocket sync with auto-reconnect

### Signal Graph

Defined entirely in [packages/shared/src/signal.ts](packages/shared/src/signal.ts). Node classes are registered in the backend registry and serialized as `GraphDescriptor` objects. The 13 built-in node kinds live under [packages/backend/src/signal/nodes/](packages/backend/src/signal/nodes/).

The VMC pipeline graph shape is hardcoded in [packages/backend/src/vmc/vmc_graph.ts](packages/backend/src/vmc/vmc_graph.ts) — it wires source → mapper → calibration → broadcast nodes.

### Database

better-sqlite3 (synchronous). Migrations in [packages/backend/src/db/migrations/](packages/backend/src/db/migrations/). All tables are project-scoped with strict foreign key constraints. Key tables: `projects`, `scenes`, `scene_nodes`, `node_components`, `asset_files`, `animation_clips`.

### Shared Types

- [packages/shared/src/types.ts](packages/shared/src/types.ts) — `Node`, `Scene`, `Project`, `Component`, `AnimationState`
- [packages/shared/src/schema.ts](packages/shared/src/schema.ts) — Zod request validation schemas
- [packages/shared/src/signal.ts](packages/shared/src/signal.ts) — `Quaternion`, `BoneRotations`, `VRM_BONE_NAMES`, `SignalNodeClass`, graph type system

# Project Documentation

Each project maintains a `dev-notes/` directory for developer-facing documentation:

- `dev-notes/ARCHITECTURE.md` — high-level overview of the project: major modules, how they fit together, key decisions and their rationale. Keep it lean; it should be enough to understand which modules are relevant, not a deep dive into each. Track the status of each module and major feature: implemented, WIP, or planned.
- `dev-notes/modules/<name>.md` — per-module detail: structure, patterns, how to extend it or add new types. Put specifics here, not in ARCHITECTURE.md.
- `dev-notes/modules/<name>/` — when a module contains multiple non-trivial implementations of the same concept (strategies, providers, handlers, adapters, etc.), use a subfolder instead. The module file becomes `<name>/index.md` and acts as an index: what the concept is, how implementations are registered or selected, and a list of the implementations with one-line descriptions. Each implementation gets its own file covering its behaviour, configuration, edge cases, and extension notes. File names should match the corresponding code identifiers. Don't pre-create files for planned implementations — list them in the index instead.

Cross-reference between module files when there are meaningful dependencies between modules. If one module's behaviour depends on or extends another, note it explicitly rather than leaving it implicit.

At the start of a new session, read `dev-notes/ARCHITECTURE.md` to orient yourself. When working in a specific module, read its module file if one exists.

Documentation is maintained by the `doc-updater` agent. Spawn it in the background (do not wait for it) in these situations, passing enough context for it to act without needing the session history:

- **Starting a task**: spawn with the task description and affected modules → it marks them WIP
- **Planning a feature**: spawn with the feature description and how it fits → it adds it as planned
- **Completing a task**: spawn with a summary of what changed, which modules were affected, and any new patterns or extension points → it updates statuses and module files

# Git

## Clean working tree before starting

Before starting any new feature branch — and before any non-trivial task — run `git status`. If there are uncommitted modifications or untracked files that look like in-progress work from a prior session, **stop and ask the user how to handle them** rather than working on top of them. Carrying someone else's uncommitted state into a new feature branch risks accidentally overwriting their work, mixing it into your commits, or having to revert files mid-task and losing it. Acceptable resolutions: (a) ask the user to commit/stash/discard, (b) stash them yourself with the user's explicit confirmation, (c) work on a different branch and come back later. Do not silently proceed.

## Branches

Work happens on feature branches, never directly on `dev` or `main`.

- Branch naming: `feature/<description>` or `bugfix/<description>`
- Create a branch at the start of any non-trivial task if one doesn't exist yet
- Feature branches merge into `dev` directly (no PR required)
- Merges from `dev` into `main` always go via a PR
- Every merge into `main` must be accompanied by a semver tag (e.g. `v1.2.0`), inferred from conventional commits since the last tag:
  - `fix:` → patch bump
  - `feat:` → minor bump
  - Any breaking change (`BREAKING CHANGE` in footer or `!` suffix) → major bump

## Commits

Use conventional commit messages: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`.

On a feature branch, commit proactively at natural stopping points — when a coherent unit of work is complete and the code is in a working state. Don't accumulate a session's worth of changes into one commit.

Before switching to a new task or context, run `git status`. If there are uncommitted changes, complete and commit them first rather than carrying dirty state across task boundaries.

## Confirming commits

Always show the proposed commit message and file list before committing, and wait for confirmation. Never skip hooks (`--no-verify`).

# Cloud Worker Handoff

Implementation work can be handed off from a local planning session to an interactive browser-based cloud session at claude.ai/code. Local Claude Code **cannot** spawn an interactive cloud session, so the handoff is a clickable link + a copy-pasteable instruction block that the user opens.

## Workflow

1. **Local (plan):** plan the change, create the feature branch, write the plan to `dev-notes/plans/<descriptive-name>.md` (use the plan template), commit, and **push the branch**. Cloud workers check out the *remote* — an unpushed plan or branch is invisible to them.
2. **Hand off:** produce the handoff artifact below for the user.
3. **Cloud (interactive):** the user opens the link, selects the branch, and drives the implementation, refining the plan live as needed.
4. **Output:** the worker opens a PR into `dev` when done.

## Handoff artifact

Emit a markdown-formatted link (plain `https://` URLs do not reliably linkify in the chat surface; markdown links do) plus a paste-fallback block.

Link format — confirmed facts:
- Base: `https://claude.ai/code`
- `repositories=<owner>/<repo>` selects the repo (find the slug from `git remote -v`).
- `prompt=<url-encoded>` pre-fills the initial message.
- **There is no branch URL parameter.** The branch must be named *in the prompt text* and selected by the user from the branch dropdown after the repo loads.

Template (substitute `<owner>/<repo>`, `<branch>`, `<plan-file>`):

```markdown
**[🔗 Open cloud session — <branch>](https://claude.ai/code?repositories=<owner>/<repo>&prompt=<url-encoded prompt below>)**

​```
Repo: <owner>/<repo>
Select branch <branch> from the branch dropdown first.

Implement the plan in dev-notes/plans/<plan-file>.

- The plan is a starting point, not a spec. If anything is underspecified
  or you hit a decision the plan doesn't cover, ask me before guessing.
- Follow the repo CLAUDE.md conventions.
- Commit at natural stopping points with conventional-commit messages.
- When done, open a PR into dev.
​```
```

The `prompt=` value is the URL-encoded form of the same paste block (use `%0A` for line breaks, `%2F` for `/`).
