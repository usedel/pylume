// Git 功能域（TD-007 迁出 main.ts）：git 状态缓存 / 状态栏 / SCM 变更面板 /
// 暂存与提交 / diff 视图 / 远程操作与 stash / 历史与 blame / 分支面板。
// 反馈通道分工（memory 61552154 决议）：命令回显与流式输出留输出面板（审计），
// 操作失败即时反馈走 toastFail（git 面板常遮挡底部，仅输出面板时用户无感知）；
// 提交详情 / blame 渲染进独立「Git」底部标签，不再 clearOutput 侵占输出面板。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { app, $, $btn, outputEl, type Tab } from "./state";
import { basename, codicon, emptyState, errMsg, languageOf, gitBadgeClass, gitLineClass, joinPath, normalizePath, renderFileIcon, setBusy } from "./util";
import { appendOutputLine } from "./output";
import { refreshTreeWithExpandedState } from "./fileTree";
import { setBottomTab } from "./termUi";
import { setSidebarTab } from "./views";
import { motionDisabled } from "./anim"; // UI-11：diff 编辑器不走 buildEditorOptions，需单独接管光标闪烁
import { gotoFromLink } from "./tracebackLink"; // TD-14：gotoFromLink 迁出 main，逐边解环（TD-13）
import { toast, toastFail } from "./toast";
import { onLocaleChange, t } from "./i18n";
import { localizeBackendError } from "./i18n/backendError"; // 输出到面板的 Rust 错误原文是中文，英文界面下要过一层
import { showMenu, type MenuAnchor, type MenuItem } from "./menu";
import { openChoice, openConfirm, openPrompt } from "./dialog";
import { buildMergedContent, parseMergeSegments, type MergeChoice, type MergeSegment } from "./gitMerge";
import { refreshGitGutter } from "./gitGutter"; // 迭代 2 · P0-5：状态刷新后联动行级装饰
import { formatPythonSource } from "./format"; // 迭代 5 · P2-8：提交前 ruff format

/** 从磁盘重载已打开文件到编辑器（main.ts 注入；丢弃更改后刷新已打开 tab 用） */
let reloadOpenedFile: ((path: string) => Promise<void>) | null = null;

/** main.ts 注入「重载已打开文件」handler（避免 git → main 循环依赖） */
export function setGitReloadHandler(fn: (path: string) => Promise<void>): void {
  reloadOpenedFile = fn;
}

/** 打开文件到编辑器（main.ts 注入；冲突项「手动解决」用） */
let openFileHandler: ((path: string) => Promise<void>) | null = null;

/** main.ts 注入「打开文件」handler（避免 git → main 循环依赖） */
export function setGitOpenFileHandler(fn: (path: string) => Promise<void>): void {
  openFileHandler = fn;
}

/** git 改写编辑器缓冲的能力注入（main.ts 实现）。autosave 与 git 的次序问题：
 *  丢弃/批量改写若不先落盘（或关闭）dirty tab，在途 autosave 计时器会把编辑器
 *  旧缓冲写回磁盘，让 checkout 结果「复活」（丢弃看起来失败）。 */
export interface GitEditorBridge {
  /** git 改写磁盘前保存指定脏文件（autosave 语义：只写内容，不跑 ruff isort/format） */
  saveTabsBeforeGit(absPaths: string[]): Promise<void>;
  /** 未跟踪文件被丢弃删除后关闭其编辑器 tab（关闭前先留本地历史快照，防丢内容） */
  closeTabOf(absPath: string): void;
  /** autosave 开启时的批量改写（pull/merge/checkout…）：dirty tab 留本地历史后强制重载 */
  reloadDirtyWithHistory(absPath: string): Promise<void>;
}

let editorBridge: GitEditorBridge | null = null;

/** main.ts 注入 GitEditorBridge */
export function setGitEditorBridge(bridge: GitEditorBridge | null): void {
  editorBridge = bridge;
}
// CR-25：状态存储下沉到零依赖的 gitStatusState（fileTree 装饰只读，不再 import 本模块）
import { gitStatuses, gitDirtyDirs, gitRepoActive, rebuildStatusIndex } from "./gitStatusState";

// ---------- 域内状态 ----------

/** Git 变更文件条目（后端 git_status 返回） */
export interface GitStatusFile { path: string; x: string; y: string; code: string }

/** Git 变更文件列表（SCM 面板用） */
let gitFiles: GitStatusFile[] = [];
/** 当前分支名（非 git 仓库或 detached 时为 null） */
let currentBranch: string | null = null;
/** 本地/远程分支列表（SCM 分支条用；迭代 3 · B8 加 remote） */
let gitBranches: { name: string; current: boolean; remote: boolean }[] = [];

let diffEditor: MonacoApi.editor.IStandaloneDiffEditor | null = null;
let diffOriginalModel: MonacoApi.editor.ITextModel | null = null;
let diffModifiedModel: MonacoApi.editor.ITextModel | null = null;
/** 当前 diff 视图展示的文件路径（Blame 入口） */
let diffFilePath: string | null = null;
/** 当前 diff 是否为冲突文件（非 null 时显示「当前 vs 传入」+ 接受按钮） */
let diffConflictPath: string | null = null;
/** diff 布局：并排（默认）/ 内联 */
let diffSideBySide = true;
/** diff 折叠未更改区域开关 */
let diffHideUnchanged = false;
/** P0.5-B4：远程操作互斥锁（push/pull/fetch 进行中时忽略后续触发，防并发 git 进程） */
let gitRemoteBusy = false;
/** P1-3：冲突 diff 编辑态（modified 侧内容变更监听器；有变更时显示「应用编辑结果」） */
let conflictEditHandler: MonacoApi.IDisposable | null = null;

// P2-6（2026-09-29 review）：git-diff-editor 不能用 lazyEl——它作为**参数**传给
// Monaco createDiffEditor（Proxy 非 Node，DOM/组件库的 instanceof 检查会抛
// TypeError，见 dialog.ts 同款踩坑注释）。改为 ensureDiffEditor 内现取真元素
//（懒创建时机本就在首次查看 diff，测试环境不触发）。

// ---------- Git 状态 ----------

/** CR-20：git 状态刷新令牌——响应乱序时旧结果不得覆盖新结果（SCM 面板显示过时暂存态） */
let gitStatusToken = 0;

/** 刷新 git 状态（非 git 仓库时静默跳过）；传入 paths 时按子集增量刷新（TD-002） */
export async function refreshGitStatus(paths?: string[]): Promise<void> {
  if (!app.workspaceRoot) {
    gitStatusToken++; // 作废在途请求
    gitStatuses.clear();
    gitFiles = [];
    gitRepoActive.value = false;
    currentBranch = null;
    gitDirtyDirs.clear();
    updateGitStatusBar();
    return;
  }
  const token = ++gitStatusToken;
  try {
    const scoped = paths && paths.length > 0 ? paths : null;
    const result = await invoke<{ files: GitStatusFile[]; is_git: boolean; current_branch: string | null }>(
      "git_status",
      { root: app.workspaceRoot, paths: scoped },
    );
    if (token !== gitStatusToken) return; // 已有更新一轮的刷新，丢弃旧结果
    gitRepoActive.value = result.is_git;
    currentBranch = result.current_branch ?? null;
    if (scoped && gitRepoActive.value && gitFiles.length > 0) {
      // 增量：移除命中查询路径（目录前缀）的旧记录，再合并最新结果
      const kept = gitFiles.filter(
        (f) => !scoped.some((p) => f.path === p || f.path.startsWith(p + "/")),
      );
      const keptPaths = new Set(kept.map((f) => f.path));
      gitFiles = [...kept];
      for (const f of result.files) {
        if (!keptPaths.has(f.path)) gitFiles.push(f);
      }
      gitFiles.sort((a, b) => a.path.localeCompare(b.path));
      gitStatuses.clear();
      for (const f of gitFiles) gitStatuses.set(f.path, f.code);
      rebuildStatusIndex();
    } else {
      gitFiles = result.files;
      gitStatuses.clear();
      for (const f of gitFiles) gitStatuses.set(f.path, f.code);
      rebuildStatusIndex();
    }
    rebuildGitDirtyDirs();
  } catch {
    gitStatuses.clear();
    rebuildStatusIndex();
    gitFiles = [];
    gitRepoActive.value = false;
    currentBranch = null;
    gitDirtyDirs.clear();
  }
  updateGitStatusBar();
  refreshGitGutter(); // 迭代 2 · P0-5：状态变化后活动文件的行级装饰即时更新
}

/** 更新状态栏当前分支显示（迭代 3 · P0-4：可点击 + 同步计数 ↑n ↓m） */
export function updateGitStatusBar(): void {
  const el = $("status-git");
  if (!el) return;
  if (gitRepoActive.value && currentBranch) {
    el.replaceChildren(codicon("git-branch"), ` ${currentBranch}`);
    el.classList.add("git-status-clickable");
    el.dataset.tip = t("git.branch.currentTip");
    el.setAttribute("aria-label", t("git.branch.currentAria", { branch: currentBranch }));
    // 同步计数异步补充（ahead/behind）
    void updateSyncCount();
  } else {
    el.textContent = "";
    el.classList.remove("git-status-clickable");
    delete el.dataset.tip;
    el.removeAttribute("aria-label");
  }
}

/** 拉取 ahead/behind 并追加到状态栏（↑待推 ↓待拉，对标 VS Code ↑2 ↓1） */
async function updateSyncCount(): Promise<void> {
  const el = $("status-git");
  if (!el || !app.workspaceRoot || !gitRepoActive.value) return;
  try {
    const s = await invoke<{ upstream: string | null; ahead: number; behind: number }>("git_sync_status", {
      root: app.workspaceRoot,
    });
    if (!gitRepoActive.value || !currentBranch) return; // 等待期间仓库已切走
    const parts: Node[] = [codicon("git-branch"), document.createTextNode(` ${currentBranch}`)];
    if (s.ahead > 0) parts.push(document.createTextNode(` ↑${s.ahead}`));
    if (s.behind > 0) parts.push(document.createTextNode(` ↓${s.behind}`));
    el.replaceChildren(...parts);
    el.dataset.tip = s.upstream
      ? t("git.branch.statusTip", { upstream: s.upstream, ahead: s.ahead, behind: s.behind })
      : t("git.branch.statusNoUpstream");
  } catch { /* 无上游或查询失败：保持纯分支名 */ }
}

/** 由变更文件列表重建「有变更的目录」集合（向上冒泡所有父目录） */
function rebuildGitDirtyDirs(): void {
  gitDirtyDirs.clear();
  for (const f of gitFiles) {
    let i = f.path.lastIndexOf("/");
    while (i > 0) {
      gitDirtyDirs.add(f.path.slice(0, i));
      i = f.path.lastIndexOf("/", i - 1);
    }
  }
}

// isGitRepoActive / gitStatusOf / isGitDirtyDir 已下沉到 gitStatusState.ts（CR-25）

// ---------- SCM 面板（Git 变更列表 / 暂存 / 提交 / diff） ----------

/** 判断文件是否已暂存（未跟踪与冲突视作未暂存） */
function gitFileStaged(f: GitStatusFile): boolean {
  if (f.code === "?" || f.code === "!") return false;
  return f.x !== " ";
}

// ---------- E-4（PyCharm 调研）：提交信息预填文件名 ----------

let lastPrefill = "";

/** 仅暂存单文件时，提交框预填该文件名（可编辑——后续输入即覆盖）。
 *  框非空永不覆盖（不动用户正在写的信息）；暂存数不再是 1 且框内仍是上次的自动预填值时清掉。 */
function prefillCommitMessage(staged: GitStatusFile[]): void {
  const msgEl = $("git-commit-msg") as HTMLTextAreaElement;
  if (staged.length === 1) {
    if (!msgEl.value.trim()) {
      const name = basename(staged[0].path);
      msgEl.value = name;
      lastPrefill = name;
    }
  } else if (lastPrefill && msgEl.value === lastPrefill) {
    msgEl.value = "";
    lastPrefill = "";
  }
}

/** 渲染 SCM 变更列表（按「已暂存 / 更改」分组） */
export function renderGitPanel(): void {
  const box = $("git-changes");
  box.textContent = "";
  const commitBtn = $("git-commit-btn") as HTMLButtonElement;
  commitBtn.toggleAttribute("disabled", true);
  // 复核修正：空态早退路径重置按钮文本——否则「提交(3)」的旧计数会残留到下一次有暂存。
  // busy 态跳过（提交进行中 setBusy 已接管文本/禁用，重写会顶掉转圈提示）
  if (!commitBtn.classList.contains("busy")) commitBtn.textContent = t("git.action.commit");
  if (!app.workspaceRoot) {
    box.appendChild(emptyState("source-control", t("git.panel.noWorkspace"), t("git.panel.noWorkspaceHint")));
    return;
  }
  if (!gitRepoActive.value) {
    // P0-7：非仓库空态提供「初始化仓库」按钮（此前仅文案提示，无入口）
    const empty = emptyState("source-control", t("git.panel.notRepo"), t("git.panel.notRepoHint"));
    const initBtn = document.createElement("button");
    initBtn.className = "btn btn--primary";
    initBtn.textContent = t("git.action.initRepo");
    initBtn.dataset.tip = t("git.panel.initHint");
    initBtn.addEventListener("click", () => void gitInitRepo());
    empty.appendChild(initBtn);
    box.appendChild(empty);
    return;
  }
  if (gitFiles.length === 0) {
    box.appendChild(emptyState("check", t("git.panel.noChanges"), t("git.panel.cleanHint")));
    return;
  }

  const staged = gitFiles.filter((f) => gitFileStaged(f));
  const unstaged = gitFiles.filter((f) => !gitFileStaged(f));

  if (staged.length > 0) {
    box.appendChild(
      gitSectionTitle(t("git.panel.stagedGroup", { n: staged.length }), {
        symbol: "−",
        tip: t("git.action.unstageAll"),
        ariaLabel: t("git.action.unstageAll"),
        action: () => void unstageFiles(staged.map((f) => f.path)),
      }),
    );
    for (const f of staged) box.appendChild(renderScmItem(f, true));
  }
  if (unstaged.length > 0) {
    box.appendChild(
      // B 批（对齐 VS Code Changes 分组）：↩ 丢弃全部更改 + + 全部暂存 双动作
      gitSectionTitle(t("git.panel.changesGroup", { n: unstaged.length }), [
        {
          symbol: "",
          icon: "discard", // 与行内「丢弃更改」同一图标（对标 VS Code 分组头 Discard All）
          tip: t("git.action.discardAllMenu"),
          ariaLabel: t("git.action.discardAll"),
          action: () => void discardAllChanges(),
        },
        {
          symbol: "+",
          tip: t("git.action.stageAll"),
          ariaLabel: t("git.action.stageAllTip"),
          action: () => void stageFiles(unstaged.map((f) => f.path)),
        },
      ]),
    );
    for (const f of unstaged) box.appendChild(renderScmItem(f, false));
  }

  // B1：提交按钮显示暂存计数（对标 VS Code「提交(3)」/ PyCharm 选中计数）。
  // busy 态跳过文本更新（提交进行中 setBusy 已接管按钮，重写会顶掉转圈）
  if (!commitBtn.classList.contains("busy")) {
    commitBtn.textContent = staged.length > 0 ? t("git.panel.commitBtn", { n: staged.length }) : t("git.action.commit");
  }
  commitBtn.toggleAttribute("disabled", staged.length === 0);
  prefillCommitMessage(staged); // E-4：仅暂存单文件时预填文件名
  // C6：多选批量操作条（选中集在 stage/unstage 后可能含已消失路径，先清幽灵）
  for (const p of [...scmSelected]) {
    if (!gitFiles.some((f) => f.path === p)) scmSelected.delete(p);
  }
  renderScmBulkBar();
  // P2-7：提交建议随暂存集刷新
  renderCommitSuggest();
}

/** 初始化 Git 仓库并刷新（P0-7：SCM 空态按钮 / Git 菜单 / 命令面板共用入口） */
export async function gitInitRepo(): Promise<void> {
  if (!app.workspaceRoot) return;
  appendOutputLine(outputEl, "> git init", "cmd", gotoFromLink, "git");
  try {
    const out = await invoke<string>("git_init", { root: app.workspaceRoot });
    appendOutputLine(outputEl, out, "stdout", gotoFromLink, "git");
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.initFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.init"), e);
    return;
  }
  toast(t("git.toast.initialized"), "success");
  await refreshGitStatus();
  await refreshBranchPanel();
  renderGitPanel();
  await refreshTreeWithExpandedState();
}

/** 丢弃全部更改（B 批对齐 VS Code「Discard All Changes」：更改分组头部 ↩ 入口 +
 *  命令面板 / Git 菜单；确认弹窗、tracked checkout / untracked 删除、编辑器重载
 *  均复用 discardFiles 单一实现） */
export async function discardAllChanges(): Promise<void> {
  const unstaged = gitFiles.filter((f) => !gitFileStaged(f));
  if (unstaged.length === 0) {
    toast(t("git.toast.nothingToDiscard"), "info");
    return;
  }
  await discardFiles(unstaged);
}

/** 暂存全部更改（命令面板 / Git 菜单 / 文件树右键共用入口） */
export async function stageAllChanges(): Promise<void> {
  const unstaged = gitFiles.filter((f) => !gitFileStaged(f));
  if (unstaged.length === 0) {
    toast(t("git.toast.nothingUnstaged"), "info");
    return;
  }
  await stageFiles(unstaged.map((f) => f.path));
}

/** 按仓库相对路径打开 diff（文件树右键「打开差异」用）。
 *  复核修正：大小写无关匹配——调用方可能持归一化小写路径（relativePath 产物），
 *  而工作目录在大小写敏感文件系统上需要原始大小写。 */
export async function showDiffForPath(relPath: string): Promise<void> {
  const f = gitFiles.find((x) => x.path === relPath)
    ?? gitFiles.find((x) => normalizePath(x.path) === normalizePath(relPath));
  if (!f) {
    toast(t("git.toast.notInChanges", { path: relPath }), "info");
    return;
  }
  if (f.code === "!") void showConflictDiff(f);
  else void showDiff(f);
}

/** 归一化相对路径 → gitFiles 中的原始大小写路径（文件树右键传 git 命令用）。
 *  git 状态 Map 的 key 与 relativePath() 均为小写归一化产物；在大小写敏感
 *  文件系统（Linux）上直接用归一化路径跑 git add / blame 会 pathspec 失配，
 *  故命中后回传 gitFiles 保存的原始路径。无匹配（状态已过期）返回 null。 */
export function gitFileOriginalPath(normalizedRel: string): string | null {
  const f = gitFiles.find((x) => normalizePath(x.path) === normalizePath(normalizedRel));
  return f ? f.path : null;
}

/** 分组标题栏的可选批量操作（hover 显现的 +/−） */
interface GitSectionAction {
  symbol: string;
  /** 可选：codicon 图标名，提供时替代 symbol 文本渲染（如分组头「丢弃全部」与行内「丢弃更改」同图标） */
  icon?: string;
  tip: string;
  ariaLabel: string;
  action: () => void;
}

function gitSectionTitle(text: string, act?: GitSectionAction | GitSectionAction[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "git-section-title";
  const label = document.createElement("span");
  label.textContent = text;
  el.appendChild(label);
  for (const a of act ? (Array.isArray(act) ? act : [act]) : []) {
    const btn = document.createElement("button");
    btn.className = "scm-section-action";
    btn.dataset.tip = a.tip;
    btn.setAttribute("aria-label", a.ariaLabel);
    if (a.icon) btn.appendChild(codicon(a.icon)); // 图标态（内部 <i> aria-hidden，语义由 aria-label 承担）
    else btn.textContent = a.symbol;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      a.action();
    });
    el.appendChild(btn);
  }
  return el;
}



/** 渲染单个变更文件条目 */
function renderScmItem(f: GitStatusFile, staged: boolean): HTMLElement {
  const el = document.createElement("div");
  el.className = "scm-item";
  if (f.code === "?") el.classList.add("untracked");
  if (scmSelected.has(f.path)) el.classList.add("selected"); // C6 多选态
  el.dataset.path = f.path;
  el.dataset.staged = staged ? "1" : "0";

  const action = document.createElement("button");
  action.className = "scm-action";
  // UI-09：迁 data-tip。按钮文本是符号（! / − / +），当可访问名称毫无意义（读屏只会念符号），
  // 故一并补 aria-label 用语义文案覆盖——这是本次迁移中少数「顺手修好既有 a11y 缺陷」的地方。
  const actionTip = f.code === "!" ? t("git.action.resolveConflict") : staged ? t("git.action.unstage") : t("git.action.stage");
  action.dataset.tip = actionTip;
  action.setAttribute("aria-label", actionTip);
  if (f.code === "!") {
    action.textContent = "!";
    action.classList.add("conflict");
  } else {
    action.textContent = staged ? "−" : "+";
    if (staged) action.classList.add("staged");
  }

  const badge = document.createElement("span");
  badge.className = gitBadgeClass(f.code);
  badge.textContent = f.code;

  const name = document.createElement("span");
  name.className = "scm-name";
  name.textContent = f.path;
  name.title = f.path;

  el.append(action, badge, renderFileIcon(basename(f.path)), name);
  // 未暂存（且非冲突）项追加「丢弃更改」行内按钮（hover 显现，对标 VSCode SCM）
  if (!staged && f.code !== "!") {
    const discard = document.createElement("button");
    discard.className = "scm-discard";
    const tip = f.code === "?" ? t("git.discard.untrackedWarning") : t("git.action.discard");
    discard.dataset.tip = tip;
    discard.setAttribute("aria-label", tip);
    discard.appendChild(codicon("discard"));
    el.appendChild(discard);
  }
  return el;
}

/** 暂存指定文件并刷新 */
export async function stageFiles(paths: string[]): Promise<void> {
  if (!app.workspaceRoot || paths.length === 0) return;
  try {
    await invoke("git_stage", { root: app.workspaceRoot, paths });
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.stageFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.stageShort"), e);
    return;
  }
  // E2E 抓出的真 bug（迭代 0 复核漏网）：stage 后必须重查状态再渲染——
  // 此前只 renderGitPanel（读旧内存），面板是否更新完全取决于 watcher 事件的
  // 异步到达时机（handleFsChanged 只 refreshGitStatus 不渲染面板）。
  await refreshGitStatus();
  await refreshTreeWithExpandedState();
  renderGitPanel();
  // 体验修复第 2 则：stage 改变暂存区 → diff 口径随之变（auto 基准下 staged 文件
  // 应切到 HEAD vs 暂存区）。stage 不触工作区文件 → watcher 无事件，须在此显式刷新
  for (const p of paths) reopenDiffIfViewing(p);
}

/** 取消暂存指定文件并刷新 */
export async function unstageFiles(paths: string[]): Promise<void> {
  if (!app.workspaceRoot || paths.length === 0) return;
  try {
    await invoke("git_unstage", { root: app.workspaceRoot, paths });
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.unstageFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.unstage"), e);
    return;
  }
  await refreshGitStatus();
  await refreshTreeWithExpandedState();
  renderGitPanel();
  for (const p of paths) reopenDiffIfViewing(p);
}

/** 丢弃更改（已跟踪文件 checkout、未跟踪文件删除），确认后执行 */
async function discardFiles(files: GitStatusFile[]): Promise<void> {
  if (!app.workspaceRoot || files.length === 0) return;
  const untracked = files.filter((f) => f.code === "?");
  const tracked = files.filter((f) => f.code !== "?");
  const ok = await openConfirm({
    title: t("git.action.discard"),
    message:
      files.length === 1
        ? untracked.length
          ? t("git.discard.untrackedConfirm", { path: files[0].path })
          : t("git.discard.confirmOne", { path: files[0].path })
        : t("git.discard.confirmMany", { count: files.length }),
    okLabel: t("git.action.discardShort"),
    cancelLabel: t("common.cancel"),
    kind: "danger",
  });
  if (!ok) return;
  const root = app.workspaceRoot;
  // 次序修复：先把受影响脏文件落盘（autosave 语义，不跑 ruff）。否则 checkout 覆盖磁盘后，
  // 在途 autosave 计时器会把编辑器旧缓冲写回去——丢弃失败、旧内容「复活」。
  if (editorBridge && tracked.length > 0) {
    try {
      await editorBridge.saveTabsBeforeGit(tracked.map((f) => joinPath(root, f.path)));
    } catch (e) {
      toastFail(t("git.action.saveBeforeDiscard"), e);
      return;
    }
  }
  try {
    if (tracked.length > 0) {
      await invoke("git_discard", { root: app.workspaceRoot, paths: tracked.map((f) => f.path) });
    }
    if (untracked.length > 0) {
      await invoke("git_clean", { root: app.workspaceRoot, paths: untracked.map((f) => f.path) });
    }
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.discardFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.discard"), e);
    return;
  }
  toast(t("git.toast.discarded", { count: files.length }), "success");
  // 丢弃会改写磁盘内容：已打开该文件的编辑器需从磁盘重载，否则留下旧内容（未跟踪文件已删除，不重载）
  // CR-28：git 返回的 f.path 是仓库相对路径，而 tab.path 是绝对路径，须 joinPath 转绝对路径再匹配
  for (const f of tracked) {
    if (!reloadOpenedFile || !root) continue;
    const abs = joinPath(root, f.path);
    console.debug("[git] discard 后重载已打开文件", { rel: f.path, abs });
    await reloadOpenedFile(abs);
  }
  // 未跟踪文件已从磁盘删除：关闭其编辑器 tab（先留本地历史快照）。若只把 tab 留在内存，
  // autosave 会把缓冲重新写回磁盘，被删除的文件「复活」。
  if (editorBridge && root) {
    for (const f of untracked) editorBridge.closeTabOf(joinPath(root, f.path));
  }
  await refreshTreeWithExpandedState();
  renderGitPanel();
}

/** 接受冲突文件的「当前」或「传入」版本（checkout 后 add，两步 = 解决该冲突）。返回是否已解决 */
async function acceptConflict(side: "current" | "incoming", f: GitStatusFile): Promise<boolean> {
  if (!app.workspaceRoot) return false;
  const label = side === "current" ? t("git.conflict.current") : t("git.conflict.incoming");
  const ok = await openConfirm({
    title: t("git.action.resolveConflict"),
    message: t("git.conflict.acceptConfirm", { side: label, path: f.path }),
    okLabel: t("git.action.accept"),
    cancelLabel: t("common.cancel"),
    kind: "primary",
  });
  if (!ok) return false;
  try {
    await invoke(side === "current" ? "git_accept_current" : "git_accept_incoming", {
      root: app.workspaceRoot,
      path: f.path,
    });
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.acceptFailed", { side: label, error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.resolveConflict"), e);
    return false;
  }
  toast(t("git.toast.accepted", { side: label, file: basename(f.path) }), "success");
  await afterConflictResolve(f.path);
  return true;
}

/** 冲突解决后的统一刷新：git 状态 + SCM 面板 + 重载已打开的编辑器 */
async function afterConflictResolve(relPath: string): Promise<void> {
  await refreshTreeWithExpandedState();
  renderGitPanel();
  const root = app.workspaceRoot;
  if (!root) return;
  const abs = joinPath(root, relPath);
  // autosave 开启时 dirty 旧缓冲必须留历史后强制重载，否则在途 autosave 计时器
  // 会把解决冲突前的缓冲写回磁盘——刚接受的版本被「复活」（与 reloadTabsFromGitChange 同类）
  const dirtyTab = app.tabs.find((t) => t.path === abs && t.dirty);
  if (dirtyTab && app.settings.autosave !== "off" && editorBridge) {
    await editorBridge.reloadDirtyWithHistory(abs);
    return;
  }
  if (reloadOpenedFile) await reloadOpenedFile(abs);
}

/** git 操作改写了工作区后，重载全部已打开的文件 tab（体验修复第 5 则：
 *  丢弃块 / cherry-pick / revert / merge / rebase / stash pop / pull /
 *  切分支都会改写磁盘，但编辑器里的旧内容纹丝不动——用户看到的是幽灵内容）。
 *  - autosave 关闭：dirty tab 跳过并提示（未保存内容不能被磁盘覆盖）
 *  - autosave 开启（delay/blur）：dirty tab 的内容本就随 autosave 落盘，磁盘≈缓冲；
 *    留本地历史快照后强制重载，否则在途 autosave 计时器会把旧缓冲写回、改写被「复活」
 *  - 批量场景（merge/pull/checkout 改多文件）与单文件场景（hunk 丢弃）共用
 *  - diff tab 不参与（kind==="diff" 无文件实体） */
async function reloadTabsFromGitChange(): Promise<void> {
  const root = app.workspaceRoot;
  if (!root || !reloadOpenedFile) return;
  const fileTabs = app.tabs.filter((t) => t.kind !== "diff");
  const autosaveOn = app.settings.autosave !== "off";
  const skipped: Tab[] = [];
  for (const t of fileTabs) {
    if (t.dirty) {
      if (autosaveOn && editorBridge) await editorBridge.reloadDirtyWithHistory(t.path);
      else skipped.push(t); // autosave 关闭：不覆盖未保存内容（下面统一提示）
      continue;
    }
    await reloadOpenedFile(t.path);
  }
  if (skipped.length > 0) {
    toast(
      skipped.length === 1
        ? t("git.toast.reloadSkippedOne", { file: basename(skipped[0].path), count: fileTabs.length - skipped.length })
        : t("git.toast.reloadSkippedMany", { count: skipped.length, rest: fileTabs.length - skipped.length }),
      "info",
    );
  }
}

/** 标记冲突为已解决（手动编辑后 git add） */
async function markResolved(path: string): Promise<void> {
  if (!app.workspaceRoot) return;
  try {
    await invoke("git_stage", { root: app.workspaceRoot, paths: [path] });
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.markResolvedFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.markResolved"), e);
    return;
  }
  toast(t("git.toast.markResolved", { file: basename(path) }), "success");
  await refreshTreeWithExpandedState();
  renderGitPanel();
}

/** 打开冲突文件到编辑器（手动删冲突标记） */
function openConflictFile(f: GitStatusFile): void {
  const root = app.workspaceRoot;
  if (!root || !openFileHandler) return;
  void openFileHandler(joinPath(root, f.path));
}

/** 冲突文件的解决方案菜单 */
function conflictMenu(f: GitStatusFile, anchor: MenuAnchor): void {
  showMenu(
    [
      { label: t("git.conflict.acceptCurrent"), detail: t("git.conflict.acceptCurrentTip"), icon: "arrow-left", action: () => void acceptConflict("current", f) },
      { label: t("git.conflict.acceptIncoming"), detail: t("git.conflict.acceptIncomingTip"), icon: "arrow-right", action: () => void acceptConflict("incoming", f) },
      { label: t("git.conflict.markResolvedBtn"), detail: t("git.conflict.markResolvedTip"), icon: "check", action: () => void markResolved(f.path) },
      { sep: true },
      { label: t("git.conflict.openFile"), icon: "edit", action: () => openConflictFile(f) },
    ],
    anchor,
  );
}

/** 提交互斥标志（P2-4）：preCommitFormat 的 await（多文件 × ruff 子进程，可达数秒）
 *  发生在 setBusy 之前——第二个 commitChanges 并发进入会读到旧 gitFiles 通过校验，
 *  双 git_commit 并发触发后端 index 锁冲突。同步检查并置位（beginRunPreparing 同款）。 */
let committing = false;

/** 提交已暂存更改 */
export async function commitChanges(amend = false): Promise<void> {
  if (!app.workspaceRoot || !gitRepoActive.value) return;
  if (committing) return; // P2-4：连点/Ctrl+Enter 与按钮双入口的并发穿透
  const msgEl = $("git-commit-msg") as HTMLTextAreaElement;
  const errEl = $("git-commit-error");
  const message = msgEl.value.trim();
  // P1-F：空值就近内联提示（不再进输出面板 stderr）；输入即清除
  if (!message) {
    errEl.textContent = t("git.toast.emptyMessage");
    errEl.classList.remove("hidden");
    msgEl.focus();
    return;
  }
  // P0.5-A1：暂存前置校验——空暂存区直接内联引导，不再把空提交发到 git 报错
  //（Amend 放行：并入上一次提交无需暂存内容）。此前 Ctrl+Enter 绕过按钮禁用态，
  // 无暂存时会发出空提交请求，用户只看到一个莫名的 git 报错 toast。
  const hasStaged = gitFiles.some((f) => gitFileStaged(f));
  if (!hasStaged && !amend) {
    errEl.textContent = t("git.toast.nothingStaged");
    errEl.classList.remove("hidden");
    msgEl.focus();
    return;
  }
  errEl.classList.add("hidden");
  // P2-4：校验通过后立即同步置位（早于任何 await，含 preCommitFormat）
  committing = true;
  try {
    // P2-8：提交前检查——格式化暂存的干净 Python 文件（会话开关，默认开；可在提交下拉关闭）
    if (preCommitFormatEnabled) await preCommitFormat();
    // P0.5-B4：忙碌态防重入（提交/推送/拉取共用提交按钮互斥），完成或失败后恢复
    const commitBtn = $btn("git-commit-btn");
    setBusy(commitBtn, true, t("git.action.committing"));
    appendOutputLine(outputEl, `> git commit${amend ? " --amend" : ""} -m "${message}"`, "cmd", gotoFromLink, "git");
    try {
      const out = await invoke<string>("git_commit", { root: app.workspaceRoot, message, amend });
      for (const line of out.split("\n")) appendOutputLine(outputEl, line, "stdout", gotoFromLink, "git");
    } catch (e) {
      appendOutputLine(outputEl, t("git.out.commitFailed", { label: amend ? t("git.action.amendShort") : t("git.action.commit"), error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
      toastFail(amend ? t("git.action.amend") : t("git.action.commit"), e);
      return;
    } finally {
      setBusy(commitBtn, false);
    }
    msgEl.value = "";
    toast(amend ? t("git.toast.amended", { message: message }) : t("git.toast.committed", { message: message }), "success");
    // E2E 抓出的同款 bug：提交改变 HEAD 与暂存区，必须重查状态再渲染
    //（此前只 renderGitPanel 读旧内存，面板残留已提交条目直至 watcher 事件链兜底）
    await refreshGitStatus();
    await refreshTreeWithExpandedState();
    renderGitPanel();
  } finally {
    committing = false; // P2-4：无论成败都释放（含 preCommitFormat 抛错路径）
  }
}

/** 提交全部：先暂存所有更改再走提交（对标 VSCode Commit All） */
export async function commitAll(): Promise<void> {
  if (!app.workspaceRoot || !gitRepoActive.value) return;
  // P0.5-A2：先校验消息非空，再暂存——否则空消息时 commitChanges 中途 return，
  // 但所有文件已被暂存，留下「什么都没提交、全仓库却进了暂存区」的错误状态。
  const msgEl = $("git-commit-msg") as HTMLTextAreaElement;
  if (!msgEl.value.trim()) {
    const errEl = $("git-commit-error");
    errEl.textContent = t("git.toast.emptyMessage");
    errEl.classList.remove("hidden");
    msgEl.focus();
    return;
  }
  const unstaged = gitFiles.filter((f) => !gitFileStaged(f));
  if (unstaged.length > 0) {
    await stageFiles(unstaged.map((f) => f.path));
  }
  await commitChanges();
}

/** 当前 diff 编辑器实例（未创建时 null，不触发创建）——供 Ctrl+F 等外部复用（editorFind.ts） */
export function currentDiffEditor(): MonacoApi.editor.IStandaloneDiffEditor | null {
  return diffEditor;
}

/** 懒创建 diff 编辑器（首次查看差异时） */
export function ensureDiffEditor(): MonacoApi.editor.IStandaloneDiffEditor {
  // UI-11：光标闪烁随「减少动画」。实例懒创建后长期复用，故每次取用都重设一次——
  // 用户中途改了开关，下次打开 diff 即生效，无需再为它单独接一条设置变更的事件线。
  const blinking = motionDisabled() ? "solid" : "blink";
  if (diffEditor) {
    diffEditor.updateOptions({ cursorBlinking: blinking });
    return diffEditor;
  }
  diffEditor = app.monaco.editor.createDiffEditor($("git-diff-editor"), {
    automaticLayout: true,
    theme: app.settings.theme,
    readOnly: true, // 默认只读；冲突模式由 enableConflictEditing 放开 modified 侧（P1-3）
    renderSideBySide: true,
    fontSize: app.settings.font_size,
    cursorBlinking: blinking,
  });
  return diffEditor;
}

/** P1-3：冲突 diff 的「传入侧可编辑」开关——普通 diff 保持只读。
 *  放开后用户直接改右侧（传入版本），点「应用编辑结果」写回并 git add，
 *  与块级选择（#git-merge-blocks）互为补充：块级适合整块取舍，编辑适合改出第三种内容。 */
function enableConflictEditing(edit: boolean, conflictPath: string | null): void {
  if (!diffEditor) return;
  // 复核修正 1：renderSideBySide 跟随 diffSideBySide 状态变量——此前硬编码 true 会把
  // 用户切好的内联布局重置回并排，且变量与实际状态分叉（再点切换按钮时图标反转）。
  // 复核修正 2：diffEditor 整体保持只读，只放开 modified（传入）侧——若整体放开，
  // 用户编辑左侧「当前更改」后，applyConflictEdit 仅回写 modified 内容，左侧编辑静默丢失。
  diffEditor.updateOptions({ readOnly: true, renderSideBySide: diffSideBySide });
  diffEditor.getModifiedEditor().updateOptions({ readOnly: !edit });
  diffEditor.getModifiedEditor().updateOptions({ readOnly: !edit });
  if (edit && conflictPath) {
    if (!conflictEditHandler) {
      conflictEditHandler = diffEditor.getModifiedEditor().onDidChangeModelContent(() => {
        const btn = $("git-diff-apply-edit");
        if (btn) btn.classList.remove("hidden");
      });
    }
  } else {
    conflictEditHandler?.dispose();
    conflictEditHandler = null;
    $("git-diff-apply-edit").classList.add("hidden");
  }
}

/** P1-3：应用冲突编辑——把 modified 侧内容写回工作区文件并 git add（标记已解决） */
async function applyConflictEdit(): Promise<void> {
  const root = app.workspaceRoot;
  if (!root || !diffConflictPath || !diffModifiedModel) return;
  // 复核补充：块级面板有未应用的选择时提醒——编辑结果会整文件覆盖，
  // 块级选择将一并失效（两条解决路径平行，避免用户误以为叠加生效）
  const pendingChoices = mergeSelections.size > 0 && mergeConflictCount > 0;
  const ok = await openConfirm({
    title: t("git.conflict.applyEditTitle"),
    message: pendingChoices
      ? t("git.conflict.applyEditConfirmLong", { path: diffConflictPath })
      : t("git.conflict.applyEditConfirm", { path: diffConflictPath }),
    okLabel: t("git.conflict.applyAndResolve"),
    cancelLabel: t("common.cancel"),
    kind: "primary",
  });
  if (!ok) return;
  try {
    await invoke("write_file", { path: joinPath(root, diffConflictPath), content: diffModifiedModel.getValue() });
    await invoke("git_stage", { root, paths: [diffConflictPath] });
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.applyEditFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.applyEdit"), e);
    return;
  }
  toast(t("git.toast.conflictResolvedByEdit"), "success");
  enableConflictEditing(false, null);
  // 复核补充：块级选择状态一并复位（该文件已解决，遗留选择会污染下一个冲突文件的默认态）
  mergeSegments = [];
  mergeSelections = new Map();
  mergeConflictCount = 0;
  closeDiffPanel();
  await afterConflictResolve(diffConflictPath);
  diffConflictPath = null;
}

/** 释放上一次 diff 模型，避免内存泄漏 */
function releaseDiffModels(): void {
  diffOriginalModel?.dispose();
  diffModifiedModel?.dispose();
  diffOriginalModel = null;
  diffModifiedModel = null;
}

/** 查看单文件 diff（Monaco 左右对照）。
 *  第 2 步迁移：diff 以编辑区 tab 承载——已开同文件 diff tab 则激活并刷新，
 *  否则新建。tab.path 用 "diff:<rel>" 前缀与文件 tab 命名空间隔离（dirty/run
 *  gutter/quickopen 等按 path 工作的逻辑天然不误伤）。
 *  迭代 2（P1-2/C4）：base 三态基准 + ignoreWhitespace。 */
async function showDiff(f: GitStatusFile, base: DiffBase = "auto"): Promise<void> {
  await showDiffImpl(f, base, true);
}

/** diff 主路径加载令牌（P2-5）：showDiffImpl / showConflictDiff / reopenDiff 共用。
 *  连点 SCM 两个文件时，慢的 A 响应后到会把内容 setModel 进 B 的标签/hunk 上
 *  （内容与标签错位）；await 后校验令牌，过期响应直接丢弃。 */
let diffLoadToken = 0;

/** diff 填充实现（skipActivate：tab 已激活的刷新路径不走 activateDiffTab——
 *  activateTab(diff) → refreshDiffOnActivate → showDiff → activateDiffTab →
 *  activateTab(diff) 的无限递归由此打断） */
async function showDiffImpl(f: GitStatusFile, base: DiffBase, activate: boolean): Promise<void> {
  if (!app.workspaceRoot) return;
  const token = ++diffLoadToken; // P2-5：请求令牌（进入即占位，慢响应到达时校验）
  diffFilePath = f.path;
  diffConflictPath = null;
  // 三态：auto = 按文件暂存态自动（staged→HEAD↔Index；否则 Index↔工作区）
  const staged = base === "auto" ? gitFileStaged(f) : base === "index";
  diffBase = base;
  const tab = ensureDiffTab(f.path, { base, conflict: false });
  if (activate) activateDiffTab(tab); // 宿主显隐 + tab 高亮（内容填充在下方）
  toggleConflictDiffButtons(false);
  toggleDiffBaseButtons(f);
  $("git-merge-blocks").classList.add("hidden");
  enableConflictEditing(false, null); // P1-3：普通 diff 保持只读
  ($("git-diff-label") as HTMLElement).textContent =
    `${f.path}  ·  ${diffBaseLabel(staged, base)}`;
  try {
    const v = await invoke<{ old: string; new: string; old_label: string; new_label: string }>(
      "git_diff_versions",
      {
        root: app.workspaceRoot,
        path: f.path,
        staged,
        base: base === "head" ? "head" : null,
        ignoreWhitespace: diffIgnoreWhitespace, // C4：透传给 Monaco 的 diff 计算
      },
    );
    if (token !== diffLoadToken) return; // P2-5：期间已有新一轮加载（或换了文件），丢弃过期响应
    const d = ensureDiffEditor();
    releaseDiffModels();
    const lang = languageOf(f.path);
    diffOriginalModel = app.monaco.editor.createModel(v.old, lang);
    diffModifiedModel = app.monaco.editor.createModel(v.new, lang);
    d.updateOptions({ ignoreTrimWhitespace: diffIgnoreWhitespace }); // C4
    d.setModel({ original: diffOriginalModel, modified: diffModifiedModel });
    d.getOriginalEditor().updateOptions({ ariaLabel: v.old_label });
    d.getModifiedEditor().updateOptions({ ariaLabel: v.new_label });
    // P1-1：拉取 hunk 列表（供「暂存当前块」按光标定位）
    await loadDiffHunks(f.path);
  } catch (e) {
    if (token !== diffLoadToken) return; // P2-5：过期失败也不关新内容正在展示的 tab
    appendOutputLine(outputEl, t("git.out.diffFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.readDiff"), e);
    closeDiffTabByPath(f.path);
  }
}

// ---------- diff tab 管理（第 2 步迁移） ----------

/** diff tab 的 path 命名空间（与文件 tab 隔离） */
const DIFF_TAB_PREFIX = "diff:";

/** diff tab 激活回调（main.ts activateTab 注入——main 持有 renderTabs/宿主切换） */
let activateDiffViewHandler: ((tab: Tab) => void) | null = null;
/** diff tab 关闭回调（main.ts closeTabSilent 注入——diff 状态清理在 git.ts） */
let closeDiffViewHandler: ((tab: Tab) => void) | null = null;

/** main.ts 注入 diff tab 的激活/关闭回调 */
export function setDiffTabHandlers(h: { activate: (tab: Tab) => void; close: (tab: Tab) => void }): void {
  activateDiffViewHandler = h.activate;
  closeDiffViewHandler = h.close;
}

/** 查找或创建文件的 diff tab（同文件复用——SCM 点击/右键/命令面板共用） */
function ensureDiffTab(relPath: string, meta: { base: DiffBase; conflict: boolean }): Tab {
  const tabPath = DIFF_TAB_PREFIX + relPath;
  const existing = app.tabs.find((t) => t.kind === "diff" && t.path === tabPath);
  if (existing) {
    existing.diff = { base: meta.base, conflict: meta.conflict };
    return existing;
  }
  const tab: Tab = {
    path: tabPath,
    model: app.monaco.editor.createModel(""), // 占位模型（diff 宿主不消费；关闭时随 tab dispose）
    dirty: false,
    kind: "diff",
    diff: { base: meta.base, conflict: meta.conflict },
  };
  app.tabs.push(tab);
  return tab;
}

/** 激活 diff tab：宿主显示 + #editor 隐藏 + renderTabs（经注入回调走 main 的统一路径） */
function activateDiffTab(tab: Tab): void {
  activateDiffViewHandler?.(tab);
}

/** 关闭指定文件的 diff tab（diff 读取失败/文件离开变更列表时） */
function closeDiffTabByPath(relPath: string): void {
  const tabPath = DIFF_TAB_PREFIX + relPath;
  const tab = app.tabs.find((t) => t.kind === "diff" && t.path === tabPath);
  if (tab) closeDiffViewHandler?.(tab);
}

/** diff tab 激活时的宿主呈现（main 注入的 activate 回调内部会调到这里）：
 *  显示 #git-diff-panel、隐藏 #editor（互斥），恢复该 tab 的冲突按钮/编辑器实例。
 *  由 main.ts 的 activate 回调在 renderTabs 之后调用。 */
export function presentDiffHost(tab: Tab): void {
  $("git-diff-panel").classList.remove("hidden");
  $("editor").classList.add("hidden");
  // 工具栏状态按 tab 元数据恢复（切走再切回不丢）
  toggleConflictDiffButtons(tab.diff?.conflict === true);
  $("git-merge-blocks").classList.toggle("hidden", tab.diff?.conflict !== true);
  // layout：宿主从 hidden → 显示后需要重算（absolute 定位容器尺寸刚生效）
  requestAnimationFrame(() => {
    diffEditor?.layout();
  });
}

/** 离开 diff tab（激活了文件 tab 或关闭）：隐藏宿主、恢复 #editor。
 *  注意不清模型——tab 还在时内容保留，切回即恢复呈现。 */
export function dismissDiffHost(): void {
  $("git-diff-panel").classList.add("hidden");
  $("editor").classList.remove("hidden");
}

/** diff tab 从后台重新激活时的按需刷新（第 2 步迁移补全）：
 *  后台期间文件可能已变（refreshDiffIfViewing 只刷活动 diff tab）。
 *  冲突 tab 不刷（保护块级选择）；文件离开变更列表则关 tab。
 *  走 showDiffImpl(activate=false)——tab 已激活，再走 activateDiffTab 会
 *  与 activateTab 形成无限递归。 */
export function refreshDiffOnActivate(tab: Tab): void {
  if (tab.diff?.conflict) return; // 冲突：保护进行中操作
  const rel = tab.path.slice(DIFF_TAB_PREFIX.length);
  const f = gitFiles.find((x) => normalizePath(x.path) === normalizePath(rel));
  if (!f) {
    closeDiffTabByPath(rel);
    return;
  }
  void showDiffImpl(f, tab.diff?.base ?? "auto", false);
}

/** 三态基准标签 */
function diffBaseLabel(staged: boolean, base: DiffBase): string {
  if (base === "head") return t("git.diff.baseAll");
  return staged ? t("git.diff.baseHead") : t("git.diff.baseIndex");
}

/** 差异视图自动刷新（第 2 步迁移后按「活动 diff tab」驱动）：
 *  文件保存/外部变更后，若活动的编辑区 tab 是该文件的 diff 视图则重拉内容。
 *  - 冲突文件不自动刷：块级选择（mergeSelections）与编辑态是用户进行中的工作，
 *    刷新会整文件覆盖毁掉进度（保护进行中操作）。
 *  - 防抖 300ms + 乱序令牌：连续保存（Ctrl+S 连按）只刷最后一次。
 *  - diff tab 在后台（用户切去了别的文件 tab）：不刷新——tab 重新激活时由
 *    presentDiffHost 之后的按需重开兜底（见 activateDiffTab 的激活链）。 */
let diffAutoRefreshTimer = 0;
let diffAutoRefreshToken = 0;
export function refreshDiffIfViewing(path: string): void {
  if (!app.workspaceRoot) return;
  const active = app.activeTab;
  if (!active || active.kind !== "diff") return; // 活动 tab 不是 diff：等激活时兜底
  if (!diffFilePath || diffConflictPath) return; // 无展示内容 / 冲突文件：保护进行中操作
  const changed = normalizePath(path);
  const viewing = normalizePath(diffFilePath);
  if (!changed.endsWith(viewing) && !viewing.endsWith(changed)) return; // 变更的不是正在看的文件
  window.clearTimeout(diffAutoRefreshTimer);
  const token = ++diffAutoRefreshToken;
  diffAutoRefreshTimer = window.setTimeout(async () => {
    if (token !== diffAutoRefreshToken) return; // 已有更新一轮的刷新
    await reopenDiffIfViewing(diffFilePath!);
  }, 300);
}

/** 同步重开正在查看的 diff（stage/unstage 后直接调用；外层已刷新 gitFiles）。
 *  auto 基准的口径语义（对齐 VS Code）：staged 文件自动切 HEAD↔Index（显示暂存的内容），
 *  unstaged 切 Index↔工作区——stage 后 diff 内容仍在，只是换了基准。
 *  文件完全离开变更列表（提交/丢弃/全部 hunk 撤销）→ 关闭 diff tab。 */
function reopenDiffIfViewing(path: string): void {
  const active = app.activeTab;
  if (!active || active.kind !== "diff" || !diffFilePath || diffConflictPath) return;
  const viewing = normalizePath(diffFilePath);
  if (!normalizePath(path).endsWith(viewing) && !viewing.endsWith(normalizePath(path))) return;
  const f = gitFiles.find((x) => normalizePath(x.path) === viewing);
  if (!f) {
    toast(t("git.toast.fileNotInChanges", { path: diffFilePath }), "info");
    closeDiffTabByPath(diffFilePath);
    return;
  }
  void showDiff(f, diffBase); // 保留用户当前的三态基准与忽略空白设置（auto 会按新暂存态切口径）
}

/** 三态切换按钮显隐 + active 态同步（P1-2：已跟踪文件才有三态意义；untracked 只有一种）。
 *  untracked 同时隐藏 hunk 操作与 Blame（实测反馈 2026-09-18：untracked 文件点
 *  「+块/丢弃块/Blame」全报错——git diff HEAD 对未跟踪文件无输出 → hunk 恒空、
 *  git blame 对 HEAD 中不存在的路径直接 fatal。无意义的操作不该出现在界面上）。 */
function toggleDiffBaseButtons(f: GitStatusFile): void {
  const tracked = f.code !== "?";
  $("git-diff-base-group").classList.toggle("hidden", !tracked);
  // hunk 操作（+块/−块/丢弃块）依赖 git diff 的 hunk 划分——untracked 不适用
  $("git-diff-hunk-stage").classList.toggle("hidden", !tracked);
  $("git-diff-hunk-discard").classList.toggle("hidden", !tracked);
  // Blame 需要 HEAD 中存在该路径——untracked 文件从未提交，blame 必 fatal
  $("git-diff-blame").classList.toggle("hidden", !tracked);
  const states: [string, boolean][] = [
    ["git-diff-base-auto", diffBase === "auto"],
    ["git-diff-base-index", diffBase === "index"],
    ["git-diff-base-head", diffBase === "head"],
  ];
  for (const [id, active] of states) {
    const btn = $(id) as HTMLButtonElement;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
  // hunk 按钮语义标签跟随基准（index 侧 = 取消暂存）
  const stageBtn = $("git-diff-hunk-stage") as HTMLButtonElement;
  const isIndex = diffBase === "index";
  stageBtn.textContent = isIndex ? t("git.diff.unstageHunk") : t("git.diff.stageHunk");
  stageBtn.dataset.tip = isIndex ? t("git.diff.unstageHunkTip") : t("git.diff.stageHunkTip");
}

// ---------- Hunk 级操作（迭代 2 · P1-1） ----------

/** diff 基准三态 */
type DiffBase = "auto" | "index" | "head";

/** 当前 hunk 列表（showDiff 时拉取，供按光标定位） */
interface DiffHunk { old_start: number; old_lines: number; new_start: number; new_lines: number }
let diffHunks: DiffHunk[] = [];
let diffHunksText = "";
let diffBase: DiffBase = "auto";
/** C4：忽略空白差异（diff 计算 + hunk 拉取共用） */
let diffIgnoreWhitespace = false;

/** 拉取 hunk 列表（工作区 vs HEAD 口径，与 gutter 同源） */
async function loadDiffHunks(path: string): Promise<void> {
  if (!app.workspaceRoot) return;
  try {
    const r = await invoke<{ hunks: DiffHunk[]; diff_text: string }>("git_diff_hunks", {
      root: app.workspaceRoot,
      path,
      ignoreWhitespace: diffIgnoreWhitespace,
    });
    diffHunks = r.hunks;
    diffHunksText = r.diff_text;
  } catch (e) {
    console.debug("[git] loadDiffHunks 失败", e);
    diffHunks = [];
    diffHunksText = "";
  }
}

/** 从 diff_text 切出第 idx 个 hunk 的可应用 patch 片段。
 *  git patch 的规范要求（用户仓库实测踩坑 2026-09-18）：
 *  1. 必须带完整文件头（diff --git / --- a/ / +++ b/），纯 @@ 片段报
 *     "patch fragment without header"；
 *  2. 末尾必须恰好一个换行——split("\n") 在尾部产生空串元素，join 后再补 \n
 *     会得到「双换行」。git 把末尾空行当额外的上下文行，--recount 重数后
 *     与 @@ 头声明不匹配 → "patch does not apply"（同 hunk 的 399B 单换行
 *     版 apply 成功、400B 双换行版失败，字节级对照实锤）。
 *  3. 行尾 \r 一并剥除（PowerShell/某些 git 配置的 CRLF 输出防污染）。 */
function sliceHunkPatch(idx: number): string | null {
  const lines = diffHunksText
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l, i, arr) => !(l === "" && i === arr.length - 1)); // 去掉尾部空串元素
  const hunkStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("@@ ")) hunkStarts.push(i);
  }
  if (idx < 0 || idx >= hunkStarts.length) return null;
  // 文件头 = 首个 @@ 之前的所有行（diff --git / index / --- / +++）
  const headerEnd = hunkStarts[0];
  const header = lines.slice(0, headerEnd).join("\n");
  const from = hunkStarts[idx];
  const to = idx + 1 < hunkStarts.length ? hunkStarts[idx + 1] : lines.length;
  const fragment = lines.slice(from, to).join("\n");
  return `${header}\n${fragment}\n`;
}

/** 光标行 → hunk 序号（modified 侧行号落在 hunk new 区间内）；未落在任何 hunk 返回 -1 */
function hunkIndexAtCursor(): number {
  if (!diffEditor) return -1;
  const pos = diffEditor.getModifiedEditor().getPosition();
  if (!pos) return -1;
  const line = pos.lineNumber;
  for (let i = 0; i < diffHunks.length; i++) {
    const h = diffHunks[i];
    const from = h.new_start;
    const to = h.new_start + Math.max(h.new_lines, 1) - 1;
    if (line >= from && line <= to) return i;
  }
  return -1;
}

/** 暂存当前光标所在的 hunk（P1-1；mode: stage=暂存 / unstage=取消暂存 / discard=丢弃） */
async function applyCurrentHunk(mode: "stage" | "unstage" | "discard"): Promise<void> {
  const root = app.workspaceRoot;
  if (!root || !diffFilePath) return;
  // untracked 前置引导：git diff HEAD 对未跟踪文件无输出，hunk 操作无从谈起
  const cur = gitFiles.find((x) => x.path === diffFilePath);
  if (cur && cur.code === "?") {
    toast(t("git.hunk.untrackedGuide", { path: diffFilePath }), "info");
    return;
  }
  // 兜底：showDiff 的 loadDiffHunks 尚在途时 hunks 为空（点得快的竞态）——现查一次
  if (diffHunks.length === 0) await loadDiffHunks(diffFilePath);
  const idx = hunkIndexAtCursor();
  if (idx < 0) {
    if (diffHunks.length === 0) {
      toast(t("git.hunk.noneInBase"), "info");
      return;
    }
    toast(t("git.hunk.cursorOutside"), "info");
    return;
  }
  const patch = sliceHunkPatch(idx);
  if (!patch) return;
  if (mode === "discard") {
    const ok = await openConfirm({
      title: t("git.hunk.discardMenu"),
      message: t("git.hunk.discardConfirm", { path: diffFilePath }),
      okLabel: t("git.action.discardShort"),
      cancelLabel: t("common.cancel"),
      kind: "danger",
    });
    if (!ok) return;
  }
  try {
    await invoke("git_apply_hunk", { root, path: diffFilePath, patch, mode });
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.hunkFailed", { mode: mode, error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(mode === "stage" ? t("git.action.stageHunk") : mode === "unstage" ? t("git.action.unstageHunk") : t("git.action.discardHunk"), e);
    return;
  }
  toast(mode === "stage" ? t("git.toast.hunkStaged") : mode === "unstage" ? t("git.toast.hunkUnstaged") : t("git.toast.hunkDiscarded"), "success");
  // 刷新：hunk 列表 + git 状态 + 面板 + gutter + 重载编辑器 + 按需重开 diff
  //（discard/unstage 直接改写工作区文件，已打开的编辑器必须跟上——用户实测报告）
  await refreshGitStatus();
  renderGitPanel();
  if (mode !== "stage") await reloadTabsFromGitChange(); // stage 只动暂存区，不改工作区
  const f = gitFiles.find((x) => x.path === diffFilePath);
  if (f) {
    // 仅在 diff tab 仍是活动 tab 时重开刷新内容——用户已切去文件 tab 时不抢焦点
    //（丢弃后常见动线：切回文件 tab 确认内容；重开会把刚切的 tab 又拉回 diff）。
    // 切走时不重开也不关：tab 重新激活时 refreshDiffOnActivate 按需重拉兜底。
    if (app.activeTab?.kind === "diff") await showDiff(f, diffBase);
  } else {
    closeDiffPanel();
  }
}

/** 关闭差异视图，切回输出面板。体验修复：同时清展示状态（path/模型/标签）——
 *  此前只切 tab 不清内容，用户再点「差异」tab 会看到已关闭文件的僵尸 diff */
/** 关闭差异视图（第 2 步迁移：即关闭当前 diff tab；状态清理在 closeDiffTab 统一做）。
 *  保留原函数名——hunk 丢弃无差异 / diff 读取失败等 6 处调用点语义不变。 */
function closeDiffPanel(): void {
  if (diffFilePath) closeDiffTabByPath(diffFilePath);
}

/** diff tab 关闭时的统一清理（main 的 close 注入回调触发）：清 git.ts 域内状态。
 *  diffEditor 实例长期复用不 dispose；模型释放与宿主隐藏即时执行。 */
export function cleanupDiffTabState(tab: Tab): void {
  const rel = tab.path.startsWith(DIFF_TAB_PREFIX) ? tab.path.slice(DIFF_TAB_PREFIX.length) : tab.path;
  // 仅当关闭的是「当前展示」的 diff（多 diff tab 场景下其他 tab 不受影响）
  if (diffFilePath && normalizePath(diffFilePath) === normalizePath(rel)) {
    diffFilePath = null;
    diffConflictPath = null;
    enableConflictEditing(false, null);
    toggleConflictDiffButtons(false);
    $("git-merge-blocks").classList.add("hidden");
    releaseDiffModels();
    if (diffEditor) diffEditor.setModel(null);
    ($("git-diff-label") as HTMLElement).textContent = "—";
    // 关闭的是活动 tab 时宿主也要隐藏（main 的 close 流程会切下一个 tab，
    // 下一个是文件 tab 时 activateTab 自然 dismiss；是 welcome 空态时这里兜底）
    if (!app.tabs.some((t) => t.kind === "diff" && t === app.activeTab)) {
      dismissDiffHost();
    }
  }
  tab.model.dispose(); // 占位模型
}

/** 查看冲突文件的两路 diff（当前 vs 传入），并提供接受按钮。
 *  第 2 步迁移：与普通 diff 同走编辑区 tab（conflict 元数据驱动按钮组与块级面板）。 */
async function showConflictDiff(f: GitStatusFile): Promise<void> {
  if (!app.workspaceRoot) return;
  const token = ++diffLoadToken; // P2-5：请求令牌（与 showDiffImpl 共用——连点切换时互斥）
  diffFilePath = f.path;
  diffConflictPath = f.path;
  const absPath = joinPath(app.workspaceRoot, f.path);
  const tab = ensureDiffTab(f.path, { base: "auto", conflict: true });
  activateDiffTab(tab);
  ($("git-diff-label") as HTMLElement).textContent = t("git.conflict.itemLabel", { path: f.path });
  toggleConflictDiffButtons(true);
  $("git-merge-blocks").classList.remove("hidden");
  try {
    const [v, worktree] = await Promise.all([
      invoke<{ base: string; current: string; incoming: string }>("git_conflict_versions", { root: app.workspaceRoot, path: f.path }),
      invoke<string>("read_file", { path: absPath }),
    ]);
    if (token !== diffLoadToken) return; // P2-5：期间已切换到其他 diff，丢弃过期响应
    // 冲突块级合并状态（解析工作区文件里的冲突标记）
    mergeSegments = parseMergeSegments(worktree);
    mergeSelections = new Map();
    mergeConflictCount = mergeSegments.filter((s) => s.kind === "conflict").length;
    renderMergeBlocks();

    const d = ensureDiffEditor();
    releaseDiffModels();
    const lang = languageOf(f.path);
    diffOriginalModel = app.monaco.editor.createModel(v.current, lang);
    diffModifiedModel = app.monaco.editor.createModel(v.incoming, lang);
    d.setModel({ original: diffOriginalModel, modified: diffModifiedModel });
    d.getOriginalEditor().updateOptions({ ariaLabel: t("git.conflict.current") });
    d.getModifiedEditor().updateOptions({ ariaLabel: t("git.conflict.incoming") });
    // P1-3：冲突模式放开传入侧编辑——用户可直接改出第三种内容（current+incoming 的手工融合），
    // 点「应用编辑结果」写回 + add；块级选择面板（#git-merge-blocks）继续可用
    enableConflictEditing(true, f.path);
  } catch (e) {
    if (token !== diffLoadToken) return; // P2-5：过期失败不影响新内容展示
    appendOutputLine(outputEl, t("git.out.conflictDiffFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.readConflictDiff"), e);
    closeDiffTabByPath(f.path);
    toggleConflictDiffButtons(false);
    $("git-merge-blocks").classList.add("hidden");
    enableConflictEditing(false, null); // P1-3：失败时收回编辑态
  }
}

/** 冲突 diff 时显隐「接受当前 / 传入 / 双方」按钮 */
function toggleConflictDiffButtons(show: boolean): void {
  $("git-diff-accept-current").classList.toggle("hidden", !show);
  $("git-diff-accept-incoming").classList.toggle("hidden", !show);
  $("git-diff-accept-both").classList.toggle("hidden", !show);
}

// ---------- 冲突块级合并（阶段 3）——解析/重组纯函数在 gitMerge.ts，此处只剩状态与 DOM 渲染 ----------

/** 冲突块合并状态（随 showConflictDiff 重置） */
let mergeSegments: MergeSegment[] = [];
let mergeSelections = new Map<number, MergeChoice>();
let mergeConflictCount = 0;

/** 渲染冲突块列表 + 应用按钮（写入 #git-merge-blocks） */
function renderMergeBlocks(): void {
  const box = $("git-merge-blocks");
  box.textContent = "";
  let conflictIdx = 0;
  for (const seg of mergeSegments) {
    if (seg.kind !== "conflict") continue;
    const idx = conflictIdx++;
    const el = document.createElement("div");
    el.className = "merge-block";
    const title = document.createElement("span");
    title.className = "merge-block-title";
    title.textContent = t("git.conflict.blockTitle", { n: idx + 1 });
    el.appendChild(title);
    el.appendChild(mergeChoiceBtn(idx, "current", t("git.conflict.keepCurrent")));
    el.appendChild(mergeChoiceBtn(idx, "incoming", t("git.conflict.keepIncoming")));
    el.appendChild(mergeChoiceBtn(idx, "both", t("git.conflict.keepBoth")));
    box.appendChild(el);
  }
  if (mergeConflictCount === 0) {
    box.appendChild(emptyState("check", t("git.conflict.none"), t("git.conflict.noneHint")));
    return;
  }
  const apply = document.createElement("button");
  apply.className = "btn btn--primary";
  apply.textContent = t("git.conflict.applyBlock");
  apply.addEventListener("click", () => void applyMergeResolve());
  box.appendChild(apply);
}

/** 单个冲突块的选择按钮（带选中态） */
function mergeChoiceBtn(idx: number, choice: MergeChoice, label: string): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "merge-choice";
  const selected = (mergeSelections.get(idx) ?? "current") === choice;
  btn.classList.toggle("active", selected);
  btn.textContent = label;
  btn.addEventListener("click", () => {
    mergeSelections.set(idx, choice);
    renderMergeBlocks();
  });
  return btn;
}

/** 应用块级解决：按选择重组内容 → 写回文件 → git add */
async function applyMergeResolve(): Promise<void> {
  const root = app.workspaceRoot;
  if (!root || !diffConflictPath) return;
  const content = buildMergedContent(mergeSegments, mergeSelections);
  // P0.5-A3：残留检测改用解析结果而非正则——原 /\n=======/ 会把 markdown setext
  // 标题下划线等普通文本误判为冲突残留，把块级合并卡死。解析器只认成对的
  // `<<<<<<<…=======…>>>>>>>` 三行结构；对重组结果再解析，仍有冲突块 = 有残留。
  const remaining = parseMergeSegments(content).filter((s) => s.kind === "conflict").length;
  if (remaining > 0) {
    toast(t("git.toast.remainingConflicts", { count: remaining }), "error");
    return;
  }
  try {
    await invoke("write_file", { path: joinPath(root, diffConflictPath), content });
    await invoke("git_stage", { root, paths: [diffConflictPath] });
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.blockResolveFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.blockResolve"), e);
    return;
  }
  toast(t("git.toast.conflictResolved"), "success");
  enableConflictEditing(false, null); // 复核修正：块级解决后同样收回编辑态
  closeDiffPanel();
  await afterConflictResolve(diffConflictPath);
  diffConflictPath = null;
}

/** 切换 diff 并排 / 内联布局 */
function diffToggleLayout(): void {
  if (!diffEditor) return;
  diffSideBySide = !diffSideBySide;
  diffEditor.updateOptions({ renderSideBySide: diffSideBySide });
  const btn = $btn("git-diff-layout");
  const icon = btn.querySelector("i");
  btn.dataset.tip = diffSideBySide ? t("git.diff.inlineView") : t("git.diff.sideBySideView");
  btn.setAttribute("aria-label", diffSideBySide ? t("git.diff.inlineView") : t("git.diff.sideBySideView"));
  if (icon) icon.className = `codicon codicon-${diffSideBySide ? "split-horizontal" : "split-vertical"}`;
}

/** 切换 diff「折叠未更改区域」开关 */
function diffToggleCollapse(): void {
  if (!diffEditor) return;
  diffHideUnchanged = !diffHideUnchanged;
  const btn = $btn("git-diff-collapse");
  btn.classList.toggle("active", diffHideUnchanged);
  btn.setAttribute("aria-pressed", String(diffHideUnchanged));
  diffEditor.updateOptions({
    hideUnchangedRegions: diffHideUnchanged
      ? { enabled: true, contextLineCount: 3, minimumLineCount: 3 }
      : { enabled: false },
  });
}

/** 跳转到上一处 / 下一处更改（dir=1 向下，-1 向上；到头回绕） */
function diffGoToChange(dir: 1 | -1): void {
  if (!diffEditor) return;
  const changes = diffEditor.getLineChanges() ?? [];
  if (changes.length === 0) return;
  const editor = diffEditor.getModifiedEditor();
  const cur = editor.getPosition()?.lineNumber ?? 0;
  const target =
    dir === 1
      ? changes.find((c) => c.modifiedStartLineNumber > cur) ?? changes[0]
      : [...changes].reverse().find((c) => c.modifiedEndLineNumber < cur) ?? changes[changes.length - 1];
  const line = target.modifiedStartLineNumber > 0 ? target.modifiedStartLineNumber : 1;
  editor.setPosition({ lineNumber: line, column: 1 });
  editor.revealLineInCenter(line);
}

/** 执行远程操作（push/pull/fetch），输出写入输出面板后刷新状态 */
/** 远程操作（迭代 4 · P2-3 重构：流式输出 + 可取消 + busy 提示条）。
 *  op: push/pull/fetch；opts 可带 remote/branch（P2-1）与 prune。 */
export async function gitRemoteOp(
  op: "push" | "pull" | "fetch",
  opts: { remote?: string; branch?: string; prune?: boolean } = {},
): Promise<void> {
  if (!app.workspaceRoot || !gitRepoActive.value) return;
  if (gitRemoteBusy) return;
  gitRemoteBusy = true;
  const label = `git ${op}`;
  showRemoteBusyBar(op, true);
  const unlisten = await getCurrentWindow().listen<{ op: string; data: string }>("git-op-stdout", (e) => {
    // 流式进度（git 的 Enumerating/Counting/Writing objects 走 stderr）
    if (e.payload.op === op) appendOutputLine(outputEl, e.payload.data.replace(/\n$/, ""), "stdout", gotoFromLink, "git");
  });
  const args: Record<string, unknown> = { root: app.workspaceRoot };
  if (op === "push" || op === "pull") {
    args.remote = opts.remote ?? null;
    args.branch = opts.branch ?? null;
  }
  if (op === "fetch") args.prune = opts.prune ?? false;
  appendOutputLine(outputEl, `> ${label}${opts.remote ? ` ${opts.remote}` : ""}${opts.branch ? ` ${opts.branch}` : ""}${op === "fetch" && opts.prune ? " --prune" : ""}`, "cmd", gotoFromLink, "git");
  try {
    const out = await invoke<string>(`git_${op}`, args);
    for (const line of out.split("\n")) if (line.trim()) appendOutputLine(outputEl, line, "stdout", gotoFromLink, "git");
  } catch (e) {
    const msg = String(e);
    appendOutputLine(outputEl, t("git.out.remoteFailed", { label: label, error: localizeBackendError(errMsg(msg)) }), "stderr", gotoFromLink, "git");
    // 取消语义走双语匹配：Rust 侧取消哨兵为「已取消」（git_cmds.rs），但错误串可能来自
    // 未过 localize 的原始输出或英文工具链（cancelled/canceled），只匹配中文在英文环境会漏判
    if (msg.includes("已取消") || /cancel/i.test(msg)) toast(t("git.toast.cancelled", { label: label }), "info");
    else toastFail(label, e);
  } finally {
    unlisten();
    gitRemoteBusy = false;
    showRemoteBusyBar(op, false);
  }
  await refreshGitStatus();
  await refreshBranchPanel();
  renderGitPanel();
  // pull 把远端内容写进工作区（fetch/push 不动工作区文件，重载是无害的幂等操作）
  if (op === "pull") await reloadTabsFromGitChange();
}

/** 远程操作 busy 提示条（P2-3：状态栏上方浮动，含取消按钮） */
function showRemoteBusyBar(op: string, show: boolean): void {
  let bar = document.getElementById("git-remote-busy");
  if (!show) {
    bar?.remove();
    return;
  }
  bar = document.createElement("div");
  bar.id = "git-remote-busy";
  bar.setAttribute("role", "status");
  const spin = codicon("loading");
  spin.classList.add("codicon-modifier-spin");
  const text = document.createElement("span");
  text.textContent = t("git.remote.running", { op: op });
  const cancel = document.createElement("button");
  cancel.className = "btn btn--sm";
  cancel.textContent = t("common.cancel");
  cancel.addEventListener("click", () => {
    void invoke("git_cancel_op", { op }).catch(() => { /* 无进行中操作时静默 */ });
  });
  bar.append(spin, text, cancel);
  document.body.appendChild(bar);
}

// ---------- Remote 管理（迭代 4 · P2-1） ----------

/** 远程仓库管理弹层（列表 + 添加 + 删除 + 推送到指定远程） */
async function openRemoteManager(): Promise<void> {
  const root = app.workspaceRoot;
  if (!root || !gitRepoActive.value) return;
  // 弹层容器（惰性建，关闭即删——单实例，无需常驻 DOM）
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.id = "git-remote-modal";
  const card = document.createElement("div");
  card.className = "modal-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", t("git.remote.manageTitle"));
  const title = document.createElement("div");
  title.className = "modal-title";
  title.textContent = t("git.remote.title");
  card.appendChild(title);
  const list = document.createElement("div");
  list.className = "git-remote-list";
  card.appendChild(list);
  // 添加行
  const addRow = document.createElement("div");
  addRow.className = "git-remote-add-row";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = t("git.remote.nameLabel");
  nameInput.autocomplete = "off";
  nameInput.spellcheck = false;
  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.placeholder = t("git.remote.urlLabel");
  urlInput.autocomplete = "off";
  urlInput.spellcheck = false;
  const addBtn = document.createElement("button");
  addBtn.className = "btn btn--primary";
  addBtn.textContent = t("git.action.add");
  addRow.append(nameInput, urlInput, addBtn);
  card.appendChild(addRow);
  const closeRow = document.createElement("div");
  closeRow.className = "modal-actions";
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn";
  closeBtn.textContent = t("common.close");
  closeRow.appendChild(closeBtn);
  card.appendChild(closeRow);
  overlay.appendChild(card);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) overlay.remove(); });
  closeBtn.addEventListener("click", () => overlay.remove());

  const renderList = async (): Promise<void> => {
    list.textContent = "";
    let remotes: { name: string; url: string; fetch: string }[] = [];
    try {
      remotes = await invoke("git_remote_list", { root });
    } catch (e) {
      list.appendChild(emptyState("error", t("git.remote.listFailed"), String(e)));
      return;
    }
    if (remotes.length === 0) {
      list.appendChild(emptyState("cloud", t("git.remote.none"), t("git.remote.noneHint")));
      return;
    }
    for (const r of remotes) {
      const row = document.createElement("div");
      row.className = "git-remote-item";
      const info = document.createElement("div");
      info.className = "git-remote-info";
      const name = document.createElement("div");
      name.className = "git-remote-name";
      name.textContent = r.name;
      const url = document.createElement("div");
      url.className = "git-remote-url";
      url.textContent = r.url;
      url.title = r.url;
      info.append(name, url);
      // 推送到该远程（当前分支）
      const pushBtn = document.createElement("button");
      pushBtn.className = "btn btn--sm";
      pushBtn.textContent = t("git.remote.pushHere");
      pushBtn.dataset.tip = t("git.remote.pushHereTip", { name: r.name });
      pushBtn.addEventListener("click", () => {
        overlay.remove();
        void gitRemoteOp("push", { remote: r.name });
      });
      const rmBtn = document.createElement("button");
      rmBtn.className = "btn btn--sm btn--danger-outline";
      rmBtn.textContent = t("git.action.delete");
      rmBtn.addEventListener("click", async () => {
        const ok = await openConfirm({
          title: t("git.remote.deleteTitle"),
          message: t("git.remote.removeConfirm", { name: r.name, url: r.url }),
          okLabel: t("git.action.delete"),
          cancelLabel: t("common.cancel"),
          kind: "danger",
        });
        if (!ok) return;
        try {
          await invoke("git_remote_remove", { root, name: r.name });
          toast(t("git.toast.remoteRemoved", { name: r.name }), "success");
          await renderList();
          await refreshBranchPanel();
        } catch (e) {
          toastFail(t("git.action.removeRemote"), e);
        }
      });
      row.append(info, pushBtn, rmBtn);
      list.appendChild(row);
    }
  };
  addBtn.addEventListener("click", async () => {
    const n = nameInput.value.trim();
    const u = urlInput.value.trim();
    if (!n || !u) {
      toast(t("git.toast.remoteEmpty"), "error");
      return;
    }
    try {
      await invoke("git_remote_add", { root, name: n, url: u });
      toast(t("git.toast.remoteAdded", { name: n }), "success");
      nameInput.value = "";
      urlInput.value = "";
      await renderList();
      await refreshBranchPanel();
    } catch (e) {
      toastFail(t("git.action.addRemote"), e);
    }
  });
  document.body.appendChild(overlay);
  await renderList();
}

/** 暂存当前更改（迭代 3 · B6：可输入说明 + 可选包含未跟踪文件） */
export async function gitStash(): Promise<void> {
  if (!app.workspaceRoot || !gitRepoActive.value) return;
  // openChoice 为 ok/neutral/cancel 三按钮模型：ok=含未跟踪 / neutral=仅已跟踪
  const mode = await openChoice({
    title: t("git.stash.title"),
    message: t("git.stash.confirm"),
    okLabel: t("git.stash.includeUntracked"),
    neutralLabel: t("git.stash.trackedOnly"),
    cancelLabel: t("common.cancel"),
    kind: "primary",
  });
  if (mode === "cancel") return;
  const message = await openPrompt({
    title: t("git.stash.messageLabel"),
    label: t("git.stash.messageHint"),
    placeholder: t("git.stash.messagePlaceholder"),
  });
  if (message === null) return; // 取消输入 = 取消整个贮藏
  appendOutputLine(outputEl, `> git stash push${mode === "ok" ? " -u" : ""}${message.trim() ? ` -m "${message.trim()}"` : ""}`, "cmd", gotoFromLink, "git");
  try {
    const out = await invoke<string>("git_stash_push", {
      root: app.workspaceRoot,
      message: message.trim(),
      includeUntracked: mode === "ok",
    });
    for (const line of out.split("\n")) appendOutputLine(outputEl, line, "stdout", gotoFromLink, "git");
    toast(t("git.toast.stashed"), "success");
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.stashFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail("Stash", e);
  }
  await refreshGitStatus();
  renderGitPanel();
  // push 把工作区改动收走（文件回退到 HEAD）：编辑器须同步（体验修复第 5 则，
  // 与 pop 对称——此前只 pop 侧重载，push 后编辑器残留已贮藏的旧内容）
  await reloadTabsFromGitChange();
  if (!$("git-stash-panel").classList.contains("hidden")) void renderStashPanel();
}

/** 弹出最近一次 stash（git stash pop）后刷新 */
export async function gitStashPop(): Promise<void> {
  if (!app.workspaceRoot || !gitRepoActive.value) return;
  appendOutputLine(outputEl, "> git stash pop", "cmd", gotoFromLink, "git");
  try {
    const out = await invoke<string>("git_stash_pop", { root: app.workspaceRoot });
    for (const line of out.split("\n")) appendOutputLine(outputEl, line, "stdout", gotoFromLink, "git");
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.stashPopFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail("Stash pop", e);
  }
  await refreshGitStatus();
  renderGitPanel();
  await reloadTabsFromGitChange(); // pop 把贮藏的改动写回工作区，编辑器须跟上
}

/** stash 列表条目 → 简述（去掉 stash@{n}: 前缀，截长） */
function stashShortLabel(raw: string): string {
  const s = raw.replace(/^stash@\{\d+\}:\s*/, "");
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/** 弹出指定索引的 stash（stash@{index}） */
async function stashPopAt(index: number): Promise<void> {
  if (!app.workspaceRoot || !gitRepoActive.value) return;
  appendOutputLine(outputEl, `> git stash pop stash@{${index}}`, "cmd", gotoFromLink, "git");
  try {
    const out = await invoke<string>("git_stash_pop_at", { root: app.workspaceRoot, index });
    for (const line of out.split("\n")) appendOutputLine(outputEl, line, "stdout", gotoFromLink, "git");
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.stashPopFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.stashPop"), e);
  }
  await refreshGitStatus();
  renderGitPanel();
  await reloadTabsFromGitChange(); // 同 gitStashPop：写回工作区后重载编辑器
  if (!$("git-stash-panel").classList.contains("hidden")) void renderStashPanel();
}

/** 展开 / 收起贮藏列表面板（迭代 5 · C3：改走 tab 切换） */
function toggleStashPanel(): void {
  setGitSubtab(activeGitSubtab() === "stash" ? "changes" : "stash");
}

/** 渲染贮藏列表面板（每项含「弹出」「丢弃」两个动作） */
async function renderStashPanel(): Promise<void> {
  const box = $("git-stash-panel");
  box.textContent = "";
  if (!app.workspaceRoot || !gitRepoActive.value) {
    box.appendChild(emptyState("source-control", t("git.panel.notRepo")));
    return;
  }
  let stashes: string[];
  try {
    stashes = await invoke<string[]>("git_stash_list", { root: app.workspaceRoot });
  } catch (e) {
    box.appendChild(emptyState("error", t("git.stash.listFailed"), String(e)));
    return;
  }
  if (stashes.length === 0) {
    box.appendChild(emptyState("save", t("git.stash.none"), t("git.stash.noneHint")));
    return;
  }
  for (let i = 0; i < stashes.length; i++) {
    box.appendChild(renderStashItem(stashes[i], i));
  }
}

/** 单条 stash：文本 + 查看 + 弹出 + 丢弃（迭代 3 · B6：加 diff 查看按钮） */
function renderStashItem(raw: string, index: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "stash-item";
  const label = document.createElement("span");
  label.className = "stash-label";
  label.textContent = stashShortLabel(raw);
  label.title = raw;
  const show = document.createElement("button");
  show.className = "btn btn--sm btn--icon";
  show.dataset.tip = t("git.stash.viewDiffTip");
  show.setAttribute("aria-label", t("git.stash.viewDiff"));
  show.appendChild(codicon("diff"));
  show.addEventListener("click", () => void showStashDiff(index));
  const pop = document.createElement("button");
  pop.className = "btn btn--sm";
  pop.textContent = t("git.stash.popBtn");
  pop.dataset.tip = t("git.stash.popTip");
  pop.addEventListener("click", () => void stashPopAt(index));
  const drop = document.createElement("button");
  drop.className = "btn btn--sm btn--danger-outline";
  drop.textContent = t("git.action.discardShort");
  drop.dataset.tip = t("git.stash.dropTip");
  drop.addEventListener("click", () => void stashDropAt(index));
  el.append(label, show, pop, drop);
  return el;
}

/** 查看指定 stash 的 diff（迭代 3 · B6：渲染进 Git 详情视图） */
async function showStashDiff(index: number): Promise<void> {
  if (!app.workspaceRoot || !gitRepoActive.value) return;
  openGitDetailView(`Stash · stash@{${index}}`, `git stash show -p stash@{${index}}`);
  try {
    const out = await invoke<string>("git_stash_show", { root: app.workspaceRoot, index });
    for (const line of out.split("\n")) appendDetailLine(line, gitLineClass(line));
  } catch (e) {
    appendDetailLine(t("git.out.stashDiffFailed", { error: localizeBackendError(errMsg(e)) }), "stderr");
    toastFail(t("git.action.readStashDiff"), e);
  }
}

/** 丢弃指定索引的 stash（stash@{index}），确认后执行 */
async function stashDropAt(index: number): Promise<void> {
  if (!app.workspaceRoot || !gitRepoActive.value) return;
  const ok = await openConfirm({
    title: t("git.action.dropStash"),
    message: t("git.stash.dropConfirm", { index: index }),
    okLabel: t("git.action.discardShort"),
    cancelLabel: t("common.cancel"),
    kind: "danger",
  });
  if (!ok) return;
  try {
    await invoke("git_stash_drop_at", { root: app.workspaceRoot, index });
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.stashDropFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.dropStash"), e);
    return;
  }
  toast(t("git.toast.stashDropped"), "success");
  await renderStashPanel();
}

// ---------- Git 详情视图（提交详情 / Blame 的独立承载，不再侵占输出面板） ----------

/** Git 详情视图容器（历史提交详情 git show / 逐行 blame 渲染处） */
const gitDetailViewEl = $("git-detail-view");
/** Git 详情视图标签（header 左侧，显示当前查看对象） */
const gitDetailLabelEl = $("git-detail-label");

/** Git 详情视图行（独立视图，不参与输出面板 channel 过滤——过滤态下打开详情不受影响） */
function appendDetailLine(text: string, cls: string): HTMLElement {
  return appendOutputLine(gitDetailViewEl, text, cls, gotoFromLink);
}

/** 渲染 Git 详情视图的空态引导（无内容时；直接点「Git」标签看到的就是这个） */
export function renderGitDetailEmptyState(): void {
  gitDetailLabelEl.textContent = "—";
  gitDetailViewEl.textContent = "";
  gitDetailViewEl.appendChild(
    emptyState(
      "git-commit",
      t("git.detail.none"),
      t("git.detail.noneHint"),
    ),
  );
}

/** 打开 Git 详情视图：切到「Git」标签、清空旧内容、写入标题 */
function openGitDetailView(label: string, cmd: string): void {
  setBottomTab("git");
  gitDetailViewEl.textContent = "";
  gitDetailLabelEl.textContent = label;
  appendDetailLine(`> ${cmd}`, "cmd");
}

/** 查看指定提交详情（git show）——渲染进独立 Git 详情视图（P0：不再 clearOutput 输出面板） */
async function showCommitDetail(hash: string): Promise<void> {
  if (!app.workspaceRoot) return;
  openGitDetailView(t("git.detail.commitTitle", { hash: hash.slice(0, 8) }), `git show ${hash}`);
  try {
    const out = await invoke<string>("git_show", { root: app.workspaceRoot, hash });
    for (const line of out.split("\n")) appendDetailLine(line, gitLineClass(line));
  } catch (e) {
    appendDetailLine(t("git.out.commitDetailFailed", { error: localizeBackendError(errMsg(e)) }), "stderr");
    toastFail(t("git.action.readCommitDetail"), e);
  }
}

/** 逐行 blame——渲染进独立 Git 详情视图（迭代 3 · P1-7/B9：结构化行 + 可点击 hash 跳提交详情 + 本地化日期）。
 *  untracked 前置拦截（实测反馈 2026-09-18）：git blame 对 HEAD 中不存在的路径直接
 *  fatal——先用状态码给出人话引导，不再把 git 原始报错甩给用户。 */
export async function showBlame(path: string): Promise<void> {
  if (!app.workspaceRoot) return;
  const st = gitFiles.find((x) => normalizePath(x.path) === normalizePath(path));
  if (st && st.code === "?") {
    toast(t("git.toast.untrackedNoHistory", { path: path }), "info");
    return;
  }
  openGitDetailView(`Blame · ${path}`, `git blame --line-porcelain -- ${path}`);
  try {
    const rows = await invoke<{ line: number; short_hash: string; author: string; time: number; summary: string }[]>(
      "git_blame",
      { root: app.workspaceRoot, path },
    );
    // 相邻同提交行折叠显示首行（信息密度优先；完整行号见 padStart）
    let lastHash = "";
    for (const r of rows) {
      // B9：本地时区日期（原 toISOString 是 UTC，差一天误导排查）
      const when = r.time
        ? new Date(r.time * 1000).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
        : "";
      const row = document.createElement("div");
      row.className = "git-blame-row";
      const sameAsPrev = r.short_hash === lastHash;
      lastHash = r.short_hash;
      const ln = document.createElement("span");
      ln.className = "git-blame-line";
      ln.textContent = sameAsPrev ? "  ⋮  " : String(r.line).padStart(5, " ");
      const hash = document.createElement("button");
      hash.className = "git-blame-hash";
      hash.textContent = sameAsPrev ? "" : r.short_hash;
      hash.title = t("git.blame.summaryTip", { summary: r.summary });
      hash.addEventListener("click", () => void showCommitDetail(r.short_hash));
      const author = document.createElement("span");
      author.className = "git-blame-author";
      author.textContent = sameAsPrev ? "" : r.author.padEnd(10, " ");
      const date = document.createElement("span");
      date.className = "git-blame-date";
      date.textContent = sameAsPrev ? "" : when;
      const summary = document.createElement("span");
      summary.className = "git-blame-summary";
      summary.textContent = sameAsPrev ? "" : r.summary;
      row.append(ln, hash, author, date, summary);
      gitDetailViewEl.appendChild(row);
    }
  } catch (e) {
    appendDetailLine(t("git.out.blameFailed", { error: localizeBackendError(errMsg(e)) }), "stderr");
    toastFail(t("git.action.readBlame"), e);
  }
}

interface GitCommitInfo { hash: string; short_hash: string; author: string; date: string; subject: string; graph: string; refs: string }

/** E-4（PyCharm 调研）：文件历史（git log --follow）——单文件的提交列表，hash 可点进提交详情。
 *  与 blame 同用 Git 详情视图（openGitDetailView 渲染任意行内容）。 */
export async function showFileHistory(relPath: string): Promise<void> {
  if (!app.workspaceRoot) return;
  openGitDetailView(t("git.history.fileTitle", { path: relPath }), `git log --follow -- ${relPath}`);
  try {
    const commits = await invoke<GitCommitInfo[]>("git_log_file", { root: app.workspaceRoot, path: relPath, count: 100 });
    if (commits.length === 0) {
      appendDetailLine(t("git.history.fileNone"), "hint");
      return;
    }
    for (const c of commits) {
      const row = document.createElement("div");
      row.className = "git-file-history-row";
      const hash = document.createElement("button");
      hash.className = "git-blame-hash";
      hash.textContent = c.short_hash;
      hash.title = t("git.blame.summaryTip", { summary: c.subject });
      hash.addEventListener("click", () => void showCommitDetail(c.short_hash));
      const meta = document.createElement("span");
      meta.className = "git-file-history-meta";
      meta.textContent = `${c.date} · ${c.author}`;
      const subject = document.createElement("span");
      subject.className = "git-file-history-subject";
      subject.textContent = c.refs ? `${c.subject}  (${c.refs})` : c.subject;
      row.append(hash, meta, subject);
      gitDetailViewEl.appendChild(row);
    }
  } catch (e) {
    appendDetailLine(t("git.out.fileHistoryFailed", { error: localizeBackendError(errMsg(e)) }), "stderr");
    toastFail(t("git.action.readFileHistory"), e);
  }
}

/** 历史面板开关（迭代 5 · C3：改走 tab 切换） */
export function toggleHistory(): void {
  setGitSubtab(activeGitSubtab() === "history" ? "changes" : "history");
}

// ---------- SCM 内嵌 tab（迭代 5 · C3：更改/历史/贮藏 三分区，tab 高亮同步） ----------

type GitSubtab = "changes" | "history" | "stash";

function activeGitSubtab(): GitSubtab {
  if (!$("git-history").classList.contains("hidden")) return "history";
  if (!$("git-stash-panel").classList.contains("hidden")) return "stash";
  return "changes";
}

/** 切换 SCM 分区 tab（唯一入口——所有互斥显隐收敛到这里） */
export function setGitSubtab(tab: GitSubtab): void {
  $("git-history").classList.toggle("hidden", tab !== "history");
  $("git-stash-panel").classList.toggle("hidden", tab !== "stash");
  $("git-changes").classList.toggle("hidden", tab !== "changes");
  $("git-commit-box").classList.toggle("hidden", tab !== "changes");
  const states: [string, boolean][] = [
    ["git-subtab-changes", tab === "changes"],
    ["git-subtab-history", tab === "history"],
    ["git-subtab-stash", tab === "stash"],
  ];
  for (const [id, active] of states) {
    const btn = $(id) as HTMLButtonElement;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  if (tab === "history") {
    closeBranchList();
    void renderHistory();
  } else if (tab === "stash") {
    closeBranchList();
    void renderStashPanel();
  }
}

/** 渲染最近提交列表 */
async function renderHistory(): Promise<void> {
  const box = $("git-history");
  box.textContent = "";
  const back = document.createElement("button");
  back.className = "git-history-back";
  back.textContent = t("git.history.back");
  back.addEventListener("click", () => toggleHistory());
  box.appendChild(back);
  if (!app.workspaceRoot || !gitRepoActive.value) {
    box.appendChild(emptyState("source-control", t("git.panel.notRepo")));
    return;
  }
  try {
    const commits = await invoke<GitCommitInfo[]>("git_log", { root: app.workspaceRoot, count: 50 });
    if (commits.length === 0) {
      box.appendChild(emptyState("git-commit", t("git.history.none")));
      return;
    }
    for (const c of commits) box.appendChild(renderCommitItem(c));
  } catch (e) {
    box.appendChild(emptyState("error", t("git.history.loadFailed"), String(e)));
  }
}

/** 历史条目右键菜单（迭代 3 · P1-4/P1-6：对标 PyCharm Log 右键全家桶的常用子集） */
function showCommitContextMenu(hash: string, subject: string, anchor: MenuAnchor): void {
  const short = hash.slice(0, 8);
  const subjectShort = subject.length > 24 ? `${subject.slice(0, 24)}…` : subject;
  showMenu(
    [
      {
        label: t("git.history.cherryPick"),
        detail: t("git.history.cherryPickTip", { hash: short }),
        icon: "copy",
        action: () => void cherryPickCommit(hash, subjectShort),
      },
      {
        label: t("git.history.revert"),
        detail: t("git.history.revertTip"),
        icon: "discard",
        action: () => void revertCommit(hash, subjectShort),
      },
      { sep: true },
      {
        label: t("git.history.branchFrom"),
        icon: "git-branch",
        action: () => void createBranchAt(hash),
      },
      {
        label: t("git.history.tagFrom"),
        icon: "tag",
        action: () => void createTagAt(hash),
      },
      { sep: true },
      {
        label: t("git.history.resetTo"),
        detail: "git reset（soft / mixed / hard）",
        icon: "arrow-left",
        danger: true,
        action: () => resetToCommit(hash, subjectShort, anchor),
      },
      { sep: true },
      {
        label: t("git.history.copyHash"),
        icon: "copy",
        action: () => void invoke("copy_to_clipboard", { text: hash }),
      },
    ],
    anchor,
  );
}

/** cherry-pick（P1-4）：失败（冲突）时提示 -n 模式 */
async function cherryPickCommit(hash: string, subject: string): Promise<void> {
  const root = app.workspaceRoot;
  if (!root) return;
  appendOutputLine(outputEl, `> git cherry-pick ${hash.slice(0, 8)}`, "cmd", gotoFromLink, "git");
  try {
    const out = await invoke<string>("git_cherry_pick", { root, hash, no_commit: false });
    for (const line of out.split("\n")) appendOutputLine(outputEl, line, "stdout", gotoFromLink, "git");
    toast(t("git.toast.cherryPicked", { subject: subject }), "success");
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.cherryPickFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail("Cherry-pick", e);
  }
  await refreshAfterBranchChange();
}

/** revert（P1-4） */
async function revertCommit(hash: string, subject: string): Promise<void> {
  const root = app.workspaceRoot;
  if (!root) return;
  const ok = await openConfirm({
    title: t("git.history.revertTitle"),
    message: t("git.history.revertConfirm", { subject: subject }),
    okLabel: "Revert",
    cancelLabel: t("common.cancel"),
    kind: "primary",
  });
  if (!ok) return;
  appendOutputLine(outputEl, `> git revert --no-edit ${hash.slice(0, 8)}`, "cmd", gotoFromLink, "git");
  try {
    const out = await invoke<string>("git_revert", { root, hash });
    for (const line of out.split("\n")) appendOutputLine(outputEl, line, "stdout", gotoFromLink, "git");
    toast(t("git.toast.reverted", { subject: subject }), "success");
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.revertFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail("Revert", e);
  }
  await refreshAfterBranchChange();
}

/** 在指定提交上新建分支（P1-4 附带；git branch <name> <hash> 后不自动切换） */
async function createBranchAt(hash: string): Promise<void> {
  const root = app.workspaceRoot;
  if (!root) return;
  const name = await openPrompt({
    title: t("git.history.branchFromTitle", { hash: hash.slice(0, 8) }),
    label: t("git.history.branchNameLabel"),
    placeholder: "feature/xxx",
  });
  if (name === null) return;
  const err = validateBranchName(name);
  if (err) {
    toast(err, "error");
    return;
  }
  try {
    // 复用 git_create_branch 不合适（它会 checkout -b）；直接走 branch <name> <hash>
    await invoke("git_create_branch_at", { root, name: name.trim(), hash });
    toast(t("git.toast.branchCreated", { name: name.trim() }), "success");
  } catch (e) {
    toastFail(t("git.action.createBranch"), e);
  }
  await refreshBranchPanel();
}

/** 在指定提交上新建标签（P1-6） */
async function createTagAt(hash: string): Promise<void> {
  const root = app.workspaceRoot;
  if (!root) return;
  const name = await openPrompt({
    title: t("git.history.tagFromTitle", { hash: hash.slice(0, 8) }),
    label: t("git.history.tagNameLabel"),
    placeholder: "v1.0.0",
  });
  if (name === null) return;
  try {
    const out = await invoke<string>("git_create_tag", { root, name: name.trim(), hash });
    toast(out, "success");
  } catch (e) {
    toastFail(t("git.action.createTag"), e);
  }
}

/** reset 到指定提交（P1-4：soft/mixed/hard 三选，经 showMenu 点选即执行） */
function resetToCommit(hash: string, subject: string, anchor: MenuAnchor): void {
  const run = (mode: "soft" | "mixed" | "hard"): void => {
    void doReset(hash, mode);
  };
  const where = t("git.reset.target", { subject: subject, hash: hash.slice(0, 8) });
  showMenu(
    [
      {
        label: t("git.reset.soft"),
        detail: t("git.reset.softTip", { target: where }),
        icon: "arrow-left",
        action: () => run("soft"),
      },
      {
        label: t("git.reset.mixed"),
        detail: t("git.reset.mixedTip", { target: where }),
        icon: "arrow-left",
        action: () => run("mixed"),
      },
      { sep: true },
      {
        label: t("git.reset.hard"),
        detail: t("git.reset.hardTip", { target: where }),
        icon: "discard",
        danger: true,
        action: () => run("hard"),
      },
    ],
    anchor,
  );
}

/** reset 实执行（hard 前有二次确认） */
async function doReset(hash: string, mode: "soft" | "mixed" | "hard"): Promise<void> {
  const root = app.workspaceRoot;
  if (!root) return;
  if (mode === "hard") {
    const sure = await openConfirm({
      title: t("git.reset.hardConfirmTitle"),
      message: t("git.reset.hardConfirm"),
      okLabel: t("git.reset.hardOk"),
      cancelLabel: t("common.cancel"),
      kind: "danger",
    });
    if (!sure) return;
  }
  appendOutputLine(outputEl, `> git reset --${mode} ${hash.slice(0, 8)}`, "cmd", gotoFromLink, "git");
  try {
    const out = await invoke<string>("git_reset", { root, hash, mode });
    for (const line of out.split("\n")) appendOutputLine(outputEl, line, "stdout", gotoFromLink, "git");
    toast(t("git.toast.reset", { mode: mode, hash: hash.slice(0, 8) }), "success");
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.resetFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.reset"), e);
  }
  // hard 重置改写了磁盘内容：重载已打开的干净 tab（dirty 保护统一在
  // reloadTabsFromGitChange；refreshAfterBranchChange 内亦会重载，此处
  // 双保险无妨——幂等操作）
  if (mode === "hard") await reloadTabsFromGitChange();
  await refreshAfterBranchChange();
}

function renderCommitItem(c: GitCommitInfo): HTMLElement {
  const el = document.createElement("div");
  el.className = "git-commit-item";
  el.dataset.hash = c.hash;
  el.dataset.shortHash = c.short_hash;
  el.dataset.subject = c.subject;
  el.title = `${c.hash}\n${c.author} · ${c.date}`;
  // P0-6 + 迭代 5 · P2-5：graph 车道列着色渲染——按字符位拆 span，
  // 每 2 列（车道宽 = 字符 + 空格）循环 4 色，拓扑结构一眼可辨
  if (c.graph) {
    const graph = document.createElement("span");
    graph.className = "graph-lane";
    for (let i = 0; i < c.graph.length; i++) {
      const ch = c.graph[i];
      const span = document.createElement("span");
      const lane = Math.floor(i / 2); // 每车道 2 字符宽（`* ` / `| `）
      span.className = `git-lane-c${lane % 4}`;
      span.textContent = ch;
      graph.appendChild(span);
    }
    el.appendChild(graph);
  }
  const hash = document.createElement("span");
  hash.className = "hash";
  hash.textContent = c.short_hash;
  const date = document.createElement("span");
  date.className = "date";
  date.textContent = c.date;
  const subject = document.createElement("span");
  subject.className = "subject";
  subject.textContent = c.subject;
  const author = document.createElement("span");
  author.className = "author";
  author.textContent = c.author;
  // P0-6：refs 装饰（HEAD -> main / tag: v1.0 / origin/main）——当前分支高亮 + 分支标签，
  // 对标 VS Code Source Control Graph 与 PyCharm Log 的分支标签
  if (c.refs) {
    const refs = document.createElement("span");
    refs.className = "git-commit-refs";
    refs.textContent = c.refs;
    refs.title = c.refs;
    el.classList.toggle("current-head", c.refs.includes("HEAD ->"));
    el.append(hash, date, refs, subject, author);
    return el;
  }
  el.append(hash, date, subject, author);
  return el;
}

// ---------- SCM 分支面板（P2：当前分支 / 切换 / 新建） ----------

/** 刷新 SCM 分支条（当前分支 + 分支列表） */
export async function refreshBranchPanel(): Promise<void> {
  if (!app.workspaceRoot || !gitRepoActive.value) {
    gitBranches = [];
    $("git-branch-current").textContent = "—";
    closeBranchList();
    return;
  }
  try {
    gitBranches = await invoke<{ name: string; current: boolean; remote: boolean }[]>("git_branches", { root: app.workspaceRoot });
  } catch {
    gitBranches = [];
  }
  const cur = gitBranches.find((b) => b.current);
  $("git-branch-current").replaceChildren(codicon("git-branch"), ` ${cur ? cur.name : (currentBranch ?? "—")}`);
  if (!$("git-branch-list").classList.contains("hidden")) renderBranchList();
}

function closeBranchList(): void {
  $("git-branch-list").classList.add("hidden");
}

/** 标签区（迭代 3 · P1-6）：列出标签，点击查看指向提交，右键检出 detached */
async function appendTagSection(box: HTMLElement): Promise<void> {
  if (!app.workspaceRoot || !gitRepoActive.value) return;
  let tags: { name: string; short_hash: string }[] = [];
  try {
    tags = await invoke<{ name: string; short_hash: string }[]>("git_tags", { root: app.workspaceRoot });
  } catch {
    return; // 查询失败静默（老 git 无 --format 支持时不显示标签区）
  }
  if (tags.length === 0) return;
  const titleEl = document.createElement("div");
  titleEl.className = "git-branch-group-title";
  titleEl.textContent = t("git.branch.tagsGroup", { n: tags.length });
  box.appendChild(titleEl);
  for (const tag of tags) {
    const item = document.createElement("div");
    item.className = "git-branch-item";
    const name = document.createElement("span");
    name.className = "scm-name";
    name.textContent = tag.name;
    const tagIcon = codicon("tag");
    tagIcon.dataset.tip = t("git.branch.tagPointsAt", { hash: tag.short_hash });
    // 点击 = 查看指向的提交详情
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      void showCommitDetail(tag.short_hash);
    });
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMenu([
        { label: t("git.branch.checkoutTag", { name: tag.name }), icon: "tag", action: () => void checkoutBranch(tag.name) },
      ], { x: e.clientX, y: e.clientY });
    });
    item.append(tagIcon, name);
    box.appendChild(item);
  }
}

export function toggleBranchList(): void {
  const list = $("git-branch-list");
  const willShow = list.classList.contains("hidden");
  list.classList.toggle("hidden", !willShow);
  if (willShow) renderBranchList();
}

function renderBranchList(): void {
  const box = $("git-branch-list");
  box.textContent = "";
  if (gitBranches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "git-empty";
    empty.textContent = t("git.branch.noBranch");
    box.appendChild(empty);
  }
  // 迭代 3 · B8：本地 / 远程分组展示（远程点击 = 检出并自动建跟踪分支）
  const locals = gitBranches.filter((b) => !b.remote);
  const remotes = gitBranches.filter((b) => b.remote);
  const renderGroup = (title: string, items: typeof gitBranches): void => {
    if (items.length === 0) return;
    const titleEl = document.createElement("div");
    titleEl.className = "git-branch-group-title";
    titleEl.textContent = title;
    box.appendChild(titleEl);
    for (const b of items) {
      const item = document.createElement("div");
      item.className = "git-branch-item" + (b.current ? " current" : "");
      item.dataset.branch = b.name;
      if (b.remote) item.dataset.remote = "1";
      const name = document.createElement("span");
      name.className = "scm-name";
      name.textContent = b.name;
      item.appendChild(name);
      if (b.current) {
        const mark = codicon("check");
        mark.dataset.tip = t("git.branch.currentGroup");
        item.appendChild(mark);
      } else if (b.remote) {
        const remoteIcon = codicon("cloud");
        remoteIcon.dataset.tip = t("git.branch.remoteGroup");
        remoteIcon.setAttribute("aria-label", t("git.branch.remoteTip"));
        item.appendChild(remoteIcon);
      }
      // 迭代 3 · P1-5：分支右键菜单（合并到当前 / 变基到）
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!b.current) showBranchContextMenu(b, { x: e.clientX, y: e.clientY });
      });
      box.appendChild(item);
    }
  };
  renderGroup(t("git.branch.localGroup"), locals);
  renderGroup(t("git.branch.remoteGroupShort"), remotes);
  // 迭代 3 · P1-6：标签区（列出 + 点击查看指向的提交）
  void appendTagSection(box);
  const newToggle = document.createElement("button");
  newToggle.className = "git-branch-new-btn";
  newToggle.textContent = t("git.branch.newBranchMenu");
  const newBox = document.createElement("div");
  newBox.className = "git-branch-new hidden";
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.placeholder = t("git.branch.newBranchPlaceholder");
  input.spellcheck = false;
  const btn = document.createElement("button");
  // UI-08：原先靠 `.git-branch-new button` 后代选择器取样式，迁移到 .btn 体系后须显式加类名
  // （wireGitUI 的事件委托仍用 `.git-branch-new button` 命中，与类名无关，不受影响）
  btn.className = "btn btn--sm btn--primary";
  btn.textContent = t("git.action.create");
  newBox.append(input, btn);
  // P1：新建分支输入框默认折叠，点「新建分支…」才展开（对标 VSCode 分支栏）
  newToggle.addEventListener("click", () => {
    newToggle.classList.add("hidden");
    newBox.classList.remove("hidden");
    input.focus();
  });
  box.append(newToggle, newBox);
}

/** 切换分支（迭代 3 · B3：脏工作区保护——stash 后切换 / 直接切换 / 取消 三选）。
 *  远程分支路由（B8 闭环）：本地无同名 → checkout --track 建跟踪分支（不弹确认，
 *  点击即用户想要的 90% 结果）；本地已有同名 → 直接切本地分支（不覆盖不重置）。 */
export async function checkoutBranch(name: string, opts?: { remote?: boolean; detachedOnly?: boolean }): Promise<void> {
  if (!app.workspaceRoot) return;
  let target = name;
  let track = false;
  if (opts?.remote && !opts.detachedOnly) {
    const short = shortRemoteName(name);
    const localExists = gitBranches.some((b) => !b.remote && b.name === short);
    if (localExists) {
      target = short; // 同名本地已有：切本地，绝不覆盖
    } else {
      track = true; // 无同名：--track origin/x → 本地 x 跟踪 origin/x
    }
  }
  const dirty = gitFiles.filter((f) => f.code !== "!");
  if (dirty.length > 0) {
    const choice = await openChoice({
      title: t("git.action.switchBranch"),
      message: t("git.branch.dirtyConfirm", { count: dirty.length }),
      okLabel: t("git.branch.stashFirst"),
      neutralLabel: t("git.branch.switchDirect"),
      cancelLabel: t("common.cancel"),
      kind: "primary",
    });
    if (choice === "cancel") return;
    if (choice === "ok") {
      try {
        await invoke("git_stash_push", { root: app.workspaceRoot, message: t("git.branch.autoStashing", { name: name }), includeUntracked: false });
      } catch (e) {
        toastFail(t("git.action.autoStash"), e);
        return;
      }
      if (await doCheckout(target, track)) {
        try {
          await invoke("git_stash_pop", { root: app.workspaceRoot });
          toast(t("git.toast.switchedAndPopped"), "success");
          // pop 发生在 doCheckout 的刷新之后：贮藏的改动刚写回工作区，补一次重载
          await reloadTabsFromGitChange();
        } catch (e) {
          appendOutputLine(outputEl, t("git.out.stashPopRestoreFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
          toastFail(t("git.action.restoreStash"), e);
        }
      }
      return;
    }
  }
  await doCheckout(target, track);
}

/** origin/feature-x → feature-x（非远程名原样返回） */
function shortRemoteName(name: string): string {
  const idx = name.indexOf("/");
  return idx > 0 ? name.slice(idx + 1) : name;
}

/** checkout 实执行（不带保护逻辑）；成功返回 true。track=true 走 --track */
async function doCheckout(name: string, track = false): Promise<boolean> {
  if (!app.workspaceRoot) return false;
  try {
    await invoke("git_checkout", { root: app.workspaceRoot, branch: name, track });
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.switchFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.switchBranch"), e);
    return false;
  }
  if (track) {
    toast(t("git.toast.checkedOut", { branch: shortRemoteName(name), remote: name }), "success");
  }
  closeBranchList();
  await refreshAfterBranchChange();
  return true;
}

/** 分支名合法性预校验（迭代 3 · C7：refs 规则前置，不再依赖 git 报错） */
function validateBranchName(name: string): string | null {
  const n = name.trim();
  if (!n) return t("git.branch.nameEmpty");
  if (n.startsWith("-") || n.startsWith("/")) return t("git.branch.nameStart");
  if (n.endsWith("-") || n.endsWith("/") || n.endsWith(".") || n.endsWith(".lock")) return t("git.branch.nameEnd");
  if (n.includes("..") || n.includes("//") || n.includes("@{")) return t("git.branch.nameSeq");
  if (/[\\\s~^:?*\[\]]/.test(n)) return t("git.branch.nameChars");
  return null;
}

/** 新建并切换分支（迭代 3 · C7：预校验） */
async function createBranchAndSwitch(name: string): Promise<void> {
  if (!app.workspaceRoot) return;
  const err = validateBranchName(name);
  if (err) {
    toast(err, "error");
    return;
  }
  const n = name.trim();
  try {
    await invoke("git_create_branch", { root: app.workspaceRoot, name: n });
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.createBranchFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.createBranch"), e);
    return;
  }
  closeBranchList();
  await refreshAfterBranchChange();
}

/** 分支右键菜单（迭代 3 · P1-5：合并 / 变基） */
function showBranchContextMenu(b: { name: string; current: boolean; remote: boolean }, anchor: MenuAnchor): void {
  const items: MenuItem[] = [];
  // B8 闭环：远程分支提供 detached 检出（与 tag 检出同款模式——明确告知后果）
  if (b.remote) {
    items.push({
      label: t("git.branch.checkoutDetached", { name: b.name }),
      detail: t("git.branch.checkoutDetachedTip"),
      icon: "eye",
      action: () => void checkoutBranch(b.name, { remote: true, detachedOnly: true }),
    });
    items.push({ sep: true });
  }
  items.push(
    {
      label: t("git.branch.mergeTitle", { branch: b.name }),
      detail: t("git.branch.mergeTip"),
      icon: "git-merge",
      action: () => void mergeBranch(b.name, { no_ff: false, squash: false }),
    },
    {
      label: t("git.branch.mergeNoFf"),
      detail: t("git.branch.mergeNoFfTip"),
      icon: "git-merge",
      action: () => void mergeBranch(b.name, { no_ff: true, squash: false }),
    },
    {
      label: t("git.branch.mergeSquash"),
      detail: t("git.branch.mergeSquashTip"),
      icon: "git-merge",
      action: () => void mergeBranch(b.name, { no_ff: false, squash: true }),
    },
    { sep: true },
    {
      label: t("git.branch.rebaseTitle", { branch: b.name }),
      detail: t("git.branch.rebaseTip"),
      icon: "arrow-right",
      action: () => void rebaseOnto(b.name),
    },
  );
  showMenu(items, anchor);
}

/** merge 指定分支到当前分支（P1-5；冲突走既有冲突解决 UI） */
async function mergeBranch(branch: string, opts: { no_ff: boolean; squash: boolean }): Promise<void> {
  const root = app.workspaceRoot;
  if (!root) return;
  appendOutputLine(outputEl, `> git merge${opts.no_ff ? " --no-ff" : ""}${opts.squash ? " --squash" : ""} ${branch}`, "cmd", gotoFromLink, "git");
  try {
    const out = await invoke<string>("git_merge", { root, branch, no_ff: opts.no_ff, squash: opts.squash });
    for (const line of out.split("\n")) appendOutputLine(outputEl, line, "stdout", gotoFromLink, "git");
    toast(t("git.toast.merged", { branch: branch }), "success");
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.mergeFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.merge"), e);
  }
  await refreshAfterBranchChange();
  renderGitPanel();
}

/** rebase 当前分支到指定分支（P1-5） */
async function rebaseOnto(branch: string): Promise<void> {
  const root = app.workspaceRoot;
  if (!root) return;
  const ok = await openConfirm({
    title: t("git.branch.rebaseConfirmTitle"),
    message: t("git.branch.rebaseConfirm", { branch: branch }),
    okLabel: t("git.action.rebase"),
    cancelLabel: t("common.cancel"),
    kind: "primary",
  });
  if (!ok) return;
  appendOutputLine(outputEl, `> git rebase ${branch}`, "cmd", gotoFromLink, "git");
  try {
    const out = await invoke<string>("git_rebase", { root, branch });
    for (const line of out.split("\n")) appendOutputLine(outputEl, line, "stdout", gotoFromLink, "git");
    toast(t("git.toast.rebased", { branch: branch }), "success");
  } catch (e) {
    appendOutputLine(outputEl, t("git.out.rebaseFailed", { error: localizeBackendError(errMsg(e)) }), "stderr", gotoFromLink, "git");
    toastFail(t("git.action.rebase"), e);
  }
  await refreshAfterBranchChange();
  renderGitPanel();
}

/** 分支变化后统一刷新（git 状态 + 分支 + 文件树 + 重载编辑器）。
 *  体验修复第 5 则：checkout/merge/rebase/revert/cherry-pick 都改写工作区文件，
 *  此前编辑器里的旧内容不刷新（幽灵内容）。收尾统一重载已打开的干净 tab。 */
async function refreshAfterBranchChange(): Promise<void> {
  await refreshGitStatus();
  await refreshBranchPanel();
  await refreshTreeWithExpandedState();
  renderGitPanel();
  await reloadTabsFromGitChange();
}

// ---------- Worktree 管理（迭代 5 · P2-9） ----------

/** worktree 管理弹层（列表 / 新建 / 移除 / 打开） */
async function openWorktreeManager(): Promise<void> {
  const root = app.workspaceRoot;
  if (!root || !gitRepoActive.value) return;
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.id = "git-worktree-modal";
  const card = document.createElement("div");
  card.className = "modal-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", t("git.worktree.manageTitle"));
  const title = document.createElement("div");
  title.className = "modal-title";
  title.textContent = t("git.worktree.title");
  card.appendChild(title);
  const list = document.createElement("div");
  list.className = "git-remote-list"; // 复用远程面板样式
  card.appendChild(list);
  // 新建行
  const addRow = document.createElement("div");
  addRow.className = "git-remote-add-row";
  const pathInput = document.createElement("input");
  pathInput.type = "text";
  pathInput.placeholder = t("git.worktree.pathLabel");
  pathInput.autocomplete = "off";
  pathInput.spellcheck = false;
  const branchInput = document.createElement("input");
  branchInput.type = "text";
  branchInput.placeholder = t("git.worktree.branchLabel");
  branchInput.autocomplete = "off";
  branchInput.spellcheck = false;
  const addBtn = document.createElement("button");
  addBtn.className = "btn btn--primary";
  addBtn.textContent = t("git.action.create");
  addRow.append(pathInput, branchInput, addBtn);
  card.appendChild(addRow);
  const closeRow = document.createElement("div");
  closeRow.className = "modal-actions";
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn";
  closeBtn.textContent = t("common.close");
  closeRow.appendChild(closeBtn);
  card.appendChild(closeRow);
  overlay.appendChild(card);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) overlay.remove(); });
  closeBtn.addEventListener("click", () => overlay.remove());

  const renderList = async (): Promise<void> => {
    list.textContent = "";
    let trees: { path: string; branch: string | null; main: boolean }[] = [];
    try {
      trees = await invoke("git_worktree_list", { root });
    } catch (e) {
      list.appendChild(emptyState("error", t("git.worktree.listFailed"), String(e)));
      return;
    }
    for (const wt of trees) {
      const row = document.createElement("div");
      row.className = "git-remote-item";
      const info = document.createElement("div");
      info.className = "git-remote-info";
      const name = document.createElement("div");
      name.className = "git-remote-name";
      name.textContent = t("git.worktree.itemLabel", { kind: wt.main ? t("git.worktree.main") : "worktree", branch: wt.branch ?? "detached" });
      const url = document.createElement("div");
      url.className = "git-remote-url";
      url.textContent = wt.path;
      url.title = wt.path;
      info.append(name, url);
      // 打开（切工作区）走「打开工作区」入口（openWorkspace 由 main 管理，这里给提示）
      const openBtn = document.createElement("button");
      openBtn.className = "btn btn--sm";
      openBtn.textContent = t("git.worktree.copyPath");
      openBtn.dataset.tip = t("git.worktree.copyPathTip");
      openBtn.addEventListener("click", () => {
        void invoke("copy_to_clipboard", { text: wt.path });
        toast(t("git.toast.pathCopied"), "info");
      });
      row.append(info, openBtn);
      if (!wt.main) {
        const rmBtn = document.createElement("button");
        rmBtn.className = "btn btn--sm btn--danger-outline";
        rmBtn.textContent = t("git.worktree.removeMenu");
        rmBtn.addEventListener("click", async () => {
          const ok = await openConfirm({
            title: t("git.worktree.removeTitle"),
            message: t("git.worktree.removeConfirm", { path: wt.path }),
            okLabel: t("git.worktree.removeOk"),
            cancelLabel: t("common.cancel"),
            kind: "danger",
          });
          if (!ok) return;
          try {
            await invoke("git_worktree_remove", { root, path: wt.path, force: true });
            toast(t("git.toast.worktreeRemoved"), "success");
            await renderList();
          } catch (e) {
            toastFail(t("git.worktree.removeTitle"), e);
          }
        });
        row.appendChild(rmBtn);
      }
      list.appendChild(row);
    }
  };
  addBtn.addEventListener("click", async () => {
    const p = pathInput.value.trim();
    const b = branchInput.value.trim();
    if (!p) {
      toast(t("git.toast.pathEmpty"), "error");
      return;
    }
    try {
      await invoke("git_worktree_add", { root, path: p, branch: b || "main", newBranch: b.length > 0 });
      toast(t("git.toast.worktreeCreated", { path: p }), "success");
      pathInput.value = "";
      branchInput.value = "";
      await renderList();
    } catch (e) {
      toastFail(t("git.action.createWorktree"), e);
    }
  });
  document.body.appendChild(overlay);
  await renderList();
}

// ---------- P2-7：提交信息建议（迭代 5 · 规则式 Conventional Commits） ----------

/** P2-8 会话级开关（默认开；提交下拉可切换。不进全局设置：避免动 Settings/Rust 三处同步） */
let preCommitFormatEnabled = true;

/** 按暂存文件集合推断提交类型前缀（feat/fix/refactor/docs/chore/test） */
function suggestCommitPrefix(staged: GitStatusFile[]): { type: string; scope: string } | null {
  if (staged.length === 0) return null;
  const isPy = (p: string): boolean => p.endsWith(".py") || p.endsWith(".pyw");
  const has = (pred: (p: string) => boolean): boolean => staged.some((f) => pred(f.path));
  // scope：单文件取模块名（去扩展名的 basename）；多文件取共同顶层目录
  let scope = "";
  if (staged.length === 1) {
    scope = staged[0].path.replace(/\.[^.]+$/, "").replace(/[\\/]/g, "-");
  } else {
    const dirs = new Set(staged.map((f) => f.path.split("/")[0] ?? ""));
    if (dirs.size === 1) {
      const d = [...dirs][0];
      if (d && staged.some((f) => f.path.includes("/"))) scope = d;
    }
  }
  // 类型推断：测试文件 → test；仅文档 → docs；依赖/配置 → chore；默认 feat
  if (staged.every((f) => /(^|\/)(tests?|test_)/.test(f.path) || f.path.match(/_test\.py$/) || f.path.startsWith("test"))) {
    return { type: "test", scope };
  }
  if (staged.every((f) => /\.(md|rst|txt)$/.test(f.path))) return { type: "docs", scope };
  if (staged.every((f) => /(pyproject\.toml|requirements.*\.txt|uv\.lock|\.gitignore|setup\.py|ci\/)/.test(f.path))) {
    return { type: "chore", scope };
  }
  void isPy; void has;
  return { type: "feat", scope };
}

/** 渲染提交建议 chips（点击填入前缀） */
function renderCommitSuggest(): void {
  const box = $("git-commit-suggest");
  const staged = gitFiles.filter((f) => gitFileStaged(f));
  const s = suggestCommitPrefix(staged);
  box.textContent = "";
  if (!s) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  const label = document.createElement("span");
  label.className = "git-suggest-label";
  label.textContent = t("git.scm.prefixSuggest");
  box.appendChild(label);
  const mk = (type: string): void => {
    const chip = document.createElement("button");
    chip.className = "git-suggest-chip";
    const full = s.scope ? `${type}(${s.scope}): ` : `${type}: `;
    chip.textContent = full;
    chip.dataset.tip = t("git.scm.prefixFill", { prefix: full });
    chip.addEventListener("click", () => {
      const msgEl = $("git-commit-msg") as HTMLTextAreaElement;
      // 已有前缀则替换，否则前插
      const cur = msgEl.value;
      if (/^(feat|fix|refactor|docs|chore|test|style|perf)(\([^)]*\))?: /i.test(cur)) {
        msgEl.value = cur.replace(/^(\w+)(\([^)]*\))?: /i, full);
      } else {
        msgEl.value = full + cur;
      }
      msgEl.focus();
    });
    box.appendChild(chip);
  };
  // 主建议 + 常用备选
  mk(s.type);
  for (const alt of ["fix", "refactor", "docs", "chore"]) {
    if (alt !== s.type) mk(alt);
  }
}

// ---------- P2-8：提交前检查（迭代 5 · 暂存 Python 文件 ruff format 后重新 add） ----------

/** 提交前对暂存的 .py 文件跑 ruff format（格式化暂存区内容）。
 *  实现：formatPythonSource(path, 暂存区内容) → 有变化则 write 回文件 + git add——
 *  注意这会把工作区未暂存改动一起带入（同文件部分提交场景），故仅对「工作区干净
 *  （该文件无未暂存改动）」的暂存文件执行，避免踩用户的部分提交意图。 */
async function preCommitFormat(): Promise<void> {
  const root = app.workspaceRoot;
  if (!root) return;
  const stagedFiles = gitFiles.filter((f) => gitFileStaged(f) && (f.path.endsWith(".py") || f.path.endsWith(".pyw")));
  for (const f of stagedFiles) {
    // 工作区与暂存区一致的文件才安全（f.y === ' ' 表示无工作区改动）
    if (f.y !== " ") continue;
    try {
      const v = await invoke<{ old: string; new: string }>("git_diff_versions", { root, path: f.path, staged: true, base: null, ignoreWhitespace: false });
      const formatted = await formatPythonSource(joinPath(root, f.path), v.new);
      if (formatted !== null && formatted !== v.new) {
        await invoke("write_file", { path: joinPath(root, f.path), content: formatted });
        await invoke("git_stage", { root, paths: [f.path] });
        appendOutputLine(outputEl, t("git.out.preCommitFormatted", { path: f.path }), "hint", gotoFromLink, "git");
      }
    } catch { /* 单文件失败不阻断提交 */ }
  }
}

// ---------- C6：SCM 列表多选 + 批量操作（迭代 5） ----------

/** 多选集合（仓库相对路径）；空 = 单选行为不变 */
const scmSelected = new Set<string>();

/** 批量操作条：有选中时显示在分组标题上方（暂存/丢弃 N 项 / 清除选择） */
function renderScmBulkBar(): void {
  document.getElementById("git-scm-bulk")?.remove();
  if (scmSelected.size === 0) return;
  const box = $("git-changes");
  const bar = document.createElement("div");
  bar.id = "git-scm-bulk";
  bar.className = "git-scm-bulk";
  const info = document.createElement("span");
  info.textContent = t("git.scm.selected", { count: scmSelected.size });
  const stageBtn = document.createElement("button");
  stageBtn.className = "btn btn--sm";
  stageBtn.textContent = t("git.scm.batchStage");
  stageBtn.addEventListener("click", () => {
    void stageFiles([...scmSelected]);
    clearScmSelection();
  });
  const unstageBtn = document.createElement("button");
  unstageBtn.className = "btn btn--sm";
  unstageBtn.textContent = t("git.scm.batchUnstage");
  unstageBtn.addEventListener("click", () => {
    void unstageFiles([...scmSelected]);
    clearScmSelection();
  });
  const discardBtn = document.createElement("button");
  discardBtn.className = "btn btn--sm btn--danger-outline";
  discardBtn.textContent = t("git.scm.batchDiscard");
  discardBtn.addEventListener("click", () => {
    const files = gitFiles.filter((f) => scmSelected.has(f.path));
    void discardFiles(files);
    clearScmSelection();
  });
  const clearBtn = document.createElement("button");
  clearBtn.className = "btn btn--sm btn--ghost";
  clearBtn.textContent = t("git.scm.clear");
  clearBtn.addEventListener("click", clearScmSelection);
  bar.append(info, stageBtn, unstageBtn, discardBtn, clearBtn);
  box.prepend(bar);
}

/** 清除多选并重渲染 */
function clearScmSelection(): void {
  scmSelected.clear();
  renderGitPanel();
}

/** 条目点击时的多选处理：Ctrl=切换、Shift=范围（同分组内连续）、普通=单选清空 */
function handleScmSelect(e: MouseEvent, path: string): void {
  if (e.ctrlKey || e.metaKey) {
    if (scmSelected.has(path)) scmSelected.delete(path);
    else scmSelected.add(path);
  } else if (e.shiftKey && scmSelected.size > 0) {
    // 范围：从最近一个选中项到当前项（按当前列表顺序）
    const order = gitFiles.map((f) => f.path);
    const last = [...scmSelected].at(-1) ?? path;
    const from = Math.min(order.indexOf(last), order.indexOf(path));
    const to = Math.max(order.indexOf(last), order.indexOf(path));
    for (let i = from; i <= to; i++) if (i >= 0) scmSelected.add(order[i]);
  } else {
    scmSelected.clear();
    scmSelected.add(path);
  }
  // 重渲染选中态 + 批量条（全量重渲染最简单且列表规模小）
  renderGitPanel();
}

// ---------- 事件接线 / 复位 ----------

/** 接线 Git 全部 UI 交互（SCM 工具栏 / 历史 / diff / 提交 / 变更列表 / 分支条） */
export function wireGitUI(): void {
  // 动态 Git 文案不在静态 index.html 的 data-i18n 扫描范围内：语言切换时重绘当前面板，
  // 否则用户会看到按钮已是英文、变更分组和分支列表仍是中文的「半切换」状态。
  onLocaleChange(() => {
    renderGitPanel();
    updateGitStatusBar();
    if (!$('git-branch-list').classList.contains("hidden")) renderBranchList();
    if (gitDetailLabelEl.textContent === "—") renderGitDetailEmptyState();
  });

  // SCM 工具栏（P0）：次要动作（远程 / stash / 历史）收进「更多操作」菜单，工具条只留刷新 + 更多。
  // 验收复核修正：刷新按钮此前只 refreshGitStatus 不重渲染——点完面板纹丝不动（真实 bug，
  // 用户须切一次 tab 才见新状态）。刷新 = 状态 + 面板 + 分支条（onShow 同款三连）。
  $btn("git-btn-refresh").addEventListener("click", () => {
    void refreshGitStatus().then(() => {
      renderGitPanel();
      void refreshBranchPanel();
    });
  });
  $btn("git-btn-more").addEventListener("click", (e) => {
    showMenu(
      [
        { label: t("git.menu.fetch"), icon: "sync", action: () => void gitRemoteOp("fetch", { prune: false }) },
        { label: t("git.menu.fetchPrune"), icon: "sync", detail: "fetch --all --prune", action: () => void gitRemoteOp("fetch", { prune: true }) },
        { label: t("git.menu.pull"), icon: "arrow-down", action: () => void gitRemoteOp("pull") },
        { label: t("git.menu.push"), icon: "arrow-up", action: () => void gitRemoteOp("push") },
        // 迭代 4 · P2-1：当前分支无上游时的「推送并建立上游」
        {
          label: t("git.menu.pushTip"),
          icon: "cloud-upload",
          detail: "push -u origin HEAD",
          action: () => void gitRemoteOp("push", { remote: "origin", branch: currentBranch ?? "" }),
        },
        { sep: true },
        { label: t("git.menu.remote"), icon: "cloud", detail: t("git.menu.remoteTip"), action: () => void openRemoteManager() },
        { label: "Worktree…", icon: "split-horizontal", detail: t("git.menu.worktreeTip"), action: () => void openWorktreeManager() },
        { sep: true },
        { label: t("git.stash.title"), icon: "save", action: () => void gitStash() },
        { label: t("git.action.stashPop"), action: () => void gitStashPop() },
        { label: t("git.menu.stashList"), icon: "list-flat", action: () => toggleStashPanel() },
        { sep: true },
        { label: t("git.menu.history"), icon: "history", action: () => toggleHistory() },
      ],
      e.currentTarget as HTMLElement,
    );
  });
  $("git-history").addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest(".git-commit-item") as HTMLElement | null;
    if (item?.dataset.hash) void showCommitDetail(item.dataset.hash);
  });
  // 迭代 3 · P1-4：历史条目右键（cherry-pick / revert / reset / 新建分支 / 新建标签）
  $("git-history").addEventListener("contextmenu", (e) => {
    const item = (e.target as HTMLElement).closest(".git-commit-item") as HTMLElement | null;
    if (!item?.dataset.hash || !app.workspaceRoot) return;
    e.preventDefault();
    showCommitContextMenu(item.dataset.hash, item.dataset.subject ?? "", { x: e.clientX, y: e.clientY });
  });
  // 差异视图操作（导航 / 折叠 / 布局切换 / 忽略空白 / 三态基准 / hunk 操作 / Blame / 关闭）
  $btn("git-diff-prev").addEventListener("click", () => diffGoToChange(-1));
  $btn("git-diff-next").addEventListener("click", () => diffGoToChange(1));
  $btn("git-diff-collapse").addEventListener("click", () => diffToggleCollapse());
  $btn("git-diff-layout").addEventListener("click", () => diffToggleLayout());
  // C4：忽略空白开关——切换后重开当前 diff（Monaco ignoreTrimWhitespace + hunk 重拉）
  $btn("git-diff-ws").addEventListener("click", () => {
    diffIgnoreWhitespace = !diffIgnoreWhitespace;
    const btn = $btn("git-diff-ws");
    btn.classList.toggle("active", diffIgnoreWhitespace);
    btn.setAttribute("aria-pressed", String(diffIgnoreWhitespace));
    if (diffFilePath) {
      const f = gitFiles.find((x) => x.path === diffFilePath);
      if (f) void showDiff(f, diffBase);
    }
  });
  // P1-2：三态基准切换
  const setBase = (base: DiffBase): void => {
    if (!diffFilePath) return;
    const f = gitFiles.find((x) => x.path === diffFilePath);
    if (!f) return;
    void showDiff(f, base);
  };
  $btn("git-diff-base-auto").addEventListener("click", () => setBase("auto"));
  $btn("git-diff-base-index").addEventListener("click", () => setBase("index"));
  $btn("git-diff-base-head").addEventListener("click", () => setBase("head"));
  // P1-1：hunk 级暂存 / 丢弃（按光标所在变更块）
  $btn("git-diff-hunk-stage").addEventListener("click", () => {
    // 当前基准是「已暂存」侧时操作语义反转（把该块从暂存区拿回来）
    void applyCurrentHunk(diffBase === "index" ? "unstage" : "stage");
  });
  $btn("git-diff-hunk-discard").addEventListener("click", () => void applyCurrentHunk("discard"));
  $btn("git-diff-accept-current").addEventListener("click", async () => {
    const f = gitFiles.find((x) => x.path === diffConflictPath);
    if (!f) return;
    if (await acceptConflict("current", f)) {
      diffConflictPath = null;
      enableConflictEditing(false, null); // 复核修正：接受后收回编辑态（closeDiffPanel 只切 tab）
      closeDiffPanel();
    }
  });
  $btn("git-diff-accept-incoming").addEventListener("click", async () => {
    const f = gitFiles.find((x) => x.path === diffConflictPath);
    if (!f) return;
    if (await acceptConflict("incoming", f)) {
      diffConflictPath = null;
      enableConflictEditing(false, null); // 复核修正：同上
      closeDiffPanel();
    }
  });
  // P0.5-C5：「接受双方」= 一键把全部冲突块设为 both 后走块级重组（写回 + add），
  // 与工具栏「当前/传入」同一交互层级，不再需要用户下钻到块级合并面板。
  $btn("git-diff-accept-both").addEventListener("click", () => {
    if (!diffConflictPath || mergeConflictCount === 0) return;
    for (let i = 0; i < mergeConflictCount; i++) mergeSelections.set(i, "both");
    renderMergeBlocks();
    void applyMergeResolve();
  });
  // P1-3：应用编辑结果（冲突 diff 传入侧被编辑后出现）
  $btn("git-diff-apply-edit").addEventListener("click", () => void applyConflictEdit());
  $btn("git-diff-close").addEventListener("click", () => closeDiffPanel());
  $btn("git-diff-blame").addEventListener("click", () => {
    if (diffFilePath) void showBlame(diffFilePath);
  });
  // Git 详情视图（提交详情 / blame）：关闭切回输出
  $btn("git-detail-close").addEventListener("click", () => setBottomTab("output"));
  // SCM：提交按钮 + 提交下拉（Amend / 提交全部）+ 提交信息输入 + 变更列表点击委托
  $btn("git-commit-btn").addEventListener("click", () => void commitChanges());
  $btn("git-commit-more").addEventListener("click", (e) => {
    showMenu(
      [
        { label: t("git.menu.commitAll"), detail: t("git.menu.commitAllTip"), action: () => void commitAll() },
        { label: t("git.menu.commitAmend"), detail: t("git.menu.commitAmendTip"), action: () => void commitChanges(true) },
        { sep: true },
        // 迭代 5 · P2-8：提交前格式化开关（会话级）
        {
          label: preCommitFormatEnabled ? t("git.menu.formatOn") : t("git.menu.formatOff"),
          detail: t("git.menu.formatTip"),
          action: () => {
            preCommitFormatEnabled = !preCommitFormatEnabled;
            toast(preCommitFormatEnabled ? t("git.toast.formatOn") : t("git.toast.formatOff"), "info");
          },
        },
      ],
      e.currentTarget as HTMLElement,
    );
  });
  $("git-commit-msg").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void commitChanges();
    }
  });
  // P1-F：输入即清除内联校验错误
  $("git-commit-msg").addEventListener("input", () => {
    const errEl = $("git-commit-error");
    if (!errEl.classList.contains("hidden")) errEl.classList.add("hidden");
  });
  $("git-changes").addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest(".scm-item") as HTMLElement | null;
    if (!item || !app.workspaceRoot) return;
    const path = item.dataset.path;
    if (!path) return;
    if (target.classList.contains("scm-action")) {
      // 暂存 / 取消暂存按钮；冲突项弹出解决菜单
      if (target.classList.contains("conflict")) {
        const f = gitFiles.find((x) => x.path === path);
        if (f) conflictMenu(f, target);
        return;
      }
      if (item.dataset.staged === "1") void unstageFiles([path]);
      else void stageFiles([path]);
    } else if (target.closest(".scm-discard")) {
      // 丢弃更改（仅未暂存项出现该按钮）
      const f = gitFiles.find((x) => x.path === path);
      if (f) void discardFiles([f]);
    } else {
      // C6：Ctrl/Shift 点击 = 多选（不打开 diff）；普通点击 = 查看 diff（并清多选）
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        handleScmSelect(e, path);
        return;
      }
      if (scmSelected.size > 0) clearScmSelection();
      // 点击条目查看 diff；冲突项打开两路冲突对比
      const f = gitFiles.find((x) => x.path === path);
      if (!f) return;
      if (f.code === "!") void showConflictDiff(f);
      else void showDiff(f);
    }
  });
  // SCM 变更项右键菜单：暂存/取消暂存、打开差异、（未暂存）丢弃、复制路径
  $("git-changes").addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest(".scm-item") as HTMLElement | null;
    if (!item || !app.workspaceRoot) return;
    e.preventDefault();
    const path = item.dataset.path;
    if (!path) return;
    const staged = item.dataset.staged === "1";
    const f = gitFiles.find((x) => x.path === path);
    // 冲突项：右键直接出解决方案菜单（接受当前/传入、标记已解决、手动解决）
    if (f && f.code === "!") {
      conflictMenu(f, { x: e.clientX, y: e.clientY });
      return;
    }
    const items: MenuItem[] = [
      staged
        ? { label: t("git.action.unstage"), icon: "remove", action: () => void unstageFiles([path]) }
        : { label: t("git.action.stage"), icon: "add", action: () => void stageFiles([path]) },
      { label: t("git.menu.openDiff"), icon: "diff", action: () => { if (f) void showDiff(f); } },
      // P0.5-C1：补「打开文件」——此前 SCM 条目只能看 diff，想改源码必须去文件树找
      { label: t("git.menu.openFile"), icon: "go-to-file", action: () => { if (f && openFileHandler && app.workspaceRoot) void openFileHandler(joinPath(app.workspaceRoot, f.path)); } },
    ];
    if (!staged && f) {
      items.push({ label: t("git.menu.discard"), icon: "discard", danger: true, action: () => void discardFiles([f]) });
    }
    items.push({ sep: true });
    items.push({ label: t("git.worktree.copyPath"), icon: "copy", action: () => void invoke("copy_to_clipboard", { text: path }) });
    showMenu(items, { x: e.clientX, y: e.clientY });
  });
  // SCM 分支条：展开列表 / 切换分支 / 新建分支
  $btn("git-branch-btn").addEventListener("click", () => toggleBranchList());
  // 迭代 5 · C3：SCM 内嵌 tab（更改/历史/贮藏）
  $btn("git-subtab-changes").addEventListener("click", () => setGitSubtab("changes"));
  $btn("git-subtab-history").addEventListener("click", () => setGitSubtab("history"));
  $btn("git-subtab-stash").addEventListener("click", () => setGitSubtab("stash"));
  // 迭代 3 · P0-4：状态栏分支名可点击（弹分支切换列表，与侧栏分支条同源）
  $("status-git").addEventListener("click", () => {
    if (!gitRepoActive.value) return;
    setSidebarTab("git");
    toggleBranchList();
  });
  $("git-branch-list").addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest(".git-branch-item") as HTMLElement | null;
    if (item && item.dataset.branch) {
      // B8 闭环：远程条目传 remote 标志（checkoutBranch 内路由 --track / 切同名本地）
      void checkoutBranch(item.dataset.branch, { remote: item.dataset.remote === "1" });
      return;
    }
    if (target.closest(".git-branch-new button")) {
      const input = $("git-branch-list").querySelector(".git-branch-new input") as HTMLInputElement | null;
      if (input) void createBranchAndSwitch(input.value);
    }
  });
  $("git-branch-list").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.target as HTMLElement).matches(".git-branch-new input")) {
      void createBranchAndSwitch((e.target as HTMLInputElement).value);
    }
  });
}

/** Git 详情视图是否有内容（无内容时 tab 点击渲染空态引导） */
export function hasGitDetailContent(): boolean {
  return gitDetailViewEl.children.length > 0;
}

/** 关闭工作区时复位 Git 状态（由 main.ts closeWorkspace 调用） */
export function resetGitState(): void {
  gitStatuses.clear();
  gitFiles = [];
  gitRepoActive.value = false;
  currentBranch = null;
  gitDirtyDirs.clear();
  gitBranches = [];
  $("git-stash-panel").classList.add("hidden");
  // 第 2 步迁移：关闭全部 diff tab（工作区切换批量清理；close 回调未注入的
  // 测试环境下直接清数组）。closeTabSilent 之外的路径——resetGitState 是 git 域
  // 自清理，tab 数组同步剔除避免残留悬空 tab。
  for (const t of app.tabs.filter((t) => t.kind === "diff")) {
    const rel = t.path.slice(DIFF_TAB_PREFIX.length);
    if (diffFilePath && normalizePath(diffFilePath) === normalizePath(rel)) {
      diffFilePath = null;
      diffConflictPath = null;
    }
    try { t.model.dispose(); } catch { /* 已释放 */ }
  }
  // 原地 splice（保持 app.tabs 引用稳定——renderTabs 等消费方持引用）
  for (let i = app.tabs.length - 1; i >= 0; i--) {
    if (app.tabs[i].kind === "diff") app.tabs.splice(i, 1);
  }
  if (app.activeTab?.kind === "diff") app.activeTab = null;
  dismissDiffHost();
  diffSideBySide = true;
  diffHideUnchanged = false;
  releaseDiffModels();
  ($("git-diff-label") as HTMLElement).textContent = "—";
  // 复位 diff 工具栏按钮状态（布局 / 折叠 / 冲突接受）
  const layoutBtn = $("git-diff-layout");
  layoutBtn.dataset.tip = t("git.diff.inlineView");
  layoutBtn.setAttribute("aria-label", t("git.diff.inlineView"));
  const layoutIcon = layoutBtn.querySelector("i");
  if (layoutIcon) layoutIcon.className = "codicon codicon-split-horizontal";
  const collapseBtn = $("git-diff-collapse");
  collapseBtn.classList.remove("active");
  collapseBtn.setAttribute("aria-pressed", "false");
  toggleConflictDiffButtons(false);
  $("git-merge-blocks").classList.add("hidden");
  mergeSegments = [];
  mergeSelections = new Map();
  mergeConflictCount = 0;
  // P1-3：编辑态一并复位（conflictEditHandler 释放 + 按钮隐藏）
  enableConflictEditing(false, null);
  gitDetailViewEl.textContent = "";
  gitDetailLabelEl.textContent = "—";
  // P1-3（用户报告 2026-09-30）：关闭工作区后 #git-changes 残留旧更改列表——
  // 本函数此前只清内存状态不重渲染，而 renderGitPanel 的既有触发点（侧栏 onShow /
  // 刷新按钮 / fs-changed / git 写操作）在「工作区已关、用户停在 git 面板不动」时
  // 全都不会发生。此处统一重渲染空态兜底：
  //  - 调用时序（main.ts closeWorkspace）：resetWorkspaceUiState 先于 workspaceRoot=null，
  //    故走「不是 Git 仓库」分支（gitRepoActive 已置 false）；切工作区路径同理，
  //    后续 onShow/refreshTree 会用新数据再刷一遍。
  renderGitPanel();
  // 分支条同步复位（"—"）：refreshBranchPanel 无工作区早退分支即此效果，async 用 void 隔离
  void refreshBranchPanel();
  // 子 tab 复位到「更改」：若关闭时停在历史/贮藏页，三区互斥显隐会保持旧态——
  // 重开工作区后 changes 仍 hidden，面板看似空白。复位即修复。
  // 注意 setGitSubtab("changes") 不触发重渲染（仅 history/stash 分支才拉数据），零开销。
  setGitSubtab("changes");
  // 提交框草稿是工作区级的（草稿语义属会话快照，不走内存残留）：
  // 关工作区后残留旧信息，且 lastPrefill 不清会导致下次单文件暂存时误判预填态。
  const msgEl2 = $("git-commit-msg") as HTMLTextAreaElement;
  if (msgEl2) {
    msgEl2.value = "";
    lastPrefill = "";
  }
  const commitErrEl = $("git-commit-error");
  if (commitErrEl) commitErrEl.classList.add("hidden");
  updateGitStatusBar();
}
