# System Hotkeys

System-wide keyboard shortcuts as a Logic **input** node. Lets a user trigger
graph reactions (play an animation, swap an expression, show an overlay) by
pressing a key combination anywhere on the machine running the backend — even
when vspark is not the focused window.

## Pieces

| Piece | Location |
|-------|----------|
| `system_hotkey` signal node | `packages/backend/src/signal/nodes/system_hotkey.ts` |
| `HotkeyManager` | `packages/backend/src/hotkeys/manager.ts` (singleton `hotkeyManager`) |
| Init + LogicManager hook | `packages/backend/src/index.ts` |
| Global keyboard hook dep | `node-global-key-listener` (optional, externalized in `bundle.mjs`) |

## How it works

This is the **overlive event-node pattern** applied to OS keystrokes:

1. The `system_hotkey` node is a source with no upstream edges. Its combo lives
   in config: `key` (String) plus `ctrl` / `shift` / `alt` / `meta` (Bool),
   all editable inline on the node card (value-in ports with config fallback).
   It exposes an `event` (Trigger) output and a `key` (String) value-out.
2. `HotkeyManager` installs a single global OS keyboard hook and, on each
   key-**DOWN**, walks `logicManager.iterateNodes()` for `system_hotkey` nodes,
   reads each node's combo straight off `node.defaultConfig`, and fires the
   `event` port of every node whose combo matches the keystroke + held
   modifiers (via `logicManager.fire`). Per-node matching lives in the manager
   (`nodeMatches`); the node body just records what fired and re-emits.
3. Matching is **exact** on the key name (case-insensitive) and on all four
   modifiers, so `Ctrl+S` does not fire on `Ctrl+Shift+S`. An empty `key`
   config never matches.

### Lifecycle / laziness

The global hook is **not** installed at boot. `LogicManager.onGraphsChanged`
(fired from `start`/`stop`) calls `hotkeyManager.sync()`, which starts the hook
the first time a `system_hotkey` node appears in any running graph and stops it
once none remain. So the keyboard is only observed while the feature is actually
in use. Runtime-added nodes are picked up automatically because dispatch walks
the running graphs live on every keystroke (same as overlive).

OS auto-repeat (repeated DOWN while a key is held) is debounced to **one fire
per physical press** via a held-key set in the manager.

### Graceful degradation

`node-global-key-listener` ships per-platform key-server binaries and needs
OS-level access (low-level hooks on Windows, Event Taps on macOS, an X server on
Linux). The manager loads it with a **guarded dynamic `import()`**: if the
package is missing, the platform is unsupported, or the hook can't be installed
(headless/remote server), it logs once and degrades — `system_hotkey` nodes
never fire and nothing else is affected. After a failure it does not retry.

### Bundling

The dep resolves its server binaries relative to its own package dir, so it
**cannot** be inlined into the single-file esbuild bundle. It's marked
`external` in `bundle.mjs` and `require()`d from `node_modules` at runtime; the
guarded import means an unbundled `node dist` / `pnpm dev` run gets full
functionality while a stripped distribution that lacks the package degrades
gracefully.

## Security note

Like overlive routing, this assumes a **single trusted local user**: a global
keyboard hook observes every keystroke on the machine while active. This is
acceptable under the same single-user assumption documented in
[ARCHITECTURE.md](../ARCHITECTURE.md) (Future Features → Multi-user usage).

## Extending

- More combo expressivity (key sequences/chords, "any modifier") would extend
  `nodeMatches` + the node config.
- The node currently exposes the fired `key`; richer outputs (modifier flags as
  value-outs) would mirror the payload already delivered in `HotkeyEventPayload`.
