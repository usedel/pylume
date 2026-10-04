@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Pylume release packaging script (NSIS installer only).
rem Runs the full pipeline: clean -> build pylume-intel (release) -> npm install -> tauri build.
rem Usage (from repo root or anywhere):
rem   build-release.bat                 full build
rem   build-release.bat -SkipNpmInstall skip npm install
rem
rem Requires: Rust toolchain (cargo) and Node.js (npm), see ci/versions.toml for pinned versions.
rem Note: uv / pyrefly are managed at user runtime, not needed for packaging.
rem       pylume-intel and probe/src are bundled via shell/src-tauri/tauri.conf.json
rem       bundle.resources; this script builds the release intel binary first.
rem       Bundle target is fixed to NSIS (tauri.conf.json bundle.targets = "nsis").

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "SKIP_NPM=0"
if /I "%~1"=="-SkipNpmInstall" set "SKIP_NPM=1"

goto :main

rem ========== helpers (must stay below main logic) ==========

:Step
    echo.
    echo ==^> %~1
    exit /b 0

:Fail
    echo ERROR: %~1
    exit /b 1

:main

rem ---------- 0. prerequisites ----------
call :Step "Prerequisites (cargo / npm)"

where cargo >nul 2>nul
if errorlevel 1 (
    call :Fail "cargo not found. Install Rust toolchain (pinned 1.96.0 in ci/versions.toml)"
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    call :Fail "npm not found. Install Node.js (pinned 22.12.0 in ci/versions.toml)"
    exit /b 1
)

rem ---------- 1. clean python caches ----------
call :Step "Clean __pycache__ under probe/"

set "PYCACHE_COUNT=0"
for /f "delims=" %%d in ('dir /s /b /ad "%ROOT%\probe\__pycache__" 2^>nul') do (
    rmdir /s /q "%%d"
    set /a PYCACHE_COUNT+=1
)

if %PYCACHE_COUNT% GTR 0 (
    echo Removed %PYCACHE_COUNT% __pycache__ dir^(s^)
) else (
    echo No __pycache__ dirs, skip
)

rem ---------- 2. build pylume-intel (release) ----------
call :Step "Build pylume-intel (release, lto, may take a while)"

pushd "%ROOT%\intel"
cargo build -p pylume-intel --release
set "CARGO_RC=%ERRORLEVEL%"
popd
if not %CARGO_RC%==0 (
    call :Fail "pylume-intel release build failed"
    exit /b 1
)

rem ---------- 2.5 fetch vendored debugpy (sha256-pinned, idempotent) ----------
call :Step "Fetch vendored debugpy (cp310-cp314 win_amd64, pinned in ci/versions.toml)"

powershell -ExecutionPolicy Bypass -File "%ROOT%\tools\fetch-debugpy.ps1"
if errorlevel 1 (
    call :Fail "fetch-debugpy.ps1 failed"
    exit /b 1
)

rem ---------- 3. npm install (optional) ----------
if %SKIP_NPM%==1 (
    echo.
    echo ==^> skip npm install ^(-SkipNpmInstall^)
) else (
    call :Step "npm install (frontend deps)"

    pushd "%ROOT%\shell"
    call npm install
    set "NPM_RC=!ERRORLEVEL!"
    popd
    if not !NPM_RC!==0 (
        call :Fail "npm install failed"
        exit /b 1
    )
)

rem ---------- 4. tauri build (NSIS only) ----------
call :Step "Tauri build (nsis)"

pushd "%ROOT%\shell"
call npm run tauri -- build
set "TAURI_RC=%ERRORLEVEL%"
popd
if not %TAURI_RC%==0 (
    call :Fail "Tauri build failed"
    exit /b 1
)

rem ---------- 5. done ----------
call :Step "Done"
echo Bundle output: shell/src-tauri/target/release/bundle/nsis/
echo pylume-intel.exe and probe/src are bundled as resources (see shell/src-tauri/tauri.conf.json bundle.resources)

exit /b 0
