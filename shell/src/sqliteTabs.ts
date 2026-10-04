// 数据库编辑器 Tab（B3 v1.4 Tab 化重设计 · docs/sqlite_tool_dev_plan.md §17）。
//
// 两种 Tab 共用 kind="db"（state.ts），path 前缀命名空间隔离（照 diff: 前缀先例，
// session 快照 / run gutter / quickopen 等按 path 工作的逻辑天然不误伤）：
//   db-data:<connId>:<对象名>  —— 表/视图数据网格（db_rows：结构化排序/筛选，后端拼装）
//   db-query:<connId>:<序号>   —— SQL 查询（Monaco + db_query）
//
// 形态：#db-tab-panel 是 #editor-row 内与 #editor 互斥的宿主（照 #git-diff-panel 范式）。
// 面板内两套视图（数据 / 查询）各只有一份 DOM，多 Tab 共享——切 Tab 时按各自
// state 重渲染（结果缓存在 state 里，切换不重查）。
//
// 纪律：
// - **不反向 import main.ts**：activateTab 由 main 经 setDbTabHandlers 注入（diff tab 同款）；
// - 并发一律**刷新令牌**（token），旧回调不得覆盖新结果；
// - 渲染前校验 `app.activeTab` —— 共享 DOM 只描述当前激活的 Tab，后台 Tab 只更新 state；
// - Monaco 宿主必须用真实 Element（lazyEl Proxy 会被 ResizeObserver 拒绝，见 splitEditor 踩坑注释）；
// - SQL 判定 / 语句切分是 Rust 同源镜像（真源 db_cmds.rs），只读连接上前端拦截省一次 IPC，
//   **硬闸门在后端**（DbReadOnly:），镜像被绕过也写不坏库。

import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { app, $ } from "./state";
import type { Tab } from "./state";
import { t } from "./i18n";
import { localizeBackendError } from "./i18n/backendError";
import { openConfirm } from "./dialog";
import { showMenu, type MenuItem } from "./menu";
import { toast, toastFail } from "./toast";
import { codicon, emptyState, errMsg } from "./util";
import {
  getActiveId as getActiveConnId,
  getConnById,
  pushConnHistory,
  saveConnections,
  updateConnDraft,
  type DbConnection,
  type DbObject,
} from "./sqliteStore";
import {
  buildGridTable,
  nextSort,
  offsetOfPage,
  pageOf,
  rowToJson,
  statusText,
  toCsv,
  type CellClickInfo,
  type DbQueryResult,
  type GridOptions,
} from "./sqliteGrid";
import {
  classifySql,
  currentStatement,
  splitSqlStatements,
} from "./sqliteSql";

// ---------- Tab 命名空间与状态 ----------

export const DB_DATA_PREFIX = "db-data:";
export const DB_QUERY_PREFIX = "db-query:";

/** 导出 CSV 的行上限（与 Rust `HARD_MAX_ROWS` 对齐：一次查询最多回这么多行） */
export const EXPORT_MAX_ROWS = 10_000;
/** 草稿写盘防抖（毫秒）：连打字时不反复写 json */
const DRAFT_SAVE_DEBOUNCE_MS = 2000;

/** SQL 查询 Tab 的每 Tab 状态（model 挂在 tab.model 上；Monaco 实例全局共享） */
interface QueryState {
  connId: string;
  result: DbQueryResult | null;
  /** 结果对应的 SQL（分页时重跑用） */
  lastSql: string;
  offset: number;
  querying: boolean;
  cancelling: boolean;
  /** 刷新令牌：连续查询 / 切 Tab 时旧回调不得覆盖新结果 */
  token: number;
}

/** 表数据 Tab 的每 Tab 状态（结果缓存在此，切 Tab 不重查） */
interface DataState {
  connId: string;
  name: string;
  sort: { col: string; desc: boolean } | null;
  /** 快速筛选表达式（如 `status = 'paid'`；空 = 不筛） */
  filter: string;
  offset: number;
  result: DbQueryResult | null;
  querying: boolean;
  cancelling: boolean;
  token: number;
}

const queries = new Map<string, QueryState>();
const datas = new Map<string, DataState>();
let querySeq = 0;
/** 结果每页行数（settings.database.db_page_size；onDbViewShow 同步） */
let pageSize = 200;
let draftTimer = 0;

// ---------- handlers 注入（main → 本模块；避免循环 import） ----------

interface DbTabHandlers {
  /** 打开/激活 Tab 统一走 main 的 activateTab（renderTabs / 宿主互斥 / 会话快照都在那边） */
  activateTab: (tab: Tab) => void;
  /** 与主编辑器同源的 Monaco options（字号 / 主题 / 连字）——SQL 编辑器实例用 */
  buildOptions: () => MonacoApi.editor.IEditorOptions;
}

let handlers: DbTabHandlers | null = null;

export function setDbTabHandlers(h: DbTabHandlers): void {
  handlers = h;
}

function activate(tab: Tab): void {
  handlers?.activateTab(tab);
}

/** 拆 path：`<prefix><connId>:<rest>` → [connId, rest]（connId 为 db-<hex>，不含冒号） */
function splitDbPath(path: string, prefix: string): [string, string] {
  const rest = path.slice(prefix.length);
  const idx = rest.indexOf(":");
  return idx >= 0 ? [rest.slice(0, idx), rest.slice(idx + 1)] : [rest, ""];
}

// ---------- 打开 Tab（侧栏 / 命令面板入口） ----------

/** 打开（或激活已存在的）表/视图数据 Tab；索引无数据，直接忽略 */
export function openTableDataTab(connId: string, obj: DbObject): void {
  if (obj.kind === "index") return;
  if (!getConnById(connId)) return;
  const path = `${DB_DATA_PREFIX}${connId}:${obj.name}`;
  let st = datas.get(path);
  if (!st) {
    st = {
      connId,
      name: obj.name,
      sort: null,
      filter: "",
      offset: 0,
      result: null,
      querying: false,
      cancelling: false,
      token: 0,
    };
    datas.set(path, st);
    const tab: Tab = {
      path,
      model: app.monaco.editor.createModel(""), // 占位模型（数据视图不消费；关闭时随 tab dispose）
      dirty: false,
      kind: "db",
    };
    app.tabs.push(tab);
    activate(tab);
    void loadRows(path);
    return;
  }
  const tab = app.tabs.find((x) => x.path === path);
  if (tab) activate(tab);
}

/** 新建一个 SQL 查询 Tab（初始内容 = 该连接的草稿） */
export function openQueryTab(connId: string): void {
  const conn = getConnById(connId);
  if (!conn) return;
  const path = `${DB_QUERY_PREFIX}${connId}:${++querySeq}`;
  const model = app.monaco.editor.createModel(conn.sql ?? "", "sql");
  model.onDidChangeContent(() => {
    updateConnDraft(connId, model.getValue());
    scheduleDraftSave();
  });
  const tab: Tab = { path, model, dirty: false, kind: "db" };
  queries.set(path, { connId, result: null, lastSql: "", offset: 0, querying: false, cancelling: false, token: 0 });
  app.tabs.push(tab);
  activate(tab);
}

/** 对当前活动连接新建查询（命令面板 / 侧栏工具条用；无连接时提示） */
export function openQueryTabForActive(): void {
  const connId = getActiveConnId();
  if (!connId) {
    toast(t("database.noConnection"), "info");
    return;
  }
  openQueryTab(connId);
}

// ---------- 宿主呈现（main 的 activateTab db 分支调用） ----------

/**
 * 激活 db Tab：显示 #db-tab-panel、隐藏 #editor（互斥，照 presentDiffHost），
 * 并把共享 DOM 同步到该 Tab 的状态（结果缓存在 state，切换不重查）。
 */
export function presentDbTab(tab: Tab): void {
  ensurePanel();
  const isQuery = tab.path.startsWith(DB_QUERY_PREFIX);
  $("db-tab-panel").classList.remove("hidden");
  $("editor").classList.add("hidden");
  $("db-data-view").classList.toggle("hidden", isQuery);
  $("db-query-view").classList.toggle("hidden", !isQuery);
  if (isQuery) {
    const ed = ensureSqlEditor();
    if (ed.getModel() !== tab.model) ed.setModel(tab.model);
    const st = queries.get(tab.path);
    if (st) {
      renderQueryResult(tab.path);
      renderQueryToolbar(st);
    }
    ed.focus();
  } else {
    const st = datas.get(tab.path);
    if (st) renderDataView(tab.path);
  }
}

/** 隐藏数据库 Tab 宿主（切回文件/diff Tab 或最后一个 db Tab 关闭时；不动各 Tab 的 state） */
export function dismissDbHost(): void {
  $("db-tab-panel")?.classList.add("hidden");
}

/** 关闭 db Tab 的域内清理（main 的 closeTabSilent db 分支调用；model 随 tab dispose） */
export function cleanupDbTab(tab: Tab): void {
  queries.delete(tab.path);
  datas.delete(tab.path);
  tab.model.dispose();
  if (!app.tabs.some((x) => x.kind === "db")) dismissDbHost();
}

// ---------- Tab 标题 / 图标（main 的 renderTabs 调用） ----------

/** db Tab 显示名：`表名 · 库名` / `查询 N · 库名` */
export function dbTabLabel(tab: Tab): string {
  if (tab.path.startsWith(DB_DATA_PREFIX)) {
    const [connId, name] = splitDbPath(tab.path, DB_DATA_PREFIX);
    return `${name} · ${connDisplayName(connId)}`;
  }
  const [connId, seq] = splitDbPath(tab.path, DB_QUERY_PREFIX);
  return `${t("database.queryTab")} ${seq} · ${connDisplayName(connId)}`;
}

/** db Tab 图标 codicon 名 */
export function dbTabIcon(tab: Tab): string {
  return tab.path.startsWith(DB_DATA_PREFIX) ? "database" : "code";
}

function connDisplayName(connId: string): string {
  return getConnById(connId)?.name ?? connId;
}

// ---------- 共享 DOM（两套视图各一份，多 Tab 复用） ----------

let panelBuilt = false;

function ensurePanel(): void {
  if (panelBuilt) return;
  panelBuilt = true;
  buildDataView();
  buildQueryView();
}

/** 分页条工厂：上一页 / 页码 / 下一页 / 每页行数 / 导出 / 取消 */
function buildPager(opts: {
  idPrefix: string;
  onPrev: () => void;
  onNext: () => void;
  onSize: (n: number) => void;
  onExport: () => void;
  onCancel: () => void;
}): HTMLElement {
  const pager = document.createElement("div");
  pager.className = "db-pager";

  const prev = document.createElement("button");
  prev.id = `${opts.idPrefix}-prev`;
  prev.className = "btn btn--sm btn--icon";
  prev.appendChild(codicon("chevron-left"));
  prev.setAttribute("aria-label", t("database.prevPage"));
  prev.dataset.tip = t("database.prevPage");
  prev.addEventListener("click", opts.onPrev);

  const label = document.createElement("span");
  label.id = `${opts.idPrefix}-page-label`;
  label.className = "db-page-label db-num";

  const next = document.createElement("button");
  next.id = `${opts.idPrefix}-next`;
  next.className = "btn btn--sm btn--icon";
  next.appendChild(codicon("chevron-right"));
  next.setAttribute("aria-label", t("database.nextPage"));
  next.dataset.tip = t("database.nextPage");
  next.addEventListener("click", opts.onNext);

  const sizeLabel = document.createElement("span");
  sizeLabel.textContent = t("database.pageSize");
  const sizeSel = document.createElement("select");
  sizeSel.id = `${opts.idPrefix}-page-size`;
  sizeSel.className = "db-page-size";
  sizeSel.setAttribute("aria-label", t("database.pageSize"));
  for (const n of [100, 200, 500, 1000]) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = String(n);
    sizeSel.appendChild(opt);
  }
  sizeSel.addEventListener("change", () => opts.onSize(Number(sizeSel.value) || 200));

  const cancel = document.createElement("button");
  cancel.id = `${opts.idPrefix}-cancel`;
  cancel.className = "btn btn--sm db-cancel hidden";
  cancel.textContent = t("database.cancel");
  cancel.addEventListener("click", opts.onCancel);

  const exportBtn = document.createElement("button");
  exportBtn.id = `${opts.idPrefix}-export`;
  exportBtn.className = "btn btn--sm";
  exportBtn.textContent = t("database.exportCsv");
  exportBtn.dataset.tip = t("database.exportHint", { n: EXPORT_MAX_ROWS });
  exportBtn.setAttribute("aria-label", t("database.exportHint", { n: EXPORT_MAX_ROWS }));
  exportBtn.addEventListener("click", opts.onExport);

  pager.append(prev, label, next, sizeLabel, sizeSel, exportBtn, cancel);
  return pager;
}

function syncPager(
  view: HTMLElement,
  result: DbQueryResult | null,
  querying: boolean,
): void {
  const label = view.querySelector(".db-page-label");
  const prev = view.querySelector(".db-pager .btn--icon:first-child") as HTMLButtonElement | null;
  const pagers = view.querySelectorAll<HTMLButtonElement>(".db-pager .btn--icon");
  const next = pagers[1] ?? null;
  const cancel = view.querySelector(".db-cancel");
  const sizeSel = view.querySelector(".db-page-size") as HTMLSelectElement | null;
  if (sizeSel) sizeSel.value = String(pageSize);
  cancel?.classList.toggle("hidden", !querying);
  if (!result) {
    if (label) label.textContent = "";
    if (prev) prev.disabled = true;
    if (next) next.disabled = true;
    return;
  }
  const info = pageOf(result.total, result.offset, pageSize);
  if (label) label.textContent = t("database.pageLabel", { page: info.page, pages: info.pages });
  if (prev) prev.disabled = !info.hasPrev || querying;
  if (next) next.disabled = !info.hasNext || querying;
}

/** 渲染网格 + 分页 + 状态条到共享视图（result 为空集时画空态） */
function renderResultArea(
  view: HTMLElement,
  result: DbQueryResult | null,
  st: { querying: boolean; cancelling: boolean; offset: number },
  writable: boolean,
  error: string | undefined,
  gridOpts: Omit<GridOptions, "offset">,
): void {
  const status = view.querySelector<HTMLElement>(".db-tab-status");
  const grid = view.querySelector<HTMLElement>(".db-tab-grid");
  if (!status || !grid) return;
  status.classList.toggle("is-error", Boolean(error));
  status.textContent = statusText({ result, writable, querying: st.querying, cancelling: st.cancelling, error });
  grid.classList.toggle("db-stale", st.querying);
  grid.textContent = "";
  if (!result) return;
  if (result.rows.length === 0) {
    // 写语句没有结果集：不显示空态（否则「DELETE 成功」看起来像「没查到数据」）
    if (result.affected === null) {
      grid.appendChild(emptyState("table", t("database.emptyResult"), t("database.emptyResultHint"), true));
    }
    syncPager(view, result, st.querying);
    return;
  }
  const table = buildGridTable(result, { offset: st.offset, ...gridOpts });
  if (table) grid.appendChild(table);
  syncPager(view, result, st.querying);
}

/** 单元格详情面板（两视图各一个；显示当前拿到的完整值——后端已按 200 字符截断） */
function showCellDetail(container: HTMLElement, column: string, row: number, d: { kind: string; full: string }): void {
  container.textContent = "";
  container.classList.remove("hidden");
  const head = document.createElement("div");
  head.className = "db-cell-detail-head";
  head.textContent = `${column} · #${row}`;
  const body = document.createElement("div");
  body.className = "db-cell-detail-body";
  body.textContent = d.kind === "null" ? t("database.null") : d.full;
  const copy = document.createElement("button");
  copy.className = "btn btn--sm";
  copy.textContent = t("database.copyValue");
  copy.addEventListener("click", () => void copyText(d.full));
  container.append(head, body, copy);
}

async function copyText(text: string): Promise<void> {
  try {
    await invoke("copy_to_clipboard", { text });
    toast(t("database.copied"), "success");
  } catch (e) {
    toastFail(t("database.failCopy"), e);
  }
}

/** 单元格右键菜单：复制值 / 复制整行（JSON / CSV） */
function cellContextMenu(info: CellClickInfo, ev: MouseEvent, result: DbQueryResult | null): void {
  const rowIndex = info.row - (result?.offset ?? 0) - 1;
  const row = result?.rows[rowIndex] ?? null;
  const items: MenuItem[] = [
    { label: t("database.copyValue"), icon: "copy", action: () => void copyText(info.display.kind === "null" ? "" : info.display.full) },
  ];
  if (row && result) {
    items.push(
      { label: t("database.copyRowJson"), icon: "json", action: () => void copyText(rowToJson(result.columns, row)) },
      { label: t("database.copyRowCsv"), icon: "table", action: () => void copyText(result.columns.map((_, i) => row[i] ?? "").map((v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")) },
    );
  }
  showMenu(items, { x: ev.clientX, y: ev.clientY });
}

// ---------- 表数据视图 ----------

function buildDataView(): void {
  const view = document.createElement("div");
  view.id = "db-data-view";
  view.classList.add("hidden");

  const toolbar = document.createElement("div");
  toolbar.className = "db-tab-toolbar";
  const title = document.createElement("span");
  title.id = "db-data-title";
  title.className = "db-tab-title";
  const filter = document.createElement("input");
  filter.id = "db-data-filter";
  filter.type = "text";
  filter.autocomplete = "off";
  filter.spellcheck = false;
  filter.placeholder = t("database.dataFilterPlaceholder");
  filter.setAttribute("aria-label", t("database.dataFilterAria"));
  const refresh = document.createElement("button");
  refresh.id = "db-data-refresh";
  refresh.className = "btn btn--ghost btn--icon";
  refresh.dataset.tip = t("database.refreshAria");
  refresh.setAttribute("aria-label", t("database.refreshAria"));
  refresh.appendChild(codicon("refresh"));
  toolbar.append(title, filter, refresh);

  const status = document.createElement("div");
  status.className = "db-tab-status";
  const grid = document.createElement("div");
  grid.className = "db-tab-grid";
  const detail = document.createElement("div");
  detail.className = "db-cell-detail hidden";

  const dataPathOf = (): string | null => (app.activeTab?.path.startsWith(DB_DATA_PREFIX) ? app.activeTab.path : null);

  filter.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      filter.value = "";
      applyFilter("");
      return;
    }
    if (e.key !== "Enter") return;
    applyFilter(filter.value);
  });
  function applyFilter(value: string): void {
    const path = dataPathOf();
    if (!path) return;
    const st = datas.get(path);
    if (!st) return;
    st.filter = value.trim();
    st.offset = 0;
    void loadRows(path);
  }
  refresh.addEventListener("click", () => {
    const path = dataPathOf();
    if (path) void loadRows(path);
  });

  view.append(toolbar, status, grid, detail);
  view.appendChild(
    buildPager({
      idPrefix: "db-data",
      onPrev: () => void gotoDataPage(-1),
      onNext: () => void gotoDataPage(1),
      onSize: (n) => {
        pageSize = n;
        const path = dataPathOf();
        if (path) void loadRows(path, 0);
      },
      onExport: () => void exportDataCsv(),
      onCancel: () => void cancelActive(),
    }),
  );
  $("db-tab-panel").appendChild(view);
}

/** 渲染表数据视图（激活 Tab 时 / 查询回调后调用） */
function renderDataView(path: string, error?: string): void {
  const st = datas.get(path);
  const view = document.getElementById("db-data-view");
  if (!st || !view) return;
  const conn = getConnById(st.connId);

  const title = view.querySelector<HTMLElement>("#db-data-title");
  if (title) title.textContent = st.name;
  const filter = view.querySelector<HTMLInputElement>("#db-data-filter");
  if (filter) filter.value = st.filter;

  renderResultArea(view, st.result, st, conn?.writable ?? false, error, {
    sort: st.sort,
    onHeaderClick: (col) => {
      st.sort = nextSort(st.sort, col);
      st.offset = 0;
      void loadRows(path);
    },
    onCellClick: (info) => {
      const detail = view.querySelector<HTMLElement>(".db-cell-detail");
      if (detail) showCellDetail(detail, info.column, info.row, info.display);
    },
    onCellContext: (info, ev) => cellContextMenu(info, ev, st.result),
  });
}

/** 拉表数据（db_rows：排序/筛选由后端拼装；分页重跑也走这里） */
async function loadRows(path: string, offset?: number): Promise<void> {
  const st = datas.get(path);
  if (!st) return;
  const conn = getConnById(st.connId);
  if (!conn) return;
  const my = ++st.token;
  if (offset !== undefined) st.offset = Math.max(0, offset);
  st.querying = true;
  st.cancelling = false;
  if (app.activeTab?.path === path) renderDataView(path);
  try {
    const got = await invoke<DbQueryResult>("db_rows", {
      id: st.connId,
      name: st.name,
      sort: st.sort?.col ?? null,
      dir: st.sort ? (st.sort.desc ? "desc" : "asc") : null,
      filter: st.filter || null,
      limit: pageSize,
      offset: st.offset,
    });
    if (my !== st.token) return; // 旧响应丢弃（已切排序/翻页/关 Tab）
    st.result = got;
    st.querying = false;
    if (app.activeTab?.path === path) renderDataView(path);
  } catch (e) {
    if (my !== st.token) return;
    st.querying = false;
    if (app.activeTab?.path === path) {
      renderDataView(path, t("database.statusFail", { error: localizeBackendError(errMsg(e)) }));
    }
    toastFail(t("database.failQuery"), e);
  }
}

/** 表数据翻页（±1 页；页码口径见 offsetOfPage） */
function gotoDataPage(delta: number): void {
  const path = app.activeTab?.path;
  if (!path || !path.startsWith(DB_DATA_PREFIX)) return;
  const st = datas.get(path);
  if (!st || !st.result || st.querying) return;
  const info = pageOf(st.result.total, st.result.offset, pageSize);
  const target = info.page + delta;
  if (target < 1 || target > info.pages) return;
  void loadRows(path, offsetOfPage(target, pageSize));
}

/** 导出当前表数据（按筛选/排序重拉全量，上限 10000 行）→ UTF-8 BOM CSV */
async function exportDataCsv(): Promise<void> {
  const path = app.activeTab?.path;
  if (!path || !path.startsWith(DB_DATA_PREFIX)) return;
  const st = datas.get(path);
  const conn = st ? getConnById(st.connId) : null;
  if (!st || !conn) {
    toast(t("database.statusIdle"), "info");
    return;
  }
  const target = await saveDialog({
    defaultPath: `${st.name}-${stamp()}.csv`,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!target) return; // 用户取消
  try {
    const full = await invoke<DbQueryResult>("db_rows", {
      id: st.connId,
      name: st.name,
      sort: st.sort?.col ?? null,
      dir: st.sort ? (st.sort.desc ? "desc" : "asc") : null,
      filter: st.filter || null,
      limit: EXPORT_MAX_ROWS,
      offset: 0,
    });
    await invoke("write_file", { path: target, content: "\ufeff" + toCsv(full) });
    toast(t("database.exportOk", { path: target }), "success");
  } catch (e) {
    toastFail(t("database.failExport"), e);
  }
}

// ---------- SQL 查询视图 ----------

let sqlEditor: MonacoApi.editor.IStandaloneCodeEditor | null = null;

/** SQL 编辑器最终 options：主编辑器同源参数（main 注入）+ 结果面板专有覆盖 */
function sqlEditorOptions(): MonacoApi.editor.IStandaloneEditorConstructionOptions {
  return {
    ...(handlers?.buildOptions() ?? {}),
    automaticLayout: true,
    language: "sql",
    minimap: { enabled: false },
    glyphMargin: false,
    scrollBeyondLastLine: false,
    wordWrap: "on",
  };
}

/**
 * 懒创建 SQL 编辑器实例（G-1 纪律：不随开随弃；切查询 Tab 只换 model，实例常驻）。
 * host 必须是真实元素（不能走 lazyEl Proxy，见文件头纪律）。
 */
function ensureSqlEditor(): MonacoApi.editor.IStandaloneCodeEditor {
  if (sqlEditor) return sqlEditor;
  const monaco = app.monaco;
  sqlEditor = monaco.editor.create($("db-query-editor-host"), sqlEditorOptions());
  sqlEditor.addAction({
    id: "pylume.dbRun",
    label: t("database.runTip"),
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    run: () => void runCurrent(),
  });
  sqlEditor.addAction({
    id: "pylume.dbRunAll",
    label: t("database.runAllTip"),
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
    run: () => void runAllStatements(),
  });
  return sqlEditor;
}

function buildQueryView(): void {
  const view = document.createElement("div");
  view.id = "db-query-view";
  view.classList.add("hidden");

  const toolbar = document.createElement("div");
  toolbar.className = "db-tab-toolbar";
  const run = document.createElement("button");
  run.id = "db-run";
  run.className = "btn btn--sm";
  run.textContent = t("database.run");
  run.dataset.tip = t("database.runTip");
  run.setAttribute("aria-label", t("database.runTip"));
  run.addEventListener("click", () => void runCurrent());
  const runAll = document.createElement("button");
  runAll.id = "db-run-all";
  runAll.className = "btn btn--sm";
  runAll.textContent = t("database.runAll");
  runAll.dataset.tip = t("database.runAllTip");
  runAll.setAttribute("aria-label", t("database.runAllTip"));
  runAll.addEventListener("click", () => void runAllStatements());
  const history = document.createElement("button");
  history.id = "db-history";
  history.className = "btn btn--sm";
  history.textContent = t("database.history");
  history.addEventListener("click", () => openHistoryMenu());
  toolbar.append(run, runAll, history);

  const editorHost = document.createElement("div");
  editorHost.id = "db-query-editor-host";
  editorHost.className = "db-query-editor-host";

  const status = document.createElement("div");
  status.className = "db-tab-status";
  const grid = document.createElement("div");
  grid.className = "db-tab-grid";
  const detail = document.createElement("div");
  detail.className = "db-cell-detail hidden";

  view.append(toolbar, editorHost, status, grid, detail);
  view.appendChild(
    buildPager({
      idPrefix: "db-query",
      onPrev: () => void gotoQueryPage(-1),
      onNext: () => void gotoQueryPage(1),
      onSize: (n) => {
        pageSize = n;
        const path = activeQueryPath();
        const st = path ? queries.get(path) : null;
        if (path && st?.lastSql) void runQueryIn(path, st.lastSql, 0);
      },
      onExport: () => void exportQueryCsv(),
      onCancel: () => void cancelActive(),
    }),
  );
  $("db-tab-panel").appendChild(view);
}

function activeQueryPath(): string | null {
  const path = app.activeTab?.path;
  return path && path.startsWith(DB_QUERY_PREFIX) ? path : null;
}

function renderQueryToolbar(st: QueryState): void {
  const run = document.getElementById("db-run") as HTMLButtonElement | null;
  const runAll = document.getElementById("db-run-all") as HTMLButtonElement | null;
  if (run) run.disabled = st.querying;
  if (runAll) runAll.disabled = st.querying;
}

function renderQueryResult(path: string, error?: string): void {
  const st = queries.get(path);
  const view = document.getElementById("db-query-view");
  if (!st || !view) return;
  const conn = getConnById(st.connId);
  renderResultArea(view, st.result, st, conn?.writable ?? false, error, {
    onCellClick: (info) => {
      const detail = view.querySelector<HTMLElement>(".db-cell-detail");
      if (detail) showCellDetail(detail, info.column, info.row, info.display);
    },
    onCellContext: (info, ev) => cellContextMenu(info, ev, st.result),
  });
  renderQueryToolbar(st);
}

/** 执行查询（查询 Tab 内；分页重跑也走这里）。前端只做「省一次往返」的拦截，硬闸门在 Rust。 */
async function runQueryIn(path: string, sql: string, offset: number): Promise<void> {
  const st = queries.get(path);
  const conn = st ? getConnById(st.connId) : null;
  const text = sql.trim().replace(/;$/, "");
  if (!st || !conn || !text) return;

  if (classifySql(text) === "write" && !conn.writable) {
    // 只读模式下执行写语句 → 不发 IPC，直接提示
    st.querying = false;
    if (app.activeTab?.path === path) renderQueryResult(path, t("database.readonlyBlocked"));
    toast(t("database.readonlyBlocked"), "info");
    return;
  }

  const my = ++st.token;
  st.lastSql = sql;
  st.offset = Math.max(0, offset);
  st.querying = true;
  st.cancelling = false;
  if (app.activeTab?.path === path) renderQueryResult(path);
  try {
    const got = await invoke<DbQueryResult>("db_query", {
      id: st.connId,
      sql,
      limit: pageSize,
      offset: st.offset,
    });
    if (my !== st.token) return;
    st.result = got;
    st.querying = false;
    if (app.activeTab?.path === path) renderQueryResult(path);
  } catch (e) {
    if (my !== st.token) return;
    st.querying = false;
    if (app.activeTab?.path === path) renderQueryResult(path, t("database.statusFail", { error: localizeBackendError(errMsg(e)) }));
    toastFail(t("database.failQuery"), e);
  }
}

/** 取消当前激活 Tab 的查询（SQLite 协作式中断，不保证即时 → 先显示「取消中…」） */
async function cancelActive(): Promise<void> {
  const path = app.activeTab?.path;
  if (!path) return;
  const st = path.startsWith(DB_QUERY_PREFIX) ? queries.get(path) : datas.get(path);
  const conn = st ? getConnById(st.connId) : null;
  if (!st || !conn || !st.querying) return;
  st.cancelling = true;
  if (app.activeTab?.path === path) {
    if (path.startsWith(DB_QUERY_PREFIX)) renderQueryResult(path);
    else renderDataView(path);
  }
  try {
    await invoke("db_cancel", { id: conn.id });
    toast(t("database.cancelled"), "info");
  } catch (e) {
    toastFail(t("database.failCancel"), e);
  }
}

/** 查询 Tab 翻页（±1 页） */
function gotoQueryPage(delta: number): void {
  const path = activeQueryPath();
  const st = path ? queries.get(path) : null;
  if (!path || !st || !st.result || st.querying) return;
  const info = pageOf(st.result.total, st.result.offset, pageSize);
  const target = info.page + delta;
  if (target < 1 || target > info.pages) return;
  void runQueryIn(path, st.lastSql, offsetOfPage(target, pageSize));
}

/**
 * 写语句闸门：只读连接直接拒（省一次 IPC）；可写连接按设置决定是否弹确认框。
 * 返回 true = 放行。**真正的硬闸门在 Rust**（`DbReadOnly:`），这里被绕过也写不坏库。
 */
async function confirmWrite(conn: DbConnection, sql: string): Promise<boolean> {
  if (classifySql(sql) !== "write") return true;
  if (!conn.writable) {
    // 只读连接：不发 IPC，直接在状态条转错误态（照旧版 §3.6 的呈现）
    const p = activeQueryPath();
    if (p && queries.has(p)) renderQueryResult(p, t("database.readonlyBlocked"));
    toast(t("database.readonlyBlocked"), "info");
    return false;
  }
  if (app.settings.db_warn_on_write === false) return true;
  return openConfirm({
    title: t("database.writeConfirmTitle"),
    message: t("database.writeConfirmBody", { sql: sql.slice(0, 200) }),
    okLabel: t("database.writeConfirmOk"),
    kind: "danger",
  });
}

/** 执行当前语句（Ctrl+Enter）：按光标位置定位 `;` 分隔出的那一条 */
export async function runCurrent(): Promise<void> {
  const path = activeQueryPath();
  const st = path ? queries.get(path) : null;
  const conn = st ? getConnById(st.connId) : null;
  if (!path || !st || !conn) {
    toast(t("database.noConnection"), "info");
    return;
  }
  if (!sqlEditor) return;
  const pos = sqlEditor.getPosition();
  const model = sqlEditor.getModel();
  const offset = pos && model ? model.getOffsetAt(pos) : 0;
  const stmt = currentStatement(model?.getValue() ?? "", offset);
  if (!stmt) {
    toast(t("database.sqlHint"), "info");
    return;
  }
  if (!(await confirmWrite(conn, stmt))) return;
  pushConnHistory(st.connId, stmt);
  scheduleDraftSave();
  await runQueryIn(path, stmt, 0);
}

/** 执行全部（Ctrl+Shift+Enter）：前端切分后逐条发（后端的读路径拒绝多语句） */
export async function runAllStatements(): Promise<void> {
  const path = activeQueryPath();
  const st = path ? queries.get(path) : null;
  const conn = st ? getConnById(st.connId) : null;
  if (!path || !st || !conn) {
    toast(t("database.noConnection"), "info");
    return;
  }
  const stmts = splitSqlStatements(sqlEditor?.getValue() ?? "");
  if (stmts.length === 0) {
    toast(t("database.sqlHint"), "info");
    return;
  }
  for (const stmt of stmts) {
    if (!(await confirmWrite(conn, stmt))) return;
    pushConnHistory(st.connId, stmt);
    await runQueryIn(path, stmt, 0);
  }
  scheduleDraftSave();
}

/** 历史下拉：点击回填编辑器（当前激活查询 Tab） */
function openHistoryMenu(): void {
  const anchor = document.getElementById("db-history");
  const path = activeQueryPath();
  const st = path ? queries.get(path) : null;
  if (!anchor || !st) return;
  const conn = getConnById(st.connId);
  const items: MenuItem[] = (conn?.history ?? []).map((h) => ({
    label: h.replace(/\s+/g, " ").slice(0, 70),
    action: () => {
      sqlEditor?.setValue(h);
      sqlEditor?.focus();
    },
  }));
  if (items.length === 0) items.push({ label: t("database.historyEmpty"), disabled: true });
  showMenu(items, anchor);
}

/** 导出当前查询结果（按 lastSql 重拉全量，上限 10000 行）→ UTF-8 BOM CSV */
async function exportQueryCsv(): Promise<void> {
  const path = activeQueryPath();
  const st = path ? queries.get(path) : null;
  const conn = st ? getConnById(st.connId) : null;
  if (!st || !conn || !st.lastSql) {
    toast(t("database.statusIdle"), "info");
    return;
  }
  const target = await saveDialog({
    defaultPath: `${conn.name.replace(/\.[^.]+$/, "")}-${stamp()}.csv`,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!target) return; // 用户取消
  try {
    const full = await invoke<DbQueryResult>("db_query", {
      id: st.connId,
      sql: st.lastSql,
      limit: EXPORT_MAX_ROWS,
      offset: 0,
    });
    await invoke("write_file", { path: target, content: "\ufeff" + toCsv(full) });
    toast(t("database.exportOk", { path: target }), "success");
  } catch (e) {
    toastFail(t("database.failExport"), e);
  }
}

// ---------- 杂项 ----------

/** 草稿落盘：写盘防抖 2s（避免连打字时反复写 json） */
function scheduleDraftSave(): void {
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => void saveConnections(), DRAFT_SAVE_DEBOUNCE_MS);
}

/** 结果每页行数（设置面板 db_page_size；onDbViewShow 同步） */
export function setDbPageSize(n: number): void {
  if (Number.isFinite(n) && n > 0) pageSize = n;
}

/** 设置保存后同步编辑器参数（字号 / 连字 / 主题；照 splitEditor.ts 范式） */
export function refreshDbSqlOptions(): void {
  sqlEditor?.updateOptions(sqlEditorOptions());
}

/** 时间戳（导出文件名用，本地时间、秒级） */
function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 工作区切换时作废全部在途请求令牌（响应回来直接丢弃） */
export function invalidateDbTokens(): void {
  for (const st of queries.values()) st.token++;
  for (const st of datas.values()) st.token++;
}
