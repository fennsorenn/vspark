# Smoke Test Report — feature/multiplayer-phase6

**Branch:** `feature/multiplayer-phase6` → `dev`  
**PR:** [#38](https://github.com/fennsorenn/vspark/pull/38)  
**Run:** 2026-06-10T23:32:32Z  
**Result:** ✅ PASS — 14/14 checks passed, 0 failed

---

## Scope

**PR title:** Multiplayer Phase 5: peer-to-peer connections, object sharing, and mesh

**Changed areas classified:**
- `packages/backend/src/multiplayer/**` → API + two-peer mesh harness  
- `packages/backend/src/routes/connections.ts` → API (new connection/sharing routes)  
- `packages/backend/src/db/migrations/027–030_*.sql` → API (schema migrations, verified by clean boot)  
- `packages/frontend/src/**` → Browser (Playwright)  
- `packages/shared/src/**` → API  
- `packages/rendezvous/**` → new standalone service  
- `dev-notes/**` → docs only (no runtime tests)

**Test types used:** API (curl) + Browser (Playwright two-peer mesh)

---

## Test Plan

| # | Check | Type |
|---|-------|------|
| 1 | Type-check all packages (`pnpm lint` + `tsc --noEmit` frontend) | Static |
| 2 | Backend A + B boot, DB migrations apply | API |
| 3 | Rendezvous server starts on :8787 | API |
| 4 | Both backends register on mesh (status=ready) | API |
| 5 | Pairing flow: create code → join → connect → accept | API |
| 6 | WebRTC connection established (both peers show connected=true) | API |
| 7 | Object share (canWrite=true) from A to B | API |
| 8 | Phase 6 collab scene share + mount (A→B) | API |
| 9 | Write tier: B edits shared node → propagates to A's DB | API |
| 10 | Home page renders (A and B frontends) | Browser |
| 11 | Language switcher EN/DE present on Home | Browser |
| 12 | German i18n: "Deutsch" select → DE strings render | Browser |
| 13 | Editor 3D canvas mounts on both frontends | Browser |
| 14 | Connections button in TopBar opens Connections window | Browser |
| 15 | Collab-synced scene ("Smoke Scene A") visible in B's editor | Browser |
| 16 | Synced scene nodes (Camera, Key Light) visible in B | Browser |
| 17 | "Connected" peer status shown in B's editor | Browser |
| 18 | /docs/connections help page renders | Browser |
| 19 | No unexpected console errors (A or B) | Browser |

---

## API Test Results

### Static analysis
- **`pnpm lint`** (backend + shared + rendezvous): ✅ PASS — 0 type errors
- **`tsc --noEmit`** (frontend): ✅ PASS — 0 type errors

### Server startup (two-peer mesh)
- **Rendezvous** (`PORT=8787`): ✅ started — `[rendezvous] listening on :8787 (turn=off)`
- **Backend A** (`PORT=3001`, `MULTIPLAYER_DISPLAY_NAME=ServerA`, `VSPARK_DB_PATH=/tmp/smoketest/a.db`): ✅ started, DB migrations applied
- **Backend B** (`PORT=3002`, `MULTIPLAYER_DISPLAY_NAME=ServerB`, `VSPARK_DB_PATH=/tmp/smoketest/b.db`): ✅ started, DB migrations applied
- **Frontend A** (`http://localhost:5173` → backend :3001): ✅ started
- **Frontend B** (`http://localhost:5174` → backend :3002): ✅ started

### Connection & mesh tests

**Both backends on mesh:**
```
Backend A: enabled=true, status="ready", peerId="VY5KKxIW3qRApAMflV3MEqvo-wVSRp9nihQW9DV95AM"
Backend B: enabled=true, status="ready", peerId="w6-WOXFoT3RYZ79iVeYa5xa41GfbXIpaBBIWQqe8i7g"
```

**Pairing flow:** ✅
```
POST /api/connections/pair/create (A) → code: "3W4JAWRH"
POST /api/connections/pair/join (B)  → ok, returned A's peerId + publicKey + displayName
POST /api/connections/peers/B/connect (A) → ok
POST /api/connections/peers/A/accept (B) → ok
```

**WebRTC connection established in <1s:** ✅
```json
{
  "peerId": "w6-WOX...",
  "displayName": "ServerB",
  "sessionGranted": true,
  "connected": true
}
```

**Object sharing (canWrite=true):** ✅
```
POST /api/connections/objects/00853f85.../share  {granteePeerId: B, canWrite: true}
→ { grantees: ["w6-WOX..."] }
```

**Phase 6 — Collab scene share + mount:** ✅
```
POST /api/connections/scenes/fd5970ca.../share-collab  {granteePeerId: B}
→ { sceneId: "fd5970ca...", granteePeerId: "w6-WOX..." }

POST /api/connections/collab/mount  {ownerPeerId: A, sceneId, projectId: B}
→ { ok: true }
```
After mount: B's `GET /api/projects/{pidB}/scenes` returns "Smoke Scene A" with all 3 nodes (Camera, Key Light, Fill Light). ✅

**Write tier (Phase 6):** ✅
```
Before: Camera at x=0, y=1.3, z=2
B PUT /api/scene-nodes/00853f85.../  {components: {transform: {x:7, y:3, z:4}}}
After (A's DB): Camera at x=7, y=3, z=4  ← propagated correctly
```

---

## Browser Test Results (Playwright)

| Check | Result |
|-------|--------|
| A: Home page shows "vspark" branding | ✅ PASS |
| A: Home page shows "New Project" button | ✅ PASS |
| A: Language switcher (select EN/DE) present | ✅ PASS |
| A: German language switch works (i18n) | ✅ PASS — DE strings visible |
| A: Editor 3D canvas mounts | ✅ PASS |
| A: Connections button clicked | ✅ PASS — "Connections" button found |
| B: Home page renders (backend B) | ✅ PASS |
| B: Editor 3D canvas mounts | ✅ PASS |
| B: Collab scene "Smoke Scene A" visible in B | ✅ PASS — scene synced A→B |
| B: Synced nodes (Camera, Key Light) visible | ✅ PASS |
| B: "Connected" peer status shown in editor | ✅ PASS |
| A: /docs/connections page renders content | ✅ PASS — 299 chars |
| A: No unexpected console errors | ✅ PASS |
| B: No unexpected console errors | ✅ PASS |

**Note on console errors:** The `EnvironmentCube`/`SafeEnvironment` React error-boundary message was observed but is explicitly known-benign (project.md §Known-benign console error): drei's `<Environment preset="city">` cannot fetch its HDRI in the sandboxed/offline environment; the `SafeEnvironment` ErrorBoundary catches it and the app continues normally.

---

## Screenshots

| Screenshot | Description |
|------------|-------------|
| [01-A-home](shots/01-A-01-home.png) | Home page — project list, language switcher, branding |
| [02-A-german-i18n](shots/02-A-02-german-i18n.png) | German language applied to home page |
| [03-A-editor](shots/03-A-03-editor.png) | Editor A — 3D viewport loaded |
| [04-A-connections-window](shots/04-A-04-connections-window.png) | Connections window open in editor A |
| [05-B-home](shots/05-B-05-home.png) | Home page on backend B |
| [06-B-editor](shots/06-B-06-editor.png) | Editor B — canvas loaded |
| [07-B-scene-and-connections](shots/07-B-07-scene-and-connections.png) | B editor with synced scene + Connected status |
| [08-A-docs-connections](shots/08-A-08-docs-connections.png) | /docs/connections help page |
| [09-A-editor-final](shots/09-A-09-editor-final.png) | Final editor A screenshot |
| [10-B-editor-final](shots/10-B-10-editor-final.png) | Final editor B screenshot |

---

## Server / Console Errors

None (outside of known-benign HDRI network artifact).

---

## Summary

All API and browser tests pass. The multiplayer Phase 5+6 feature set is working end-to-end:
- Rendezvous signaling and WebRTC P2P mesh connect in <1s
- Pairing, session grant, object sharing all function via REST
- Phase 6 collab scene sharing propagates owner's scene into the receiver's DB
- Write tier confirmed: receiver edits route back to owner's DB
- Both frontends render the shared/synced scene correctly
- Connections window button appears in TopBar; i18n (EN/DE) works; help docs page renders
