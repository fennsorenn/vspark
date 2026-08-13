@echo off
setlocal enabledelayedexpansion

rem ---------------------------------------------------------------------------
rem  vspark - unlock database
rem
rem  Clears the stale lock debris that makes vspark fail to start with
rem  "database is locked". This happens when vspark was killed or crashed
rem  instead of shutting down cleanly, leaving behind:
rem
rem    vspark.db.lock\     lock directory (mkdir = acquire, rmdir = release)
rem    vspark.db-journal   rollback journal
rem    vspark.db.pid       owner PID file
rem
rem  Your actual data (vspark.db) is NEVER touched by this script.
rem
rem  USAGE: put this file in the vspark install folder (the one containing
rem         bundle.cjs) and double-click it. Make sure vspark is closed first.
rem ---------------------------------------------------------------------------

echo.
echo  === vspark database unlock ===
echo.

rem --- Locate vspark.db: next to this script, or one level down/up ------------
set "DB="
for %%P in (
  "%~dp0vspark.db"
  "%~dp0dist\vspark.db"
  "%~dp0..\vspark.db"
  "%~dp0packages\backend\src\vspark.db"
) do (
  if not defined DB if exist "%%~fP" set "DB=%%~fP"
)

if not defined DB (
  echo  ERROR: could not find vspark.db
  echo.
  echo  Put this script in the vspark install folder - the folder that
  echo  contains bundle.cjs and vspark.db - then run it again.
  echo.
  pause
  exit /b 1
)

echo  Database: !DB!
echo.

rem --- Refuse to run while vspark is still up --------------------------------
rem  The lock debris is only safe to remove when nothing is holding the DB.
tasklist /fi "imagename eq node.exe" 2>nul | find /i "node.exe" >nul
if not errorlevel 1 (
  echo  WARNING: a node.exe process is still running.
  echo.
  echo  vspark may still be open. Close vspark completely, wait a few
  echo  seconds, then run this script again.
  echo.
  set /p "GOON=Clean up anyway? Only do this if vspark is definitely closed. [y/N] "
  if /i not "!GOON!"=="y" (
    echo.
    echo  Aborted - nothing was changed.
    echo.
    pause
    exit /b 1
  )
  echo.
)

set "CLEANED=0"

rem --- 1. lock directory -----------------------------------------------------
if exist "!DB!.lock\" (
  rd /s /q "!DB!.lock" 2>nul
  if exist "!DB!.lock\" (
    echo  [FAIL] could not remove !DB!.lock
    echo         Something still has the folder open.
  ) else (
    echo  [ OK ] removed stale lock directory
    set "CLEANED=1"
  )
) else (
  echo  [ -- ] no lock directory
)

rem --- 2. rollback journal ---------------------------------------------------
if exist "!DB!-journal" (
  del /f /q "!DB!-journal" 2>nul
  if exist "!DB!-journal" (
    echo  [FAIL] could not remove !DB!-journal
  ) else (
    echo  [ OK ] removed stale journal
    set "CLEANED=1"
  )
) else (
  echo  [ -- ] no journal file
)

rem --- 3. owner PID file -----------------------------------------------------
if exist "!DB!.pid" (
  del /f /q "!DB!.pid" 2>nul
  if exist "!DB!.pid" (
    echo  [FAIL] could not remove !DB!.pid
  ) else (
    echo  [ OK ] removed stale PID file
    set "CLEANED=1"
  )
) else (
  echo  [ -- ] no PID file
)

echo.
if "!CLEANED!"=="1" (
  echo  Done - stale lock removed. You can start vspark again.
) else (
  echo  Nothing to clean: no stale lock files were present.
  echo.
  echo  If vspark still reports "database is locked", another copy of
  echo  vspark is probably running. Check Task Manager for node.exe.
)
echo.
pause
endlocal
