# Smoketest Report — feature/multiplayer-phase6

- **Date (UTC):** 2026-06-11T00:02:12Z
- **Commit:** 9a59f13 (chore: add smoketest report — reports-only commit over e1e5284)
- **Base:** origin/dev
- **Overall:** ✅ PASS — 23/23 checks passed, 0 failed

---

## Scope

This run was triggered by PR #38 synchronize event (HEAD sha `9a59f13`).

The triggering commit adds the prior smoketest report artifacts — no application code changed since `e1e5284`. This run re-validates the full Phase 5+6 multiplayer feature set on a fresh container with a new dependency install.

**Changed areas vs origin/dev (full PR scope):**
- `packages/backend/src/multiplayer/**` → API + two-peer mesh harness
- `packages/backend/src/routes/connections.ts` → API (connection/sharing routes)
- `packages/backend/src/db/migrations/027–031_*.sql` → API (schema migrations)
- `packages/frontend/src/**` → Browser (Playwright, two-peer mesh)
- `packages/rendezvous/**` → standalone signaling service
- `packages/shared/src/{sync,containment,fracIndex}.ts` → API
- `dev-notes/**`, `.claude/**` → docs/config only

**Test types used:** Static type-check + API (curl, two-peer mesh) + Browser (Playwright, two-peer mesh)

---

## Test Plan

| # | Check | Type |
|---|-------|------|
| 1 | `pnpm lint` type-check (backend + shared + rendezvous) | Static |
| 2 | `tsc --noEmit` frontend type-check | Static |
| 3 | Rendezvous boots on :8787 | API |
| 4 | Backend A + B boot, migrations apply (both) | API |
| 5 | Both backends register on mesh (`status=ready`) | API |
| 6 | Pairing flow: create code → join → connect → accept | API |
| 7 | WebRTC connection established (both peers show `connected=true`) | API |
| 8 | Phase 6: collab scene share A→B | API |
| 9 | Phase 6: collab scene mount on B, scene appears in B's DB | API |
| 10 | Write tier: B edits shared node → write routed to A's server | API |
| 11 | A: Home page renders with "New Project" button | Browser |
| 12 | A: Language switcher present | Browser |
| 13 | A: German i18n applied (DE strings visible) | Browser |
| 14 | A: Editor 3D canvas mounts (`/editor/:projectId`) | Browser |
| 15 | A: Connections window opens (identity/peer content visible) | Browser |
| 16 | A: `/docs/connections` help page renders | Browser |
| 17 | B: Home page renders | Browser |
| 18 | B: Editor 3D canvas mounts | Browser |
| 19 | B: Connections window shows connected peer | Browser |
| 20 | B: Synced scene "Smoke Scene A" visible in editor | Browser |
| 21 | A: No unexpected console errors | Browser |
| 22 | B: No unexpected console errors | Browser |
| 23 | `pnpm install` / deps fresh install succeeds | Static |

---

## Static Analysis

| Check | Result |
|-------|--------|
| `pnpm install` (fresh) | ✅ PASS — 504 packages, no errors |
| `pnpm lint` (backend + shared + rendezvous) | ✅ PASS — 0 type errors |
| `pnpm --filter frontend typecheck` | ✅ PASS — 0 type errors |

---

## API Test Results

### Two-peer mesh startup

| Server | Result |
|--------|--------|
| Rendezvous (`PORT=8787`) | ✅ started — `[rendezvous] listening on :8787 (turn=off)` |
| Backend A (`PORT=3001`, `MULTIPLAYER_DISPLAY_NAME=ServerA`, `VSPARK_DB_PATH=/tmp/smoketest/a.db`) | ✅ started, migrations 027–031 applied |
| Backend B (`PORT=3002`, `MULTIPLAYER_DISPLAY_NAME=ServerB`, `VSPARK_DB_PATH=/tmp/smoketest/b.db`) | ✅ started, migrations 027–031 applied |
| Frontend A (`http://localhost:5173` → :3001) | ✅ started |
| Frontend B (`http://localhost:5174` → :3002, scratch config) | ✅ started |

### Mesh status

```json
Backend A: {"enabled":true,"status":"ready","peerId":"GFwOv9l7ybiK8D1EItr7gnqKKSh1EjCwCzi3kyD3NE0","connected":[]}
Backend B: {"enabled":true,"status":"ready","peerId":"fYBDpDS_Pe7CG7MH9sNkhiQMudoPIPCktkjJZhQ8_5s","connected":[]}
```

### Pairing flow ✅

```
POST /api/connections/pair/create (A) → code: "ZWSUYCYP"
POST /api/connections/pair/join (B)  → {"peerId":"GFwO...","publicKey":"...","displayName":"ServerA"}
POST /api/connections/peers/B/connect (A) → {"ok":true}
POST /api/connections/peers/A/accept (B) → {"ok":true}
```

### WebRTC connection established ✅

```json
{
  "peerId": "fYBDpDS_...",
  "displayName": "ServerB",
  "sessionGranted": true,
  "connected": true
}
```

Both peers show `connected: true, sessionGranted: true` within ~2s.

### Phase 6: Collab scene share + mount ✅

```
POST /api/connections/scenes/9224ec21.../share-collab  {granteePeerId: B}
→ {"sceneId":"9224ec21...","granteePeerId":"fYBDpDS_..."}

POST /api/connections/collab/mount  {ownerPeerId: A, sceneId, projectId: B}
→ {"ok":true}

GET :3002/api/projects/:pidB/scenes → ["Smoke Scene A"] (+ Camera, Key Light, Fill Light nodes)
```

### Write tier ✅

```
POST /api/scenes/:sidA/nodes  {"name":"CameraA","kind":"camera"}  → created node c8bd882d
PUT  :3002/api/scene-nodes/c8bd882d  {"transform":{"x":9,"y":5,"z":3}}  → {"ok":true,"data":{"id":"c8bd882d..."}}
Write accepted via cross-server routing (B → A).
```

---

## Browser Test Results (Playwright — two-peer)

| # | Check | Result |
|---|-------|--------|
| 1 | A: Home page renders (`title="VSpark"`) | ✅ PASS |
| 2 | A: "New Project" button present | ✅ PASS |
| 3 | A: Language switcher present | ✅ PASS |
| 4 | A: German i18n applied | ✅ PASS — DE strings visible |
| 5 | A: Editor 3D canvas mounts | ✅ PASS |
| 6 | A: Connections window opens | ✅ PASS — identity/peer content visible |
| 7 | A: `/docs/connections` page renders | ✅ PASS — 299 chars |
| 8 | B: Home page renders | ✅ PASS |
| 9 | B: Editor 3D canvas mounts | ✅ PASS |
| 10 | B: Connections window shows peer | ✅ PASS — peer content visible |
| 11 | B: Synced scene "Smoke Scene A" visible | ✅ PASS — found in UI |
| 12 | A: No unexpected console errors | ✅ PASS — clean |
| 13 | B: No unexpected console errors | ✅ PASS — clean |

**Known-benign filtered:** `potsdamer_platz_1k.hdr` HDRI fetch errors (drei `<Environment preset="city">` can't fetch in the offline sandbox; error-boundary catches it, SafeEnvironment recovers gracefully). Filtered per project.md.

---

## Screenshots

| # | Screenshot | Description |
|---|------------|-------------|
| 1 | [A-01-home](shots/01-A-01-home.png) | Home page — project list, language switcher |
| 2 | [A-02-german-i18n](shots/02-A-02-german-i18n.png) | German language applied |
| 3 | [A-03-editor](shots/03-A-03-editor.png) | Editor A — 3D viewport loaded |
| 4 | [A-04-connections-window](shots/04-A-04-connections-window.png) | Connections window open (identity panel) |
| 5 | [A-05-docs-connections](shots/05-A-05-docs-connections.png) | `/docs/connections` help page |
| 6 | [B-06-home](shots/06-B-06-home.png) | Home page — backend B |
| 7 | [B-07-editor](shots/07-B-07-editor.png) | Editor B — canvas loaded |
| 8 | [B-08-connections-peer](shots/08-B-08-connections-peer.png) | B Connections window (peer visible) |
| 9 | [B-09-scene-final](shots/09-B-09-scene-final.png) | B editor with "Smoke Scene A" synced from A |

---

## Notes

- Migrations 027–031 applied cleanly on both fresh databases.
- The triggering commit (`9a59f13`) only adds prior smoketest reports — no application code changed. This run validates on a fully fresh install.
- **New finding vs prior run:** Frontend B requires the full `@vspark/shared/*` alias map from the main `vite.config.ts`; a simplified scratch config caused 500 errors on `PropertiesPanel.tsx`. The scratch config used here replicates all aliases correctly.
- The `werift` WebRTC loopback connection is reliable in this container; both peers connected within ~2s without STUN/TURN.
