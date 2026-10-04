// English (US) 语言包「ide 域」：key 与 zh-CN/ide.ts 一一对应，Record<IdeKey, string> 在编译期强校验漏译。
import type { IdeKey } from "../zh-CN/ide";

export const ide: Record<IdeKey, string> = {
  // ---- ide.bg ----
  "ide.bg.failLoad": "Load breakpoints",
  "ide.bg.failSave": "Save breakpoints",
  "ide.bg.tipBreakpoint": "Breakpoint",
  "ide.bg.tipCondition": "Condition: {condition}",
  "ide.bg.tipHit": "Hit count: {hit}",
  "ide.bg.tipLog": "Log (no pause): {message}",
  // ---- ide.cd ----
  "ide.cd.actionLabel": "Compare with clipboard",
  "ide.cd.clipboardEmpty": "Clipboard is empty or unreadable",
  "ide.cd.currentFile": "Current file",
  "ide.cd.readFailed": "Reading the file failed: {error}",
  "ide.cd.selection": "Selection",
  "ide.cd.title": "{label} ↔ clipboard",
  // ---- ide ----
  "ide.completionKeyword": "keyword",
  "ide.debugValue": "Debug value",
  // ---- ide.dsl ----
  "ide.dsl.hint": "Tip: right-click → \"Open in regex tester\", or press Ctrl+Alt+R to test regexes",
  "ide.dsl.needPyFormat": "The format-string tool needs an open Python file",
  "ide.dsl.needPyRegex": "The regex tester needs an open Python file",
  "ide.dsl.noFormat": "No format-string literal detected in the current file",
  "ide.dsl.noRegex": "No re regex literal detected in the current file",
  // ---- ide.engine ----
  "ide.engine.indexing": "{name} · indexing…",
  "ide.engine.indexingTitle": "The static engine is indexing/querying in the background; reference and rename results may be incomplete",
  // ---- ide.fu ----
  "ide.fu.actionLabel": "Find references",
  "ide.fu.chipAll": "All",
  "ide.fu.emptyTitle": "No references",
  "ide.fu.engineNotReady": "The static engine is not ready (it may still be starting); results may be incomplete — try again later",
  "ide.fu.failed": "Find references failed: {error}",
  "ide.fu.indexIncomplete": "The workspace index may not be finished yet; results may be incomplete — query again later",
  "ide.fu.kindCall": "call",
  "ide.fu.kindDefinition": "definition",
  "ide.fu.kindImport": "import",
  "ide.fu.kindReference": "reference",
  "ide.fu.noRefs": "No references found for the symbol at the cursor",
  "ide.fu.noSymbol": "Position the cursor on a symbol to find references first",
  "ide.fu.renameBtn": "Rename",
  "ide.fu.renameTip": "Rename this symbol and all of its references (Shift+F6)",
  "ide.fu.unstableRetry": "The index is still unstable; results may be incomplete — query again later",
  // ---- ide.fw ----
  "ide.fw.hint": "Detected a {framework} project ({file}).{miss}A run configuration can be generated in one click:",
  "ide.fw.missing": "{names} not installed yet (run uv add {first}).",
  // ---- ide ----
  "ide.importAliasDetail": "import alias",
  "ide.installPkg": "Install package \"{pkg}\"",
  "ide.installPkgShort": "Install {pkg}",
  // ---- ide.json ----
  "ide.json.formatTitle": "Format JSON literal",
  "ide.json.minifyTitle": "Minify JSON literal",
  "ide.json.needPy": "The JSON tools need an open Python file",
  "ide.json.notInLiteral": "The cursor is not inside a json.loads literal",
  "ide.json.openJsonpath": "Open in the JSONPath extractor",
  "ide.json.parseFailed": "JSON parsing failed: {error}",
  // ---- ide.kb ----
  "ide.kb.columnSelectOff": "Column selection off",
  "ide.kb.columnSelectOn": "Column selection on: drag will select a rectangle (press again to exit)",
  "ide.kb.conflict": "Keybinding \"{label}\" conflicts with \"{dup}\" ({norm})",
  "ide.kb.invalidFormat": "Keybinding \"{label}\" has invalid format: {raw}",
  // ---- ide.lens ----
  "ide.lens.argsCount.one": "⚙ {count} parameters",
  "ide.lens.argsCount.other": "⚙ {count} parameters",
  "ide.lens.openFormat": "Open in the format-string tool",
  "ide.lens.openRegex": "Open in the regex tester",
  "ide.lens.testBoth": "🧪 Test (regex / format string)",
  "ide.lens.testFormat": "🧪 Test format string",
  "ide.lens.testRegex": "🧪 Test regex",
  // ---- ide.lsp ----
  "ide.lsp.intelClosed": "Runtime intelligence closed",
  "ide.lsp.notReady": "LSP engine not ready",
  "ide.lsp.processExited": "LSP process exited (code={code})",
  "ide.lsp.requestTimeout": "LSP request timed out ({sec}s): {method}",
  "ide.lsp.stopped": "LSP stopped",
  // ---- ide ----
  "ide.menuLoadFailed": "(Failed to load)",
  // ---- ide.mv ----
  "ide.mv.error": "error",
  "ide.mv.none": "No diagnostics to jump to (error / warning)",
  "ide.mv.otherErrors.one": "{count} type/reference errors",
  "ide.mv.otherErrors.other": "{count} type/reference errors",
  "ide.mv.progress": "{idx}/{total}{wrapped} {kind}: {brief}",
  "ide.mv.savedStatus": "{file}: {parts} (saved)",
  "ide.mv.syntaxErrors.one": "{count} syntax errors",
  "ide.mv.syntaxErrors.other": "{count} syntax errors",
  "ide.mv.warning": "warning",
  "ide.mv.wrapped": " (wrapped)",
  // ---- ide.res ----
  "ide.res.summary.one": "Total {mb} MB · {count} child processes",
  "ide.res.summary.other": "Total {mb} MB · {count} child processes",
  // ---- ide.ruff ----
  "ide.ruff.actionLabel": "Ignore this rule (append # noqa at line end)",
  "ide.ruff.added": "Added # noqa: {code}",
  "ide.ruff.alreadyIgnored": "This line is already ignored: {code}",
  "ide.ruff.noCode": "This diagnostic has no rule code; it cannot be ignored with # noqa",
  "ide.ruff.noDiagnostic": "No ruff diagnostic at the cursor",
  // ---- ide.term ----
  "ide.term.closeRunTip": "Close the run terminal (stop it first)",
  "ide.term.closeTip": "Close terminal",
  "ide.term.label": "Terminal {n}",
  "ide.term.newTip": "New terminal",
  "ide.term.none": "No terminals yet",
  "ide.term.noneHint": "Click \"＋\" above to create one, or right-click a file in the explorer → \"Open in Terminal\"",
  "ide.term.project": "Project",
  "ide.term.projectN": "Project {n}",
  "ide.term.runLabel": "Run · {name}",
  "ide.term.shellAuto": "Auto (PowerShell first, falls back to cmd)",
  "ide.term.shellCmd": "Command Prompt (cmd)",
  "ide.term.stopTip": "Stop {label}",
  // ---- ide.traceback ----
  "ide.traceback.openAction": "Open traceback file",
  "ide.traceback.openFailed": "Cannot open: {path}",
};
