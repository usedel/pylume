// English (US) 语言包「storage 域」：key 与 zh-CN/storage.ts 一一对应，Record<StorageKey, string> 在编译期强校验漏译。
import type { StorageKey } from "../zh-CN/storage";

export const storage: Record<StorageKey, string> = {
  // ---- storage.action ----
  "storage.action.clean": "Clean",
  "storage.action.cleanAll": "Clean all",
  "storage.action.deepClean": "Deep clean",
  "storage.action.delete": "Delete",
  // ---- storage ----
  "storage.cleanFailed": "Cleaning failed",
  "storage.done": "Done.",
  "storage.exampleDir": "e.g. D:\\pylume-data",
  // ---- storage.firstRun ----
  "storage.firstRun.saveFail": "Save first-run settings",
  "storage.firstRun.setMsg": "The data root now points to {dir}. Takes effect after restart (nothing stored yet on first run; restarting loses nothing). Restart now?",
  "storage.firstRun.setTitle": "Data location set",
  // ---- storage ----
  "storage.freed": "Freed {size}.",
  "storage.freedKeepLogs": "Freed {size} (the current log file was kept).",
  // ---- storage.migration ----
  "storage.migration.askRestart": "Restart the app now to make the new location effective?",
  "storage.migration.copyTo": "The current data root will be copied in full to {target}, and the data-root pointer will be moved there.",
  "storage.migration.done": "Data copied to {root}.{note}",
  "storage.migration.doneTitle": "Migration finished",
  "storage.migration.failed": "Migration failed",
  "storage.migration.incompleteMsg": "The data root {root} has an interrupted-migration marker. Re-run the migration in \"Settings → Storage\", or delete the .migration-in-progress marker in that directory to ignore it.",
  "storage.migration.incompleteTitle": "Unfinished migration detected",
  "storage.migration.oldDir": "The old directory {root} is not deleted automatically; remove it manually after restarting and verifying everything works.",
  "storage.migration.restartNote": "Takes effect after restart; do not close the app during the migration. Continue?",
  "storage.migration.restartNow": "Restart now",
  "storage.migration.skippedNote.one": "1 locked file could not be copied (see .migration-skipped.txt in the new directory).",
  "storage.migration.skippedNote.other": "{count} locked files could not be copied (see .migration-skipped.txt in the new directory).",
  "storage.migration.start": "Start migration",
  "storage.migration.title": "Migrate data",
  // ---- storage ----
  "storage.needTargetDir": "Enter the target directory",
  "storage.openDataDir": "Open data directory",
  "storage.pickDirFail": "Select directory",
  "storage.setFailed": "Setup failed",
  // ---- storage.state ----
  "storage.state.cleaning": "Cleaning…",
  "storage.state.deepCleaning": "Deep cleaning…",
  "storage.state.measuring": "Measuring…",
  "storage.state.migrating": "Migrating…",
  // ---- storage.tag ----
  "storage.tag.nonDeletable": "non-deletable",
  "storage.tag.partiallyRenewable": "partially renewable",
  "storage.tag.renewable": "renewable",
  // ---- storage.trace ----
  "storage.trace.allLabel": "(all traces)",
  "storage.trace.cleanAllMsg": "This deletes the runtime type-sampling stores of all projects (re-running a script samples again). Continue?",
  "storage.trace.cleanAllTitle": "Clean all trace stores",
  "storage.trace.cleanOneMsg": "This deletes this project's trace store (re-running the script samples again). Continue?",
  "storage.trace.cleanOneTitle": "Delete this trace store",
  // ---- storage ----
  "storage.usageFailed": "Measuring usage failed: {error}",
  // ---- storage.uv ----
  "storage.uv.deepMsg": "This deletes the entire uv cache (installed environments are unaffected; reinstalling packages will download them again). Continue?",
  "storage.uv.deepTitle": "Deep-clean uv cache",
  "storage.uv.msg": "This removes invalid/dangling entries from the uv cache. Continue?",
  "storage.uv.note": "uv (owned by the user; Pylume does not manage it)",
  "storage.uv.title": "Clean uv cache",
  // ---- storage.webview ----
  "storage.webview.msg": "This deletes the WebView2 cache subdirectories (logins and other files are kept). Continue?",
  "storage.webview.title": "Clean WebView cache",
};
