// 数据库侧栏「资源管理器」（B3 v1.4 Tab 化重设计 · docs/sqlite_tool_dev_plan.md §17）。
//
// 旧版四段竖排（工具条 → 树 → SQL → 结果）+ 宽屏 DOM 搬移已整体退役：空间错配是旧版
// 难用的根源（侧栏 380px 放不下 460px 的最小内容）。新架构：
//   侧栏 = 连接列表 + 对象树（表 / 视图 / 索引，树内过滤）
//   编辑器区 = db-data / db-query 两类 Tab（见 sqliteTabs.ts）
//
// 纪律：
// - **不反向 import main.ts**；本模块只做 DOM 与编排，数据归 sqliteStore，Tab 归 sqliteTabs；
// - 点击连接 = 打开（关旧开新，同时只活一个——可写 SQLite 连接持文件锁）；
// - 双击表 / 视图 = 打开数据 Tab（最常用路径必须顺手）。

import { invoke } from "@tauri-apps/api/core";
import { app, $ } from "./state";
import { t, onLocaleChange, type TFuncKey } from "./i18n";
import { openAlert, openConfirm } from "./dialog";
import { showMenu, type MenuItem } from "./menu";
import { toast, toastFail } from "./toast";
import { codicon, emptyState } from "./util";
import {
  activateConnection,
  disconnectConnection,
  getActiveId,
  getConnections,
  getObjects,
  isTreeLoading,
  onDbStoreChange,
  refreshConnections,
  refreshTree,
  removeConnection,
  reopenConnection,
  resetDbStoreTree,
} from "./sqliteStore";
import { openQueryTabForActive, openTableDataTab, setDbPageSize } from "./sqliteTabs";

// ---------- 状态 ----------

/** 对象树是否展开（活动连接的树体） */
let expanded = true;
/** 收起的分组（table / view / index） */
const collapsedGroups = new Set<string>();
/** 树内过滤文本（过滤活动连接的表/视图/索引名，大小写不敏感） */
let filterText = "";
/** 视图是否显示过（工作区自动恢复完成前的初始化不拉连接，见 refreshDbWorkspace） */
let viewShownOnce = false;

// ---------- DOM 构建 ----------

/** 初始化数据库视图 DOM（init 时调用一次；#view-database 容器已在 index.html 声明） */
export function initDbView(): void {
  buildShell();
  onDbStoreChange(() => renderTree());
  onLocaleChange(() => buildShell());
}

/** 组装侧栏骨架（头部 + 过滤框 + 树容器）；语言切换时整体重建 */
function buildShell(): void {
  const root = $("view-database");
  root.textContent = "";

  const header = document.createElement("div");
  header.id = "db-explorer-header";
  header.className = "db-explorer-header";
  const title = document.createElement("span");
  title.className = "db-explorer-title";
  title.textContent = t("database.explorerTitle");
  header.appendChild(title);
  header.append(
    headerBtn("db-add", "database.addAria", "add", () => void addConnection()),
    headerBtn("db-new-query", "database.cmdNewQuery", "code", () => openQueryTabForActive()),
    headerBtn("db-refresh", "database.refreshAria", "refresh", () => void refreshTree()),
    headerBtn("db-more", "database.moreAria", "ellipsis", (ev) => openMoreMenu(ev)),
  );

  const filterBox = document.createElement("div");
  filterBox.className = "db-filter-box";
  const filter = document.createElement("input");
  filter.id = "db-filter-input";
  filter.type = "text";
  filter.autocomplete = "off";
  filter.spellcheck = false;
  filter.placeholder = t("database.treeFilterPlaceholder");
  filter.setAttribute("aria-label", t("database.treeFilterAria"));
  filter.value = filterText;
  filter.addEventListener("input", () => {
    filterText = filter.value.trim();
    renderTree();
  });
  filterBox.appendChild(filter);

  const tree = document.createElement("div");
  tree.id = "db-tree";
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", t("database.explorerTitle"));

  root.append(header, filterBox, tree);
  renderTree();
}

/** 头部图标按钮（tip + aria-label 同源，避免两者漂移） */
function headerBtn(
  id: string,
  ariaKey: TFuncKey,
  icon: string,
  onClick: (ev: MouseEvent) => void,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.id = id;
  b.className = "btn btn--ghost btn--icon";
  b.setAttribute("aria-label", t(ariaKey));
  b.dataset.tip = t(ariaKey);
  b.appendChild(codicon(icon));
  b.addEventListener("click", onClick);
  return b;
}

// ---------- 渲染 ----------

/** 对象树：连接列表 → 活动连接展开 表 / 视图 / 索引 三组（树内过滤生效时跨组匹配） */
function renderTree(): void {
  const host = document.getElementById("db-tree");
  if (!host) return;
  host.textContent = "";

  if (!app.workspaceRoot) {
    host.appendChild(
      emptyState("database", t("database.noWorkspace"), t("database.noWorkspaceHint"), true),
    );
    return;
  }
  const connections = getConnections();
  if (connections.length === 0) {
    host.appendChild(
      emptyState("database", t("database.noConnection"), t("database.noConnectionHint"), true),
    );
    return;
  }
  if (isTreeLoading()) {
    host.appendChild(emptyState("loading", t("database.listing"), undefined, true));
    return;
  }

  const activeId = getActiveId();
  for (const conn of connections) {
    host.appendChild(buildConnNode(conn, conn.id === activeId));
  }
}

function buildConnNode(conn: { id: string; name: string; path: string; writable: boolean }, isActive: boolean): HTMLElement {
  const item = document.createElement("div");
  item.className = `db-conn-node ${isActive ? "active" : ""}`;
  item.dataset.id = conn.id;
  item.setAttribute("role", "treeitem");
  item.tabIndex = 0;
  item.title = conn.path;

  if (isActive) {
    const arrow = codicon(expanded ? "chevron-down" : "chevron-right");
    arrow.className += " db-conn-arrow";
    item.appendChild(arrow);
  } else {
    const spacer = document.createElement("i");
    spacer.className = "codicon db-conn-arrow";
    spacer.setAttribute("aria-hidden", "true");
    item.appendChild(spacer);
  }

  const icon = codicon("database");
  icon.className += " db-conn-icon";
  item.appendChild(icon);

  const name = document.createElement("span");
  name.className = "db-tree-name";
  name.textContent = conn.name;
  item.appendChild(name);

  // 可写锁形开关（点击切换，需二次确认；不冒泡到连接打开逻辑）
  const lock = document.createElement("button");
  lock.className = "btn btn--ghost btn--icon db-conn-lock";
  lock.setAttribute("aria-pressed", String(conn.writable));
  lock.dataset.tip = conn.writable ? t("database.writableTipOn") : t("database.writableTipOff");
  lock.setAttribute("aria-label", conn.writable ? t("database.writableTipOn") : t("database.writableTipOff"));
  lock.appendChild(codicon(conn.writable ? "unlock" : "lock"));
  lock.addEventListener("click", (e) => {
    e.stopPropagation();
    void toggleWritable(conn.id);
  });
  item.appendChild(lock);

  const select = (): void => {
    if (conn.id === getActiveId()) {
      expanded = !expanded;
      renderTree();
      return;
    }
    void selectConnection(conn.id);
  };
  item.addEventListener("click", select);
  item.addEventListener("dblclick", (e) => {
    e.preventDefault();
    openQueryTabFor(conn.id);
  });
  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      select();
    } else if (e.key === " ") {
      e.preventDefault();
      if (conn.id === getActiveId()) {
        expanded = !expanded;
        renderTree();
      }
    }
  });
  item.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showMenu(
      [
        { label: t("database.cmdNewQuery"), icon: "code", action: () => openQueryTabFor(conn.id) },
        { sep: true },
        {
          label: conn.writable ? t("database.writableTipOn") : t("database.writableTipOff"),
          icon: conn.writable ? "unlock" : "lock",
          action: () => void toggleWritable(conn.id),
        },
        { label: t("database.copyPath"), icon: "copy", action: () => void copyPath(conn.path) },
        { label: t("database.revealInOs"), icon: "folder-opened", action: () => void revealInOs(conn.path) },
        { sep: true },
        { label: t("database.closeConn"), icon: "close", action: () => void disconnectConnection(conn.id) },
        {
          label: t("database.removeAria"),
          icon: "trash",
          action: () => void removeConnWithConfirm(conn.id, conn.name),
        },
      ],
      { x: e.clientX, y: e.clientY },
    );
  });

  if (isActive && expanded) {
    item.appendChild(buildObjectGroups());
  }
  return item;
}

/** 活动连接的对象树：三组（表 / 视图 / 索引），过滤文本生效时只留匹配项 */
function buildObjectGroups(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "db-conn-objects";
  const objects = getObjects();
  const ft = filterText.toLowerCase();

  const groups: [TFuncKey, "table" | "view" | "index"][] = [
    ["database.groupTables", "table"],
    ["database.groupViews", "view"],
    ["database.groupIndexes", "index"],
  ];
  for (const [key, kind] of groups) {
    const items = objects
      .filter((o) => o.kind === kind)
      .sort((a, b) => a.name.localeCompare(b.name))
      .filter((o) => !ft || o.name.toLowerCase().includes(ft));
    if (items.length === 0) continue;
    const collapsed = collapsedGroups.has(kind) && !ft; // 过滤时强制展开
    const header = document.createElement("div");
    header.className = "db-tree-group";
    header.setAttribute("role", "button");
    header.tabIndex = 0;
    header.setAttribute("aria-expanded", String(!collapsed));
    header.append(codicon(collapsed ? "chevron-right" : "chevron-down"));
    const label = document.createElement("span");
    label.textContent = `${t(key)} (${items.length})`;
    header.appendChild(label);
    const toggle = (): void => {
      if (collapsedGroups.has(kind)) collapsedGroups.delete(kind);
      else collapsedGroups.add(kind);
      renderTree();
    };
    header.addEventListener("click", (e) => {
      e.stopPropagation(); // 不冒泡到连接节点
      toggle();
    });
    header.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
    wrap.appendChild(header);
    if (!collapsed) {
      for (const o of items) wrap.appendChild(buildTreeItem(o));
    }
  }
  if (wrap.children.length === 0) {
    wrap.appendChild(emptyState("database", t("database.noObjects"), t("database.noObjectsHint"), true));
  }
  return wrap;
}

function buildTreeItem(o: { name: string; kind: string; rowCount: number | null; columns: { name: string; declType: string; pk: boolean; notNull: boolean }[] | null }): HTMLElement {
  const item = document.createElement("div");
  item.className = "db-tree-item";
  item.dataset.name = o.name;
  item.dataset.kind = o.kind;
  item.setAttribute("role", "treeitem");
  item.tabIndex = 0;

  const icon = codicon(o.kind === "table" ? "table" : o.kind === "view" ? "eye" : "list-ordered");
  const name = document.createElement("span");
  name.className = "db-tree-name";
  name.textContent = o.name;
  const count = document.createElement("span");
  count.className = "db-tree-count db-num";
  if (o.kind !== "index") {
    count.textContent = o.rowCount === null ? "…" : t("database.rowsCount", { n: o.rowCount });
  }

  item.append(icon, name, count);

  if (o.kind !== "index") {
    // 列清单（默认收起）
    const cols = document.createElement("div");
    cols.className = "db-tree-cols hidden";
    for (const c of o.columns ?? []) {
      const row = document.createElement("div");
      row.className = "db-tree-col";
      const cn = document.createElement("span");
      cn.textContent = c.name;
      const ct = document.createElement("span");
      ct.className = "db-tree-col-type";
      const flags = [c.pk ? "PK" : "", c.notNull ? "NN" : ""].filter(Boolean);
      ct.textContent = [c.declType, ...flags].filter(Boolean).join(" ");
      row.append(cn, ct);
      cols.appendChild(row);
    }
    item.appendChild(cols);
  }

  const showRows = (): void => {
    // 双击表/视图 → 数据 Tab（最常用路径，必须顺手）
    const activeId = getActiveId();
    if (activeId) openTableDataTabById(activeId, o);
  };
  item.addEventListener("click", (e) => {
    e.stopPropagation(); // 不冒泡到连接节点（否则触发展开/收起，把整棵树折叠掉）
    if (o.kind === "index") return;
    const body = item.querySelector(".db-tree-cols");
    body?.classList.toggle("hidden");
  });
  item.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showRows();
  });
  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      showRows();
    } else if (e.key === " " && o.kind !== "index") {
      e.preventDefault();
      item.querySelector(".db-tree-cols")?.classList.toggle("hidden");
    }
  });
  item.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation(); // 不冒泡到连接节点（否则两份菜单叠加）
    const activeId = getActiveId();
    const items: MenuItem[] = [
      { label: t("database.showRows"), icon: "table", action: showRows },
    ];
    if (o.kind !== "index" && activeId) {
      items.push({ label: t("database.showDdl"), icon: "code", action: () => void showDdl(activeId, o.name) });
    }
    items.push(
      { label: t("database.copyName"), icon: "copy", action: () => void copyPath(o.name) },
      {
        label: t("database.copySelect"),
        icon: "terminal",
        action: () => void copyPath(`SELECT * FROM "${o.name}"`),
      },
    );
    showMenu(items, { x: e.clientX, y: e.clientY });
  });
  return item;
}

function openTableDataTabById(connId: string, o: { name: string; kind: string; rowCount: number | null; columns: { name: string; declType: string; pk: boolean; notNull: boolean }[] | null }): void {
  openTableDataTab(connId, {
    name: o.name,
    kind: o.kind as "table" | "view" | "index",
    sql: null,
    rowCount: o.rowCount,
    columns: o.columns,
  });
}

// ---------- 交互 ----------

async function selectConnection(id: string): Promise<void> {
  await activateConnection(id);
  expanded = true;
  renderTree();
}

function openQueryTabFor(connId: string): void {
  if (connId !== getActiveId()) {
    // 未打开的连接：先打开再建查询（查询 Tab 依赖连接在线）
    void (async () => {
      if (await activateConnection(connId)) {
        openQueryTabForActive();
        renderTree();
      }
    })();
    return;
  }
  openQueryTabForActive();
}

/** 可写开关：开启需二次确认（写库不可撤销，且只读是产品默认值） */
async function toggleWritable(connId: string): Promise<void> {
  const conn = getConnections().find((c) => c.id === connId);
  if (!conn) return;
  const next = !conn.writable;
  if (next) {
    const ok = await openConfirm({
      title: t("database.writableConfirmTitle"),
      message: t("database.writableConfirmBody"),
      okLabel: t("database.writableConfirmOk"),
      kind: "danger",
    });
    if (!ok) return;
  }
  const reopened = await reopenConnection(connId, next);
  if (reopened) {
    toast(next ? t("database.writableOn") : t("database.writableOff"), "info");
    renderTree();
  }
}

async function removeConnWithConfirm(connId: string, name: string): Promise<void> {
  const ok = await openConfirm({
    title: t("database.removeConfirmTitle"),
    message: t("database.removeConfirm", { name }),
    okLabel: t("database.removeConfirmOk"),
    kind: "danger",
  });
  if (!ok) return;
  await removeConnection(connId);
}

/** ⋯ 更多菜单（作用于当前活动连接） */
function openMoreMenu(ev: Event): void {
  const conn = getConnections().find((c) => c.id === getActiveId());
  if (!conn) {
    toast(t("database.noConnection"), "info");
    return;
  }
  const anchor = (ev.currentTarget as HTMLElement | null) ?? { x: 0, y: 0 };
  showMenu(
    [
      { label: t("database.cmdNewQuery"), icon: "code", action: () => openQueryTabFor(conn.id) },
      { sep: true },
      { label: t("database.copyPath"), icon: "copy", action: () => void copyPath(conn.path) },
      { label: t("database.revealInOs"), icon: "folder-opened", action: () => void revealInOs(conn.path) },
      { sep: true },
      { label: t("database.closeConn"), icon: "close", action: () => void disconnectConnection(conn.id) },
      {
        label: t("database.removeAria"),
        icon: "trash",
        action: () => void removeConnWithConfirm(conn.id, conn.name),
      },
    ],
    anchor,
  );
}

async function copyPath(text: string): Promise<void> {
  try {
    await invoke("copy_to_clipboard", { text });
    toast(t("database.copied"), "success");
  } catch (e) {
    toastFail(t("database.failCopy"), e);
  }
}

async function revealInOs(path: string): Promise<void> {
  try {
    await invoke("reveal_in_explorer", { path });
  } catch (e) {
    toastFail(t("database.failReveal"), e);
  }
}

/** 查看建表 / 建索引语句（右键菜单） */
async function showDdl(connId: string, name: string): Promise<void> {
  try {
    const ddl = await invoke<string>("db_ddl", { id: connId, name });
    await openAlert({ title: t("database.ddlTitle", { name }), message: ddl });
  } catch (e) {
    toastFail(t("database.failDdl"), e);
  }
}

/** 添加连接：选文件 → db_open（默认只读）→ 刷新列表并打开 */
export async function addConnection(): Promise<void> {
  let picked: string | null = null;
  try {
    picked = await invoke<string | null>("pick_file");
  } catch (e) {
    toastFail(t("database.failPick"), e);
    return;
  }
  if (!picked) return; // 用户取消
  try {
    // 后缀白名单在 Rust 侧校验（DbInvalidPath:ext:…）——pick_file 不带过滤器
    const conn = await invoke<{ id: string }>("db_open", { path: picked, writable: false });
    await refreshConnections();
    await selectConnection(conn.id);
  } catch (e) {
    toastFail(t("database.failOpen"), e);
  }
}

// ---------- 生命周期 ----------

/** 视图显示时调用（切到 database 视图） */
export async function onDbViewShow(): Promise<void> {
  viewShownOnce = true;
  setDbPageSize(app.settings.db_page_size ?? 200);
  if (getConnections().length === 0) await refreshConnections();
  else renderTree();
  // 有连接但没激活时自动打开第一条：只列出来却不打开会让树区停在「没有数据库连接」空态
  if (!getActiveId() && getConnections().length > 0) await selectConnection(getConnections()[0].id);
}

/**
 * 工作区就绪后补一次渲染（openWorkspace 收尾时调用）。
 * 视图可能在「启动自动恢复工作区」完成前初始化/显示——renderTree 依赖 app.workspaceRoot，
 * 当时只会画出「未打开工作区」空态，且工作区就绪不会触发任何重渲染
 * （§10.3-8b 真机发现；与 main.ts 的 git 视图补刷新同款处理）。
 */
export function refreshDbWorkspace(): void {
  if (!viewShownOnce) return; // 视图从未显示：不开连接不建编辑器（autosave 等域的 e2e 回归）
  void (async () => {
    if (getConnections().length === 0) await refreshConnections();
    else renderTree();
    if (!getActiveId() && getConnections().length > 0) await selectConnection(getConnections()[0].id);
  })();
}

/** 工作区切换 / 关闭时复位（连接列表是全局的，保留；树回空） */
export function resetDbView(): void {
  resetDbStoreTree();
}
