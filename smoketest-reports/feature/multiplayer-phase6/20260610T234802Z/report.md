# Smoketest Report — feature/multiplayer-phase6

- **Date (UTC):** 2026-06-10T23:48:02Z
- **Commit:** e1e5284 (merge: smoketest reports from two parallel sessions)
- **Base:** origin/dev
- **Overall:** ✅ PASS — 21/21 checks passed, 0 failed

---

## Scope

This run was triggered by PR #38 synchronize event (HEAD sha `e1e5284`).

The triggering commit is a merge of two smoketest report branches — no application code changed since the prior comprehensive run. This run re-validates the full feature set on a fresh container.

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
| 7 | WebRTC connection established (both peers show connected=true) | API |
| 8 | Phase 6: collab scene share A→B | API |
| 9 | Phase 6: collab scene mount on B, scene + nodes appear | API |
| 10 | Write tier: B edits shared node → propagates to A's DB | API |
| 11 | A: Home page renders with "New Project" button | Browser |
| 12 | A: Language switcher present | Browser |
| 13 | A: German i18n applied (DE strings visible) | Browser |
| 14 | A: Editor 3D canvas mounts (via Home → Open) | Browser |
| 15 | A: Connections window opens (identity/peer content visible) | Browser |
| 16 | A: /docs/connections help page renders | Browser |
| 17 | B: Home page renders | Browser |
| 18 | B: Editor 3D canvas mounts | Browser |
| 19 | B: Connections window shows connected peer | Browser |
| 20 | B: Synced scene "Smoke Scene A" visible in editor | Browser |
| 21 | No unexpected console errors (A or B) | Browser |

---

## API Test Results

### Static analysis

| Check | Result |
|-------|--------|
| `pnpm lint` (backend + shared + rendezvous) | ✅ PASS — 0 type errors |
| `tsc --noEmit` (frontend) | ✅ PASS — 0 type errors |

### Two-peer mesh startup

| Server | Result |
|--------|--------|
| Rendezvous (`PORT=8787`) | ✅ started |
| Backend A (`PORT=3001`, `MULTIPLAYER_DISPLAY_NAME=ServerA`, `VSPARK_DB_PATH=/tmp/smoketest/a.db`) | ✅ started, migrations applied |
| Backend B (`PORT=3002`, `MULTIPLAYER_DISPLAY_NAME=ServerB`, `VSPARK_DB_PATH=/tmp/smoketest/b.db`) | ✅ started, migrations applied |
| Frontend A (`http://localhost:5173` → :3001) | ✅ started |
| Frontend B (`http://localhost:5174` → :3002) | ✅ started |

### Mesh + pairing

**Both backends on mesh:**
```
Backend A: enabled=true, status="ready", peerId="8D3sJ5eDPv-zIDdsZiAvwy75vvcXB1uwio9StLNrnBU"
Backend B: enabled=true, status="ready", peerId="356C3jHFhpRKg8N2O-z9vE9v3eWoX3ACMJhCNDFXtJo"
```

**Pairing flow:** ✅
```
POST /api/connections/pair/create (A) → code: "GC9PVP3A"
POST /api/connections/pair/join (B)  → ok, returned A's peerId + publicKey + displayName
POST /api/connections/peers/B/connect (A) → ok
POST /api/connections/peers/A/accept (B) → ok
```

**WebRTC connection established in <1s:** ✅
```json
{
  "peerId": "356C3jHF...",
  "displayName": "ServerB",
  "sessionGranted": true,
  "connected": true
}
```

### Phase 6: Collab scene share + mount

**Share A→B:** ✅
```
POST /api/connections/scenes/eba231ea.../share-collab  {granteePeerId: B}
→ { sceneId: "eba231ea...", granteePeerId: "356C3jHF..." }
```

**Mount on B:** ✅
```
POST /api/connections/collab/mount  {ownerPeerId: A, sceneId, projectId: B}
→ { ok: true }
After mount: GET :3002/api/projects/{pidB}/scenes → "Smoke Scene A" with Camera, Key Light, Fill Light
```

### Write tier (Phase 6)

```
Before: Camera at x=0, y=1.3, z=2  (A's DB)
B: PUT /api/scene-nodes/98afff5d.../  {transform: {x:9, y:5, z:3}}  → { ok: true }
After:  Camera at x=9, y=5, z=3  (A's DB — write propagated correctly)
```
✅ Write tier confirmed.

---

## Browser Test Results (Playwright — two-peer)

| # | Check | Result |
|---|-------|--------|
| 1 | A: Home page renders | ✅ PASS |
| 2 | A: "New Project" button present | ✅ PASS |
| 3 | A: Language switcher present | ✅ PASS |
| 4 | A: German i18n applied | ✅ PASS — DE strings visible |
| 5 | A: Editor 3D canvas mounts | ✅ PASS |
| 6 | A: Connections window opens | ✅ PASS — panel content visible |
| 7 | A: /docs/connections page renders | ✅ PASS — 299 chars |
| 8 | B: Home page renders | ✅ PASS |
| 9 | B: Editor 3D canvas mounts | ✅ PASS |
| 10 | B: Connections window shows peer | ✅ PASS — peer visible |
| 11 | B: Synced scene "Smoke Scene A" visible | ✅ PASS |
| 12 | A: No unexpected console errors | ✅ PASS |
| 13 | B: No unexpected console errors | ✅ PASS |

**Note:** The `SafeEnvironment`/`EnvironmentCube` HDRI fetch failure is known-benign (drei's `<Environment preset="city">` can't fetch in the offline sandbox; error-boundary catches it). Filtered from console error checks per project.md.

---

## Screenshots

| # | Screenshot | Description |
|---|------------|-------------|
| 1 | [A-01-home](shots/01-A-01-home.png) | Home page — project list, language switcher |
| 2 | [A-02-german-i18n](shots/02-A-02-german-i18n.png) | German language applied |
| 3 | [A-03-editor](shots/03-A-03-editor.png) | Editor A — 3D viewport loaded |
| 4 | [A-04-connections-window](shots/04-A-04-connections-window.png) | Connections window open (identity panel) |
| 5 | [A-05-docs-connections](shots/05-A-05-docs-connections.png) | /docs/connections help page |
| 6 | [B-06-home](shots/06-B-06-home.png) | Home page — backend B |
| 7 | [B-07-editor](shots/07-B-07-editor.png) | Editor B — canvas loaded |
| 8 | [B-08-connections-peer](shots/08-B-08-connections-peer.png) | B Connections window showing connected peer (ServerA) |
| 9 | [B-09-scene-final](shots/09-B-09-scene-final.png) | B editor with "Smoke Scene A" synced from A |

---

## Notes

- Migrations 027–031 all applied cleanly on fresh databases (both A and B backends).
- The triggering commit (`e1e5284`) is a merge-only commit bringing two prior smoketest report branches together — no application code was changed. This run re-validates the full Phase 5+6 multiplayer feature set.
- Frontend B requires the Vite config to include the `@vspark/shared/*` alias map (same as the committed `vite.config.ts`); the scratch config used here replicates those aliases.
