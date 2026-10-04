// 最近打开的文件（P0，PyCharm Ctrl+E 对标）：弹窗列出本工作区最近打开的文件，可过滤 + 键盘漫游。
//
// 数据源是**已存在**的后端 `file_ops::get_recent`（<data_root>/recent/<hash>.json，上限 10，
// 工作区级）——此前前端只写不读（doOpenFile 里的 recordRecent），本模块是那半截功能的收尾。
// 不新增持久化：排序、去重、过滤磁盘上已删除的文件都在 Rust 侧完成（add_recent），此处只消费。
//
// 焦点模型：**焦点始终留在过滤输入框**，↑↓ 只移动高亮项（.active）而不移走焦点——
// 这样用户可以边输边改选，与 PyCharm / VS Code 的「Recent Files」一致。
// 列表项因此不需要 tabindex，也不参与 Tab 序列（APG listbox + combobox 的常见简化形态）。

import { invoke } from "@tauri-apps/api/core";
import { hideEl, showEl } from "./anim";
import { trapFocus } from "./focusTrap";
import { app } from "./state";
import { basename, emptyState, renderFileIcon, relativePath } from "./util";
import { t } from "./i18n"; // 第十批 i18n：最近文件域动态文案走语言包

// ---------- handlers 注入（同 debugView 先例，避免反向依赖 main.ts） ----------

export interface RecentFilesHandlers {
  /** 选中某文件（main.ts 的 openFile） */
  openFile: (path: string) => void;
}

let handlers: RecentFilesHandlers | null = null;

export function setRecentFilesHandlers(h: RecentFilesHandlers): void {
  handlers = h;
}

// ---------- DOM 与状态 ----------

let modalEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let listEl: HTMLElement | null = null;
/** UI-05：焦点陷阱解除句柄 */
let releaseFocus: (() => void) | null = null;

/** 全部候选（后端返回的有序全路径） */
let entries: string[] = [];
/** 当前高亮项在**过滤后**列表中的下标 */
let sel = 0;

/** 初始化弹窗 DOM（init 时调用一次；容器 #recent-modal 已在 index.html 声明） */
export function initRecentFiles(): void {
  const host = document.getElementById("recent-modal");
  if (!host) return;
  host.textContent = "";

  const card = document.createElement("div");
  card.className = "modal-card recent-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", t("search.recent.title"));

  const input = document.createElement("input");
  input.id = "recent-input";
  input.type = "text";
  input.placeholder = t("search.recent.ph");
  input.spellcheck = false;
  input.autocomplete = "off";
  // aria-activedescendant 由 renderList 维护（高亮项 id 指向，读屏跟随 ↑↓ 报出当前项）
  input.setAttribute("aria-controls", "recent-list");

  const list = document.createElement("div");
  list.id = "recent-list";
  list.className = "recent-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", t("search.recent.title"));

  card.append(input, list);
  host.appendChild(card);

  modalEl = host;
  inputEl = input;
  listEl = list;

  input.addEventListener("input", () => {
    sel = 0;
    renderList();
  });
  input.addEventListener("keydown", (e) => {
    // 与全局 window 级快捷键隔离：输入框内的按键不被任何键位截走
    e.stopPropagation();
    const n = filtered().length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n === 0) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      renderList();
    } else if (e.key === "Home") {
      e.preventDefault();
      sel = 0;
      renderList();
    } else if (e.key === "End") {
      e.preventDefault();
      sel = Math.max(0, n - 1);
      renderList();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = filtered()[sel];
      if (p) void openPath(p);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeRecentFiles();
    }
  });
  list.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".recent-item");
    if (row?.dataset.path) void openPath(row.dataset.path);
  });
  // 点遮罩关闭
  host.addEventListener("mousedown", (e) => {
    if (e.target === host) closeRecentFiles();
  });
}

// ---------- 打开 / 关闭 ----------

/** 打开「最近打开的文件」弹窗（Ctrl+E / 视图菜单入口） */
export async function openRecentFiles(): Promise<void> {
  if (!modalEl || !inputEl) return;
  inputEl.value = "";
  sel = 0;
  showEl(modalEl);
  releaseFocus?.();
  releaseFocus = trapFocus(modalEl);
  await loadEntries();
  renderList();
  inputEl.focus();
}

export function closeRecentFiles(): void {
  if (!modalEl) return;
  releaseFocus?.();
  releaseFocus = null;
  hideEl(modalEl);
}

export function isRecentFilesOpen(): boolean {
  return !!modalEl && !modalEl.classList.contains("hidden");
}

async function loadEntries(): Promise<void> {
  if (!app.workspaceRoot) {
    entries = [];
    return;
  }
  try {
    entries = await invoke<string[]>("get_recent", { workspaceRoot: app.workspaceRoot });
  } catch (e) {
    console.warn("[recentFiles] 读取最近文件失败", e);
    entries = [];
  }
}

// ---------- 渲染 ----------

/** 过滤：路径包含关键词（不敏感）；空关键词保留后端原顺序（即最近优先） */
function filtered(): string[] {
  const q = (inputEl?.value ?? "").trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((p) => p.toLowerCase().includes(q));
}

function renderList(): void {
  if (!listEl || !inputEl) return;
  // 闭包内复用局部引用：模块级 let 在回调里会被 TS 重新放宽为可空
  const list = listEl;
  const input = inputEl;
  list.textContent = "";
  const items = filtered();
  if (sel >= items.length) sel = Math.max(0, items.length - 1);
  if (items.length === 0) {
    list.appendChild(
      emptyState(
        "history",
        app.workspaceRoot ? t("search.recent.noMatch") : t("search.recent.noWorkspace"),
        app.workspaceRoot ? t("search.recent.noMatchHint") : t("search.recent.emptyHint"),
      ),
    );
    input.removeAttribute("aria-activedescendant");
    return;
  }
  items.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = `recent-item${i === sel ? " active" : ""}`;
    row.id = `recent-item-${i}`;
    row.dataset.path = p;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === sel));
    row.appendChild(renderFileIcon(basename(p)));
    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = basename(p);
    const dir = document.createElement("span");
    dir.className = "recent-dir";
    // 工作区内显示相对路径（省去冗长的绝对前缀），完整路径挂 title
    dir.textContent = app.workspaceRoot ? relativePath(app.workspaceRoot, p) : p;
    dir.title = p;
    row.append(name, dir);
    list.appendChild(row);
  });
  input.setAttribute("aria-activedescendant", `recent-item-${sel}`);
  list.children[sel]?.scrollIntoView({ block: "nearest" });
}

async function openPath(path: string): Promise<void> {
  closeRecentFiles();
  handlers?.openFile(path);
}
