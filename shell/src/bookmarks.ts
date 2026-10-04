// 行级书签（P2 · PyCharm F11 书签对标）：在可疑行/待办行打个标记，
// 列表里一键跳回、一键删除。
//
// 与 TODO 工具窗的分工：TODO 扫的是**注释里的标记**（代码有意为之、面向所有人）；
// 书签是**我自己的临时备忘**（不改动文件、不进版本库）。二者互补，不重合。
//
// 持久化在后端（<data_root>/bookmarks/<工作区 hash>.json）：书签随工作区走，
// 换机器/重开应用仍在；存文件里（而非 localStorage）也与既有 recent/bookmarks 同源。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { invoke } from "@tauri-apps/api/core";
import { hideEl, showEl } from "./anim";
import { trapFocus } from "./focusTrap";
import { app, type MonacoModule } from "./state";
import { basename, emptyState, relativePath } from "./util";
import { bindingLabel } from "./keybindings";
import { openConfirm } from "./dialog";
import { toastFail } from "./toast";
import { t } from "./i18n"; // 第十一批 i18n：书签动态文案走语言包

export interface Bookmark {
  path: string;
  line: number;
  text: string;
}

export interface BookmarkHandlers {
  /** 跳转（main.ts 的 openFile） */
  openFile: (path: string, line: number) => void;
}

let handlers: BookmarkHandlers | null = null;

export function setBookmarkHandlers(h: BookmarkHandlers): void {
  handlers = h;
}

// ---------- gutter 装饰 ----------
// 书签必须有**就地**的视觉反馈：只在列表里出现的话，用户按了 Ctrl+F11 会以为没生效。

let editorRef: MonacoApi.editor.IStandaloneCodeEditor | null = null;
let monacoRef: MonacoModule | null = null;
let decorations: MonacoApi.editor.IEditorDecorationsCollection | null = null;

/** 重绘当前文件的书签标记（切 tab / 增删书签 / 内容变化后调用） */
export function refreshBookmarkGutter(): void {
  decorations?.clear();
  decorations = null;
  const editor = editorRef;
  const monaco = monacoRef;
  const tab = app.activeTab;
  if (!editor || !monaco || !tab) return;
  const lines = items.filter((b) => b.path === tab.path).map((b) => b.line);
  if (lines.length === 0) return;
  decorations = editor.createDecorationsCollection(
    lines.map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: "gutter-bookmark",
        glyphMarginHoverMessage: { value: t("workbench.bookmarks.glyphTip", { line: line }) },
      },
    })),
  );
}

// ---------- 数据 ----------

let items: Bookmark[] = [];

/** 取当前工作区的书签（缓存；列表弹窗打开时刷新） */
export function bookmarkList(): Bookmark[] {
  return items;
}

export async function loadBookmarks(): Promise<void> {
  if (!app.workspaceRoot) {
    items = [];
    return;
  }
  try {
    items = await invoke<Bookmark[]>("get_bookmarks", { workspaceRoot: app.workspaceRoot });
  } catch (e) {
    console.warn("[bookmarks] 读取书签失败", e);
    toastFail(t("workbench.bookmarks.failRead"), e);
    items = [];
  }
}

/** 某行是否已有书签（gutter 装饰用） */
export function hasBookmark(path: string, line: number): boolean {
  return items.some((b) => b.path === path && b.line === line);
}

/** 切换当前光标行的书签 */
export async function toggleBookmarkAtCursor(): Promise<void> {
  const tab = app.activeTab;
  if (!tab || !app.workspaceRoot) return;
  const line = app.editor.getPosition()?.lineNumber;
  if (!line) return;
  const text = app.editor.getModel()?.getLineContent(line)?.trim() ?? "";
  try {
    items = await invoke<Bookmark[]>("toggle_bookmark", {
      workspaceRoot: app.workspaceRoot,
      path: tab.path,
      line,
      text,
    });
  } catch (e) {
    console.warn("[bookmarks] 切换书签失败", e);
    toastFail(t("workbench.bookmarks.failToggle"), e);
    return;
  }
  refreshBookmarkGutter();
}

async function removeAt(path: string, line: number): Promise<void> {
  if (!app.workspaceRoot) return;
  try {
    items = await invoke<Bookmark[]>("toggle_bookmark", {
      workspaceRoot: app.workspaceRoot,
      path,
      line,
      text: "",
    });
  } catch (e) {
    console.warn("[bookmarks] 删除书签失败", e);
    toastFail(t("workbench.bookmarks.failDelete"), e);
    return;
  }
  refreshBookmarkGutter();
  renderList();
}

async function clearAll(): Promise<void> {
  if (!app.workspaceRoot) return;
  try {
    items = await invoke<Bookmark[]>("clear_bookmarks", { workspaceRoot: app.workspaceRoot });
  } catch (e) {
    console.warn("[bookmarks] 清空书签失败", e);
    toastFail(t("workbench.bookmarks.failClear"), e);
    return;
  }
  refreshBookmarkGutter();
  renderList();
}

/** UX P0-2：清空全部书签不可恢复，补确认框（与「删除文件」的确认标准对齐；列表为空时无事发生） */
async function confirmClearAll(): Promise<void> {
  if (items.length === 0) return;
  const ok = await openConfirm({
    message: t("workbench.bookmarks.clearConfirm", { count: items.length }),
    okLabel: t("workbench.common.clear"),
    kind: "danger",
  });
  if (ok) await clearAll();
}

/** 工作区复位 */
export function resetBookmarks(): void {
  items = [];
}

// ---------- UI ----------

let modalEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;
let sel = 0;

export function initBookmarks(
  editor: MonacoApi.editor.IStandaloneCodeEditor,
  monaco: MonacoModule,
): void {
  editorRef = editor;
  monacoRef = monaco;
  const host = document.getElementById("bookmark-modal");
  if (!host) return;
  host.textContent = "";
  const card = document.createElement("div");
  card.className = "modal-card bookmark-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", t("workbench.bookmarks.title"));

  const list = document.createElement("div");
  list.id = "bookmark-list";
  list.className = "bookmark-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", t("workbench.bookmarks.listAria"));

  const footer = document.createElement("div");
  footer.className = "bookmark-footer";
  const hint = document.createElement("span");
  hint.className = "bookmark-hint";
  hint.textContent = t("workbench.bookmarks.hint");
  const clear = document.createElement("button");
  clear.id = "bookmark-clear";
  clear.className = "btn btn--sm btn--danger-outline";
  clear.textContent = t("workbench.bookmarks.failClear");
  clear.addEventListener("click", () => void confirmClearAll());
  footer.append(hint, clear);

  card.append(list, footer);
  host.appendChild(card);
  modalEl = host;
  listEl = list;

  list.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".bookmark-item");
    const i = row ? Number(row.dataset.index) : NaN;
    if (Number.isNaN(i)) return;
    const b = items[i];
    if (!b) return;
    closeBookmarks();
    handlers?.openFile(b.path, b.line);
  });
  host.addEventListener("mousedown", (e) => {
    if (e.target === host) closeBookmarks();
  });
  document.addEventListener("keydown", (e) => {
    if (!isBookmarksOpen()) return;
    // confirm/alert 等模态叠在书签弹窗之上时忽略按键：否则确认框打开期间
    // 按 Delete/Esc 会同时作用到背后的书签列表（误删别的书签 / 直接关掉弹窗）
    const confirmModal = document.getElementById("confirm-modal");
    if (confirmModal && !confirmModal.classList.contains("hidden")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeBookmarks();
    } else if (e.key === "Delete") {
      const b = items[sel];
      if (b) {
        e.preventDefault();
        void removeAt(b.path, b.line);
      }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length === 0) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      renderList();
    } else if (e.key === "Enter") {
      const b = items[sel];
      if (b) {
        e.preventDefault();
        closeBookmarks();
        handlers?.openFile(b.path, b.line);
      }
    }
  });
}

export function isBookmarksOpen(): boolean {
  return !!modalEl && !modalEl.classList.contains("hidden");
}

export async function openBookmarks(): Promise<void> {
  if (!modalEl) return;
  await loadBookmarks();
  sel = 0;
  showEl(modalEl);
  releaseFocus?.();
  releaseFocus = trapFocus(modalEl);
  renderList();
}

export function closeBookmarks(): void {
  if (!modalEl) return;
  releaseFocus?.();
  releaseFocus = null;
  hideEl(modalEl);
}

function renderList(): void {
  const list = listEl;
  if (!list) return;
  list.textContent = "";
  if (items.length === 0) {
    // S4 键位防漂移：文案改读键位系统（原硬编码 Ctrl+F11，用户改键后失真）
    list.appendChild(
      emptyState(
        "bookmark",
        t("workbench.bookmarks.empty"),
        t("workbench.bookmarks.emptyHint", { key: bindingLabel("bookmark_toggle") || t("workbench.bookmarks.noBinding") }),
      ),
    );
    return;
  }
  items.forEach((b, i) => {
    const row = document.createElement("div");
    row.className = `bookmark-item${i === sel ? " active" : ""}`;
    row.dataset.index = String(i);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === sel));

    const loc = document.createElement("span");
    loc.className = "bookmark-loc";
    loc.textContent = `${basename(b.path)}:${b.line}`;
    loc.title = b.path;
    const text = document.createElement("span");
    text.className = "bookmark-text";
    text.textContent = b.text;
    text.title = b.text;
    const dir = document.createElement("span");
    dir.className = "bookmark-dir";
    dir.textContent = app.workspaceRoot ? relativePath(app.workspaceRoot, b.path) : b.path;
    row.append(loc, text, dir);
    list.appendChild(row);
  });
}
