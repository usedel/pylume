// 存储面板（docs/disk-space-plan.md P1/P2 前端）：
// - 占用可视化（数据根子目录 + trace 逐项 + uv 官方目录）
// - 可再生内容清理（traces / WebView 缓存 / 轮转日志 / uv 缓存）
// - 数据根迁移到其他盘（复制 + setx + 重启生效）
// - 首启数据落位提示（onboarding，只弹一次）

import { invoke } from "@tauri-apps/api/core";
import { $, $btn } from "./state";
import { hideEl, showEl } from "./anim";
import { trapFocus } from "./focusTrap";
import { openAlert, openConfirm } from "./dialog";
import { toastFail } from "./toast";
import { setBusy, errMsg } from "./util"; // CR-27：按钮忙碌态收敛到 util
import { t } from "./i18n"; // 第六批 i18n：存储域动态文案走语言包
import { localizeBackendError } from "./i18n/backendError";

// ---------- 类型（对应 storage_cmds.rs 的 serde 结构） ----------

interface StorageEntry {
  key: string;
  label: string;
  path: string;
  size_bytes: number;
  renewable: string; // "yes" | "partial" | "no"
}
interface TraceEntry {
  hash: string;
  path: string;
  size_bytes: number;
}
interface UvEntry {
  label: string;
  path: string;
  size_bytes: number;
}
interface StorageUsage {
  data_root: string;
  entries: StorageEntry[];
  traces: TraceEntry[];
  uv: UvEntry[];
}
interface FirstRunStatus {
  should_prompt: boolean;
  data_root: string;
  pointer_set: boolean;
  migration_pending: boolean;
}
interface MigrateResult {
  old_root: string;
  new_root: string;
  skipped: string[];
}

// ---------- 域内 DOM ----------

const usageEl = $("storage-usage");
const rootPathEl = $("storage-root-path") as HTMLElement;
const migratePathEl = $("storage-migrate-path") as HTMLInputElement;
const onboardingModalEl = $("storage-onboarding-modal");
/** UI-05：首启落位提示模态的焦点陷阱解除句柄 */
let releaseOnboardingFocus: (() => void) | null = null;

/** 关闭首启落位提示（解除焦点陷阱 + 隐藏），供两个按钮的收尾路径共用 */
function closeOnboarding(): void {
  releaseOnboardingFocus?.();
  releaseOnboardingFocus = null;
  hideEl(onboardingModalEl);
}

// ---------- 按钮忙碌态（CR-27：已收敛到 util.ts 的 setBusy，本域直接 import 使用） ----------

// ---------- 渲染 ----------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function renewableBadge(r: string): HTMLElement {
  const span = document.createElement("span");
  if (r === "yes") {
    span.className = "storage-badge storage-badge-ok";
    span.textContent = t("storage.tag.renewable");
  } else if (r === "partial") {
    span.className = "storage-badge storage-badge-part";
    span.textContent = t("storage.tag.partiallyRenewable");
  } else {
    span.className = "storage-badge";
    span.textContent = t("storage.tag.nonDeletable");
  }
  return span;
}

function sizeText(n: number): HTMLElement {
  const span = document.createElement("span");
  span.className = "storage-size";
  span.textContent = formatBytes(n);
  return span;
}

/** 构造一行 storage-row（CR-04：全 DOM API + textContent，路径/错误串不再经 innerHTML 插值） */
function storageRow(cls: string, title: string, ...children: Node[]): HTMLDivElement {
  const row = document.createElement("div");
  row.className = cls;
  row.title = title; // 属性赋值：含 " < > & 的路径不会逃逸出属性边界
  row.append(...children);
  return row;
}

function labelSpan(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "storage-label";
  span.textContent = text;
  return span;
}

function renderUsage(u: StorageUsage): void {
  rootPathEl.textContent = u.data_root;
  rootPathEl.title = u.data_root;
  usageEl.textContent = "";
  for (const e of u.entries) {
    usageEl.appendChild(
      storageRow("storage-row", e.path, labelSpan(e.label), sizeText(e.size_bytes), renewableBadge(e.renewable)),
    );
    if (e.key === "traces" && u.traces.length > 0) {
      for (const trace of u.traces) {
        const del = document.createElement("button");
        del.className = "btn btn--sm btn--danger-outline"; // UI-08：迁移到通用按钮体系
        del.dataset.trace = trace.hash;
        del.textContent = t("storage.action.delete");
        usageEl.appendChild(
          storageRow("storage-row storage-row-sub", trace.path, labelSpan(trace.hash), sizeText(trace.size_bytes), del),
        );
      }
      const allDel = document.createElement("button");
      allDel.className = "btn btn--sm btn--danger-outline";
      allDel.dataset.trace = "__all__";
      allDel.textContent = t("storage.action.cleanAll");
      usageEl.appendChild(
        storageRow("storage-row storage-row-sub", "", labelSpan(t("storage.trace.allLabel")), allDel),
      );
    }
  }
  if (u.uv.length > 0) {
    const sep = document.createElement("div");
    sep.className = "storage-sep";
    sep.textContent = t("storage.uv.note");
    usageEl.appendChild(sep);
    for (const v of u.uv) {
      usageEl.appendChild(
        storageRow("storage-row", v.path, labelSpan(v.label), sizeText(v.size_bytes)),
      );
    }
  }
}

export async function loadStorageUsage(): Promise<void> {
  // 递归扫目录（uv 缓存可达数万文件）需要时间，先给行内 loading 占位
  usageEl.textContent = "";
  const row = document.createElement("div");
  row.className = "storage-row";
  const loading = labelSpan(t("storage.state.measuring"));
  const icon = document.createElement("i");
  icon.className = "codicon codicon-loading codicon-modifier-spin";
  loading.prepend(icon);
  row.appendChild(loading);
  usageEl.appendChild(row);
  try {
    const u = await invoke<StorageUsage>("storage_usage");
    renderUsage(u);
  } catch (e) {
    usageEl.textContent = "";
    usageEl.appendChild(storageRow("storage-row", "", labelSpan(t("storage.usageFailed", { error: localizeBackendError(errMsg(String(e))) }))));
  }
}

// ---------- 清理动作 ----------

async function cleanTraces(hash: string, btn?: HTMLButtonElement): Promise<void> {
  const all = hash === "__all__";
  const ok = await openConfirm({
    title: all ? t("storage.trace.cleanAllTitle") : t("storage.trace.cleanOneTitle"),
    message: all
      ? t("storage.trace.cleanAllMsg")
      : t("storage.trace.cleanOneMsg"),
    kind: "danger",
    okLabel: all ? t("storage.action.cleanAll") : t("storage.action.delete"),
  });
  if (!ok) return;
  if (btn) setBusy(btn, true, t("storage.state.cleaning"));
  try {
    const freed = await invoke<number>("clean_traces", { hash: all ? null : hash });
    await openAlert({ message: t("storage.freed", { size: formatBytes(freed) }) });
  } catch (e) {
    await openAlert({ title: t("storage.cleanFailed"), message: String(e), kind: "danger" });
  } finally {
    if (btn) setBusy(btn, false);
  }
  void loadStorageUsage();
}

async function cleanWebview(btn: HTMLButtonElement): Promise<void> {
  const ok = await openConfirm({
    title: t("storage.webview.title"),
    message: t("storage.webview.msg"),
    kind: "danger",
  });
  if (!ok) return;
  setBusy(btn, true, t("storage.state.cleaning"));
  try {
    const freed = await invoke<number>("clean_webview_cache");
    await openAlert({ message: t("storage.freed", { size: formatBytes(freed) }) });
  } catch (e) {
    await openAlert({ title: t("storage.cleanFailed"), message: String(e), kind: "danger" });
  } finally {
    setBusy(btn, false);
  }
  void loadStorageUsage();
}

async function cleanLogs(btn: HTMLButtonElement): Promise<void> {
  setBusy(btn, true, t("storage.state.cleaning"));
  try {
    const freed = await invoke<number>("clean_log_rotation");
    await openAlert({ message: t("storage.freedKeepLogs", { size: formatBytes(freed) }) });
  } catch (e) {
    await openAlert({ title: t("storage.cleanFailed"), message: String(e), kind: "danger" });
  } finally {
    setBusy(btn, false);
  }
}

async function uvClean(deep: boolean, btn: HTMLButtonElement): Promise<void> {
  const ok = await openConfirm({
    title: deep ? t("storage.uv.deepTitle") : t("storage.uv.title"),
    message: deep
      ? t("storage.uv.deepMsg")
      : t("storage.uv.msg"),
    kind: "danger",
    okLabel: deep ? t("storage.action.deepClean") : t("storage.action.clean"),
  });
  if (!ok) return;
  setBusy(btn, true, deep ? t("storage.state.deepCleaning") : t("storage.state.cleaning"));
  try {
    const msg = await invoke<string>("uv_cache_clean", { deep });
    await openAlert({ message: msg || t("storage.done") });
  } catch (e) {
    await openAlert({ title: t("storage.cleanFailed"), message: String(e), kind: "danger" });
  } finally {
    setBusy(btn, false);
  }
  void loadStorageUsage();
}

// ---------- 迁移 ----------

async function migrate(btn: HTMLButtonElement): Promise<void> {
  const target = migratePathEl.value.trim();
  if (!target) {
    await openAlert({ title: t("storage.needTargetDir"), message: t("storage.exampleDir") });
    return;
  }
  const ok = await openConfirm({
    title: t("storage.migration.title"),
    message:
      t("storage.migration.copyTo", { target: target }) +
      t("storage.migration.restartNote"),
    okLabel: t("storage.migration.start"),
  });
  if (!ok) return;
  setBusy(btn, true, t("storage.state.migrating"));
  try {
    const r = await invoke<MigrateResult>("migrate_data_root", { target });
    setBusy(btn, false);
    // 确认语多段拼装（含 \n\n 不走 apply_ts 映射，避免语言包转义链失真），按段取词
    const skippedNote = r.skipped.length > 0 ? `\n\n${t("storage.migration.skippedNote", { count: r.skipped.length })}` : "";
    const go = await openConfirm({
      title: t("storage.migration.doneTitle"),
      message: `${t("storage.migration.done", { root: r.new_root, note: skippedNote })}\n\n${t("storage.migration.oldDir", { root: r.old_root })}\n\n${t("storage.migration.askRestart")}`,
      okLabel: t("storage.migration.restartNow"),
    });
    if (go) await invoke("restart_app");
  } catch (e) {
    await openAlert({ title: t("storage.migration.failed"), message: String(e), kind: "danger" });
  } finally {
    setBusy(btn, false);
  }
}

// ---------- 首启落位提示（P2-a） ----------

/** 首启检测：shouldPrompt 时弹一次落位提示；迁移中断时给恢复提示。 */
export async function checkFirstRunStorage(): Promise<void> {
  try {
    const st = await invoke<FirstRunStatus>("first_run_status");
    if (st.migration_pending) {
      await openAlert({
        title: t("storage.migration.incompleteTitle"),
        message: t("storage.migration.incompleteMsg", { root: st.data_root }),
      });
    }
    if (!st.should_prompt) return;
    showEl(onboardingModalEl);
    releaseOnboardingFocus?.();
    releaseOnboardingFocus = trapFocus(onboardingModalEl);
  } catch (e) {
    console.warn("首启落位检测失败", e);
  }
}

function wireOnboarding(): void {
  $btn("storage-ob-default").addEventListener("click", () => {
    invoke("ack_first_run")
      .catch((e) => toastFail(t("storage.firstRun.saveFail"), e))
      .finally(() => closeOnboarding());
  });
  $btn("storage-ob-custom").addEventListener("click", async () => {
    try {
      const dir = await invoke<string | null>("pick_folder");
      if (!dir) return; // 取消选择 → 弹窗保持，用户可再选或用默认
      await invoke("set_data_root", { path: dir });
      closeOnboarding();
      const go = await openConfirm({
        title: t("storage.firstRun.setTitle"),
        message: t("storage.firstRun.setMsg", { dir: dir }),
        okLabel: t("storage.migration.restartNow"),
      });
      if (go) await invoke("restart_app");
    } catch (e) {
      await openAlert({ title: t("storage.setFailed"), message: String(e), kind: "danger" });
    }
  });
}

// ---------- 接线 ----------

export function wireStoragePanel(): void {
  wireOnboarding();
  $btn("storage-refresh").addEventListener("click", (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    setBusy(btn, true, t("storage.state.measuring"));
    void loadStorageUsage().finally(() => setBusy(btn, false));
  });
  $btn("storage-open").addEventListener("click", () => {
    invoke("open_data_dir").catch((e) => toastFail(t("storage.openDataDir"), e));
  });
  usageEl.addEventListener("click", (e) => {
    // UI-08：改按 [data-trace] 命中——按钮外观已由 .btn 体系承载，不再拿样式类名当事件钩子
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-trace]");
    if (btn?.dataset.trace) void cleanTraces(btn.dataset.trace, btn);
  });
  $btn("storage-clean-webview").addEventListener("click", (e) =>
    void cleanWebview(e.currentTarget as HTMLButtonElement));
  $btn("storage-clean-logs").addEventListener("click", (e) =>
    void cleanLogs(e.currentTarget as HTMLButtonElement));
  $btn("storage-uv-prune").addEventListener("click", (e) =>
    void uvClean(false, e.currentTarget as HTMLButtonElement));
  $btn("storage-uv-clean").addEventListener("click", (e) =>
    void uvClean(true, e.currentTarget as HTMLButtonElement));
  $btn("storage-migrate-browse").addEventListener("click", async () => {
    try {
      const dir = await invoke<string | null>("pick_folder");
      if (dir) migratePathEl.value = dir;
    } catch (e) {
      toastFail(t("storage.pickDirFail"), e);
    }
  });
  $btn("storage-migrate").addEventListener("click", (e) =>
    void migrate(e.currentTarget as HTMLButtonElement));
}
