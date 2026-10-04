// 文件树功能域（TD-007 迁出 main.ts）：树渲染 / 展开折叠 / 选择 / 右键菜单 /
// 文件操作（新建/重命名/复制/剪切/粘贴/删除/拖拽）/ 过滤 / 键盘导航 / 输入模态。
// 域内私有状态留在本模块；跨域共享状态经 state.ts 的 app 读写。

import { invoke } from "@tauri-apps/api/core";
import { app, $, lazyEl, statusFileEl, type Entry, type Tab } from "./state";
import { basename, ensurePyExtension, normalizePath, samePath, stripPyExtension, gitBadgeClass, gitStatusLabel, joinPath, parentDirOf, relativePath, relativePathOrName, relativePathRaw, renderFileIcon } from "./util";
// CR-25：状态读取改从零依赖的 gitStatusState（切断 fileTree ↔ git 的状态耦合）；
// refreshGitStatus 是运行时才调用的函数（无初始化期循环风险），保留从 git.ts 导入
import { refreshGitStatus, stageFiles, showDiffForPath, showBlame, showFileHistory, gitFileOriginalPath } from "./git";
import { gitStatusOf, isGitRepoActive, isGitDirtyDir } from "./gitStatusState";
import { openTerminalAt } from "./termUi";
import * as mdPreview from "./markdownPreview"; // Markdown 预览（.md 右键「打开预览」）
import { openConfirm } from "./dialog";
import { toast, toastFail } from "./toast";
import { setSidebarTab } from "./views";
import * as lsp from "./lsp/client";
import { hideMenu, showMenu, type MenuItem } from "./menu";
import { openLocalHistory } from "./localHistory"; // E-3：右键「本地历史」入口（localHistory 不反向依赖本模块，无环）
import { diffFileWithClipboard } from "./clipboardDiff"; // C-5：右键「与剪贴板对比」（clipboardDiff 不依赖本模块，无环）
import { headerTemplateApplies } from "./newFileTemplate"; // PR-K：新建 .py 文件头模板门控（零依赖纯函数）
import { onLocaleChange, t } from "./i18n"; // 第四批 i18n：文件树域动态文案走语言包

// ---------- 注入（main 的 init 中 setFileTreeHandlers） ----------
// TD-13：解「fileTree.ts → main.ts」循环边——打开文件 / 重绘标签 / 静默关标签 / 插入文件头
// 都是运行时函数引用，改由 main 注入（参照 terminal.ts::setTerminalLinkHandler 先例）。

interface FileTreeHandlers {
  /** opts.focusEditor=false：焦点留在文件树（单击/键盘打开不抢编辑器焦点，可继续漫游） */
  openFile: (path: string, revealLine?: number, opts?: { focusEditor?: boolean }) => Promise<void>;
  renderTabs: () => void;
  closeTabSilent: (tab: Tab) => void;
  insertHeaderTemplate: () => Promise<boolean>;
  /** v3.4 §8（M3-3.4）：文件树右键「运行脚本」（runFlow 注入，避免 fileTree → runFlow 循环依赖） */
  runScript: (path: string) => void;
}

let handlers: FileTreeHandlers | null = null;

/** 注入 main 域函数（main 在 init 中、wireFileTree 之前调用；树交互都发生在 init 之后） */
export function setFileTreeHandlers(h: FileTreeHandlers): void {
  handlers = h;
}

function fh(): FileTreeHandlers {
  if (!handlers) throw new Error("[Pylume] fileTree 尚未接线（setFileTreeHandlers 须在 init 中先于文件树交互）");
  return handlers;
}

// ---------- 域内状态 ----------

// CR-26：顶层 DOM 快照改惰性（测试环境无完整 DOM 时模块仍可被 import）
const treeEl = lazyEl("tree");

/** 内部文件剪贴板（复制/剪切） */
let fileClipboard: { paths: string[]; mode: "copy" | "cut" } | null = null;
/** 多选：当前选中的路径集合 */
const selectedPaths = new Set<string>();
/** 兼容旧逻辑：最后选中的条目 */
let selectedEntry: Entry | null = null;
/** 内联输入框是否激活（激活时屏蔽树快捷键） */
let inlineInputActive = false;
/** 树过滤关键字 */
let treeFilter = "";
/** 已展开目录路径 → 子项容器（供局部刷新） */
const dirContainers = new Map<string, { container: HTMLElement; depth: number }>();
/** 是否显示隐藏文件（dot 文件） */
let showHiddenFiles = false;
/** 已展开目录路径集合（持久化用） */
const expandedDirs = new Set<string>();

// ---------- 展开状态持久化（按工作区，localStorage；B 批体验项） ----------

const TREE_EXPANDED_KEY_PREFIX = "pylume.tree_expanded:";
/** G-1 红线：持久化必须有界——超出视为异常膨胀（如循环符号链接误展开），放弃落盘 */
const MAX_PERSISTED_DIRS = 500;

/** 当前工作区的展开状态存储 key；无工作区返回 null */
function treeExpandedKey(): string | null {
  if (!app.workspaceRoot) return null;
  return TREE_EXPANDED_KEY_PREFIX + normalizePath(app.workspaceRoot);
}

/** 展开集合 → localStorage（toggleDir / collapseAll 变更点写穿） */
function saveExpandedDirs(): void {
  const key = treeExpandedKey();
  if (!key) return;
  try {
    if (expandedDirs.size > MAX_PERSISTED_DIRS) return;
    localStorage.setItem(key, JSON.stringify([...expandedDirs]));
  } catch {
    // 存储满/被禁用：静默（与 layout.ts 同款降级）
  }
}

/** localStorage → 展开集合（refreshTree 在清空后调用，恢复当前工作区的持久化状态） */
function loadExpandedDirs(): void {
  const key = treeExpandedKey();
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const arr: unknown = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const d of arr) if (typeof d === "string") expandedDirs.add(d);
    }
  } catch {
    // 数据损坏：忽略，按无持久化处理
  }
}

/** 把指定集合中已渲染的目录逐个重新展开（refreshTree / refreshTreeWithExpandedState 共用；
 *  根节点已在 renderRootNode 中展开，跳过） */
async function restoreExpandedDirs(dirs: Iterable<string>): Promise<void> {
  for (const dir of dirs) {
    if (dir === app.workspaceRoot) continue;
    const itemEl = treeEl.querySelector<HTMLElement>(`.tree-item[data-path="${CSS.escape(dir)}"]`);
    if (!itemEl) continue;
    const entry = entryFromEl(itemEl);
    if (entry?.is_dir) await toggleDir(itemEl, entry, depthOf(itemEl));
  }
}

// ---------- 树渲染 ----------

// 树节点缩进：基础缩进（根级距左）+ 每层递增步长。
// depthOf 依赖这两个值反推深度，改动必须同步；步长已从 14px 收紧为 10px。
const TREE_INDENT_BASE = 8;
const TREE_INDENT_STEP = 10;

export async function refreshTree(): Promise<void> {
  if (!app.workspaceRoot) return;
  await refreshGitStatus();
  treeEl.textContent = "";
  dirContainers.clear();
  expandedDirs.clear();
  loadExpandedDirs(); // B 批：打开工作区时按持久化恢复展开状态（重启后不再全部收起）
  await renderRootNode();
  await restoreExpandedDirs(expandedDirs);
  saveExpandedDirs(); // 清掉存储里已不存在的陈旧目录
}

/** 渲染工作区根节点（可见、可折叠、默认展开），其子项装入根节点的子容器。
 *  根节点是「工作区」的视觉锚点：右键即可在根目录新建，初用者不再无从下手。 */
async function renderRootNode(): Promise<void> {
  const root = app.workspaceRoot!;
  const rootEntry: Entry = { name: basename(root), path: root, is_dir: true };
  const rootItem = renderTreeItem(rootEntry, 0, { isRoot: true });
  treeEl.appendChild(rootItem);
  // 复用 toggleDir 的展开分支：建子容器 + 登记 dirContainers/expandedDirs + buildDir 填充
  await toggleDir(rootItem, rootEntry, 0);
}

/** 读取 dir 的一层并填充到 container（不负责登记 map） */
async function buildDir(dir: string, container: HTMLElement, depth: number): Promise<void> {
  let entries: Entry[];
  try {
    entries = await invoke<Entry[]>("read_dir", { path: dir, showHidden: showHiddenFiles });
  } catch (e) {
    console.warn("read_dir 失败", dir, e);
    return;
  }
  entries.sort((a, b) => (b.is_dir ? 1 : 0) - (a.is_dir ? 1 : 0) || a.name.localeCompare(b.name));
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    // UI-16：role=tree 的容器期望子级为 treeitem/group；占位提示自身无语义，
    // 标 presentation 避免读屏把它当成结构节点（文本内容仍会被朗读）
    empty.setAttribute("role", "presentation");
    empty.style.paddingLeft = `${TREE_INDENT_BASE + depth * TREE_INDENT_STEP}px`;
    empty.textContent = t("filetree.tree.empty");
    container.appendChild(empty);
    return;
  }
  for (const e of entries) container.appendChild(renderTreeItem(e, depth));
}

/** 渲染单个树节点（文件/目录），含类型图标 + git 状态装饰 */
function renderTreeItem(e: Entry, depth: number, opts?: { isRoot?: boolean }): HTMLElement {
  const isRoot = opts?.isRoot ?? false;
  const item = document.createElement("div");
  item.className = `tree-item ${e.is_dir ? "dir" : "file"}${isRoot ? " tree-root" : ""}`;
  item.style.paddingLeft = `${TREE_INDENT_BASE + depth * TREE_INDENT_STEP}px`;
  item.title = e.path;
  item.dataset.path = e.path;
  if (isRoot) item.dataset.root = "true"; // 根节点标记：collapseAll/applyTreeFilter/键盘守卫据此豁免
  item.tabIndex = -1; // 可聚焦但不进 tab 序列（键盘导航手动管理）
  // UI-16：tree 模式（WAI-ARIA treeitem）。容器 #tree 的 role=tree 在 index.html 静态声明；
  // 目录的展开态用 aria-expanded（toggleDir/collapseAll 与 twisty 图标同源切换）；
  // 选中态用 aria-selected（selectEntry 与 .active 类同源切换）。
  item.setAttribute("role", "treeitem");
  item.setAttribute("aria-selected", "false");
  if (e.is_dir) item.setAttribute("aria-expanded", "false");

  const twisty = document.createElement("i");
  twisty.className = "twisty" + (e.is_dir ? " codicon codicon-chevron-right" : "");

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = e.name;

  if (e.is_dir) {
    // 目录只保留展开箭头 + 名称：无文件夹图标、无图标占位（更紧凑）。
    // 代价：目录名会比文件名靠左一个图标槽位（文件名前仍有类型图标）。
    item.append(twisty, name);
  } else {
    item.append(twisty, renderFileIcon(e.name), name);
  }

  // 目录级变更标记（P2：父目录含变更时高亮）
  if (e.is_dir && isGitRepoActive() && app.workspaceRoot) {
    const rel = relativePath(app.workspaceRoot, e.path);
    if (isGitDirtyDir(rel)) item.classList.add("git-dirty");
  }

  // Git 状态装饰（仅 git 仓库时渲染）
  if (!e.is_dir && isGitRepoActive() && app.workspaceRoot) {
    const rel = relativePath(app.workspaceRoot, e.path);
    const st = gitStatusOf(rel);
    if (st) {
      const badge = document.createElement("span");
      badge.className = gitBadgeClass(st);
      badge.textContent = st;
      // UI-09：保留原生 title（嵌套约束）。父级 .tree-item 按「截断披露」规则保留 title=e.path，
      // 而原生 title 沿祖先链继承解析——若此处改用 data-tip，悬停徽标时会与父级 title 双重提示。
      badge.title = gitStatusLabel(st);
      item.appendChild(badge);
    }
  }

  item.addEventListener("click", (ev) => {
    selectEntry(e, item, ev);
    if (e.is_dir && !ev.ctrlKey && !ev.shiftKey) void toggleDir(item, e, depth);
    // focusEditor=false：焦点留在树内，连续浏览/键盘漫游不被编辑器抢焦点（VSCode 式）
    else if (!e.is_dir && !ev.ctrlKey && !ev.shiftKey) void fh().openFile(e.path, undefined, { focusEditor: false });
  });
  item.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    // 右键时若未选中当前项，则单选它
    if (!selectedPaths.has(e.path)) selectEntry(e, item);
    // 根节点走背景菜单：只保留「在该目录下」的新建/粘贴/复制路径/终端，
    // 不给重命名/删除/复制/剪切——工作区根不可删改名，误操作代价极高
    showContextMenu(e, ev.clientX, ev.clientY, isRoot ? { background: true } : undefined);
  });
  // 拖拽支持（根节点不可拖拽：不能把工作区根移动到自己子目录）
  item.draggable = !isRoot;
  item.addEventListener("dragstart", (ev) => {
    ev.stopPropagation();
    if (!ev.dataTransfer) return;
    ev.dataTransfer.setData("text/plain", e.path);
    ev.dataTransfer.effectAllowed = "move";
  });
  if (e.is_dir) {
    item.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      item.classList.add("drag-over");
    });
    item.addEventListener("dragleave", (ev) => {
      ev.stopPropagation();
      item.classList.remove("drag-over");
    });
    item.addEventListener("drop", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      item.classList.remove("drag-over");
      const srcPath = ev.dataTransfer?.getData("text/plain");
      if (srcPath && srcPath !== e.path) void dropMoveFile(srcPath, e.path);
    });
  }
  return item;
}

/** 切换 twisty 箭头方向（codicon chevron 两态） */
function setTwisty(el: HTMLElement | null, expanded: boolean): void {
  if (!el) return;
  el.classList.toggle("codicon-chevron-right", !expanded);
  el.classList.toggle("codicon-chevron-down", expanded);
}

/** 展开/折叠目录（懒加载 + 登记 map 供局部刷新） */
async function toggleDir(item: HTMLElement, e: Entry, depth: number): Promise<void> {
  const twisty = item.querySelector(".twisty") as HTMLElement | null;
  const existing = dirContainers.get(e.path);
  if (existing) {
    existing.container.remove();
    dirContainers.delete(e.path);
    expandedDirs.delete(e.path);
    saveExpandedDirs(); // B 批：展开状态变更写穿持久化
    setTwisty(twisty, false);
    item.setAttribute("aria-expanded", "false"); // UI-16：与 twisty 图标同源
    return;
  }
  setTwisty(twisty, true);
  item.setAttribute("aria-expanded", "true"); // UI-16
  expandedDirs.add(e.path);
  saveExpandedDirs(); // B 批：展开状态变更写穿持久化
  const childContainer = document.createElement("div");
  childContainer.className = "tree-children";
  childContainer.setAttribute("role", "group"); // UI-16：treeitem 的子级分组
  childContainer.dataset.depth = String(depth + 1);
  item.insertAdjacentElement("afterend", childContainer);
  dirContainers.set(e.path, { container: childContainer, depth: depth + 1 });
  await buildDir(e.path, childContainer, depth + 1);
}

/** 局部刷新：重建受影响目录的已展开容器（不整树重载） */
export async function reloadDir(dirPath: string): Promise<void> {
  const st = dirContainers.get(dirPath);
  if (!st) return; // 未展开：下次展开时自然读到最新内容
  const normBase = dirPath.replace(/[\\/]+$/, "");
  for (const key of [...dirContainers.keys()]) {
    const nk = key.replace(/[\\/]+$/, "");
    if (nk === normBase || nk.startsWith(normBase + "\\") || nk.startsWith(normBase + "/")) {
      dirContainers.delete(key);
    }
  }
  st.container.textContent = "";
  await buildDir(dirPath, st.container, st.depth);
  dirContainers.set(dirPath, st);
}

/** 全部折叠（保留根目录，收起所有已展开子目录） */
function collapseAll(): void {
  for (const [path, st] of [...dirContainers.entries()]) {
    if (path === app.workspaceRoot) continue; // 保留根
    st.container.remove();
    dirContainers.delete(path);
    expandedDirs.delete(path);
  }
  saveExpandedDirs(); // B 批：全部折叠也落盘（下次打开工作区保持折叠态）
  // 重置所有 twisty 为收起态（UI-16：aria-expanded 一并复位）。
  // 根节点（data-root）豁免：它始终保持展开，是工作区的视觉锚点。
  treeEl.querySelectorAll<HTMLElement>(".tree-item.dir:not([data-root]) .twisty").forEach((el) => setTwisty(el, false));
  treeEl.querySelectorAll<HTMLElement>(".tree-item.dir:not([data-root])").forEach((el) => {
    el.setAttribute("aria-expanded", "false");
  });
}

/** 同步「显示隐藏文件」开关按钮的视觉态与提示——.active / data-tip / aria-label / aria-pressed 的单一来源。
 *
 *  UI-09 顺带修掉两个既有缺陷：
 *  1. 双重提示：index.html 上本按钮已带静态 data-tip，而这里又动态设 title，两个 tooltip 会同时弹出；
 *  2. 状态失同步：原先 toggleHiddenFiles 与 resetTreeState 各改一半状态——关闭工作区时
 *     resetTreeState 只把 showHiddenFiles 复位为 false，却不清 .active 与提示文案，
 *     导致按钮残留高亮、下次点击时视觉与真实状态相反。收敛到本函数后两处共用同一套写入。 */
function syncHiddenFilesBtn(): void {
  // 不用 $()：$ 在元素缺失时抛错，而本函数会在 closeWorkspace 路径上被调用，
  // 精简 DOM（如单测）环境下按钮可能不存在，此处按「无按钮则跳过」处理。
  const btn = document.getElementById("btn-tree-hidden");
  if (!btn) return;
  const tip = showHiddenFiles ? t("filetree.btn.hideHidden") : t("filetree.btn.showHidden");
  btn.classList.toggle("active", showHiddenFiles);
  btn.dataset.tip = tip;
  // 图标按钮：内部 <i> 带 aria-hidden，可访问名称须由 aria-label 承担；
  // 开关态用 aria-pressed 表达，与 .active 类同源写入，避免二者不一致。
  btn.setAttribute("aria-label", tip);
  btn.setAttribute("aria-pressed", String(showHiddenFiles));
}

/** 切换显示/隐藏隐藏文件 */
async function toggleHiddenFiles(): Promise<void> {
  showHiddenFiles = !showHiddenFiles;
  syncHiddenFilesBtn();
  await refreshTreeWithExpandedState();
}

/** 刷新树并恢复之前的展开状态 */
export async function refreshTreeWithExpandedState(): Promise<void> {
  if (!app.workspaceRoot) return;
  const prevExpanded = new Set(expandedDirs);
  // B 批：快照滚动位置——重建 DOM 会归零，展开态恢复了滚动也该恢复
  const scrollTop = treeEl.scrollTop;
  await refreshGitStatus();
  treeEl.textContent = "";
  dirContainers.clear();
  expandedDirs.clear();
  await renderRootNode();
  await restoreExpandedDirs(prevExpanded);
  saveExpandedDirs(); // 清掉已不存在的陈旧目录
  treeEl.scrollTop = scrollTop;
}

/** UI-16：选中态的单一写入点——.active 类（视觉）与 aria-selected（读屏）必须同源，
 *  散落两写必然漂移（第四批 syncHiddenFilesBtn 同款教训）。 */
function setTreeItemSelected(el: HTMLElement, selected: boolean): void {
  el.classList.toggle("active", selected);
  el.setAttribute("aria-selected", String(selected));
}

/** 选中树节点（支持 Ctrl 多选、Shift 范围选） */
function selectEntry(e: Entry, itemEl?: HTMLElement, ev?: MouseEvent): void {
  const ctrl = ev?.ctrlKey || ev?.metaKey;
  const shift = ev?.shiftKey;

  if (ctrl && itemEl) {
    // Ctrl+点击：切换选中状态
    if (selectedPaths.has(e.path)) {
      selectedPaths.delete(e.path);
      setTreeItemSelected(itemEl, false);
    } else {
      selectedPaths.add(e.path);
      setTreeItemSelected(itemEl, true);
    }
    selectedEntry = e;
    return;
  }

  if (shift && itemEl && selectedEntry) {
    // Shift+点击：范围选择
    const items = Array.from(treeEl.querySelectorAll<HTMLElement>(".tree-item"));
    const startEl = items.find((el) => el.dataset.path === selectedEntry!.path);
    const startIdx = startEl ? items.indexOf(startEl) : 0;
    const endIdx = items.indexOf(itemEl);
    const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
    selectedPaths.clear();
    clearTreeSelection();
    for (let i = lo; i <= hi; i++) {
      const p = items[i].dataset.path;
      if (p) selectedPaths.add(p);
      setTreeItemSelected(items[i], true);
    }
    selectedEntry = e;
    return;
  }

  // 普通点击：单选
  selectedPaths.clear();
  selectedPaths.add(e.path);
  selectedEntry = e;
  clearTreeSelection();
  if (itemEl) setTreeItemSelected(itemEl, true);
}

/** 清除全树选中高亮（.active 与 aria-selected 同步复位） */
function clearTreeSelection(): void {
  treeEl.querySelectorAll<HTMLElement>(".tree-item.active").forEach((el) => setTreeItemSelected(el, false));
}

/** 获取当前所有选中的 Entry */
function getSelectedEntries(): Entry[] {
  const entries: Entry[] = [];
  for (const p of selectedPaths) {
    const el = treeEl.querySelector<HTMLElement>(`.tree-item[data-path="${CSS.escape(p)}"]`);
    if (el) {
      const entry = entryFromEl(el);
      if (entry) entries.push(entry);
    }
  }
  return entries.length > 0 ? entries : (selectedEntry ? [selectedEntry] : []);
}

// ---------- 右键菜单 ----------

export interface CtxItem {
  label?: string;
  sep?: boolean;
  danger?: boolean;
  action?: () => void;
}

function showContextMenu(entry: Entry, x: number, y: number, opts?: { background?: boolean }): void {
  // 背景右键（树空白处，entry = 工作区根）：菜单只做「在该目录下」的操作。
  // 关键：不显示 重命名/删除/复制/剪切——它们作用于 selectedPaths，而背景右键与选中项无关，
  // 否则会把上一次的多选当成操作目标（复制路径三件套同理，由 contextPaths 兜底回 entry）。
  const background = opts?.background ?? false;
  const multi = !background && selectedPaths.size > 1;
  const items: CtxItem[] = [
    { label: t("filetree.menu.newFile"), action: () => createFileAt(entry) },
    { label: t("filetree.menu.newFolder"), action: () => createDirAt(entry) },
    { label: t("filetree.menu.newPyFile"), action: () => void createPyFileAt(entry) },
    { label: t("filetree.menu.newPyPackage"), action: () => void createPyPackageAt(entry) },
    { sep: true },
  ];
  if (fileClipboard) {
    items.push({ label: t("filetree.menu.paste"), action: () => pasteEntry(entry) }, { sep: true });
  }
  if (!background) {
    if (!multi) {
      items.push({ label: t("filetree.menu.rename"), action: () => renameEntry(entry) });
    }
    items.push(
      { label: multi ? t("filetree.menu.deleteMany", { count: selectedPaths.size }) : t("filetree.menu.delete"), danger: true, action: () => void deleteSelected() },
      { sep: true },
      { label: multi ? t("filetree.menu.copyMany", { count: selectedPaths.size }) : t("filetree.menu.copy"), action: () => copySelected() },
      { label: multi ? t("filetree.menu.cutMany", { count: selectedPaths.size }) : t("filetree.menu.cut"), action: () => cutSelected() },
    );
  }
  // 复制路径三件套（对齐 VSCode：Copy Name / Copy Relative Path / Copy Path）；
  // 多选时复制全部选中项，每行一个
  const targets = contextPaths(entry);
  items.push(
    { label: t("filetree.menu.copyName"), action: () => void copyPaths("name", targets) },
    { label: t("filetree.menu.copyRelPath"), action: () => void copyPaths("relative", targets) },
    { label: t("filetree.menu.copyAbsPath"), action: () => void copyPaths("full", targets) },
  );
  items.push(
    { sep: true },
    { label: t("filetree.menu.openTerminal"), action: () => void openTerminalAt(entry.is_dir ? entry.path : parentDirOf(entry.path)) },
    { label: t("filetree.menu.revealInExplorer"), action: () => revealEntry(entry) },
  );
  // E-3（PyCharm 调研）：本地历史入口下沉（Ctrl+Shift+H 已交付但不可发现——文件级历史对任意文件有意义）
  if (!entry.is_dir) {
    items.push({ label: t("filetree.menu.localHistory"), action: () => void openLocalHistory(entry.path) });
    items.push({ label: t("filetree.menu.diffClipboard"), action: () => void diffFileWithClipboard(entry.path) }); // C-5
  }
  // Markdown 预览（markdown preview dev plan §5-T4）：.md 文件右键「打开预览」= 打开 + 开启分栏
  if (!entry.is_dir && mdPreview.isMarkdownPath(entry.path)) {
    items.push(
      { sep: true },
      { label: t("filetree.menu.openPreview"), action: () => { mdPreview.setPreviewOpen(true); void fh().openFile(entry.path); } },
    );
  }
  // v3.4 §8（M3-3.4）：.py 文件右键「运行脚本」（顺带补上的可选入口）
  if (!entry.is_dir && (entry.path.endsWith(".py") || entry.path.endsWith(".pyw"))) {
    items.push(
      { sep: true },
      { label: t("filetree.menu.runScript"), action: () => handlers?.runScript(entry.path) },
    );
  }
  // P0-3：Git 操作进文件树右键（对标 VS Code / PyCharm）——暂存 / 打开差异 / Blame。
  // is_dir 不提供（整目录暂存易误操作，diff/blame 只对单文件有意义）。
  // 复核修正：gitStatusOf 的 key 与 relativePath 均为「小写归一化」路径——直接把它传给
  // git add / blame 在大小写敏感文件系统上会 pathspec 失配。此处先做大小写无关匹配，
  // 命中后改用 gitFiles 里的原始大小写路径。untracked（?）无 diff/blame 意义，只提供暂存。
  if (!entry.is_dir && isGitRepoActive() && app.workspaceRoot) {
    const rel = relativePath(app.workspaceRoot, entry.path);
    const code = gitStatusOf(rel);
    if (code !== undefined) {
      const exact = gitFileOriginalPath(rel);
      if (exact) {
        items.push(
          { sep: true },
          { label: code === "?" ? t("filetree.menu.stageNew") : t("filetree.menu.stageChanges"), action: () => void stageFiles([exact]) },
        );
        if (code !== "?") {
          items.push(
            { label: t("filetree.menu.openDiff"), action: () => void showDiffForPath(exact) },
            { label: t("filetree.menu.blame"), action: () => void showBlame(exact) },
          );
        }
      }
    }
    // E-4（PyCharm 调研）：Git 文件历史——对任何仓库内文件都有意义（含当前无改动的已跟踪文件）
    items.push({ label: t("filetree.menu.gitFileHistory"), action: () => void showFileHistory(relativePath(app.workspaceRoot!, entry.path)) });
  }

  renderCtxMenu(items, x, y);
}

/** 渲染右键菜单（通用：树/标签/分支共用）。C1 起为 menu.ts 的薄封装：
 *  CtxItem → MenuItem 映射后交给 showMenu，关闭接线已随渲染器收编到 menu.ts。 */
export function renderCtxMenu(items: CtxItem[], x: number, y: number): void {
  const mapped: MenuItem[] = items.map((it) => ({
    label: it.label,
    sep: it.sep,
    danger: it.danger,
    action: it.action,
  }));
  showMenu(mapped, { x, y });
}

export function hideContextMenu(): void {
  hideMenu();
}

// ---------- 输入模态（新建/重命名） ----------

/** 是否有任一模态框打开（打开时禁用文件树 F2/Del 快捷键）。
 * 模态多为懒创建（lt-modal 等随首次打开才建 DOM），必须用 getElementById——
 * $ 在元素缺失时抛「缺少元素」错（E2E 实测：未打开过 live-templates 时 F2 触发即崩）。 */
function anyModalOpen(): boolean {
  return [
    "confirm-modal",
    "env-modal",
    "settings-modal",
    "new-project-modal",
    "lt-modal",
    "surround-modal",
    "palette-modal",
  ].some((id) => {
    const m = document.getElementById(id);
    return m !== null && !m.classList.contains("hidden");
  });
}

/** 焦点是否位于可编辑控件（搜索框/过滤框等输入场景，应屏蔽文件树 F2/Del 快捷键） */
function isEditableFocused(): boolean {
  const el = document.activeElement;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

// ---------- 文件操作（P25-T02） ----------

/** 内联输入框：在树中指定位置创建输入行，返回用户输入（取消返回 null） */
function inlineInput(container: HTMLElement, beforeEl: HTMLElement | null, initial: string, depth: number, selectStem = false): Promise<string | null> {
  return new Promise((resolve) => {
    inlineInputActive = true;
    const row = document.createElement("div");
    row.className = "tree-item inline-input-row";
    // UI-16：借用 .tree-item 只为行高/内边距样式，它不是树节点（role=tree 容器里
    // 出现第二个 treeitem 语义会误导读屏），标 presentation；内部 input 语义不受影响
    row.setAttribute("role", "presentation");
    row.style.paddingLeft = `${TREE_INDENT_BASE + depth * TREE_INDENT_STEP}px`;
    const input = document.createElement("input");
    input.className = "inline-input";
    input.type = "text";
    input.autocomplete = "off";
    input.value = initial;
    input.spellcheck = false;
    row.appendChild(input);
    if (beforeEl) container.insertBefore(row, beforeEl);
    else container.appendChild(row);

    let finished = false;
    const finish = (val: string | null) => {
      if (finished) return;
      finished = true;
      inlineInputActive = false;
      row.remove();
      resolve(val);
    };
    input.title = t("filetree.inline.title");
    input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // 防止触发树快捷键
      if (e.key === "Enter") finish(input.value.trim() || null);
      else if (e.key === "Escape") finish(null);
    });
    // P1（UX 审查）：blur = 取消而非提交——原先点击别处会被误当作确认，
    // 半输入的文件名/新名直接落盘（误建文件 / 误重命名）。提交必须显式按 Enter。
    input.addEventListener("blur", () => finish(null));
    setTimeout(() => {
      input.focus();
      if (selectStem) {
        const dot = initial.lastIndexOf(".");
        input.setSelectionRange(0, dot > 0 ? dot : initial.length);
      } else {
        input.select();
      }
    }, 0);
  });
}

/** 确保目录已展开并返回其子容器与深度（内联输入定位用）。
 *  未展开则展开它（根节点恒在，普通目录走 toggleDir）；找不到节点时回落到树根。
 *  收敛四个 create* 的「取容器/深度」样板，并顺带处理「根节点被折叠时在其下新建」的定位。 */
async function ensureDirExpanded(path: string): Promise<{ container: HTMLElement; depth: number }> {
  const st = dirContainers.get(path);
  if (st) return st;
  const el = treeEl.querySelector<HTMLElement>(`.tree-item[data-path="${CSS.escape(path)}"]`);
  const entry = el ? entryFromEl(el) : null;
  if (el && entry?.is_dir) {
    await toggleDir(el, entry, depthOf(el));
    const st2 = dirContainers.get(path);
    if (st2) return st2;
  }
  return { container: treeEl, depth: 0 };
}

// ---------- E-3（PyCharm 调研）：文件树定位到当前文件 ----------

/** 在树中定位到指定路径：逐级展开父目录 → 滚动到可见 → 置为选中。
 *  节点未渲染（如新建后未刷新的文件）时先刷新其父目录再找一次。
 *  opts.switchView=false 时不强制切到 files 视图（自动跟随用；手动按钮入口保持切换）。 */
export async function revealInTree(path: string, opts?: { switchView?: boolean }): Promise<void> {
  if (!app.workspaceRoot) return;
  const rel = relativePathRaw(app.workspaceRoot, path);
  if (!rel) return; // 不在工作区内，无从定位
  if (opts?.switchView !== false) setSidebarTab("files");
  const parts = rel.split(/[\\/]/).filter(Boolean);
  let cur = app.workspaceRoot;
  for (const part of parts.slice(0, -1)) {
    cur = joinPath(cur, part);
    await ensureDirExpanded(cur);
  }
  let el = treeEl.querySelector<HTMLElement>(`.tree-item[data-path="${CSS.escape(path)}"]`);
  if (!el) {
    // 节点未渲染：先保证父目录展开（覆盖根节点折叠态 / 顶层文件——上面的逐级循环
    // 只处理中间目录，工作区直接子文件的 slice 结果为空不会触发展开），再局部刷新找一次
    await ensureDirExpanded(parentDirOf(path));
    await reloadDir(parentDirOf(path));
    el = treeEl.querySelector<HTMLElement>(`.tree-item[data-path="${CSS.escape(path)}"]`);
    if (!el) return;
  }
  const entry = entryFromEl(el);
  if (entry) selectEntry(entry, el); // 普通单选路径（无 ev 参数）
  el.scrollIntoView({ block: "nearest" });
}

/** 「滚动到当前文件」工具栏按钮入口：无活动文件时轻提示 */
export async function revealActiveFile(): Promise<void> {
  const tab = app.activeTab;
  if (!tab) {
    toast(t("filetree.reveal.noActiveFile"), "info");
    return;
  }
  await revealInTree(tab.path);
}

// ---------- B 批：切文件自动在树中定位（可关开关，localStorage 持久化） ----------

const TREE_FOLLOW_KEY = "pylume.tree_follow";
/** 默认开启；存 "0" 视为关闭（用户主动关过）。顶层取值兜底 try/catch——
 *  纯 Node 测试环境无 localStorage，import 不可即炸（CR-26 同款考虑） */
let followActiveFile = (() => {
  try {
    return localStorage.getItem(TREE_FOLLOW_KEY) !== "0";
  } catch {
    return true;
  }
})();
/** 跟随防抖 timer（域内私有状态）：快速连续切 tab（Ctrl+Tab 长按）只定位最后一个 */
let followTimer: number | null = null;

function syncFollowBtn(): void {
  // 无按钮则跳过（精简 DOM 环境 / closeWorkspace 路径，同 syncHiddenFilesBtn 处理）
  const btn = document.getElementById("btn-tree-follow");
  if (!btn) return;
  const tip = followActiveFile ? t("filetree.btn.followOn") : t("filetree.btn.followOff");
  btn.classList.toggle("active", followActiveFile);
  btn.dataset.tip = tip;
  btn.setAttribute("aria-label", tip);
  btn.setAttribute("aria-pressed", String(followActiveFile));
}

function toggleTreeFollow(): void {
  followActiveFile = !followActiveFile;
  try {
    localStorage.setItem(TREE_FOLLOW_KEY, followActiveFile ? "1" : "0");
  } catch {
    // 存储不可用：本次会话内仍生效
  }
  syncFollowBtn();
}

/** 切标签后由 main.ts::activateTab 调用（仅 files 视图可见时）：防抖 120ms 后自动定位 */
export function scheduleFollowReveal(): void {
  if (!followActiveFile) return;
  if (followTimer !== null) window.clearTimeout(followTimer);
  followTimer = window.setTimeout(() => {
    followTimer = null;
    const tab = app.activeTab;
    if (tab && tab.kind !== "diff") void revealInTree(tab.path, { switchView: false });
  }, 120);
}

/** 新建文件（内联输入，支持相对路径 pkg/mod.py；创建后立即打开） */
export async function createFileAt(entry: Entry): Promise<void> {
  const base = entry.is_dir ? entry.path : parentDirOf(entry.path);
  const { container, depth } = await ensureDirExpanded(base);
  const rel = await inlineInput(container, null, "", depth);
  if (!rel) return;
  const target = joinPath(base, rel);
  try {
    await invoke("create_file", { path: target });
  } catch (e) {
    console.error("新建文件失败", e);
    toastFail(t("filetree.menu.newFile"), e);
    return;
  }
  await reloadDir(base);
  await fh().openFile(target);
  await insertHeaderIfEnabled(target); // PR-K：新建 .py 时按设置插文件头模板
}

/** P1（UX 审查）：全局「新建文件」入口（键位 Ctrl+Alt+Insert / 工具栏按钮）。
 *  目标目录 = 活动文件所在目录（无活动文件时为工作区根）；目标目录的展开
 *  由 createFileAt → ensureDirExpanded 统一处理（含根节点折叠态），无需在此手动展开。
 *  setSidebarTab 经 views.ts 注入无环（views 零依赖）。 */
export async function createFileInteractive(): Promise<void> {
  if (!app.workspaceRoot) return;
  setSidebarTab("files"); // 输入框在树里，先保证文件视图可见
  const tab = app.activeTab;
  const base = tab ? parentDirOf(tab.path) : app.workspaceRoot;
  await createFileAt({ name: basename(base), path: base, is_dir: true });
}

/** 全局「新建文件夹」入口（工具栏按钮）：目标目录同 createFileInteractive（活动文件目录 / 工作区根）。 */
export async function createDirInteractive(): Promise<void> {
  if (!app.workspaceRoot) return;
  setSidebarTab("files");
  const tab = app.activeTab;
  const base = tab ? parentDirOf(tab.path) : app.workspaceRoot;
  await createDirAt({ name: basename(base), path: base, is_dir: true });
}

/** 新建文件夹（内联输入，支持嵌套路径） */
export async function createDirAt(entry: Entry): Promise<void> {
  const base = entry.is_dir ? entry.path : parentDirOf(entry.path);
  const { container, depth } = await ensureDirExpanded(base);
  const rel = await inlineInput(container, null, "", depth);
  if (!rel) return;
  const target = joinPath(base, rel);
  try {
    await invoke("create_dir", { path: target });
  } catch (e) {
    console.error("新建文件夹失败", e);
    toastFail(t("filetree.menu.newFolder"), e);
    return;
  }
  await reloadDir(base);
}

/** 新建 Python 文件（.py/.pyw）：自动补扩展名，创建后立即打开并按设置插 header 文件头（PR-K 门控） */
export async function createPyFileAt(entry: Entry): Promise<void> {
  const base = entry.is_dir ? entry.path : parentDirOf(entry.path);
  const { container, depth } = await ensureDirExpanded(base);
  const rel = await inlineInput(container, null, "", depth);
  if (!rel) return;
  const target = joinPath(base, ensurePyExtension(rel));
  try {
    await invoke("create_file", { path: target });
  } catch (e) {
    console.error("新建 Python 文件失败", e);
    toastFail(t("filetree.menu.newPyFile"), e);
    return;
  }
  await reloadDir(base);
  await fh().openFile(target);
  await insertHeaderIfEnabled(target);
}

/** PR-K：按设置对新建的 .py/.pyw 文件插入 header 模板（开关关/非 Python 文件为 no-op）。
 *  门控判定收敛到 newFileTemplate.ts 纯函数（普通新建/专属 Python 新建两入口共用）。 */
async function insertHeaderIfEnabled(target: string): Promise<void> {
  if (!headerTemplateApplies(target, app.settings.new_file_template === true)) return;
  app.editor.setPosition({ lineNumber: 1, column: 1 });
  await fh().insertHeaderTemplate();
}

/** 新建 Python 包：目录 + 空 __init__.py（后端原子命令）；不自动打开文件 */
export async function createPyPackageAt(entry: Entry): Promise<void> {
  const base = entry.is_dir ? entry.path : parentDirOf(entry.path);
  const { container, depth } = await ensureDirExpanded(base);
  const rel = await inlineInput(container, null, "", depth);
  if (!rel) return;
  const target = joinPath(base, stripPyExtension(rel));
  try {
    await invoke("create_py_package", { path: target });
  } catch (e) {
    console.error("新建 Python 包失败", e);
    toastFail(t("filetree.menu.newPyPackage"), e);
    return;
  }
  await reloadDir(base);
}

/** 重命名（内联输入，磁盘层面 + 树刷新 + 标签联动） */
async function renameEntry(entry: Entry): Promise<void> {
  // 工作区根不可重命名（F2 选中根节点时守卫；右键背景菜单本就不给重命名）
  if (app.workspaceRoot && samePath(entry.path, app.workspaceRoot)) return;
  const oldPath = entry.path;
  const itemEl = treeEl.querySelector<HTMLElement>(`.tree-item[data-path="${CSS.escape(oldPath)}"]`);
  if (!itemEl) return;
  const container = itemEl.parentElement!;
  const depth = depthOf(itemEl);

  const rel = await inlineInput(container, itemEl, entry.name, depth, true);
  if (!rel || rel === entry.name) return;
  const newPath = joinPath(parentDirOf(oldPath), rel);
  try {
    await invoke("rename_path", { oldPath, newPath });
  } catch (e) {
    console.error("重命名失败", e);
    toastFail(t("filetree.menu.rename"), e);
    return;
  }
  await handleRenameLinks(oldPath, newPath);
  await reloadDir(parentDirOf(oldPath));
  if (selectedEntry) selectedEntry = { ...selectedEntry, path: newPath, name: rel };
  selectedPaths.delete(oldPath);
  selectedPaths.add(newPath);
}

/**
 * T03 重命名联动：磁盘改名已完成，这里迁移打开中的标签路径 + LSP didClose/didOpen
 * + 诊断缓存 key。内容不重新读盘（文件仍在磁盘，model 内容不变）。
 * 支持目录重命名：其下所有打开文件路径一起迁移。
 */
async function handleRenameLinks(oldPath: string, newPath: string): Promise<void> {
  const normOld = oldPath.replace(/[\\/]+$/, "");
  const matches = app.tabs.filter(
    (t) =>
      t.path === oldPath ||
      t.path.startsWith(normOld + "\\") ||
      t.path.startsWith(normOld + "/"),
  );
  for (const t of matches) {
    const oldTabPath = t.path;
    const newTabPath = newPath + oldTabPath.slice(oldPath.length);
    lsp.didClose(oldTabPath); // 关闭旧路径（引擎侧）
    lsp.migrateDiagnostics(oldTabPath, newTabPath); // 诊断缓存 key 迁移
    t.path = newTabPath;
    lsp.markModelPath(t.model, newTabPath);
    lsp.didOpen(newTabPath, t.model); // 以新路径重开（内容不变）
    if (app.pendingChanges.has(oldTabPath)) {
      const ch = app.pendingChanges.get(oldTabPath) ?? [];
      app.pendingChanges.delete(oldTabPath);
      app.pendingChanges.set(newTabPath, ch);
    }
    if (app.activeTab === t) statusFileEl.textContent = newTabPath;
  }
  fh().renderTabs();
}

/** 复制选中项到内部剪贴板 */
function copySelected(): void {
  const paths = [...selectedPaths];
  if (paths.length === 0 && selectedEntry) paths.push(selectedEntry.path);
  fileClipboard = { paths, mode: "copy" };
}

/** 剪切选中项 */
function cutSelected(): void {
  const paths = [...selectedPaths];
  if (paths.length === 0 && selectedEntry) paths.push(selectedEntry.path);
  fileClipboard = { paths, mode: "cut" };
  // 视觉上标记被剪切的项
  treeEl.querySelectorAll(".tree-item.cut").forEach((el) => el.classList.remove("cut"));
  for (const p of paths) {
    const el = treeEl.querySelector<HTMLElement>(`.tree-item[data-path="${CSS.escape(p)}"]`);
    el?.classList.add("cut");
  }
}

/** 粘贴（复制模式：同名加副本；剪切模式：移动） */
async function pasteEntry(entry: Entry): Promise<void> {
  if (!fileClipboard) return;
  const targetDir = entry.is_dir ? entry.path : parentDirOf(entry.path);
  const srcPaths = fileClipboard.paths;
  const mode = fileClipboard.mode;

  // UX P0-2：剪切（移动）不支持覆盖——目标目录已存在同名项时先拦截并提示，
  // 而不是让 rename_path 逐个报错后才知情（复制模式后端自动加「副本」，无同名冲突）。
  let moves = srcPaths;
  if (mode === "cut") {
    const skipped: string[] = [];
    moves = [];
    for (const src of srcPaths) {
      const name = basename(src);
      // 原地粘贴（目标 = 源位置）：不算同名冲突，交给循环内 src === dst 的跳过逻辑
      if (await dirHasEntry(targetDir, name) && !samePath(joinPath(targetDir, name), src)) skipped.push(name);
      else moves.push(src);
    }
    if (skipped.length > 0) {
      toast(t("filetree.op.pasteSkipped", { names: skipped.join("、") }));
    }
    if (moves.length === 0) return; // 全部被跳过：剪贴板与 .cut 标记保持原状
  }

  const failed: string[] = [];
  for (const src of moves) {
    try {
      if (mode === "cut") {
        const newName = basename(src);
        const dst = joinPath(targetDir, newName);
        if (src === dst) continue;
        await invoke("rename_path", { oldPath: src, newPath: dst });
        await handleRenameLinks(src, dst);
      } else {
        await invoke<string>("paste_path", { src, dstDir: targetDir });
      }
    } catch (e) {
      console.error("粘贴失败", src, e);
      failed.push(basename(src));
    }
  }
  // UX P0-1：部分失败要有汇总反馈（原先只 console.error，用户以为粘贴成功）
  if (failed.length > 0) toast(t("filetree.op.pasteFailed", { count: failed.length, names: failed.join("、") }), "error");

  // 剪切完成后清除剪贴板和视觉标记
  if (mode === "cut") {
    fileClipboard = null;
    treeEl.querySelectorAll(".tree-item.cut").forEach((el) => el.classList.remove("cut"));
    // 刷新源目录
    const srcDirs = new Set(srcPaths.map((p) => parentDirOf(p)));
    for (const d of srcDirs) {
      if (dirContainers.has(d)) await reloadDir(d);
    }
  }
  // 刷新目标目录
  await reloadDir(targetDir);
}

/** 删除所有选中项 */
async function deleteSelected(): Promise<void> {
  // 工作区根不可删除（Delete 选中根节点时守卫；右键背景菜单本就不给删除）
  const entries = getSelectedEntries().filter(
    (e) => !(app.workspaceRoot && samePath(e.path, app.workspaceRoot)),
  );
  if (entries.length === 0) return;
  // 确认语两句手工拼装（不走 apply_ts 映射）：词条含 \n 会在语言包 JSON/TS 转义链路里失真成字面 "\n"
  const msg = entries.length === 1
    ? `${t("filetree.delete.confirmOne", { path: entries[0].path })}\n${t("filetree.delete.recycleHint")}`
    : `${t("filetree.delete.confirmMany", { count: entries.length })}\n${t("filetree.delete.recycleHint")}`;
  const ok = await openConfirm({ message: msg, okLabel: t("filetree.menu.delete"), kind: "danger" });
  if (!ok) return;

  const affectedDirs = new Set<string>();
  const failed: string[] = [];
  for (const entry of entries) {
    try {
      await invoke("trash_path", { path: entry.path });
    } catch (e) {
      console.error("删除失败", entry.path, e);
      failed.push(basename(entry.path));
      continue;
    }
    // 关闭打开中的标签
    for (const t of [...app.tabs]) {
      if (t.path === entry.path || t.path.startsWith(entry.path + "\\") || t.path.startsWith(entry.path + "/")) {
        fh().closeTabSilent(t);
      }
    }
    affectedDirs.add(parentDirOf(entry.path));
  }
  selectedPaths.clear();
  selectedEntry = null;
  // UX P0-1：失败项要有可见反馈
  if (failed.length > 0) toast(t("filetree.op.deleteFailed", { count: failed.length, names: failed.join("、") }), "error");
  for (const d of affectedDirs) {
    if (dirContainers.has(d)) await reloadDir(d);
  }
}

/** 目标目录下是否已存在同名项（Windows 文件系统大小写不敏感，比较归一小写）。
 *  UX P0-2：移动/剪切不支持覆盖，冲突在动手前拦截并提示。目录读不到时返回 false，
 *  让后续 rename_path 自己报错（走 toastFail，不吞真实原因）。 */
async function dirHasEntry(dir: string, name: string): Promise<boolean> {
  try {
    const entries = await invoke<Entry[]>("read_dir", { path: dir, showHidden: true });
    const lower = name.toLowerCase();
    return entries.some((e) => e.name.toLowerCase() === lower);
  } catch {
    return false;
  }
}

/** 拖拽移动文件到目标目录 */
async function dropMoveFile(srcPath: string, targetDirPath: string): Promise<void> {
  // 不能移动到自身或自身的子目录（UX P0-2：原先静默拒绝，用户不知道拖拽为什么没生效）
  if (srcPath === targetDirPath) return;
  if (targetDirPath.startsWith(srcPath + "\\") || targetDirPath.startsWith(srcPath + "/")) {
    toast(t("filetree.op.moveIntoSelf"));
    return;
  }
  const newName = basename(srcPath);
  const dst = joinPath(targetDirPath, newName);
  if (srcPath === dst) return;
  // UX P0-2：目标同名先拦截（移动不支持覆盖）
  if (await dirHasEntry(targetDirPath, newName)) {
    toast(t("filetree.op.moveExists", { name: newName }));
    return;
  }
  try {
    await invoke("rename_path", { oldPath: srcPath, newPath: dst });
  } catch (e) {
    console.error("拖拽移动失败", e);
    toastFail(t("filetree.op.dropMove"), e);
    return;
  }
  await handleRenameLinks(srcPath, dst);
  const srcDir = parentDirOf(srcPath);
  if (dirContainers.has(srcDir)) await reloadDir(srcDir);
  if (dirContainers.has(targetDirPath)) await reloadDir(targetDirPath);
}

/** 当前右键操作的目标路径：多选且右键项确在选中集内时取全部选中项，否则只取该 entry。
 * 「在选中集内」的判定是必须的：树空白处右键（entry = 工作区根）不经过 selectEntry，
 * selectedPaths 会残留上一次多选，若只看 size>1 会把旧选中项当成复制目标。 */
function contextPaths(entry: Entry): string[] {
  return selectedPaths.size > 1 && selectedPaths.has(entry.path) ? [...selectedPaths] : [entry.path];
}

/** 复制路径三件套：文件名 / 相对路径 / 绝对路径；多选时每行一个（对齐 VSCode） */
async function copyPaths(kind: "name" | "relative" | "full", paths: string[]): Promise<void> {
  const texts = paths.map((p) => {
    if (kind === "name") return basename(p);
    if (kind === "full") return p;
    return relativePathOrName(app.workspaceRoot, p);
  });
  try {
    await invoke("copy_to_clipboard", { text: texts.join("\n") });
  } catch (e) {
    console.error("复制路径失败", e);
    toastFail(t("filetree.op.copyPath"), e);
  }
}

/** 在资源管理器中显示并选中 */
async function revealEntry(entry: Entry): Promise<void> {
  try {
    await invoke("reveal_in_explorer", { path: entry.path });
  } catch (e) {
    console.error("打开资源管理器失败", e);
    toastFail(t("filetree.op.revealExplorer"), e);
  }
}

// ---------- 事件接线 ----------

/** 接线文件树全部交互：工具栏按钮 + 过滤框 + 树全局事件（原 init 内片段 + wireFileTreeEvents） */
export function wireFileTree(): void {
  // 语言切换时重绘本域持久文案（与 git.ts 同款约定）：
  // 右键菜单/toast 是点击时经 t() 现算的，无需处理；持久的是按钮 tip/aria 与树内「（空）」占位。
  onLocaleChange(() => {
    syncHiddenFilesBtn();
    syncFollowBtn();
    if (app.workspaceRoot && !isTreeEmpty()) void refreshTreeWithExpandedState();
  });

  // 文件树工具栏按钮（新建文件/文件夹放最左，对齐 VS Code explorer 工具栏的可见入口）
  $("btn-tree-new-file").addEventListener("click", () => void createFileInteractive());
  $("btn-tree-new-folder").addEventListener("click", () => void createDirInteractive());
  $("btn-tree-refresh").addEventListener("click", () => void refreshTreeWithExpandedState());
  $("btn-tree-collapse").addEventListener("click", collapseAll);
  $("btn-tree-reveal").addEventListener("click", () => void revealActiveFile()); // E-3
  $("btn-tree-follow").addEventListener("click", () => toggleTreeFollow()); // B 批：自动定位开关
  syncFollowBtn(); // 恢复上次会话的开关视觉态（aria-pressed / .active / data-tip）
  $("btn-tree-hidden").addEventListener("click", () => void toggleHiddenFiles());
  // 文件树过滤
  const filterInput = $("tree-filter-input") as HTMLInputElement;
  filterInput.addEventListener("input", () => {
    treeFilter = filterInput.value.trim();
    applyTreeFilter();
  });
  filterInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      filterInput.value = "";
      treeFilter = "";
      applyTreeFilter();
      filterInput.blur();
    }
    e.stopPropagation(); // 防止触发树快捷键
  });
  wireFileTreeEvents();
}

/** 树全局事件：空白处右键（根级新建）、F2/Del、菜单点击外部关闭、键盘导航 */
function wireFileTreeEvents(): void {
  // 树空白处右键 → 背景菜单：只做工作区根目录级操作（新建/粘贴/复制路径/终端），
  // 不涉及当前选中项，避免误用残留的多选目标
  treeEl.addEventListener("contextmenu", (ev) => {
    if (ev.target === treeEl && app.workspaceRoot) {
      ev.preventDefault();
      showContextMenu(
        { name: basename(app.workspaceRoot), path: app.workspaceRoot, is_dir: true },
        ev.clientX, ev.clientY,
        { background: true },
      );
    }
  });
  // 树容器级拖放：拖到空白处 = 移动到工作区根目录
  treeEl.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
  });
  treeEl.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const srcPath = ev.dataTransfer?.getData("text/plain");
    if (srcPath && app.workspaceRoot) {
      void dropMoveFile(srcPath, app.workspaceRoot);
    }
  });
  // 右键菜单的关闭接线已随渲染器收编到 menu.ts（document click + Escape），此处不再重复接线。
  window.addEventListener("keydown", (e) => {
    // 模态/内联输入框打开时不处理文件树快捷键
    if (anyModalOpen() || inlineInputActive) return;
    const inEditor = !!document.activeElement?.closest(".monaco-editor");
    if (inEditor) return;
    // 焦点在输入控件（如搜索框）时不触发文件树快捷键：
    // 否则选中过文件后在搜索框按 Delete 会误弹删除确认、F2 会误触重命名
    if (isEditableFocused()) return;

    // 树键盘导航（焦点在树内或无选中时）
    const treeFocused = treeEl.contains(document.activeElement) || document.activeElement === treeEl;
    if (treeFocused && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(e.key)) {
      e.preventDefault();
      handleTreeKeyNav(e.key);
      return;
    }

    if (!selectedEntry) return;
    if (e.key === "F2") {
      e.preventDefault();
      void renameEntry(selectedEntry);
    } else if (e.key === "Delete") {
      e.preventDefault();
      void deleteSelected();
    }
  });
  // 树容器聚焦时支持键盘导航
  treeEl.tabIndex = 0;
  treeEl.addEventListener("keydown", (e) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(e.key)) {
      e.preventDefault();
      handleTreeKeyNav(e.key);
    }
  });
}

/** 树键盘导航：↑↓ 移动焦点、→ 展开、← 折叠、Enter 打开 */
function handleTreeKeyNav(key: string): void {
  const items = Array.from(treeEl.querySelectorAll<HTMLElement>(".tree-item"));
  if (items.length === 0) return;

  const current = document.activeElement?.closest(".tree-item") as HTMLElement | null;
  const idx = current ? items.indexOf(current) : -1;

  switch (key) {
    case "ArrowDown": {
      const next = items[Math.min(idx + 1, items.length - 1)] ?? items[0];
      focusTreeItem(next);
      break;
    }
    case "ArrowUp": {
      const prev = items[Math.max(idx - 1, 0)] ?? items[0];
      focusTreeItem(prev);
      break;
    }
    case "ArrowRight": {
      if (!current) break;
      const entry = entryFromEl(current);
      if (entry?.is_dir && !dirContainers.has(entry.path)) {
        void toggleDir(current, entry, depthOf(current));
      }
      break;
    }
    case "ArrowLeft": {
      if (!current) break;
      const entry = entryFromEl(current);
      if (entry?.is_dir && dirContainers.has(entry.path)) {
        void toggleDir(current, entry, depthOf(current));
      }
      break;
    }
    case "Enter": {
      if (!current) break;
      const entry = entryFromEl(current);
      if (entry) {
        selectEntry(entry, current);
        if (entry.is_dir) void toggleDir(current, entry, depthOf(current));
        else void fh().openFile(entry.path, undefined, { focusEditor: false }); // 键盘漫游：焦点留在树内
      }
      break;
    }
  }
}

/** 聚焦树节点并同步选中状态 */
function focusTreeItem(el: HTMLElement): void {
  el.focus();
  const entry = entryFromEl(el);
  if (entry) selectEntry(entry, el);
}

/** 从 DOM 元素反查 Entry（通过 dataset.path） */
function entryFromEl(el: HTMLElement): Entry | null {
  const path = el.dataset.path;
  if (!path) return null;
  const name = basename(path);
  const isDir = el.classList.contains("dir");
  return { name, path, is_dir: isDir };
}

/** 获取树节点的深度（通过 paddingLeft 反推） */
function depthOf(el: HTMLElement): number {
  const pl = parseInt(el.style.paddingLeft || "8", 10);
  return Math.max(0, Math.round((pl - TREE_INDENT_BASE) / TREE_INDENT_STEP));
}

// ---------- 文件树过滤 ----------

/** 应用过滤：隐藏名称不匹配的节点（目录若有匹配子项则保留） */
function applyTreeFilter(): void {
  const keyword = treeFilter.toLowerCase();
  const items = treeEl.querySelectorAll<HTMLElement>(".tree-item");
  if (!keyword) {
    // 清除过滤：显示所有
    items.forEach((el) => el.classList.remove("filtered-out"));
    treeEl.querySelectorAll(".tree-empty.filtered-out").forEach((el) => el.classList.remove("filtered-out"));
    return;
  }
  // 先标记所有项（根节点恒显，不参与过滤——否则过滤词不匹配文件夹名时整树会被隐藏）
  for (const item of items) {
    if (item.dataset.root === "true") continue;
    const name = item.querySelector(".name")?.textContent?.toLowerCase() ?? "";
    const match = name.includes(keyword);
    item.classList.toggle("filtered-out", !match);
  }
  // 目录：若其子容器内有匹配项，则目录本身也显示
  for (const [dirPath, st] of dirContainers) {
    if (dirPath === app.workspaceRoot) continue;
    const hasVisibleChild = st.container.querySelector(".tree-item:not(.filtered-out)");
    if (hasVisibleChild) {
      const dirEl = treeEl.querySelector<HTMLElement>(`.tree-item[data-path="${CSS.escape(dirPath)}"]`);
      dirEl?.classList.remove("filtered-out");
    }
  }
}

// ---------- 供 main.ts 查询/复位 ----------

/** 目录是否已展开（文件监听增量刷新用） */
export function isDirExpanded(dirPath: string): boolean {
  return dirContainers.has(dirPath);
}

/** 树是否为空（首次监听整树刷新判定用） */
export function isTreeEmpty(): boolean {
  return treeEl.children.length === 0;
}

/** 关闭工作区时复位文件树状态（由 main.ts closeWorkspace 调用） */
export function resetTreeState(): void {
  showHiddenFiles = false;
  syncHiddenFilesBtn(); // UI-09：同步复位按钮的 .active / 提示 / aria 态（此前遗漏，详见该函数注释）
  expandedDirs.clear();
  if (followTimer !== null) {
    window.clearTimeout(followTimer); // 工作区已关：挂起的自动定位作废（revealInTree 也会自行早退）
    followTimer = null;
  }
  treeEl.textContent = "";
  dirContainers.clear();
}
