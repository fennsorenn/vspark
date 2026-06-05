# Self-update / release flow

In-app self-update: the running server checks GitHub Releases, downloads a platform
zip, and relaunches itself into the new version **in the same console**. The flow spans
three places that must agree on a contract:

- **Backend** — `packages/backend/src/routes/update.ts` (check / download / apply routes)
- **Frontend** — `packages/frontend/src/components/editor/UpdateDialog.tsx` (channel
  selector, release notes, progress bar, Update Now)
- **Release packaging** — `.github/workflows/release.yml` generates the bundled
  supervising start script (`start.sh` / `start.bat`) and the release zip.

Shared types: `UpdateStatus`, `UpdateChannel`, `AppConfig` in
`packages/shared/src/types.ts`. Channel preference is persisted via `routes/config.ts`
(`config.json`); see also the `TopBar` update badge and `editorStore` update slice.

## The start-script ↔ server contract

This is the non-obvious part. Two independent processes (the OS shell script and the
Node server) coordinate through three hard-coded conventions. **Change one, change all.**

1. **Sentinel exit code 42.** `update.ts` defines `const UPDATE_EXIT_CODE = 42`. The
   `/update/apply` route calls `process.exit(42)` (after a 500 ms delay so the HTTP
   response and the `server_update` WS broadcast flush). The start script supervises the
   server in a loop: on exit code 42 it applies the update and relaunches; any other exit
   code stops normally. The literal `42` is duplicated in the start scripts inside
   `release.yml` — there is no shared constant across the language boundary.

2. **Update zip path.** `downloadZipPath()` in `update.ts` returns
   `<parent-of-install-dir>/vspark-update.zip` — i.e. the parent directory that contains
   the `vspark/` install folder, *not* the OS temp dir. This is deliberate: the server
   writes the zip and the start script reads it, and a stable relative path lets them
   agree without either side guessing `TMPDIR` / `%TEMP%`. The start scripts compute the
   same path as `<script-dir>/../vspark-update.zip`.

3. **In-place unzip into the parent.** On exit 42 the script unzips over the install:
   - `start.sh`: `unzip -o "$ZIP" -d "$DIR/.." && rm -f "$ZIP"`, then `continue` the loop.
   - `start.bat`: `Expand-Archive -Force` into `%DIR%..`, `del` the zip, `goto loop`.

   The zip's top-level folder is the install dir name (`vspark/`), so extracting into the
   parent overwrites the install in place.

### Why a supervisor loop (key decision)

The previous design spawned a detached `updater.sh` / `updater.bat`, then
`process.exit(0)`. That relaunched the server in a *new* process/window and orphaned the
terminal the user originally launched from. The supervisor-loop design keeps everything
in the same console: the script owns the process lifecycle, the server just signals
"apply + relaunch" via exit 42. The standalone `updater.sh` / `updater.bat` scripts were
removed entirely (including from the `release.yml` packaging matrix).

## Check-for-updates

`checkForUpdates()` in `update.ts`:

- Reads `version.json` (written by `release.yml`: `{ version, channel }`) for the current
  version and channel. `release.yml` derives the channel from the tag: `-alpha` →
  `experimental`, `-beta` → `recent`, else `stable`.
- Fetches `GET /repos/fennsorenn/vspark/releases` (GitHub returns newest-first).
- `pickRelease(releases, channel)` selects the candidate:
  - **stable** — first non-prerelease tag matching `vX.Y.Z`.
  - **recent** — first `vX.Y.Z-beta.N` prerelease, else falls back to first stable.
  - **experimental** — `releases[0]` (newest of any kind).
- `compareSemver` decides if the candidate is newer (stable > pre-release at equal
  numbers). Sets `updateAvailable`, `latestVersion`, `releaseNotes`, and stashes the
  matching platform asset URL (`vspark-win-x64.zip` / `vspark-linux-x64.zip`,
  chosen from `process.platform`).

`initUpdateChecker(installDir, wsSync)` wires the install dir and WS broadcaster and kicks
off an initial check. `getInstallDir()` returns the exe dir if a `version.json` sits next
to it (packaged build), else `process.cwd()` (dev).

## Download

`POST /update/download` responds immediately (`{ started: true }`) and streams the asset
in the background to `downloadZipPath()`, following redirects (GitHub asset URLs redirect
to S3 via the shared `httpsGet` redirect-following helper).

Progress is tracked on `_status`: `downloadedBytes` updates per chunk, `totalBytes` comes
from `Content-Length` (may be `null`). Console logging is throttled to whole-percent steps
(or per-MB when total is unknown). On stream finish, `downloadReady = true`.

`UpdateStatus` carries `downloadedBytes` / `totalBytes` so the frontend can render
progress (both `null` when no download is in flight).

## Apply

`POST /update/apply` requires `downloadReady`. It broadcasts `server_update`
(`{ reloadOnReconnect: true }`) over WS, returns `{ ok: true }`, then after 500 ms exits
with code 42. The browser reloads on WS reconnect (handled by `useWsSync` /
`editorStore` `pendingReload`).

## Frontend (UpdateDialog)

- On open: `getUpdateStatus()` populates current version + channel.
- Channel change: `putConfig({ channel })` then re-checks status and updates the store's
  `updateAvailable` / `updateInfo`.
- Update Now: `startUpdateDownload()`, then **polls `/update-status` every 500 ms**. Each
  poll updates the progress bar from `downloadedBytes` / `totalBytes`; when
  `downloadReady` flips true it stops polling and calls `applyUpdate()`.
- Progress bar shows percent when `totalBytes` is known, otherwise an indeterminate
  (dimmed) look. The poll interval is cleared on unmount and on error.

## Extending / gotchas

- **Adding a field to `UpdateStatus`** — update the interface in `shared/src/types.ts`,
  set it on `_status` in `update.ts`, and read it in `UpdateDialog`.
- **Changing the sentinel code or zip path** — you must edit *both* `update.ts` and the
  inline start scripts in `release.yml`. There is no shared source of truth across the
  Node/shell boundary; the coupling is only documented (here and in code comments).
- **start.bat exit-code check** — `if errorlevel 42 if not errorlevel 43` is the cmd.exe
  idiom for "exit code == 42" (errorlevel is "≥ N").
