// TODO 工具窗（P0，PyCharm TODO tool window 对标）：扫描工作区的 TODO/FIXME 等标记并列出。
//
// 扫描在 Rust 侧（`fs_cmds::scan_todos`），复用 `search_workspace` 的 `ignore` 走查
// （.gitignore 感知 + 隐藏过滤 + 噪声目录剪枝），本模块只负责渲染与跳转：
// - 按标记分组（TODO / FIXME / HACK / BUG / XXX），只显示有命中的分组；
// - 每行显示「文件:行号 + 说明」，点击/Enter 跳转源码；
// - 结果用令牌防乱序（同 search.ts / 大纲的既有做法）。

import { invoke } from "@tauri-apps/api/core";
import { app, $ } from "./state";
import { basename, codicon, emptyState, errMsg } from "./util";
import { t } from "./i18n"; // 第十二批 i18n：TODO 视图动态文案走语言包
import { localizeBackendError } from "./i18n/backendError";

export interface TodoMatch {
  path: string;
  line: number;
  /** 归一化标记（大写，如 "TODO"） */
  tag: string;
  /** 标记之后的说明文字 */
  message: string;
  /** 整行原文（trim 后） */
  text: string;
}

/** 分组展示顺序（与 Rust TODO_TAGS 一致；无命中的分组不显示） */
const TAG_ORDER = ["TODO", "FIXME", "HACK", "BUG", "XXX"];

/** 标记 → 徽标类名后缀（小写；CSS 侧 .todo-badge-<tag>） */
const tagClass = (tag: string): string => `todo-badge todo-badge-${tag.toLowerCase()}`;

// ---------- handlers 注入（同 debugView 先例） ----------

export interface TodoViewHandlers {
  /** 点击条目 → 打开源码并定位（main.ts 的 openFile） */
  openFile: (path: string, line: number) => void;
}

let handlers: TodoViewHandlers | null = null;

export function setTodoViewHandlers(h: TodoViewHandlers): void {
  handlers = h;
}

// ---------- 状态 ----------

let results: TodoMatch[] = [];
/** 刷新令牌：并发/连续刷新时旧结果不得覆盖新结果 */
let todoToken = 0;
let loading = false;

/** 初始化 TODO 视图 DOM（init 时调用一次；#view-todo 容器已在 index.html 声明） */
export function initTodoView(): void {
  const root = $("view-todo");
  root.textContent = "";

  const toolbar = document.createElement("div");
  toolbar.id = "todo-toolbar";
  const summary = document.createElement("span");
  summary.id = "todo-summary";
  summary.textContent = "—";
  const refresh = document.createElement("button");
  refresh.id = "todo-refresh";
  refresh.className = "btn btn--ghost btn--icon";
  refresh.dataset.tip = t("editor.todo.rescan");
  refresh.setAttribute("aria-label", t("editor.todo.rescan"));
  refresh.appendChild(codicon("refresh"));
  refresh.addEventListener("click", () => void refreshTodos());
  toolbar.append(summary, refresh);

  const list = document.createElement("div");
  list.id = "todo-results";

  root.append(toolbar, list);
  renderTodoPanel();
}

/** 重新扫描工作区（视图 onShow 与刷新按钮共用） */
export async function refreshTodos(): Promise<void> {
  const list = document.getElementById("todo-results");
  const summary = document.getElementById("todo-summary");
  if (!app.workspaceRoot) {
    results = [];
    renderTodoPanel();
    return;
  }
  const token = ++todoToken;
  loading = true;
  if (summary) summary.textContent = t("editor.todo.scanning");
  if (list) list.textContent = "";
  let got: TodoMatch[];
  try {
    got = await invoke<TodoMatch[]>("scan_todos", { root: app.workspaceRoot });
  } catch (e) {
    if (token !== todoToken) return;
    results = [];
    loading = false;
    renderTodoPanel(t("editor.todo.scanFailed", { error: localizeBackendError(errMsg(e)) }));
    return;
  }
  if (token !== todoToken) return; // 已有更新一轮的扫描，丢弃旧结果
  results = got;
  loading = false;
  renderTodoPanel();
}

/** 工作区切换 / 关闭时复位（避免旧工作区结果残留） */
export function resetTodoView(): void {
  todoToken++;
  results = [];
  loading = false;
  renderTodoPanel();
}

/** 渲染面板（error 非空时显示为空态 + 错误说明） */
export function renderTodoPanel(error?: string): void {
  const list = document.getElementById("todo-results");
  const summary = document.getElementById("todo-summary");
  if (!list) return;

  if (summary) {
    if (error) summary.textContent = t("editor.todo.scanFailedShort");
    else if (loading) summary.textContent = t("editor.todo.scanning");
    else if (results.length === 0) summary.textContent = t("editor.todo.zeroItems");
    else {
      const tags = new Set(results.map((m) => m.tag));
      summary.textContent = t("editor.todo.summary", { count: results.length, tags: [...tags].join(" / ") });
    }
  }

  list.textContent = "";
  if (error) {
    list.appendChild(emptyState("error", t("editor.todo.scanFailedShort"), error, true));
    return;
  }
  if (loading) {
    list.appendChild(emptyState("loading", t("editor.todo.scanning"), t("editor.todo.scanningHint"), true));
    return;
  }
  if (!app.workspaceRoot) {
    list.appendChild(emptyState("checklist", t("editor.todo.noWorkspace"), t("editor.todo.noWorkspaceHint"), true));
    return;
  }
  if (results.length === 0) {
    list.appendChild(emptyState("checklist", t("editor.todo.none"), t("editor.todo.noneHint"), true));
    return;
  }

  // 按标记分组（保持 TAG_ORDER；未登记的标记排在最后，按字典序）
  const groups = new Map<string, TodoMatch[]>();
  for (const m of results) {
    const arr = groups.get(m.tag);
    if (arr) arr.push(m);
    else groups.set(m.tag, [m]);
  }
  const tags = [...groups.keys()].sort((a, b) => {
    const ia = TAG_ORDER.indexOf(a);
    const ib = TAG_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  for (const tag of tags) {
    const items = groups.get(tag)!;
    const header = document.createElement("div");
    header.className = "todo-group-header";
    const badge = document.createElement("span");
    badge.className = tagClass(tag);
    badge.textContent = tag;
    const count = document.createElement("span");
    count.className = "todo-group-count";
    count.textContent = String(items.length);
    header.append(badge, count);
    list.appendChild(header);

    for (const m of items) {
      list.appendChild(buildTodoRow(m));
    }
  }
}

function buildTodoRow(m: TodoMatch): HTMLElement {
  const row = document.createElement("div");
  row.className = "todo-item";
  const loc = document.createElement("span");
  loc.className = "todo-loc";
  loc.textContent = `${basename(m.path)}:${m.line}`;
  loc.title = m.path;
  const msg = document.createElement("span");
  msg.className = "todo-msg";
  // 无说明文字时回退到整行原文（如只有孤零零一个 `TODO`）
  msg.textContent = m.message || m.text;
  msg.title = msg.textContent;
  row.append(loc, msg);
  // UI-16：可点击行补 button 语义 + 键盘激活
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.setAttribute("aria-label", `${basename(m.path)}:${m.line} ${msg.textContent}`);
  const jump = (): void => handlers?.openFile(m.path, m.line);
  row.addEventListener("click", jump);
  row.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      jump();
    }
  });
  return row;
}
