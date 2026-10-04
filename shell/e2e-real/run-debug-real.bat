@echo off
rem Real-app (tauri dev + WebView2 CDP) acceptance runner for the debug feature.
rem Usage: shell\e2e-real\run-debug-real.bat
rem Env:   OC_CDP_PORT (default 9223) / OC_CDP_TIMEOUT sec (default 600) / OC_KEEP_APP=1 to keep app alive
cd /d %~dp0..
node e2e-real\debug-real.cjs %*
