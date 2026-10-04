// 本地历史（Local History，P1 · PyCharm Local History 对标）：**没有 Git 也能回退**。
//
// 目标用户画像（自用脚本 / 爬虫 / 小工具）里，大量文件压根不在版本库里——
// 误存、误删、改崩了想回到十分钟前，Git 帮不上忙。本模块提供兜底：
// 保存时后端自动快照（main.ts::saveActive 在写盘前调 history_snapshot），
// 这里负责「列表 + diff 预览 + 回滚」。
//
// 与 Git diff 的关系：diff 编辑器**另起一个实例**（#history-diff），不复用
// git.ts::ensureDiffEditor——两者生命周期不同（Git diff 常驻底部面板，本地历史是模态），
// 共用一个实例会互相顶掉模型。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { invoke } from "@tauri-apps/api/core";
import { hideEl, showEl } from "./anim";
import { openAlert, openConfirm } from "./dialog";
import { trapFocus } from "./focusTrap";
import { app, $ } from "./state";
import { basename, emptyState, languageOf, relativePath } from "./util";
import { toastFail } from "./toast";
import { onLocaleChange, t } from "./i18n"; // 第十一批 i18n：本地历史动态文案走语言包

/** 后端 history.rs 的 HistoryEntry 镜像 */
export interface HistoryEntry {
  id: string;
  ts: number;
  kind: string;
  size: number;
}

export interface LocalHistoryHandlers {
  /** 回滚后从磁盘重新加载文件（刷新编辑器 model） */
  reloadFile: (path: string) => Promise<void>;
}

let handlers: LocalHistoryHandlers | null = null;

export function setLocalHistoryHandlers(h: LocalHistoryHandlers): void {
  handlers = h;
}

// ---------- DOM 与状态 ----------

let modalEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let diffHostEl: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;

let diffEditor: MonacoApi.editor.IStandaloneDiffEditor | null = null;
let originalModel: MonacoApi.editor.ITextModel | null = null;
let modifiedModel: MonacoApi.editor.ITextModel | null = null;

let currentPath: string | null = null;
let entries: HistoryEntry[] = [];
let sel = 0;
/** 异步刷新令牌（照搬 search.ts：慢响应不得覆盖新结果） */
let loadToken = 0;

// i18n：标签表为模块级缓存，语言切换时重建（见 initLocalHistory 的订阅）
let KIND_LABEL: Record<string, string> = {
  save: t("workbench.history.tagSave"),
  manual: t("workbench.history.tagManual"),
  restore: t("workbench.history.tagRestore"),
};

/** 时间戳 → 可读文本（本地时区，补零对齐） */
export function formatTs(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return t("workbench.history.unknownTime");
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 初始化（init 时调用一次；容器 #history-modal 已在 index.html 声明） */
export function initLocalHistory(): void {
  const host = document.getElementById("history-modal");
  if (!host) return;
  modalEl = host;
  titleEl = document.getElementById("history-title");
  listEl = document.getElementById("history-list");
  diffHostEl = document.getElementById("history-diff");

  // 语言切换：重建标签缓存；面板打开中则重绘列表（未打开时下次打开自然用新语言）
  onLocaleChange(() => {
    KIND_LABEL = { save: t("workbench.history.tagSave"), manual: t("workbench.history.tagManual"), restore: t("workbench.history.tagRestore") };
    if (isLocalHistoryOpen()) renderList();
  });

  $("history-close").addEventListener("click", closeLocalHistory);
  $("history-refresh").addEventListener("click", () => void load());
  $("history-mark").addEventListener("click", () => void markCurrent());
  $("history-revert").addEventListener("click", () => void revertSelected());
  $("history-clear").addEventListener("click", () => void clearHistory());
  host.addEventListener("mousedown", (e) => {
    if (e.target === host) closeLocalHistory();
  });
  document.addEventListener("keydown", onModalKeydown);
}

/** Esc 关闭（仅在本模态打开时生效） */
function onModalKeydown(e: KeyboardEvent): void {
  if (!isLocalHistoryOpen()) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeLocalHistory();
  }
}

export function isLocalHistoryOpen(): boolean {
  return !!modalEl && !modalEl.classList.contains("hidden");
}

/** 打开本地历史；path 缺省为当前激活标签 */
export async function openLocalHistory(path?: string): Promise<void> {
  if (!modalEl) return;
  currentPath = path ?? app.activeTab?.path ?? null;
  if (!currentPath) {
    // 没有打开任何文件时静默返回会给「点了没反应」的错觉，明确说一句
    await openAlert({ title: t("workbench.history.title"), message: t("workbench.history.needFile") });
    return;
  }
  if (titleEl) {
    titleEl.textContent = app.workspaceRoot
      ? relativePath(app.workspaceRoot, currentPath)
      : basename(currentPath);
  }
  showEl(modalEl);
  releaseFocus?.();
  releaseFocus = trapFocus(modalEl);
  await load();
}

export function closeLocalHistory(): void {
  if (!modalEl) return;
  releaseFocus?.();
  releaseFocus = null;
  hideEl(modalEl);
}

// ---------- 数据 ----------

async function load(): Promise<void> {
  const token = ++loadToken;
  if (!app.workspaceRoot || !currentPath) {
    entries = [];
    renderList();
    return;
  }
  try {
    const list = await invoke<HistoryEntry[]>("history_list", {
      workspaceRoot: app.workspaceRoot,
      path: currentPath,
    });
    if (token !== loadToken) return;
    entries = list;
    sel = Math.min(sel, Math.max(0, entries.length - 1));
  } catch (e) {
    console.warn("[localHistory] 读取历史失败", e);
    if (token !== loadToken) return;
    entries = [];
  }
  renderList();
  await renderDiff();
}

/** 手动标记当前内容（可来自未保存的编辑器缓冲区） */
async function markCurrent(): Promise<void> {
  if (!app.workspaceRoot || !currentPath) return;
  const tab = app.tabs.find((t) => t.path === currentPath);
  try {
    await invoke("history_snapshot", {
      workspaceRoot: app.workspaceRoot,
      path: currentPath,
      content: tab ? tab.model.getValue() : null,
      kind: "manual",
    });
    await load();
  } catch (e) {
    console.warn("[localHistory] 标记失败", e);
    toastFail(t("workbench.history.failMark"), e);
  }
}

async function revertSelected(): Promise<void> {
  const entry = entries[sel];
  if (!entry || !app.workspaceRoot || !currentPath) return;
  const ok = await openConfirm({
    title: t("workbench.history.restoreTitle"),
    // 确认语两段拼装（含 \n 不走 apply_ts 映射，避免语言包转义链失真），按段取词
    message: `${t("workbench.history.restoreConfirm", { name: basename(currentPath), time: formatTs(entry.ts) })}\n${t("workbench.history.restoreNote")}`,
    okLabel: t("workbench.history.restoreOk"),
    kind: "danger",
  });
  if (!ok) return;
  try {
    await invoke("history_restore", {
      workspaceRoot: app.workspaceRoot,
      path: currentPath,
      id: entry.id,
    });
    await handlers?.reloadFile(currentPath);
    await load();
  } catch (e) {
    console.warn("[localHistory] 回滚失败", e);
    toastFail(t("workbench.history.failRestore"), e);
  }
}

async function clearHistory(): Promise<void> {
  if (!app.workspaceRoot || !currentPath) return;
  const ok = await openConfirm({
    title: t("workbench.history.clearTitle"),
    message: t("workbench.history.clearMsg", { name: basename(currentPath) }),
    okLabel: t("workbench.common.clear"),
    kind: "danger",
  });
  if (!ok) return;
  try {
    await invoke("history_clear", { workspaceRoot: app.workspaceRoot, path: currentPath });
    entries = [];
    sel = 0;
    await load();
  } catch (e) {
    console.warn("[localHistory] 清空历史失败", e);
    toastFail(t("workbench.history.failClear"), e);
  }
}

// ---------- 渲染 ----------

function renderList(): void {
  const el = listEl;
  if (!el) return;
  el.textContent = "";
  if (entries.length === 0) {
    el.appendChild(
      emptyState(
        "history",
        t("workbench.history.empty"),
        app.workspaceRoot ? t("workbench.history.emptyHint") : t("workbench.history.emptyNoWs"),
        true,
      ),
    );
    return;
  }
  entries.forEach((e, i) => {
    const row = document.createElement("div");
    row.className = `history-item${i === sel ? " active" : ""}`;
    row.dataset.index = String(i);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === sel));
    row.tabIndex = 0;

    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = formatTs(e.ts);
    const kind = document.createElement("span");
    kind.className = "history-kind";
    kind.textContent = KIND_LABEL[e.kind] ?? e.kind;
    const size = document.createElement("span");
    size.className = "history-size";
    size.textContent = `${e.size} B`;
    row.append(time, kind, size);

    row.addEventListener("click", () => {
      sel = i;
      renderList();
      void renderDiff();
    });
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        sel = i;
        renderList();
        void renderDiff();
      }
    });
    el.appendChild(row);
  });
}

function releaseDiffModels(): void {
  originalModel?.dispose();
  modifiedModel?.dispose();
  originalModel = null;
  modifiedModel = null;
}

/** 左：选中快照；右：文件当前内容（让用户看清「我要改掉什么」） */
async function renderDiff(): Promise<void> {
  const host = diffHostEl;
  const entry = entries[sel];
  if (!host || !app.workspaceRoot || !currentPath) return;

  if (!entry) {
    releaseDiffModels();
    diffEditor?.setModel(null);
    host.textContent = "";
    host.appendChild(emptyState("history", t("workbench.history.noSelection"), t("workbench.history.noSelectionHint"), true));
    return;
  }

  let oldText: string;
  let newText: string;
  try {
    oldText = await invoke<string>("history_read", {
      workspaceRoot: app.workspaceRoot,
      path: currentPath,
      id: entry.id,
    });
    newText = await invoke<string>("read_file", { path: currentPath });
  } catch (e) {
    console.warn("[localHistory] 读取快照失败", e);
    return;
  }

  host.textContent = "";
  if (!diffEditor) {
    diffEditor = app.monaco.editor.createDiffEditor(host, {
      automaticLayout: true,
      theme: app.settings.theme,
      readOnly: true,
      renderSideBySide: true,
      fontSize: app.settings.font_size,
    });
  }
  releaseDiffModels();
  const lang = languageOf(currentPath);
  originalModel = app.monaco.editor.createModel(oldText, lang);
  modifiedModel = app.monaco.editor.createModel(newText, lang);
  diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  diffEditor.getOriginalEditor().updateOptions({ ariaLabel: t("workbench.history.diffOriginal", { time: formatTs(entry.ts) }) });
  diffEditor.getModifiedEditor().updateOptions({ ariaLabel: t("workbench.history.diffCurrent") });
}
