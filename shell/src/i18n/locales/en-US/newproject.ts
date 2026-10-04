// English (US) 语言包「newproject 域」：key 与 zh-CN/newproject.ts 一一对应，Record<NewprojectKey, string> 在编译期强校验漏译。
import type { NewprojectKey } from "../zh-CN/newproject";

export const newproject: Record<NewprojectKey, string> = {
  // ---- newproject ----
  "newproject.tabLocal": "Local Creation",
  "newproject.createFailed": "Creation failed: {error}",
  "newproject.creating": "Creating…",
  "newproject.creatingEnv": "Creating environment…",
  "newproject.depsExitFailed": "Dependency installation failed (exit {code}); see the output above for details. Declarations were written to pyproject.toml — run the project later and uv syncs automatically",
  "newproject.depsExitNote": "exit {code} (declarations written; not blocking)",
  "newproject.depsFailedNonBlocking": "Dependency installation failed (declarations written to pyproject.toml; not blocking): {error} — run the project later and uv syncs automatically",
  "newproject.envSetupFailed": "Environment setup failed: {error}",
  "newproject.failDeps": "Dependency installation",
  "newproject.failEnvSetup": "Environment setup",
  "newproject.gitInitFailed": "git init failed (project was created): {message}",
  "newproject.gotIt": "Got it",
  "newproject.installingDeps": "Installing dependencies…",
  "newproject.loadingVersions": "Loading version list…",
  "newproject.needNameAndPath": "Enter a project name and location",
  "newproject.noInterpFallback": "Until then, running falls back to uv run (the first run may download Python from the network).",
  "newproject.noInterpHead": "Pick one of the following:",
  "newproject.noInterpStep1": "1) Install a uv-managed Python (from the environment panel or a terminal: uv python install 3.13)",
  "newproject.noInterpStep2": "2) Point to an installed python executable manually (environment panel → interpreter)",
  "newproject.noInterpTitle": "No Python interpreter detected",
  "newproject.previewPath": "Will be created at: {target}{suffix}",
  "newproject.previewSuffix": " ({label} entry main.py + {deps} dependencies)",
  "newproject.systemInterpreter": "Using system interpreter: {interp}",
  // ---- newproject.type ----
  "newproject.type.fastapi": "FastAPI service",
  "newproject.type.script": "Python script",
  // ---- newproject.versions ----
  "newproject.versions.default": "(default version)",
  "newproject.versions.needDownload": "{version} (download required)",
};
