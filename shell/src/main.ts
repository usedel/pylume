// 入口与胶水层（TD-007 + TD-14 功能域拆分后）：工作区生命周期 / 标签页与编辑器 /
// LSP 接线 / 搜索与大纲 / 最近文件 / 菜单栏数据 / 调试入口 / 文件监听 / init。
// 文件树 → fileTree.ts；Git → git.ts；终端与底部面板 → termUi.ts；设置面板 → settingsPanel.ts；
// Python 环境面板 → envPanel.ts；新建项目 → newProject.ts；菜单栏机制 → menuBar.ts；
// 运行域（含 RunState 收敛）→ runFlow.ts + runState.ts；运行配置面板 → runConfigPanel.ts；
// 输出链接跳转 → tracebackLink.ts；跨域共享状态 → state.ts（app 上下文对象）。

// D2：统一单色图标体系（@vscode/codicons，MIT）。先于 style.css 引入，
// 使本项目的分场景图标尺寸规则在同特异性下覆盖 codicon 基础 16px。
import "@vscode/codicons/dist/codicon.css";
import "./style.css";
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
// @tauri-apps/api/window 的 ResizeDirection 未导出（上游类型导出缺失），本地声明同步。
type ResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";
import { initLiveTemplates, type LiveTemplatesHandle } from "./live-templates";
import * as ltUi from "./live-templates/ui/manager";
import { registerKeywordCompletion, setKeywordCompletionEnabled } from "./completion/keywordCompletion"; // 零引擎关键字补全（无 LSP 引擎的语言）
import { wireWordBasedSuggestions } from "./completion/wordBasedSuggestions"; // 文档词补全按语言开关
import { initDevTools, openDevTools, openDevToolsPanel, listDevTools, groupToolsByCategory, categoryLabel } from "./devtools";
// PR-2：插件域（plugin_system_design §9）——加载器 / facade 依赖注入 / inline 管线
import { initPluginLoader, scanPlugins, schedulePluginRescan, listPluginRecords, setAppVersion } from "./extensions/loader";
import { initInlineRunner, listInlineEntries, runInline, inlineCommandLabel } from "./extensions/inline";
import { initInlineSelectionMenu } from "./extensions/inlineMenu"; // P2：编辑器右键「变换选区 ▸」子菜单
import { setPluginsTabHandlers, openGuide } from "./extensions/pluginsTab";
import {
  openOnboardingGuide, wireWelcomeGuide, isWelcomeForced, setWelcomeOverlayRefresh, setWelcomeGuideHandlers,
  renderQuickstartCards, renderTour, showWelcomeOverlay, dismissWelcomeOverlay, consumeWelcomeForce,
} from "./welcomeGuide";
import { formatPythonSource, optimizeImportsSource, registerRuffFormatter, setFormatErrorHandler } from "./format";
import { runSearch, cancelSearch, resetSearch, setOpenMatchHandler, type SearchMatch, type SearchScope, type SearchScopeMode } from "./search";
import { findUsagesAtCursor, renameSymbolAtCursor, resetFindUsages, setOpenRefHandler, queryAndRender, initFindUsagesAction, installCtrlShiftDblclickUsages } from "./findUsages";
import { wireProblemsPanel, resetProblemsPanel, setOpenProblemHandler, setShowPanelHandler, renderProblemsChip, openProblemsPanel } from "./problemsPanel"; // 问题面板（对标 PyCharm Problems）
import { initCodeVision, refreshCodeVision } from "./codeVision";
import { initDslLens, openRegexTesterAtCursor } from "./dslLens"; // 库支持 PR-2：正则 lens/装饰/诊断/右键
import { initJsonLiteral } from "./jsonLiteral"; // 库支持 P1 §7-3：JSON 字面量高亮/折叠/诊断/右键
import { refreshImportAliases, registerImportAliasCompletion } from "./importAlias"; // import 别名补全（import pandas as pd）
import { registerAutoImportCompletion, resetAutoImportIndex } from "./autoImport"; // PR-E：补全内联 auto-import（自研，探针结局 C）
import { initRenameWidget, setAfterRenameHandler, resetPydanticRenameWarn } from "./renameWidget";
import { initClipboardDiffAction } from "./clipboardDiff"; // C-5：与剪贴板对比（右键菜单）
import { initNoqaAction } from "./ruffLint"; // D-4：忽略此规则（# noqa，右键菜单）
import { installPasteJson } from "./pasteJson"; // PR-M（dx_features_backlog §6.6）：粘贴 JSON → Python 字面量
import { initQuickFixActions, resetQuickFixCache } from "./quickFix"; // P4：D-1 缺失 import 兜底 + D-2 就地创建符号
import { breakDownSaveErrors, saveErrorToastMessage, revealFirstError } from "./markerNavigation"; // 诊断导航 + 保存错误分类（F8 / 保存 toast 定位）
import * as splitEditor from "./splitEditor"; // P4（C-4）：向右分屏（handlers 注入，防 settingsPanel 成环）
import { recordClosedTab, reopenClosedTab, resetTabReopen, setTabReopenHandlers } from "./tabReopen"; // PR-A（dx_features_backlog §6.1）：重开关闭的标签
import { registerSidebarView, setSidebarTab, activeView, restoreSidebarView } from "./views";
import * as lsp from "./lsp/client";
import * as kb from "./keybindings";
import { appendOutputLine, clearOutput, setOutputLevelColorsEnabled, setOutputTracebackHandler, setOutputUrlHandler } from "./output";
import { openAlert, openConfirm, openPrompt } from "./dialog";
import { app, $, lazyEl, outputEl, statusFileEl, type Entry, type SaveOptions, type Tab } from "./state";
import {
  createDirAt, createFileInteractive, isDirExpanded, isTreeEmpty, refreshTree, reloadDir,
  renderCtxMenu, resetTreeState, scheduleFollowReveal, setFileTreeHandlers, wireFileTree, type CtxItem,
} from "./fileTree";
import {
  cleanupDiffTabState, commitAll, currentDiffEditor, discardAllChanges, dismissDiffHost, gitInitRepo, gitRemoteOp, gitStash, gitStashPop,
  presentDiffHost, refreshBranchPanel, refreshDiffIfViewing, refreshDiffOnActivate, refreshGitStatus,
  renderGitPanel, resetGitState, setDiffTabHandlers, setGitEditorBridge, setGitOpenFileHandler, setGitReloadHandler, stageAllChanges,
  toggleBranchList, toggleHistory, wireGitUI,
} from "./git";
import {
  disposeTerminal, openTerminalAt, resetOutputChannelUi, setBottomTab, toggleBottomPanel, wireBottomPanel, wireTerminalEvents,
} from "./termUi";
import { setTerminalLinkHandler, setTerminalUrlHandler } from "./terminal";
import { setExternalUrlOpener } from "./termUi";
import { loadSettings, saveSettings, applyFontStatus, openSettingsPanel, setSettingsPanelHandlers, wireSettingsPanel, buildEditorOptions, ensureEditorFontLoaded } from "./settingsPanel";
import { checkFirstRunStorage } from "./storagePanel";
import { cancelPendingSessionSave, restoreSession, scheduleSessionSave, saveSessionNow, setSessionHandlers } from "./session"; // A-5 会话恢复
import { wireResourcePanel } from "./resourcePanel"; // A-1 资源可观测
import { basename, codicon, DisposableStore, emptyState, languageOf, normalizePath, parentDirOf, relativePathOrName, renderFileIcon, samePath, symbolIcon } from "./util";
import { toast, toastFail } from "./toast";
import { initI18n, onLocaleChange, t } from "./i18n"; // i18n 运行时：initI18n 首屏套用静态骨架，t 取动态文案
import { restoreLayout, toggleSidebar, wireSplitters } from "./layout";
import { motionDisabled, restoreReduceMotion } from "./anim";
import { wireTooltip } from "./tooltip";
import { renderEngineChip, setEngineBusy, setEngineChipHandlers, wireEngineChip } from "./engineChip";
import { renderRunWidget, setRunWidgetHandlers, setRunWidgetRepaint, wireRunWidget, runWidgetHandlers } from "./runWidget";
import { clearRunGutter, isRunGutterLine, refreshRunGutter, setRunGutterHandlers, wireRunGutter } from "./runGutter";
import { clearGitGutter, refreshGitGutter, scheduleGitGutter, wireGitGutter } from "./gitGutter"; // 迭代 2 · P0-5
import { wireGutterHover } from "./gutterHover";
import * as dap from "./dap/client";
import {
  breakpointKind, clearCurrentLine, getBreakpointSpec, isBreakpointEnabled, loadBreakpoints, pushAllBreakpoints,
  refreshDebugGutter, removeBreakpoint, resetBreakpoints, setBreakpointEnabled, setBreakpointMenuHandler, toggleBreakpoint,
  updateBreakpoint, wireDebugGutter,
} from "./debugGutter";
import { showMenu, type MenuItem } from "./menu";
import { initTodoView, refreshTodos, resetTodoView, setTodoViewHandlers } from "./todoView"; // P0：TODO 工具窗
import { initEndpointView, refreshEndpoints, resetEndpointView, setEndpointViewHandlers } from "./endpointView"; // F1：端点工具窗
import { initDbView, onDbViewShow, resetDbView, refreshDbWorkspace, addConnection } from "./sqliteView"; // B3：SQLite 数据库侧栏（资源管理器）
import { setDbTabHandlers, presentDbTab, cleanupDbTab, dismissDbHost, dbTabLabel, dbTabIcon, invalidateDbTokens, openQueryTabForActive } from "./sqliteTabs"; // B3：SQLite 编辑器 Tab（表数据 / SQL 查询）
import { initDebugView, notifyDepFound, renderDebugView, runToCursor as runToCursorIn, setDebugViewHandlers, wireDebugViewEvents } from "./debugView";
import { closeRecentFiles, initRecentFiles, openRecentFiles, setRecentFilesHandlers } from "./recentFiles"; // P0：最近打开的文件（Ctrl+E）
// P1（PyCharm 调研）：Search Everywhere / 导航历史 / 本地历史 / 调试控制台
import {
  initQuickOpen, invalidateQuickOpenFiles, isQuickOpenOpen, openQuickOpen, closeQuickOpen,
  registerQuickOpenActions, setQuickOpenHandlers, type QuickOpenAction,
} from "./quickOpen";
import { goBack, goForward, noteOpen, pushCurrent, resetNavHistory, setNavHistoryHandlers } from "./navHistory";
import { initLocalHistory, openLocalHistory, closeLocalHistory, setLocalHistoryHandlers } from "./localHistory";
import { initEditHistory } from "./editHistory"; // 低延迟编辑预测数据源 V1：行对采集
// P2
import {
  initBreadcrumbs, invalidateBreadcrumbs, resetBreadcrumbs, scheduleBreadcrumbs, setBreadcrumbHandlers,
} from "./breadcrumbs";
import { initDebugConsole, clearDebugConsole, notifyNotPaused, openEvaluatePrompt } from "./debugConsole";
import { initInlineValues } from "./inlineValues";
import { lintActiveFile, resetRuffLint, scheduleRuffLint, setRuffLintHandlers } from "./ruffLint";
import { applyPydanticMarkersOnOpen, initPydanticDiagnostics, resetPydanticDiagnostics, schedulePydanticRescan, setPydanticDiagnosticsHandlers } from "./pydanticDiagnostics";
import { cleanupSaveContent } from "./saveCleanup"; // PR-C（dx_features_backlog §6.3）：保存清理
import { initEditPoints, jumpToLastEdit, resetEditPoints } from "./editPoints"; // PR-D（dx_features_backlog §6.4）：最近编辑位置
import {
  initBookmarks, loadBookmarks, openBookmarks, closeBookmarks, refreshBookmarkGutter,
  resetBookmarks, setBookmarkHandlers, toggleBookmarkAtCursor,
} from "./bookmarks";
import {
  initRunHistory, openRunHistory, closeRunHistory, resetRunHistory,
  setRunHistoryHandlers,
} from "./runHistory";
import { renderWelcomeShortcuts } from "./welcomeShortcuts"; // UI-25：欢迎页快捷键跟随键位系统
import * as mdPreview from "./markdownPreview"; // Markdown 预览（markdown preview dev plan）
// TD-14 拆分出的功能域：环境面板 / 新建项目 / 菜单栏机制 / 运行域 / 运行配置面板 / 输出链接
import {
  clearInterpreterStatus, currentInterpreter, declarePackage, initEnvPanel, initEnvPanelEvents,
  installMissingPackage, maybePromptToolchain, maybePromptVenv, refreshInterpreterStatus,
  resetEnvPanelState, openEnvPanel, onEnvPanelOpened, refreshPackagesIfOpen, repaintPkgBadgesIfOpen,
} from "./envPanel";
import { openNewProjectPanel, wireNewProject } from "./newProject";
import { openCloneTab, wireCloneRepository } from "./cloneRepository";
import {
  handleTracebackLine, runOpenWorkspaceCheck, resetDepHealth, initDepHealth,
  setDepInstallHandler, wireDepHealthEvents,
} from "./depHealth";
import {
  initDepHealthPanel, renderDepHealth, resetDepHealthPanel, handleScanComplete, setHealthStatus,
  expandDepDetail,
} from "./depHealthPanel";
import { wireMenuBar, type MenuEntry } from "./menuBar";
import {
  initRunEvents, isRunBusy,
  maybeSuggestFramework, prepareRun,
  resetRunSessionState, runScript, runProject, stopAllRuns,
  runSelection, runWidgetState, setRunFlowHandlers, stopRun, wireRunFlow,
  clearRunProfilesCache, rerunRecord,
} from "./runFlow";
import { openRunConfig, wireRunConfigPanel } from "./runConfigPanel";
import { gotoFromLink, setTracebackOpenFile } from "./tracebackLink";
import { isRunning, scriptRunActive, runningPathsOf, type RunConfig } from "./runState";
import { installFindShortcut, setFindDiffEditorProvider } from "./editorFind";
import { installBrowserKeyGuard } from "./browserKeys";

// ---------- 模块级状态（本层私有；TD-14 后运行态归 runState.ts / runFlow.ts） ----------

let liveTemplatesHandle: LiveTemplatesHandle | null = null;
let searchCaseSensitive = false;
// PR-H（dx_features_backlog §6.6）：全局搜索的正则开关与文件掩码（会话内记忆，不落设置）
let searchUseRegex = false;
let searchFileGlob = "";
/** 文件监听防抖定时器 */
let fsWatchTimer: number | undefined;
/** P1：Double Shift 的判定窗口（ms）——两次 Shift 抬起间隔超过它就不算双击 */
const DOUBLE_SHIFT_MS = 400;

// ---------- DOM ----------
// P2-6（2026-09-29 review）：顶层快照改惰性（铁律 1——模块加载期解析 DOM 会让
// 精简 DOM 测试环境 import 即炸，main 域因此一直无法单测）。
const tabbarEl = lazyEl("tabbar");
const outlineEl = lazyEl("outline");
const statusLspEl = lazyEl("status-lsp");

// ---------- 工作区 ----------

/** CR-13：编辑器防抖 timer 集中管理（原为 init() 局部闭包，工作区切换/关闭无法清理，
 * autosave 会在 tab 已 dispose 后触发，旧工作区未存修改被静默丢弃） */
const editorTimers = {
  change: undefined as number | undefined,
  outline: undefined as number | undefined,
  /** autosave delay 模式：每个脏 tab 独立计时（path → timer；对标 VSCode 语义，
   *  后台 tab 的编辑静默到期也落盘，不再是只存 activeTab） */
  autosave: new Map<string, number>(),
  gutter: undefined as number | undefined,
  /** P1-8（2026-09-29 review）：断点/书签 gutter 防抖槽位——此前两处裸 setTimeout
   *  既不 clear 前值也不入集中管理，快速输入 N 字符 = N 次全量重算，且工作区切换后
   *  clearAll 清不到（靠 refreshXxx 内部判空兜底）。 */
  debug: undefined as number | undefined,
  bookmark: undefined as number | undefined,
  /** 全部 clearTimeout（切换/关闭工作区时调用，防旧工作区回调跨生命周期触发） */
  clearAll(): void {
    window.clearTimeout(this.change);
    window.clearTimeout(this.outline);
    for (const t of this.autosave.values()) window.clearTimeout(t);
    this.autosave.clear();
    window.clearTimeout(this.gutter);
    window.clearTimeout(this.debug);
    window.clearTimeout(this.bookmark);
    this.change = this.outline = this.gutter = this.debug = this.bookmark = undefined;
  },
  /** 清除指定文件的 autosave 计时器（关闭 tab 时调用，防 dispose 后回调触发） */
  clearAutosave(path: string): void {
    const t = this.autosave.get(path);
    if (t !== undefined) {
      window.clearTimeout(t);
      this.autosave.delete(path);
    }
  },
};

/** 切换/关闭工作区时的共享 UI 复位：清理旧工作区残留的可视内容与内存状态 */
function resetWorkspaceUiState(): void {
  editorTimers.clearAll();      // CR-13：防抖 timer 全清（autosave 不再跨工作区触发）
  app.pendingChanges.clear();   // CR-13：在途文档同步一并作废
  outlineToken++;               // CR-20：作废在途大纲请求
  clearOutput(outputEl);        // 输出面板（调试输出 / traceback）
  clearDebugConsole();          // P0（2026-09-30 审计）：调试控制台 #debug-console-log——renderDebugView/onShow 均不覆盖，唯一清空入口 clearDebugConsole 此前零调用
  resetGitState();              // git 状态 + diff 视图 + 分支列表
  outlineEl.textContent = "";   // 大纲符号树
  resetSearch();                // 搜索结果 + 作废在途请求
  resetFindUsages();            // 查找引用结果面板 + 行缓存
  resetTodoView();              // P0：TODO 列表 + 作废在途扫描
  resetEndpointView();          // F1：端点列表 + 作废在途扫描
  resetDbView();                // B3：数据库连接态 / 对象树 / 结果 + 作废在途请求
  invalidateDbTokens();         // B3 v1.4：db Tab 的在途查询响应一并作废
  resetNavHistory();            // P1：导航历史（跨工作区的历史没有意义）
  invalidateQuickOpenFiles();   // P1：工作区文件清单缓存随工作区失效
  resetBreadcrumbs();           // P2：面包屑（含符号缓存与防抖 timer）
  resetRuffLint();              // P2：ruff lint（防抖 timer + 在途请求）
  resetPydanticDiagnostics();   // 阶段 4：Pydantic 诊断（timer + 在途请求 + 栈状态）
  resetProblemsPanel();         // 问题面板（防抖 timer + 过滤态复位；marker 随 model 销毁自然清空）
  splitEditor.resetSplitEditor(); // C-4：分屏随工作区切换收起（快照不含分屏态）
  resetQuickFixCache();          // P4：自研快速修复的符号来源缓存随工作区失效
  resetBookmarks();             // P2：书签（列表缓存 + gutter 装饰）
  resetBreakpoints();           // P2-11：断点内存表随工作区切换清空（盘上数据按工作区隔离）
  resetRunHistory();            // P2：运行历史（§15：切换/关闭工作区重置）
  resetEnvPanelState();          // 环境域状态（包面板 + 解释器缓存 + 在途请求令牌 + 提示去重）
  resetDepHealth();              // 依赖健康域（在途体检令牌作废 + diff 快照清空，dep plan §4.7 规则 4）
  resetDepHealthPanel();         // 健康面板 UI 投影（横幅/tab/折叠态/状态栏图标，dep plan M3）
  ($("search-input") as HTMLInputElement).value = ""; // 清空搜索关键词
  // P1（2026-09-30 审计）：文件掩码同属工作区级输入，残留会让新工作区首次搜索被旧掩码
  // 静默过滤（*.py 残留 → 搜 .txt 无结果）；内存态 searchFileGlob 一并复位
  ($("search-mask") as HTMLInputElement).value = "";
  searchFileGlob = "";
  // v3.4 §15（M3-3.10）：停全部运行实例（teardownCurrent 已停止）+ 清实例表 + 清配置缓存
  resetRunSessionState();
  clearRunGutter(); // C5：切换/关闭工作区清空 gutter ▶
  clearGitGutter(); // 迭代 2 · P0-5：git 行级装饰一并清空
  clearCurrentLine(); // D4：清调试当前行高亮
  renderDebugView(); // D4：调试侧栏复位到 idle 呈现
}

/** 清理当前工作区（关闭标签 + 停 LSP + 销毁终端）；有未保存修改时先确认，取消则返回 false */
async function teardownCurrent(): Promise<boolean> {
  if (app.workspaceRoot) {
    // A-5：草稿会随会话快照保留（重开工作区自动恢复），故文案不再是「将丢失」——
    // 保留确认（用户仍应知道有未落盘的改动），但不再暗示数据会没。
    if (app.tabs.some((t) => t.dirty) && !(await openConfirm({ message: t("main.confirm.closeWorkspace"), kind: "danger" }))) {
      return false;
    }
    // v3.4 §15（M3-3.10）：切换/关闭工作区前停掉**全部**运行实例（脚本 + 所有项目实例）。
    // 否则后端进程会变成孤儿继续跑，而前端运行态随后被 resetWorkspaceUiState 复位，
    // 用户就再也没有停止入口了（§7.1 不变式：状态与进程同生共死）。
    // 调试清理走 debug_stop 独立链路（§13.5），不在此处覆盖。
    if (isRunning()) await stopAllRuns();

    // 调试会话同理（§8 坑 7）：关闭工作区必须停调试，否则 debugpy 进程树成孤儿。
    if (dap.currentPhase() !== "idle" && dap.currentPhase() !== "exited") {
      await dap.stopDebug();
      dap.resetDebugState();
    }

    // CR-30：teardown 计时改 console.debug（绕过日志系统的 console.log 清理；release 默认不显示）
    let t0 = performance.now();
    console.debug("[teardown] closeTabs begin, tabs=", app.tabs.length);
    // A-5：关标签之前先落一次会话快照（tab / 光标 / 未保存草稿），下次打开原地恢复
    await saveSessionNow();
    for (const t of [...app.tabs]) closeTabSilent(t);
    console.debug("[teardown] closeTabs done, took=", (performance.now() - t0).toFixed(0), "ms");

    t0 = performance.now();
    console.debug("[teardown] lsp.stopEngine begin");
    await lsp.stopEngine();
    console.debug("[teardown] lsp.stopEngine done, took=", (performance.now() - t0).toFixed(0), "ms");

    t0 = performance.now();
    console.debug("[teardown] disposeTerminal begin");
    await disposeTerminal();
    console.debug("[teardown] disposeTerminal done, took=", (performance.now() - t0).toFixed(0), "ms");
  }
  return true;
}

// P1-9（2026-09-29 review）：openWorkspace / closeWorkspace 的并发互斥。
// 原实现「检查（workspaceRoot）→ await teardownCurrent（含确认弹窗可达数秒）→ 置位」，
// 窗口期内第二路并发进入会再次走完整 teardown + 双份 refreshTree/startLsp/restoreSession
// 交错（LSP 双启动）。同步置位互斥标志，finally 复位。
let wsSwitching = false;

async function openWorkspace(root: string): Promise<void> {
  if (wsSwitching) return; // 已有切换在进行：丢弃并发调用
  // 复核注记（2026-09-30）：丢弃语义是有意取舍——并发场景主要是「启动自动恢复在途 +
  // 用户主动选新目录」，此时丢弃的是**用户请求**（不理想，用户需重试一次）；备选方案
  // 「排队最后一次」需处理排队合并与取消，复杂度不成比例。若后续用户反馈「点了没反应」
  // 再升级为排队语义。串行损坏（双 teardown / LSP 双启动）的防护优先。
  wsSwitching = true;
  try {
    // 切换工作区：先清理旧工作区状态
    if (app.workspaceRoot && app.workspaceRoot !== root) {
      if (!(await teardownCurrent())) return;
      cancelPendingSessionSave(); // A-5：teardown 已同步存过旧工作区快照，挂起的防抖不得用新 root 覆盖
      await stopFileWatcher();
      resetWorkspaceUiState();
    }
    app.workspaceRoot = root;
    $("tree-header-text").textContent = root;
    // P2：书签按工作区持久化，换工作区要重新加载（并刷新 gutter 装饰）
    await loadBookmarks();
    refreshBookmarkGutter();
    // P2-11（UX 审查）：断点同样按工作区持久化——回填后重绘当前文件的红点
    await loadBreakpoints();
    refreshDebugGutter();
    // Markdown 预览：动态授权 asset 协议读取当前工作区根（本地图片渲染）
    await invoke("allow_asset_dir", { path: root }).catch(console.error);
    await invoke("add_recent_workspace", { path: root }).catch(console.error);
    await refreshTree();
    await invoke("sweep_run_configs", { workspaceRoot: root }).catch(console.error); // tech-debt #9：打开工作区清扫孤儿运行配置
    await loadTemplatesConfig();
    await refreshInterpreterStatus(); // 先确定解释器，供 startLsp/run 使用
    await startLsp();
    // 依赖健康体检（dep plan §4.7，M1 形态）：后台数据采集，绝不阻塞打开流程——
    // L0 style 判定先行，1.5s 后若 venv 确认/工具链引导等弹窗在前台则排队轮询（R13 弹窗优先），
    // 结果只进输出面板一行摘要（无横幅无弹窗，M3 才上 UI 投影）
    void runOpenWorkspaceCheck(root);
    await maybePromptVenv();
    await startFileWatcher(); // 启动文件监听
    await restoreSession(); // A-5：恢复上次现场（标签 / 光标 / 未保存草稿）
    // 框架探针表（P1：Django / Flask / FastAPI）：仅提示，不打扰；工作区级可关闭
    void maybeSuggestFramework();
    // 阶段 4：Pydantic 构造校验诊断（第四桶）——栈命中才扫描，后台进行不阻塞打开流程
    void initPydanticDiagnostics(root);
    // import 别名频率学习：缓存秒生效 + 后台重扫回写，失败静默（importAlias 域）
    void refreshImportAliases(root);
    resetAutoImportIndex(); // PR-E：工作区切换后 auto-import 索引按新根重建（TTL 兜底文件变更）
    // PR review（dx_features_backlog §6.5）：跨工作区残留一并清空——重开栈与编辑点栈
    resetTabReopen();
    resetEditPoints();
    // P1-3（2026-09-30 审计）：切换工作区时若用户停在 git 视图，teardown 阶段的空态渲染
    // 后不会再有 onShow 触发——补一次与新仓库数据的同步刷新（refreshTree 内部的
    // refreshGitStatus 只更新内存，不重渲染面板 DOM）。
    if (activeView() === "git") {
      renderGitPanel();
      void refreshBranchPanel();
    }
    // B3（§10.3-8b 真机发现）：数据库视图若在自动恢复工作区完成前初始化，会停在
    // 「未打开工作区」空态且无 onShow 触发——工作区就绪后补一次状态刷新。
    refreshDbWorkspace();
    updateEditorOverlay();
  } finally {
    wsSwitching = false;
  }
}

/** 关闭当前工作区，回到无工作区状态 */
async function closeWorkspace(): Promise<void> {
  if (!app.workspaceRoot) return;
  if (wsSwitching) return; // P1-9：与 openWorkspace 互斥（交叉并发防双 teardown）
  wsSwitching = true;
  try {
    if (!(await teardownCurrent())) return;
    const t0 = performance.now();
    console.debug("[closeWorkspace] stopFileWatcher begin");
    await stopFileWatcher();
    console.debug("[closeWorkspace] stopFileWatcher done, took=", (performance.now() - t0).toFixed(0), "ms");
    resetWorkspaceUiState();
    closeRecentFiles(); // 最近文件是工作区级的，切换工作区后旧列表不应还能被打开
    // P2（2026-09-30 审计）：工作区级弹层一并收口——开着弹层关工作区时，候选列表/历史
    // 残留旧工作区数据且动作按钮已失效（内存已清、DOM 仍旧数据）。统一关闭最干净。
    closeQuickOpen();          // Ctrl+P 候选列表（点旧条目会打开已关闭工作区的文件）
    closeRunHistory();         // 运行历史（重放按钮指向已清空的 runs 表，静默 no-op）
    closeBookmarks();          // 书签列表（items 已随 resetBookmarks 清空）
    closeLocalHistory();       // 本地历史（针对当前文件，工作区关闭后无意义）
    app.workspaceRoot = null;
    resetTreeState();
    $("tree-header-text").textContent = t("tree.treeHeaderText"); // UI-13：与 index.html 静态词条同 key（第二十批 i18n）
    statusFileEl.textContent = "";
    clearInterpreterStatus();
    // P1-3 补充：resetWorkspaceUiState 先于本行执行，其 renderGitPanel 走「不是 Git 仓库」
    // 分支（gitRepoActive 已 false 但 root 未清）。root 置 null 后补一次终态渲染——
    // 文案修正为「尚未打开工作区」空态，避免误导用户以为要 git init。
    renderGitPanel();
    // 框架提示去重为工作区级，关闭工作区即清空
    clearRunProfilesCache();
    // 阶段 2：Pydantic 字段改名提示的会话去重同样工作区级
    resetPydanticRenameWarn();
    renderRunWidget(runWidgetState());
    updateEditorOverlay();
  } finally {
    wsSwitching = false;
  }
}

/** 根据当前状态刷新编辑区覆盖层：
 *  - 已打开文件 → 隐藏
 *  - 无工作区 → 完整 Get Started（含快捷入口与最近工作区）
 *  - 有工作区但未打开文件 → 仅保留品牌与快捷键，隐藏快捷入口与最近工作区
 *  PR-S2c（MB-13 收口）：forceWelcome 态下即使有 activeTab / workspaceRoot 也显示**完整版**
 *  overlay（actions + quickstart + tour + recents 全显）——纯显示层覆盖，不动会话真值。 */
function updateEditorOverlay(): void {
  const overlayEl = $("editor-overlay");
  const actionsEl = $("ew-actions");
  const recentEl = $("ew-recent-section");
  const quickstartEl = $("ew-quickstart");
  const tourEl = $("ew-tour-section");
  const forceCloseEl = $("ew-force-close");

  if (app.activeTab && !isWelcomeForced()) {
    overlayEl.classList.add("hidden");
    return;
  }

  overlayEl.classList.remove("hidden");
  // UI-25：覆盖层要显示了才重绘快捷键网格（改键后 / 设置加载完成后经此路径刷新为真实键位）
  renderWelcomeShortcuts();
  // PR-S2：三步卡与巡礼同口径重绘（键位标签跟随改键；巡礼完成态即时刷新）
  renderQuickstartCards();
  renderTour();

  const forced = isWelcomeForced();
  forceCloseEl.classList.toggle("hidden", !forced);

  if (app.workspaceRoot && !forced) {
    actionsEl.classList.add("hidden");
    quickstartEl.classList.add("hidden");
    tourEl.classList.add("hidden");
    recentEl.classList.add("hidden");
    return;
  }

  actionsEl.classList.remove("hidden");
  quickstartEl.classList.remove("hidden");
  tourEl.classList.remove("hidden");
  void renderEditorWelcomeRecents();
}

/** 渲染编辑器区 Welcome 页「最近的工作区」列表 */
async function renderEditorWelcomeRecents(): Promise<void> {
  const section = $("ew-recent-section");
  const listEl = $("ew-recent-list");
  listEl.textContent = "";
  const recents = await getRecentWorkspaces();
  if (recents.length === 0) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  for (const p of recents) {
    const item = document.createElement("div");
    item.className = "ew-recent-item";
    const folder = document.createElement("span");
    folder.className = "folder";
    folder.appendChild(codicon("folder"));
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = basename(p);
    const path = document.createElement("span");
    path.className = "path";
    path.textContent = p;
    item.append(folder, name, path);
    // UI-09：整行与行内「×」按钮同轨迁到 data-tip。原生 title 会沿祖先链继承解析，
    // 若父行保留 title、子按钮改用 data-tip，悬停按钮时两个提示会同时出现。
    item.dataset.tip = p;
    item.addEventListener("click", () => openWorkspace(p).catch(console.error));
    // 单条删除（× 按钮，hover 时显示）
    const remove = document.createElement("button");
    remove.className = "ew-recent-remove";
    remove.dataset.tip = t("main.recent.remove");
    // 图标按钮：内部 <i> 带 aria-hidden，可访问名称原先仅由 title 提供，须同步补 aria-label
    remove.setAttribute("aria-label", t("main.recent.remove"));
    remove.appendChild(codicon("close"));
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      void removeRecentWorkspace(p);
    });
    item.appendChild(remove);
    listEl.appendChild(item);
  }
}

/** 读取最近工作区列表（去重后按时间倒序） */
async function getRecentWorkspaces(): Promise<string[]> {
  try {
    return await invoke<string[]>("get_recent_workspaces");
  } catch (e) {
    console.warn("读取最近工作区失败", e);
    return [];
  }
}

/** 清空最近工作区列表并刷新 Welcome 页 */
async function clearRecentWorkspaces(): Promise<void> {
  try {
    await invoke("clear_recent_workspaces");
  } catch (e) {
    console.warn("清空最近工作区失败", e);
    toastFail(t("main.recent.clear"), e);
  }
  void renderEditorWelcomeRecents();
}

/** 删除单条最近工作区并刷新 Welcome 页 */
async function removeRecentWorkspace(path: string): Promise<void> {
  try {
    await invoke("remove_recent_workspace", { path });
  } catch (e) {
    console.warn("删除最近工作区失败", e);
    toastFail(t("main.recent.removeOne"), e);
  }
  void renderEditorWelcomeRecents();
}

/** 启动时的自动恢复：有记录打开最近，无记录则保持 Welcome 页，不弹目录框 */
async function autoOpenRecentWorkspace(): Promise<void> {
  const recents = await getRecentWorkspaces();
  if (recents.length > 0) {
    await openWorkspace(recents[0]);
  }
}

/** 多窗口启动路径：项目窗口（label→path）优先于「恢复最近」。 */
async function openInitialWorkspace(): Promise<void> {
  const winProject = await invoke<string | null>("get_window_project").catch(() => null);
  if (winProject) {
    await openWorkspace(winProject).catch((e) => console.error("打开窗口项目失败", e));
  } else {
    await autoOpenRecentWorkspace();
  }
}

/** 工具栏「📂 打开」：弹文件夹选择框并切换工作区 */
async function openFolderFromToolbar(): Promise<void> {
  const path = await invoke<string | null>("pick_folder");
  if (!path) return;
  await openWorkspace(path);
}

/** 「在新窗口打开工作区」：弹文件夹选择框（挑选后经后端新开项目窗口，去重由后端承担） */
async function openFolderInNewWindow(): Promise<void> {
  const path = await invoke<string | null>("pick_folder");
  if (!path) return;
  await invoke("open_workspace_window", { path }).catch((e) => toastFail(t("main.recent.openInNewWindow"), e));
}

async function loadTemplatesConfig(): Promise<void> {
  // live templates M1 重构：重读用户/工作区配置并重建 registry
  await liveTemplatesHandle?.reload();
}

/** 在当前激活编辑器插入 header 文件头模板（新建 .py/.pyw 后调用）；模板缺失/禁用返回 false */
export async function insertHeaderTemplate(): Promise<boolean> {
  return liveTemplatesHandle ? liveTemplatesHandle.insertByAbbreviation("header") : false;
}

// ---------- 标签右键菜单 ----------

/** tab 的相对路径（规则见 util.relativePathOrName） */
function relativePathOfTab(path: string): string {
  return relativePathOrName(app.workspaceRoot, path);
}

/** 复制文本到系统剪贴板（tab 右键菜单）；成功静默、失败弹提示（与 fileTree.copyPaths 一致） */
async function copyTabPath(text: string): Promise<void> {
  try {
    await invoke("copy_to_clipboard", { text });
  } catch (e) {
    console.error("复制路径失败", e);
    toastFail(t("main.recent.copyPath"), e);
  }
}

/** 标签右键菜单（P25-T08） */
function showTabContextMenu(tab: Tab, x: number, y: number): void {
  activateTab(tab);
  const isPy = tab.path.endsWith(".py") || tab.path.endsWith(".pyw");
  const items: CtxItem[] = [
    { label: t("main.tab.close"), action: () => void closeTab(tab) },
    { label: t("main.tab.closeOthers"), action: () => void closeOthersExcept(tab) },
    { label: t("main.tab.closeRight"), action: () => void closeTabsRightOf(tab) },
    { label: t("main.tab.closeAll"), action: () => void closeAllTabs() },
    { sep: true },
    // 复制路径三件套（对齐 VSCode：Copy Name / Copy Relative Path / Copy Path）
    { label: t("main.tab.copyName"), action: () => void copyTabPath(basename(tab.path)) },
    { label: t("main.tab.copyRelPath"), action: () => void copyTabPath(relativePathOfTab(tab.path)) },
    // PR-A（dx_features_backlog §6.1）：file:line 引用（相对工作区根，贴 issue/聊天可直点）
    { label: t("main.tab.copyFileLine"), action: () => void copyTabPath(`${relativePathOfTab(tab.path)}:${app.editor.getPosition()?.lineNumber ?? 1}`) },
    { label: t("main.tab.copyAbsPath"), action: () => void copyTabPath(tab.path) },
    { label: t("main.tab.openInTerminal"), action: () => void openTerminalAt(parentDirOf(tab.path)) },
    { label: t("main.tab.revealInExplorer"), action: () => invoke("reveal_in_explorer", { path: tab.path }).catch(console.error) },
  ];
  // P3（建议 2）：Python 脚本可编辑持久化运行配置（Parameters / 环境变量）
  // v3.4 §8（M3-3.4）：标签右键入口对齐四控件运行组——「运行脚本 / 运行项目 / 运行配置…」
  //（「在终端中运行」已删：运行统一走终端控制台，双入口等价无意义，§6.5）
  if (isPy) {
    items.splice(
      5,
      0,
      { label: t("main.run.script"), action: () => void runScript(tab.path) },
      { label: t("main.run.project"), action: () => void runProject() },
      { label: t("main.run.config"), action: () => void openRunConfig(tab.path) },
      { sep: true },
    );
  }
  // Markdown 预览（markdown preview dev plan §5-T4）：.md tab 右键开关分栏预览
  if (mdPreview.isMarkdownPath(tab.path)) {
    const open = mdPreview.isPreviewOpen();
    items.splice(
      5,
      0,
      { label: open ? t("main.tab.previewClose") : t("main.tab.previewOpen"), action: () => mdPreview.setPreviewOpen(!open) },
      { sep: true },
    );
  }
  renderCtxMenu(items, x, y);
}

async function closeTabsQuiet(list: Tab[]): Promise<void> {
  if (list.length === 0) return;
  if (list.some((t) => t.dirty) && !(await openConfirm({ message: t("main.confirm.closeTabs"), kind: "danger" }))) return;
  for (const t of [...list]) {
    closeTabSilent(t);
    if (t.kind !== "diff") recordClosedTab(t.path); // PR-A：批量关闭同样入重开栈（按关闭顺序栈顶=最后关闭）
  }
}

async function closeOthersExcept(tab: Tab): Promise<void> {
  await closeTabsQuiet(app.tabs.filter((t) => t !== tab));
}

async function closeTabsRightOf(tab: Tab): Promise<void> {
  const idx = app.tabs.indexOf(tab);
  await closeTabsQuiet(app.tabs.slice(idx + 1));
}

async function closeAllTabs(): Promise<void> {
  await closeTabsQuiet([...app.tabs]);
}

// ---------- 文件监听 ----------

/** 启动文件监听（打开工作区时调用） */
async function startFileWatcher(): Promise<void> {
  if (!app.workspaceRoot) return;
  try {
    await invoke("watch_start", { root: app.workspaceRoot });
  } catch (e) {
    console.warn("文件监听启动失败", e);
  }
}

/** 停止文件监听（关闭工作区时调用） */
async function stopFileWatcher(): Promise<void> {
  try {
    await invoke("watch_stop");
  } catch { /* 忽略 */ }
}

/** 处理文件变更事件（防抖后增量刷新受影响目录） */
function handleFsChanged(dirs: string[]): void {
  // v3.4 §18 裁决 3：auto_rerun 已删（框架自带 reload，纯脚本手动重跑够用），监听回调只剩通用防抖刷新
  window.clearTimeout(fsWatchTimer);
  fsWatchTimer = window.setTimeout(async () => {
    // 增量刷新 git 状态：仅重查受影响的目录，避免大仓库全量扫描（TD-002）
    const root = app.workspaceRoot;
    const relPaths = root
      ? dirs
          .filter((d) => d.startsWith(root))
          .map((d) => d.slice(root.length).replace(/^[\\/]/, "").replace(/\\/g, "/"))
          .filter((p) => p.length > 0)
      : [];
    await refreshGitStatus(relPaths);
    // 体验修复（用户报告）：编辑器改文件后 SCM 面板不实时更新，须切走再切回——
    // 此前只刷内存不重渲染。git 视图可见时立即重绘（不可见则等 onShow 兜底渲染）
    if (activeView() === "git") {
      renderGitPanel();
    }
    // 体验修复第 2 则：活动 diff tab 正展示某文件时，该文件变更 → 差异内容自动重拉
    //（第 2 步迁移后 diff 在编辑区 tab；防抖与冲突保护在 refreshDiffIfViewing 内部）
    if (app.activeTab?.kind === "diff") {
      for (const dir of dirs) refreshDiffIfViewing(dir);
    }
    // 增量刷新受影响的已展开目录
    for (const dir of dirs) {
      if (isDirExpanded(dir)) {
        await reloadDir(dir);
      }
    }
    // 如果变更涉及工作区根目录且树为空（首次），整树刷新
    if (root && dirs.includes(root) && isTreeEmpty()) {
      await refreshTree();
    }
    // P1：文件增删后作废 Search Everywhere 的文件清单缓存（下次打开重新拉取）
    invalidateQuickOpenFiles();
    // Live Templates 热重载：用户层（<data_root>/config，watcher 附加监听）或工作区层配置变更（M2）
    if (
      dirs.some((d) => {
        const n = d.toLowerCase().replace(/\\/g, "/");
        return n.endsWith(".pylume") || n.endsWith("pylume/config") || n.endsWith("/config");
      })
    )
      await loadTemplatesConfig();
  }, 200);
}

// ---------- 符号大纲（P25-T07）+ 全局搜索 ----------

/** 搜索匹配点击 → 打开文件并定位到匹配处 */
async function openSearchMatch(m: SearchMatch): Promise<void> {
  await openFile(m.path, m.line);
  app.editor.setPosition({ lineNumber: m.line, column: m.column });
  app.editor.revealLineInCenter(m.line);
  app.editor.focus();
}

/** 执行搜索（工作区未打开时忽略；E-5：scope 支持 当前文件 / 打开的标签 / 整个工作区） */
async function executeSearch(): Promise<void> {
  if (!app.workspaceRoot) return;
  const input = $("search-input") as HTMLInputElement;
  const mode = ($("search-scope") as HTMLSelectElement).value as SearchScopeMode;
  let scope: SearchScope | undefined;
  if (mode === "file") {
    const t = app.activeTab;
    // 无普通文件 tab（未打开/diff 视图）时给空列表 →「已扫描 0 个文件」空态；
    // 静默回退全工作区搜索反而误导（scope 选择与实际行为不符）
    scope = { mode, paths: t && t.kind !== "diff" ? [t.path] : [] };
  } else if (mode === "tabs") {
    // 只搜普通文件 tab（diff 视图的 path 是仓库相对路径，不是可读文件路径）
    scope = { mode, paths: app.tabs.filter((t) => t.kind !== "diff").map((t) => t.path) };
  }
  // PR-H：正则 / 掩码两个开关随每次搜索透传（workspace 走 Rust，scope 走 TS 筛选器，语义一致）
  await runSearch(app.workspaceRoot, input.value, searchCaseSensitive, $("search-results"), scope, {
    useRegex: searchUseRegex,
    fileGlob: searchFileGlob,
  });
}

/** CR-20：本批大纲符号所属 tab（点击回调校验用，渲染时记录） */
let outlineOwnerTab: Tab | null = null;

function renderOutlineSymbols(container: HTMLElement, symbols: lsp.LspDocumentSymbol[], depth: number): void {
  for (const s of symbols) {
    const line = (s.selectionRange?.start?.line ?? s.range?.start?.line ?? 0) + 1;
    const item = document.createElement("div");
    item.className = "outline-item";
    item.style.paddingLeft = `${8 + depth * 14}px`;
    const icon = document.createElement("span");
    icon.className = "outline-icon";
    icon.appendChild(codicon(symbolIcon(s.kind)));
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = s.name;
    item.append(icon, name);
    item.title = `${s.name}:${line}`;
    item.addEventListener("click", () => {
      // CR-20：响应渲染时所在 tab 已可能被切换，点击前校验仍在该 tab 才跳转
      if (app.activeTab !== outlineOwnerTab) return;
      app.editor.setPosition({ lineNumber: line, column: 1 });
      app.editor.revealLineInCenter(line);
      app.editor.focus();
    });
    container.appendChild(item);
    if (s.children?.length) renderOutlineSymbols(container, s.children, depth + 1);
  }
}

/** CR-20：大纲刷新令牌——响应乱序时旧结果不得覆盖新结果（照搬 search.ts 的令牌模式） */
let outlineToken = 0;

async function refreshOutline(): Promise<void> {
  if (!app.activeTab) {
    outlineEl.textContent = "";
    return;
  }
  const tab = app.activeTab;
  const token = ++outlineToken;
  const symbols = await lsp.documentSymbols(tab.path);
  if (token !== outlineToken) return; // 已有更新一轮的请求（或工作区已切换），丢弃旧结果
  outlineOwnerTab = tab; // CR-20：记录本批符号所属 tab
  outlineEl.textContent = "";
  if (symbols.length === 0) {
    outlineEl.appendChild(emptyState("symbol-misc", t("main.outline.noSymbols"), undefined, true));
    return;
  }
  renderOutlineSymbols(outlineEl, symbols, 0);
}

/** CR-13：串行冲刷待同步的文档变更——changeTimer 回调与补全前钩子共用。
 * 原来 for 循环内并发 fire-and-forget 多条 didChangeFull，invoke 到达顺序不保证 →
 * version 乱序，引擎文档状态错乱。此处逐条 await 保证 version 单调递增送达。 */
async function syncPendingChanges(): Promise<void> {
  for (const [path, changes] of [...app.pendingChanges]) {
    app.pendingChanges.delete(path);
    const t = app.tabs.find((x) => x.path === path);
    if (t) {
      await lsp.didChange(path, t.model, changes);
    }
  }
}

// ---------- 最近文件（P25-T09） ----------

async function recordRecent(path: string): Promise<void> {
  if (!app.workspaceRoot) return;
  try {
    await invoke("add_recent", { workspaceRoot: app.workspaceRoot, file: path });
  } catch (e) {
    console.warn("记录最近文件失败", e);
  }
}

// ---------- 标签页 / 编辑器 ----------

/** CR-24：LSP provider 注册句柄集中管理（应用生命周期；startLsp 重建时 dispose 再注册） */
const lspProviders = new DisposableStore();

/** CR-08：openFile 进行中去重表（path → 未完成的打开 Promise），防并发双开同文件 */
const openFileInflight = new Map<string, Promise<void>>();

/** openFile 选项 */
export interface OpenFileOptions {
  /** 打开后是否把焦点交给编辑器（默认 true）。文件树单击/键盘打开传 false：
   *  焦点留在树内可继续浏览与键盘漫游（VSCode/PyCharm 同款）——修复 tree 点击
   *  已打开文件时焦点被编辑器抢走的回归（activateTab 焦点改造引入）。 */
  focusEditor?: boolean;
}

export async function openFile(path: string, revealLine?: number, opts?: OpenFileOptions): Promise<void> {
  // CR-08：in-flight 去重——双击/多入口并发打开同一文件时，两次调用都查不到 tab、
  // 都进 read_file → createModel 对重复 URI 返回既有 model → 两 Tab 持同一 model，
  // closeTabSilent dispose 掉另一个仍在用的 model。以归一化路径（斜杠/大小写无关）为键串行化，
  // 后续调用 await 同一个 Promise（含 gotoFromLink / openSearchMatch / 历史重跑双击路径）。
  const key = normalizePath(path);
  const inflight = openFileInflight.get(key);
  if (inflight) {
    await inflight;
    await revealAfterOpen(path, revealLine);
    return;
  }
  const p = doOpenFile(path, revealLine, opts);
  openFileInflight.set(key, p);
  try {
    await p;
  } finally {
    openFileInflight.delete(key);
  }
}

/** CR-08：openFile 的实际执行体（由 in-flight 去重表保证同一 path 串行） */
async function doOpenFile(path: string, revealLine?: number, opts?: OpenFileOptions): Promise<void> {
  // P1：导航历史——先记「离开前的位置」，末尾记「到达的位置」，后退才能回到出发点
  pushCurrent();
  // 路径等价比较用 samePath（斜杠/大小写无关）：会话恢复的 tab 路径与文件树/Rust
  // 返回的路径分隔符方向可能不同（如 D:\proj/src/a.py vs D:\proj\src\a.py），
  // 严格 === 会导致同一文件开出第二个标签。
  let tab = app.tabs.find((t) => samePath(t.path, path));
  if (!tab) {
    let content: string;
    try {
      content = await invoke<string>("read_file", { path });
    } catch (e) {
      // 大文件守卫 / 目录 / 编码错误等：toast 呈现而非静默 unhandled rejection
      toast(t("main.openFile.failed", { msg: String(e) }), "error");
      return;
    }
    // CR-08：并发防线二——创建前再查既有 model 命中则复用（防其它入口已建）
    const uri = app.monaco.Uri.file(path);
    const model = app.monaco.editor.getModel(uri) ?? app.monaco.editor.createModel(content, languageOf(path), uri);
    model.updateOptions({ tabSize: app.settings.tab_size, insertSpaces: app.settings.insert_spaces }); // P1 缩进设置
    lsp.markModelPath(model, path);
    model.onDidChangeContent((e) => {
      const t = app.tabs.find((x) => x.model === model);
      if (t && !t.dirty) {
        t.dirty = true;
        renderTabs();
      }
      // 累积增量编辑（200ms 防抖后发；basedpyright 走增量、pyrefly 由 lsp.didChange 回落全量）
      if (t) {
        const acc = app.pendingChanges.get(t.path) ?? [];
        acc.push(...e.changes);
        app.pendingChanges.set(t.path, acc);
      }
      scheduleSessionSave(); // A-5：编辑后刷新会话快照（草稿随内容一起留存）
      // autosave delay 模式：每个文件独立计时（model 级监听，后台 tab 的编辑也触发）
      if (t) scheduleAutosave(t.path);
    });
    tab = { path, model, dirty: false };
    app.tabs.push(tab);
    lsp.didOpen(path, model);
    // 应用引擎已发布的诊断（打开前就收到的 publishDiagnostics）
    lsp.applyCachedDiagnostics(path, setMarkers);
    // 阶段 4：第四桶同款回放（扫描完成时文件未开 → marker 挂不上；打开时从缓存补）
    applyPydanticMarkersOnOpen(path);
  }
  activateTab(tab, opts?.focusEditor === false ? { focusEditor: false } : undefined);
  void recordRecent(path);
  revealAfterOpen(path, revealLine);
  // P1：记录到达位置（未指定行时取编辑器当前行，与用户所见一致）
  noteOpen(path, revealLine ?? app.editor.getPosition()?.lineNumber ?? 1);
}

/** CR-08：打开完成后按需跳行（去重等待路径也要走，故独立成函数） */
function revealAfterOpen(path: string, revealLine?: number): void {
  if (revealLine === undefined) return;
  const tab = app.tabs.find((t) => samePath(t.path, path));
  if (tab && app.activeTab === tab) {
    app.editor.revealLineInCenter(revealLine);
    app.editor.setPosition({ lineNumber: revealLine, column: 1 });
  }
}

function activateTab(tab: Tab, opts?: { focusEditor?: boolean }): void {
  // 帮助菜单「欢迎页」是纯显示层 force 覆盖（welcomeGuide.ts §6 决策 4）：一旦激活任何内容 tab
  // （文件树打开文件 / 切标签 / 关标签后自动激活下一个），说明用户已回到内容——必须解除覆盖，
  // 否则新打开的文件被欢迎页整层盖住看不见（严重可用性 bug）。置于最前，末尾的
  // updateEditorOverlay 才会按真实态（有 activeTab）隐藏覆盖层。
  consumeWelcomeForce();
  // v1.4 Tab 化：宽屏 hack 已退役，无需在此归位（历史见 sqlite_tool_dev_plan.md §16）
  // 切标签记忆视图状态：离开前保存前一文件 tab 的光标/滚动，切回时恢复
  const prev = app.activeTab;
  if (prev && prev !== tab && prev.kind !== "diff" && app.editor.getModel() === prev.model) {
    prev.viewState = app.editor.saveViewState() ?? undefined;
  }
  app.activeTab = tab;
  scheduleSessionSave(); // A-5：切标签后刷新会话快照（恢复期间由 session.ts 的 restoring 标志屏蔽）
  if (tab.kind === "diff") {
    // 第 2 步迁移：diff tab——主编辑器隐藏（宿主由 git.presentDiffHost 显示），
    // 模型不动（占位）、状态栏显示 diff: 前缀路径、编辑器专属装饰全部跳过
    app.editor.setModel(null);
    dismissDbHost(); // v1.4：db Tab 宿主与 diff 宿主同为 #editor-row 浮层，互斥
    presentDiffHost(tab);
    splitEditor.setDiffActive(true); // C-4：diff 占满编辑区，分屏（若开着）一并隐藏
    renderTabs();
    statusFileEl.textContent = tab.path;
    updateEditorOverlay(); // 诊断实证：diff tab 也是「有活动内容」，欢迎页覆盖层必须隐藏
    refreshDiffOnActivate(tab); // 后台期间文件可能已变：按需重拉（冲突 tab 保护跳过）
    return;
  }
  if (tab.kind === "db") {
    // v1.4 Tab 化：数据库 Tab（表数据 / SQL 查询）——主编辑器隐藏，
    // 宿主由 sqliteTabs.presentDbTab 显示并同步共享视图 DOM（结果缓存在 Tab 内，切换不重查）
    app.editor.setModel(null);
    presentDbTab(tab);
    splitEditor.setDiffActive(true); // db Tab 占满编辑区，分屏（若开着）一并隐藏
    renderTabs();
    statusFileEl.textContent = "";
    updateEditorOverlay(); // db Tab 也是「有活动内容」，欢迎页覆盖层必须隐藏
    mdPreview.updatePreviewVisibility();
    return;
  }
  // 文件 tab：从 diff/db tab 切回时恢复主编辑器
  dismissDiffHost();
  dismissDbHost(); // v1.4：db Tab 宿主随切回文件隐藏（互斥，不动各 Tab 的 state）
  splitEditor.setDiffActive(false); // C-4：分屏若开着则恢复显示
  app.editor.setModel(tab.model);
  if (tab.viewState) app.editor.restoreViewState(tab.viewState);
  renderTabs();
  statusFileEl.textContent = tab.path;
  if (activeView() === "files") {
    refreshOutline();
    scheduleFollowReveal(); // B 批：文件树自动跟随当前文件（可关开关，防抖 120ms 去抖动）
  }
  updateEditorOverlay();
  refreshRunGutter(); // C5：切换 tab 重算 __main__ 守卫行的 ▶
  refreshDebugGutter(); // D3：切换 tab 重算断点红点
  refreshGitGutter(); // 迭代 2 · P0-5：切换 tab 重算 git 行级变更装饰
  scheduleBreadcrumbs(); // P2：面包屑跟随激活文件
  refreshBookmarkGutter(); // P2：书签标记跟随激活文件
  renderProblemsChip(); // 问题芯片：切 tab 立即按新文件的 marker 刷新（不等 500ms 防抖）
  void lintActiveFile(); // P2：ruff 实时 lint（切 tab 立即跑，不等防抖）
  mdPreview.updatePreviewVisibility(); // Markdown 预览：切换 tab 后按「是否 md + 开关」刷新显隐
  // 鼠标切 tab / 关 tab 后焦点落回编辑器（打字立即生效）；tab 键盘激活路径传 false，
  // 保住 UI-16 的 tabbar 方向键漫游（Enter 激活后继续 ←→ 移动）
  if (opts?.focusEditor !== false) app.editor.focus();
}

/** 下一个/上一个标签（Ctrl+Tab / Ctrl+Shift+Tab）：按 tabs 数组顺序循环切换 */
function cycleTab(dir: 1 | -1): void {
  if (app.tabs.length < 2) return;
  const idx = app.activeTab ? app.tabs.indexOf(app.activeTab) : -1;
  const next = app.tabs[(idx + dir + app.tabs.length) % app.tabs.length] ?? null;
  if (next) activateTab(next);
}

async function closeTab(tab: Tab): Promise<void> {
  const idx = app.tabs.indexOf(tab);
  if (idx === -1) return;
  // diff/db tab 恒不 dirty（占位模型/只读视图），无需确认直接关
  if (tab.kind !== "diff" && tab.kind !== "db" && tab.dirty && !(await openConfirm({ message: t("main.confirm.closeDirty", { name: basename(tab.path) }), kind: "danger" }))) return;
  closeTabSilent(tab);
  if (tab.kind !== "diff" && tab.kind !== "db") recordClosedTab(tab.path); // PR-A：用户主动关闭入重开栈（工作区切换的批量清理不入栈）
}

/** 关闭标签（不弹确认，用于工作区切换时的批量清理） */
export function closeTabSilent(tab: Tab): void {
  const idx = app.tabs.indexOf(tab);
  if (idx === -1) return;
  app.tabs.splice(idx, 1);
  if (tab.kind === "diff") {
    // diff tab：不走 LSP/诊断/标记链（path 是 diff: 虚拟路径）；域内清理统一入口
    cleanupDiffTabState(tab);
  } else if (tab.kind === "db") {
    // v1.4：db tab 不走 LSP/诊断/标记链（path 是 db-data:/db-query: 虚拟路径）；
    // model（查询 Tab 的 SQL model / 占位模型）与状态表由域内统一清理
    cleanupDbTab(tab);
  } else {
    editorTimers.clearAutosave(tab.path); // 在途 autosave 计时器随 tab 关闭作废（防 dispose 后写盘复活内容）
    lsp.didClose(tab.path);
    lsp.discardCachedDiagnostics(tab.path); // CR-22：关文件即释放诊断缓存
    app.monaco.editor.setModelMarkers(tab.model, "pylume-lsp", []);
    splitEditor.onModelDisposed(tab.model); // C-4：分屏钉住该 model 时同步收起（先于 dispose）
    tab.model.dispose();
  }
  if (app.activeTab === tab) {
    app.activeTab = null;
    const next = app.tabs[Math.min(idx, app.tabs.length - 1)] ?? null;
    if (next) activateTab(next);
    else {
      app.editor.setModel(null);
      statusFileEl.textContent = "";
      dismissDiffHost(); // 最后一个 diff tab 关闭（无下一个 tab）：宿主一并隐藏
      dismissDbHost(); // v1.4：最后一个 db tab 关闭同理
      updateEditorOverlay();
    }
  }
  renderTabs();
  refreshRunGutter(); // C5：关闭 tab 后重算/清空 ▶
  refreshDebugGutter(); // D3：关闭 tab 后重算/清空断点红点
  mdPreview.updatePreviewVisibility(); // Markdown 预览：关闭 tab 后刷新显隐
}

export function renderTabs(): void {
  // UI-16：重绘会销毁正在聚焦的 tab 元素，先记录焦点、渲染后按路径恢复，
  // 否则键盘用户每次激活/关闭标签后焦点都掉回 body（与 termUi 终端 tab 同款处理）。
  // 用 closest(".tab")：焦点也可能在 tab 内部的关闭按钮上
  const focusedPath = tabbarEl.contains(document.activeElement)
    ? ((document.activeElement as HTMLElement | null)?.closest(".tab") as HTMLElement | null)?.dataset?.path ?? null
    : null;
  tabbarEl.textContent = "";
  for (const tab of app.tabs) {
    const active = tab === app.activeTab;
    const isDiff = tab.kind === "diff";
    const isDb = tab.kind === "db";
    // diff tab 的显示名：剥 diff: 前缀（VS Code 同款「文件名 (Working Tree)」语义）
    // db tab 的显示名由域内解析（`表名 · 库名` / `查询 N · 库名`），path 里是 connId 哈希
    const displayName = isDiff
      ? t("main.tab.diffTitle", { name: basename(tab.path.slice("diff:".length)) })
      : isDb
        ? dbTabLabel(tab)
        : basename(tab.path);
    const el = document.createElement("div");
    el.className = `tab ${active ? "active" : ""}`;
    // UI-16：tabs 模式（#tabbar 的 role=tablist 在 index.html 静态声明）。
    // 所有 tab 共享同一个 Monaco 面板，故不设 aria-controls/tabpanel（与事实不符的声明不如不声明）；
    // 漫游 tabindex：激活项 0、其余 -1；←→ 在 tab 间移动焦点，Enter/Space 激活。
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", String(active));
    el.tabIndex = active ? 0 : -1;
    el.dataset.path = tab.path;
    // 悬停显示完整路径（tooltip.ts 规则 4：纯路径披露用原生 title，不挂 data-tip；
    // tab 内部无 data-tip，不触发规则 5 的父子不同轨冲突）
    // db tab 的 path 是 connId 哈希虚拟路径，对用户无意义——title 用显示名
    el.title = isDb ? displayName : tab.path;
    // diff/db tab 用专属图标（与文件类型图标区分）；文件 tab 保持类型图标
    el.appendChild(isDiff ? codicon("diff") : isDb ? codicon(dbTabIcon(tab)) : renderFileIcon(basename(tab.path))); // D2 P-08：标签页文件类型图标
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = displayName;
    const dirty = document.createElement("span");
    dirty.className = "dirty";
    if (tab.dirty) dirty.appendChild(codicon("circle-filled"));
    // TD-14：runningPathsOf() 取运行中脚本路径集合，故 tab.path 命中即为「该 tab 正在运行」
    //（v3.4 M3-3.3：多实例模型——脚本实例的 path 集合；项目实例无文件锚点不在此列）
    const runningScripts = runningPathsOf();
    const isRunningHere = runningScripts.has(tab.path);
    // UI-16：脏标记/运行指示的圆点是纯视觉装饰（aria-hidden），状态并入 tab 的可访问名称，
    // 读屏聚焦该 tab 时直接听到「已修改 / 运行中」（承接 UI-09 对 .tab-running 的遗留说明）
    const labelParts = [displayName];
    if (tab.dirty) labelParts.push(t("main.tab.modified"));
    if (isRunningHere) labelParts.push(t("main.tab.running"));
    el.setAttribute("aria-label", labelParts.join("，"));
    // 被动运行指示（C3）：动作已集中到菜单栏运行组，tab 只显示状态（不可点，避免第二个动作入口）
    const close = document.createElement("span");
    close.className = "close";
    close.appendChild(codicon("close"));
    // UI-16：span 充当按钮 → 补 role/aria-label/tabindex + Enter/Space 键盘激活（第四批待办同款）
    close.setAttribute("aria-label", t("main.tab.closeAria", { name: displayName }));
    close.tabIndex = 0;
    close.addEventListener("keydown", (ev) => {
      ev.stopPropagation(); // 不冒泡到 tab 本体的 Enter/方向键处理
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        void closeTab(tab);
      }
    });
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void closeTab(tab);
    });
    if (isRunningHere) {
      const ind = document.createElement("span");
      ind.className = "tab-running";
      ind.setAttribute("aria-hidden", "true"); // UI-16：运行态已并入 tab 的 aria-label
      const spin = codicon(motionDisabled() ? "circle-filled" : "loading");
      if (!motionDisabled()) spin.classList.add("codicon-modifier-spin");
      ind.appendChild(spin);
      // UI-09：删除死代码。.tab .tab-running 带 pointer-events:none（被动指示，动作集中在菜单栏运行组），
      // 浏览器命中测试不会落到它身上，原生 title 从来不显示；改 data-tip 同样无效（委托依赖 mouseover 命中）。
      el.append(name, dirty, ind, close);
    } else {
      el.append(name, dirty, close);
    }
    el.addEventListener("click", () => activateTab(tab));
    // 中键关闭（编辑器惯例）：mousedown 先拦掉 Chromium 的 autoscroll，auxclick 执行关闭
    el.addEventListener("mousedown", (ev) => {
      if (ev.button === 1) ev.preventDefault();
    });
    el.addEventListener("auxclick", (ev) => {
      if (ev.button !== 1) return;
      ev.preventDefault();
      ev.stopPropagation();
      void closeTab(tab); // dirty 时仍走 closeTab 的确认弹窗，与关闭按钮一致
    });
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        activateTab(tab, { focusEditor: false }); // 键盘激活：焦点留在 tabbar，方向键漫游继续
      } else if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
        ev.preventDefault();
        const tabs = Array.from(tabbarEl.querySelectorAll<HTMLElement>(".tab"));
        if (tabs.length < 2) return;
        const dir = ev.key === "ArrowRight" ? 1 : -1;
        tabs[(tabs.indexOf(el) + dir + tabs.length) % tabs.length].focus();
      }
    });
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showTabContextMenu(tab, ev.clientX, ev.clientY);
    });
    tabbarEl.appendChild(el);
  }
  // UI-16：焦点恢复（原焦点 tab 已被关闭时落到激活项，与鼠标行为一致）
  if (focusedPath) {
    const target =
      tabbarEl.querySelector<HTMLElement>(`.tab[data-path="${CSS.escape(focusedPath)}"]`) ??
      tabbarEl.querySelector<HTMLElement>(".tab.active");
    target?.focus();
  }
  // 激活标签滚入可视区（Ctrl+E / 跳转定义打开远处文件时激活 tab 可能完全在屏外；
  // nearest 只在屏外时才滚，不影响日常重绘）
  tabbarEl.querySelector<HTMLElement>(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  // 运行组按钮随 tab / 运行态一起重绘（renderTabs 覆盖了大多数状态变化点）
  renderRunWidget(runWidgetState());
}

/** Optimize Imports（P0，Ctrl+Alt+O）：整理当前 Python 文件的导入（排序 + 删无用）。 */
async function optimizeImportsActive(): Promise<void> {
  const tab = app.activeTab;
  if (!tab) return;
  if (!tab.path.endsWith(".py") && !tab.path.endsWith(".pyw")) {
    toast(t("main.imports.pyOnly", { name: basename(tab.path) }), "info");
    return;
  }
  const before = tab.model.getValue();
  const optimized = await optimizeImportsSource(tab.path, before);
  if (optimized === null || optimized === before) return; // 失败已由 format 域提示；无改动则不动模型
  tab.model.setValue(optimized); // 单次 setValue → Ctrl+Z 可整体撤销
  toast(t("main.imports.done", { name: basename(tab.path) }), "success");
}

/**
 * 保存**指定** tab（保存时整理导入 → 格式化 → 写盘 → 本地历史 → 通知引擎）。
 * 从 saveActive 抽出来是为了运行域：▶ 的粘性目标可能不是活动 tab，只靠 saveActive
 * 会漏存目标文件，导致「跑了磁盘上的旧内容」（表现为改了没生效）。
 * @param opts.runOnSaveActions 保存时动作（isort/format）开关：显式保存（Ctrl+S/菜单）为 true；
 *  自动保存与运行前落盘传 false——落盘与保存动作解耦，避免 autosave 高频跑 ruff（PyCharm 教训）。
 */
async function saveTab(tab: Tab, opts?: SaveOptions): Promise<void> {
  const isPy = tab.path.endsWith(".py") || tab.path.endsWith(".pyw");
  const runActions = opts?.runOnSaveActions !== false;
  // 保存时整理导入（ruff I,F401，设置开关）：**先整理后格式化**——ruff format 不重排导入，
  // 二者正交，此顺序与 PyCharm 的「Optimize Imports → Reformat」一致。失败不阻断保存。
  if (runActions && app.settings.optimize_imports_on_save && isPy) {
    const optimized = await optimizeImportsSource(tab.path, tab.model.getValue());
    if (optimized !== null && optimized !== tab.model.getValue()) {
      tab.model.setValue(optimized); // 单次 setValue → Ctrl+Z 可整体撤销
    }
  }
  // 保存时格式化（ruff，设置开关）：失败不阻断保存
  if (runActions && app.settings.format_on_save && isPy) {
    const formatted = await formatPythonSource(tab.path, tab.model.getValue());
    if (formatted !== null && formatted !== tab.model.getValue()) {
      tab.model.setValue(formatted); // 单次 setValue → Ctrl+Z 可整体撤销
    }
  }
  // PR-C（dx_features_backlog §6.3）：保存清理（行尾空白 / 最终换行，设置开关）。
  // 与 ruff 钩子同一显式保存纪律（runActions 门控）；在 format **之后**执行——ruff format
  // 自身会重写内容，清理须以最终内容为准。单次 setValue 先例同上。
  if (runActions && (app.settings.trim_trailing_whitespace !== false || app.settings.final_newline !== false)) {
    const value = tab.model.getValue();
    const cleaned = cleanupSaveContent(value, {
      trimTrailing: app.settings.trim_trailing_whitespace !== false,
      finalNewline: app.settings.final_newline !== false,
    });
    if (cleaned !== value) tab.model.setValue(cleaned);
  }
  // PR-F（dx_features_backlog §6.6/§6.8）：保存时语法错误提示——写盘前查当前模型 error 级
  // marker。getModelMarkers 不带 owner 过滤 = 三桶统一覆盖（pylume-lsp / pylume-intel /
  // pylume-ruff，owner 名实测见 6.6），与 quickFix.ts 的双桶口径一致且更宽。
  // **只提示不阻止保存**（避免打断自动化场景）；runActions 门控——autosave / 运行前落盘 /
  // git 改写磁盘等非显式路径不弹 toast（高频路径会刷屏）。
  // 2026-09-29 修订：文案区分「语法错误 / 类型/引用错误」（旧文案统称语法错误，pyrefly
  // typeCheckingMode=default 下 168 error 中仅 23 个是语法错误——大文件场景用户按文案找不到
  // 语法错误误以为错报），并加「定位」动作直达第一个错误（revealFirstError）。
  if (runActions) {
    const errorMarkers = app.monaco.editor
      .getModelMarkers({ resource: tab.model.uri })
      .filter((m) => m.severity === app.monaco.MarkerSeverity.Error);
    if (errorMarkers.length > 0) {
      const breakdown = breakDownSaveErrors(errorMarkers, app.monaco.MarkerSeverity.Error);
      toast(saveErrorToastMessage(basename(tab.path), breakdown), "error", {
        actionLabel: t("main.save.locate"),
        onAction: () => revealFirstError(),
      });
    }
  }
  // P1：本地历史——**写盘前**留一版快照（content 传 null = 后端读磁盘，落的是保存前的内容）。
  // 失败只记日志：历史是兜底能力，绝不阻断保存（与 ruff 缺席不阻断格式化的策略一致）。
  await snapshotHistory(tab.path);
  await invoke("write_file", { path: tab.path, content: tab.model.getValue() });
  tab.dirty = false;
  renderTabs();
  // 保存通知（引擎常在保存时触发完整重新检查）
  lsp.didSave(tab.path, tab.model);
  // 阶段 4：Pydantic 构造校验随保存防抖重扫（跨文件校验，全量毫秒级）
  schedulePydanticRescan();
}

async function saveActive(opts?: SaveOptions): Promise<void> {
  if (!app.activeTab) return;
  await saveTab(app.activeTab, opts);
}

/** autosave delay 模式的核心：为指定文件安排独立计时器（每个脏 tab 各自静默到期落盘）。
 *  timer 回调再次校验模式（设置中途改 off 时在途计时器自然失效）与 dirty 状态；
 *  写盘走 runOnSaveActions=false（autosave 不跑 ruff，保存动作只跟显式保存走）。 */
function scheduleAutosave(path: string): void {
  if (app.settings.autosave !== "delay") return;
  editorTimers.clearAutosave(path);
  const timer = window.setTimeout(() => {
    editorTimers.autosave.delete(path);
    if (app.settings.autosave !== "delay") return;
    const tab = app.tabs.find((x) => x.path === path);
    // 失败 toast 兜底：autosave 静默失败比显式保存更危险（用户以为已落盘）
    if (tab?.dirty) saveTab(tab, { runOnSaveActions: false }).catch((e) => toastFail(t("main.save.autosave"), e));
  }, app.settings.autosave_delay);
  editorTimers.autosave.set(path, timer);
}

/** 本地历史快照（保存前自动留痕）；无工作区时静默跳过 */
async function snapshotHistory(path: string, content: string | null = null): Promise<void> {
  if (!app.workspaceRoot) return;
  try {
    await invoke("history_snapshot", {
      workspaceRoot: app.workspaceRoot,
      path,
      content,
      kind: "save",
    });
  } catch (e) {
    console.warn("[history] 保存快照失败", e);
  }
}

/** 从磁盘重新加载文件到编辑器（git 改写工作区 / 本地历史回滚后刷新内容用）。
 *  体验修复第 5 则：force=false 时 dirty tab 跳过——git 改写工作区后，用户未保存
 *  的修改绝不能被磁盘内容静默覆盖；本地历史回滚是用户主动替换（force=true）不受限。 */
async function reloadFileFromDisk(path: string, force = false): Promise<void> {
  const tab = app.tabs.find((t) => t.path === path);
  console.debug("[reloadFileFromDisk]", path, "命中 tab:", !!tab, "打开的 tab:", app.tabs.map((t) => t.path));
  if (!tab) return;
  if (!force && tab.dirty) return; // 有未保存修改且非强制：跳过（调用方负责提示）
  const content = await invoke<string>("read_file", { path });
  // 全文替换用 pushEditOperations 而非 setValue——setValue 会清空该 model 的 undo 栈，
  // git 改写工作区/本地历史回滚后 Ctrl+Z 将无法回到替换前内容；pushEditOperations 保栈
  tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text: content }], () => null);
  tab.dirty = false;
  renderTabs();
  await lsp.didChangeFull(path, tab.model);
}

// 运行域（prepareRun / runScript / runProject / runSelection /
// stopRun / runWidgetState / 输出事件流）→ runFlow.ts；运行态真值 → runState.ts。

// ---------- 调试（debug dev plan §6.7：调试运行入口） ----------

/** 调试运行入口：prepareRun 复用 → debug_detect（debugpy 定位 + 依赖提示）→
 * debug_start（后端拉起 debugpy + TCP）→ DAP 握手（initialize → setBreakpoints →
 * configurationDone）→ 切调试侧栏 + 终端承载 stdout。 */
async function runDebug(): Promise<void> {
  if (!app.activeTab) return;
  const path = app.activeTab.path;
  if (!path.endsWith(".py") && !path.endsWith(".pyw")) {
    toast(t("main.debug.notPython", { name: basename(path) }), "info");
    return;
  }
  // 调试态与运行态互斥（后端强制）：正在运行/准备时提示先停止
  if (isRunBusy()) {
    toast(t("main.debug.runBusy"), "info");
    return;
  }
  const phase = dap.currentPhase();
  if (phase === "starting" || phase === "running" || phase === "stopped") {
    toast(t("main.debug.sessionBusy"), "info");
    return;
  }
  // P1-13（2026-09-29 review）：phase 门控到 startDebug 内部才置 starting——prepareRun /
  // get_run_config / debug_detect 多个 await 期间双击 F5 可并发穿透，第二个失败调用的
  // resetDebugState 会把第一会话的 phase 踩回 idle。这里在首个 await 前同步置位，
  // 失败路径由下面的 catch / 各早退点统一复位。
  // 复核补丁（2026-09-30）：markStarting 之后的代码若出现未预期异常（各早退点已复位，
  // 但 prepareRun / appendOutputLine 等 throw 时无人收口），phase 会永卡 starting——
  // F5 被门控拒死。包 try/catch 兜底；`sessionEstablished` 在 startDebug 握手成功的
  // 那一刻置位，其后 phase 归状态机接管，兜底不再触发（避免误清已建立的后端会话，
  // 同 P1-12 场景）。
  dap.markStarting();
  let sessionEstablished = false;
  try {
    await runDebugInner(path, () => { sessionEstablished = true; });
  } catch (e) {
    appendOutputLine(outputEl, t("main.debug.startError", { msg: String(e) }), "stderr", gotoFromLink, "debug");
    toastFail(t("main.debug.start"), e);
  } finally {
    if (!sessionEstablished) dap.resetDebugState();
  }
}

/** runDebug 的主体（markStarting 已由外层置位；异常统一在外层兜底复位）。
 *  `onEstablished` 在 startDebug 握手成功时回调（此后异常不复位 phase）。 */
async function runDebugInner(path: string, onEstablished: () => void): Promise<void> {
  // prepareRun 复用（自动保存 / 依赖预检 / 读运行配置；stdin=file 场景由后端 fail fast）
  const prep = await prepareRun(path);
  if (!prep) {
    dap.resetDebugState(); // markStarting 早退复位（P1-13）
    return;
  }

  // P1：调试复用运行配置——后端 debug_start 直读 run_configs（参数 / env / 工作目录），
  // 这里把「用上了什么」显式回显，避免用户以为调试是完全独立的一套配置。
  if (app.workspaceRoot) {
    const rc = await invoke<Partial<RunConfig>>("get_run_config", { workspaceRoot: app.workspaceRoot, scriptPath: path })
      .catch(() => ({} as Partial<RunConfig>));
    const parts: string[] = [];
    if (rc.args?.trim()) parts.push(t("main.debug.argsLine", { args: rc.args.trim() }));
    if (rc.env?.length) parts.push(t("main.debug.envLine", { n: rc.env.length }));
    if (parts.length) {
      appendOutputLine(outputEl, t("main.debug.reuseConfig", { parts: parts.join("，") }), "hint", gotoFromLink, "debug");
    }
  }

  // debug_detect：debugpy 定位 + 依赖声明提示（§5.1.6：提示性质，不阻断）
  interface DebugDetectResult { debugpyOk: boolean; debugpyDir: string | null; depFound: boolean; depFiles: string[] }
  let detect: DebugDetectResult;
  try {
    detect = await invoke<DebugDetectResult>("debug_detect", { workspaceRoot: app.workspaceRoot });
  } catch (e) {
    appendOutputLine(outputEl, t("main.debug.detectError", { msg: String(e) }), "stderr", gotoFromLink, "debug");
    toastFail(t("main.debug.detect"), e);
    dap.resetDebugState(); // markStarting 早退复位（P1-13）
    return;
  }
  if (!detect.debugpyOk) {
    // E 类（长指导走 openAlert 对话框，非输出面板 stderr；附可复制命令）
    void openAlert({
      title: t("main.debug.noDebugpyTitle"),
      message:
        t("main.debug.noDebugpyBody1") +
        t("main.debug.noDebugpyBody2") +
        "powershell -ExecutionPolicy Bypass -File tools/fetch-debugpy.ps1",
      okLabel: t("main.debug.gotIt"),
    });
    dap.resetDebugState(); // markStarting 早退复位（P1-13）
    return;
  }
  // §3.5：依赖清单命中 → 输出面板一次性提示（自带副本不冲突），不弹窗不阻断
  if (detect.depFound) {
    notifyDepFound(detect.depFiles);
    appendOutputLine(
      outputEl,
      t("main.debug.depHint", { files: detect.depFiles.join("、") }),
      "hint",
      gotoFromLink,
    );
  }

  appendOutputLine(outputEl, `> [debug] ${basename(path)}  (${path})`, "cmd", gotoFromLink, "debug");
  try {
    await dap.startDebug(path, app.workspaceRoot, pushAllBreakpoints);
    onEstablished(); // 握手成功：phase 归状态机接管，外层兜底从此不触发
  } catch (e) {
    appendOutputLine(outputEl, t("main.debug.startFailed", { msg: String(e) }), "stderr", gotoFromLink, "debug");
    toastFail(t("main.debug.start"), e);
    // P1-12（2026-09-29 review）：startDebug 中途失败（握手超时 / 断点异常 / debug_start
    // 后任一步失败）时，后端 DEBUG 槽仍持有 adapter——只复位前端 phase 会让下次启动被
    // 「已有调试会话在运行」永久卡住。先停后端会话再复位（stopDebug 对未启动场景幂等）。
    await dap.stopDebug();
    dap.resetDebugState();
    return;
  }
  // 切到调试侧栏（§6.7）；终端 tab 承载调试进程 stdout（后端已落 PTY）
  setSidebarTab("debug");
}

/** 停止调试（Shift+F5 / 工具栏停止 / 调试态下的停止按钮路由） */
async function stopDebugSession(): Promise<void> {
  await dap.stopDebug();
  dap.resetDebugState();
  clearCurrentLine();
}

/**
 * P2：新建草稿文件（PyCharm Ctrl+Alt+Shift+Insert Scratch 同款）。
 * 草稿落在数据根的 scratches/ 目录（**不在工作区里**——不入库、不污染项目），
 * 创建后直接打开即可运行 / 调试。
 */
async function newScratch(): Promise<void> {
  try {
    const path = await invoke<string>("create_scratch", { ext: ".py" });
    await openFile(path);
    toast(t("main.scratch.created"), "success");
  } catch (e) {
    toastFail(t("main.scratch.failAction"), e);
  }
}

/** Alt+F9 Run to Cursor：跑到光标所在行（临时断点 + 继续，命中断点后自动撤掉） */
async function runToCursorAtCursor(): Promise<void> {
  const tab = app.activeTab;
  if (!tab) return;
  const line = app.editor.getPosition()?.lineNumber;
  if (!line) return;
  if (dap.currentPhase() !== "stopped") {
    toast(t("main.debug.runToCursorHint"), "info");
    return;
  }
  await runToCursorIn(tab.path, line);
}

/** Alt+F8 求值表达式：非暂停态给明确指引，暂停态切到调试侧栏并弹输入框 */
async function onEvaluateShortcut(): Promise<void> {
  if (dap.currentPhase() !== "stopped") {
    await notifyNotPaused();
    return;
  }
  setSidebarTab("debug");
  await openEvaluatePrompt();
}

/**
 * 插件 facade 依赖（PR-2）：编辑器选区/插入操作与工作区根。
 * devtools host 与插件 facade 共用同一套编辑器语义，此处集中构造。
 */
function buildPluginFacadeDeps() {
  return {
    monaco: app.monaco,
    workspaceRoot: () => app.workspaceRoot,
    getSelectedText: () => {
      const model = app.editor.getModel();
      const sel = app.editor.getSelection();
      if (!model || !sel || sel.isEmpty()) return null;
      return model.getValueInRange(sel);
    },
    replaceSelection: (text: string) => {
      const model = app.editor.getModel();
      if (!model) return false;
      const sel = app.editor.getSelection();
      const range = sel ?? new app.monaco.Range(1, 1, 1, 1);
      app.editor.executeEdits("plugin-inline", [{ range, text }]);
      app.editor.focus();
      return true;
    },
    insertToEditor: (text: string) => {
      const model = app.editor.getModel();
      if (!model) return false;
      const sel = app.editor.getSelection() ?? {
        startLineNumber: model.getLineCount(),
        startColumn: model.getLineMaxColumn(model.getLineCount()),
        endLineNumber: model.getLineCount(),
        endColumn: model.getLineMaxColumn(model.getLineCount()),
      };
      app.editor.executeEdits("plugin-inline", [{ range: sel, text }]);
      app.editor.focus();
      return true;
    },
  };
}

/**
 * 工具菜单（PR-1，plugin_system_design §9.8）：按 category 分组 → flyout 子菜单。
 * groupToolsByCategory 处理预置有序集 + 自定义追加；空 category 归「其他」。
 */
function buildToolsMenu(): MenuEntry[] {
  const groups = groupToolsByCategory(listDevTools());
  const entries: MenuEntry[] = groups.map(([cat, tools]) => ({
    // 第十七批 i18n：预置分组展示名走语言包（标识串仍为中文原文，排序恒定）
    label: categoryLabel(cat),
    submenu: () => tools.map((t) => ({
      label: t.title,
      detail: t.description,
      action: () => openDevTools(t.id),
    })),
  }));
  // §9.8：尾部固定「插件管理…」入口（设置页插件 tab）
  if (groups.length > 0) entries.push({ label: "", sep: true });
  entries.push({ label: t("main.cmd.plugins"), action: () => openSettingsPanel("plugins") });
  return entries;
}

/**
 * P1：Search Everywhere 的「命令」数据源。
 * 键位表里已有的动作直接用其 id——hint 会自动跟随用户在设置里改过的键位
 * （同 debugView 工具栏提示的处理，避免硬编码 "F5" 这类会失真的文案）；
 * 无键位的动作用显式 hint（如内建的 Shift+Alt+F）或留空。
 */
function buildQuickOpenActions(): QuickOpenAction[] {
  return [
    { id: "save", label: t("main.cmd.save"), run: () => void saveActive() },
    // v3.4 §8（M3-3.4）：命令面板对齐四控件运行组
    { id: "run_script", label: t("main.run.script"), run: () => { if (app.activeTab) void runScript(app.activeTab.path); } },
    { id: "run_project", label: t("main.run.project"), run: () => void runProject() },
    { id: "stop", label: t("main.run.stop"), run: () => void stopRun() },
    { id: "debug", label: t("main.cmd.debugStart"), run: () => void runDebug() },
    { id: "debug_stop", label: t("main.cmd.debugStop"), run: () => void stopDebugSession() },
    { id: "debug_evaluate", label: t("main.cmd.evaluate"), run: () => void onEvaluateShortcut() },
    { id: "debug_run_to_cursor", label: t("main.cmd.runToCursor"), run: () => void runToCursorAtCursor() },
    { id: "bookmark_toggle", label: t("main.cmd.bookmarkToggle"), run: () => void toggleBookmarkAtCursor() },
    { id: "bookmark_list", label: t("main.cmd.bookmarkList"), run: () => void openBookmarks() },
    { id: "scratch_new", label: t("main.cmd.scratchNew"), run: () => void newScratch() },
    { id: "split_editor", label: t("main.cmd.splitRight"), run: () => splitEditor.toggleSplit() }, // P4（C-4）
    // PR-A（dx_features_backlog §6.1）：键位补齐组的命令面板入口（id 对齐键位表，hint 自动跟随改键；
    // run 复用键位 handler——review 建议 5：与 keybindings.ts 的命令 id 手写两份会漂移）
    { id: "delete_line", label: t("main.cmd.deleteLine"), run: () => kb.triggerEditorKeybindingAction("delete_line") },
    { id: "fold_all", label: t("main.cmd.foldAll"), run: () => kb.triggerEditorKeybindingAction("fold_all") },
    { id: "unfold_all", label: t("main.cmd.unfoldAll"), run: () => kb.triggerEditorKeybindingAction("unfold_all") },
    { id: "jump_to_bracket", label: t("main.cmd.jumpBracket"), run: () => kb.triggerEditorKeybindingAction("jump_to_bracket") },
    { id: "reopen_tab", label: t("main.cmd.reopenTab"), run: () => { if (!reopenClosedTab()) toast(t("main.cmd.reopenNone"), "info"); } },
    { id: "recent_edit_locations", label: t("main.cmd.lastEdit"), run: () => { if (!jumpToLastEdit()) toast(t("main.cmd.noEarlierEdit"), "info"); } },
    { id: "run_history", label: t("main.cmd.runHistory"), run: () => openRunHistory() },
    { id: "goto_file", label: t("main.cmd.gotoFile"), run: () => void openQuickOpen("files") },
    { id: "goto_symbol", label: t("main.cmd.gotoSymbol"), run: () => kb.triggerEditorKeybindingAction("goto_symbol") },
    // PR-J：触发补全建议备选键（Ctrl+Space 被中文 IME 吞键，人工验证；handler 在 keybindings.ts）
    { id: "trigger_suggest", label: t("main.cmd.triggerSuggest"), run: () => kb.triggerEditorKeybindingAction("trigger_suggest") },
    { id: "goto_line", label: t("main.cmd.gotoLine"), run: () => void openQuickOpen("line") },
    { id: "goto_definition", label: t("main.cmd.gotoDef"), run: () => void lsp.gotoDefinitionAtCursor(app.editor) },
    { id: "global_search", label: t("main.cmd.globalSearch"), run: () => setSidebarTab("search") },
    { id: "recent_files", label: t("main.cmd.recentFiles"), run: () => void openRecentFiles() },
    { id: "optimize_imports", label: t("main.cmd.optimizeImports"), run: () => void optimizeImportsActive() },
    { id: "local_history", label: t("main.cmd.localHistory"), run: () => void openLocalHistory() },
    { id: "template_palette", label: t("main.cmd.ltPalette"), run: () => liveTemplatesHandle?.openPalette() },
    { id: "surround", label: t("main.cmd.surround"), run: () => liveTemplatesHandle?.openSurround() },
    { id: "markdown_preview", label: t("main.cmd.mdPreview"), run: () => mdPreview.togglePreview() },
    { id: "format_document", label: t("main.cmd.formatDoc"), hint: "Shift+Alt+F", run: () => void app.editor.getAction("editor.action.formatDocument")?.run() },
    { id: "open_settings", label: t("main.cmd.openSettings"), run: () => openSettingsPanel() },
    // PR-S1/S2（onboarding plan §3.1）：新手指南 + 欢迎页 force-show 进命令面板
    { id: "onboarding_guide", label: t("main.cmd.guide"), run: () => void openOnboardingGuide() },
    { id: "welcome_page", label: t("main.cmd.welcome"), run: () => { if (isWelcomeForced()) dismissWelcomeOverlay(); else showWelcomeOverlay(); } },
    { id: "new_project", label: t("main.cmd.newProject"), run: () => openNewProjectPanel() },
    { id: "git_clone", label: t("cloneRepository.cmdLabel"), run: () => openCloneTab() },
    { id: "git_panel", label: t("main.cmd.gitPanel"), run: () => setSidebarTab("git") },
    // P0-1：git 高频操作进命令面板（对标 VS Code Git: * 命令族）——
    // 此前仅 git_panel 一条，键盘流用户完全不可达（报告 D9）
    { id: "git_init", label: t("main.cmd.gitInit"), run: () => void gitInitRepo() },
    { id: "git_stage_all", label: t("main.cmd.gitStageAll"), run: () => void stageAllChanges() },
    { id: "git_discard_all", label: t("main.cmd.gitDiscardAll"), run: () => void discardAllChanges() },
    { id: "git_commit", label: t("main.cmd.gitCommit"), run: () => { setSidebarTab("git"); ($("git-commit-msg") as HTMLTextAreaElement).focus(); } },
    { id: "git_commit_all", label: t("main.cmd.gitCommitAll"), run: () => void commitAll() },
    { id: "git_fetch", label: t("main.cmd.gitFetch"), run: () => void gitRemoteOp("fetch") },
    { id: "git_pull", label: t("main.cmd.gitPull"), run: () => void gitRemoteOp("pull") },
    { id: "git_push", label: t("main.cmd.gitPush"), run: () => void gitRemoteOp("push") },
    { id: "git_stash", label: t("main.cmd.gitStash"), run: () => void gitStash() },
    { id: "git_stash_pop", label: t("main.cmd.gitStashPop"), run: () => void gitStashPop() },
    { id: "git_history", label: t("main.cmd.gitHistory"), run: () => { setSidebarTab("git"); toggleHistory(); } },
    { id: "git_branches", label: t("main.cmd.gitBranches"), run: () => { setSidebarTab("git"); toggleBranchList(); } },
    // 迭代 3：高级工作流进命令面板（cherry-pick/reset 等历史操作走历史条目右键）
    { id: "git_sync_status", label: t("main.cmd.gitSyncStatus"), run: () => { setSidebarTab("git"); toast(t("main.cmd.syncUpdated"), "info"); void refreshBranchPanel(); } },
    { id: "todo_panel", label: t("main.cmd.todoPanel"), run: () => setSidebarTab("todo") },
    // B3：数据库工具窗（引擎在 Rust db_cmds.rs；侧栏见 sqliteView.ts，Tab 见 sqliteTabs.ts）
    { id: "db_add_connection", label: t("database.cmdOpen"), run: () => { setSidebarTab("database"); void addConnection(); } },
    { id: "db_new_query", label: t("database.cmdNewQuery"), run: () => { setSidebarTab("database"); openQueryTabForActive(); } },
    // PR-S2 巡礼（onboarding plan §3.2b）：open_devtools 此前只有键位（Ctrl+Shift+T）与
    // keybindings.ts 分发，命令面板查不到——巡礼「试一下」挂注册表 id，一并补上可发现性
    { id: "open_devtools", label: t("main.cmd.devtools"), run: () => openDevToolsPanel() },
    // P1（UX 审查）：高频操作进命令面板（id 对齐键位表 → 提示自动跟随改键）
    { id: "close_tab", label: t("main.cmd.closeTab"), run: () => { if (app.activeTab) void closeTab(app.activeTab); } },
    { id: "new_file", label: t("main.cmd.newFile"), run: () => void createFileInteractive() },
    { id: "toggle_sidebar", label: t("main.cmd.toggleSidebar"), run: () => toggleSidebar() },
    { id: "toggle_bottom", label: t("main.cmd.toggleBottom"), run: () => toggleBottomPanel() },
    // 问题面板（PyCharm Problems View 同位；hint 跟随键位表改键，run 直接调域入口）
    { id: "open_problems", label: t("main.cmd.problems"), run: () => openProblemsPanel() },
    // PR-1（plugin_system_design §9.9）：注册表中的工具统一以「工具: <title>」前缀进命令面板
    ...listDevTools().map((tool) => ({
      id: `tool_${tool.id}`,
      label: t("main.cmd.toolPrefix", { title: tool.title }), // 参数名避开 t（i18n 取词函数，踩坑 ⑤）
      run: () => openDevTools(tool.id),
    })),
    // PR-2：插件 inline 变换入口（§9.15：命令面板「工具: <inline.label>」）
    ...listInlineEntries(listPluginRecords(), true).map((e) => ({
      id: `inline_${e.toolId}`,
      label: inlineCommandLabel(e),
      run: () => void runInline(e.toolId),
    })),
  ];
}

// ---------- 断点右键菜单（P0：条件断点 / 命中次数 / Logpoint） ----------

/**
 * 断点 gutter 右键菜单（对标 PyCharm 右键断点）。
 * 三个字段均为 DAP `SourceBreakpoint` 原生能力（见 dap/client.ts::BreakpointSpec），
 * 本函数只负责「录入 + 落库 + 重绘」，协议透传与同步由 debugGutter 负责。
 *
 * 录入口径：openPrompt 返回 null = 取消（保持原值）；空串 = 清空该字段。
 */
async function showBreakpointMenu(path: string, line: number, x: number, y: number): Promise<void> {
  const spec = getBreakpointSpec(path, line);
  const has = spec !== null;
  const kind = breakpointKind(spec);
  const apply = (next: Parameters<typeof updateBreakpoint>[2]): void => {
    updateBreakpoint(path, line, next);
    refreshDebugGutter();
  };

  showMenu(
    [
      {
        label: has ? t("main.bp.editCondition") : t("main.bp.addCondition"),
        icon: "debug-breakpoint-conditional",
        // 条件为真才断下——爬虫循环「第 N 次迭代才断」场景刚需
        detail: spec?.condition ? t("main.bp.current", { value: spec.condition }) : undefined,
        action: () => {
          void openPrompt({
            title: t("main.bp.conditionTitle", { name: basename(path), line: line }),
            label: t("main.bp.conditionLabel"),
            value: spec?.condition ?? "",
            placeholder: "i > 10",
          }).then((v) => {
            if (v === null) return; // 取消：保持原值
            apply({ ...spec, condition: v || undefined });
          });
        },
      },
      {
        label: t("main.bp.hitCount"),
        icon: "debug-breakpoint-function",
        detail: spec?.hitCondition ? t("main.bp.current", { value: spec.hitCondition }) : undefined,
        action: () => {
          void openPrompt({
            title: t("main.bp.hitTitle", { name: basename(path), line: line }),
            label: t("main.bp.hitLabel"),
            value: spec?.hitCondition ?? "",
            placeholder: ">3",
          }).then((v) => {
            if (v === null) return;
            apply({ ...spec, hitCondition: v || undefined });
          });
        },
      },
      {
        label: has && spec?.logMessage ? t("main.bp.editLog") : t("main.bp.setLogpoint"),
        icon: "debug-breakpoint-log",
        detail: spec?.logMessage ? t("main.bp.current", { value: spec.logMessage }) : undefined,
        action: () => {
          void openPrompt({
            title: t("main.bp.logTitle", { name: basename(path), line: line }),
            label: t("main.bp.logLabel"),
            value: spec?.logMessage ?? "",
            placeholder: "i={i}, url={url}",
          }).then((v) => {
            if (v === null) return;
            apply({ ...spec, logMessage: v || undefined });
          });
        },
      },
      {
        label: t("main.bp.toPlain"),
        icon: "debug-breakpoint",
        disabled: kind === "plain",
        disabledReason: t("main.bp.alreadyPlain"),
        action: () => apply(null),
      },
      {
        // B-6：启用/禁用（禁用 = 保留断点与全部属性，但不下发 debugger；gutter 灰点）
        label: has && isBreakpointEnabled(spec) ? t("main.bp.disable") : t("main.bp.enable"),
        icon: "eye-closed",
        disabled: !has,
        disabledReason: t("main.bp.noBpHere"),
        action: () => {
          setBreakpointEnabled(path, line, !isBreakpointEnabled(spec));
          refreshDebugGutter();
        },
      },
      { sep: true },
      has
        ? {
            label: t("main.bp.remove"),
            icon: "trash",
            danger: true,
            action: () => {
              removeBreakpoint(path, line);
              refreshDebugGutter();
            },
          }
        : {
            label: t("main.bp.addHere"),
            icon: "debug-breakpoint",
            action: () => {
              toggleBreakpoint(path, line);
              refreshDebugGutter();
            },
          },
    ],
    { x, y },
  );
}

// ---------- LSP ----------

export async function startLsp(): Promise<void> {
  if (!app.workspaceRoot) return;
  // 引擎真值统一读 app.settings.lsp_engine（C2 修 bug：不再读 menubar 的 DOM select，
  // 避免「界面显示 A、实际跑 B」的永久分叉）
  const engine = app.settings.lsp_engine || "pyrefly";
  const rootUri = lsp.workspaceRootUri(app.workspaceRoot); // CR-29：正确百分号编码（空格/中文路径）
  try {
    await lsp.startEngine(engine, rootUri, currentInterpreter, app.workspaceRoot ?? undefined);
  } catch (e) {
    statusLspEl.textContent = t("main.lsp.startFailed", { msg: String(e) });
    return;
  }
  // 运行时引擎（pylume-intel）：开关控制（P3-T09），失败静默降级（静态引擎照常工作）
  if (app.settings.runtime_intel_enabled) {
    try {
      await lsp.startIntel(app.workspaceRoot, rootUri);
    } catch (e) {
      console.warn("[intel] 启动异常:", e);
    }
  } else {
    await lsp.stopIntel();
  }
  // 两个引擎（重）启动后重新同步已打开文件——新进程对它们一无所知
  for (const t of app.tabs) lsp.didOpen(t.path, t.model);
}

function setMarkers(path: string, markers: MonacoApi.editor.IMarkerData[], owner = "pylume-lsp"): void {
  // samePath（斜杠+大小写归一）：pydantic 诊断的 Rust 侧返回正斜杠绝对路径，
  // tab.path 可能是反斜杠——精确 === 会全程失配（2026-09-29 复核修复）
  const tab = app.tabs.find((t) => samePath(t.path, path));
  if (tab) app.monaco.editor.setModelMarkers(tab.model, owner, markers);
}

// ---------- 菜单栏（TD-14：机制已迁至 menuBar.ts，此处仅保留菜单项数据源 getMenuItems） ----------

function rootEntry(): Entry {
  return { name: basename(app.workspaceRoot ?? ""), path: app.workspaceRoot ?? "", is_dir: true };
}

/** gutter ▶ 右键菜单（v3.4 §8：对齐四控件——运行脚本 / 运行项目 / 停止 / 运行配置…）。
 *  从 runWidget 注入的 handlers + **即时状态**（runWidgetState 现算，不依赖渲染快照——
 *  菜单打开时刻的状态可能与上次渲染不同）派生，保证各入口动作一致。 */
function buildRunMenuItems(): MenuItem[] {
  const h = runWidgetHandlers();
  const s = runWidgetState();
  return [
    {
      label: t("main.run.script"),
      icon: "run",
      shortcut: kb.bindingLabel("run_script") || undefined,
      disabled: !s.canRunScript || s.scriptBusy,
      disabledReason: s.scriptDisabledReason || t("main.run.preparingScript"),
      action: () => h?.runScript(),
    },
    {
      label: t("main.run.project"),
      icon: "run-all",
      shortcut: kb.bindingLabel("run_project") || undefined,
      disabled: !s.canRunProject || s.projectPreparing,
      disabledReason: s.projectDisabledReason || t("main.run.preparingProject"),
      action: () => h?.runProject(),
    },
    { sep: true },
    {
      label: t("main.run.stop"),
      icon: "debug-stop",
      shortcut: kb.bindingLabel("stop") || undefined,
      disabled: !s.debugging && !s.stopTarget,
      disabledReason: t("main.run.noneRunning"),
      action: () => h?.stop(),
    },
    {
      label: t("main.run.config"),
      icon: "gear",
      disabled: !s.canOpenConfig,
      disabledReason: t("main.run.needWorkspace"),
      action: () => h?.openRunConfig(),
    },
  ];
}

function getMenuItems(menu: string): MenuEntry[] {
  switch (menu) {
    case "file": return [
      { label: t("menu.file.newProject"), action: () => openNewProjectPanel() },
      { label: t("menu.file.cloneRepository"), action: () => openCloneTab() },
      // P1（UX 审查）：改走 createFileInteractive——目标目录跟随活动文件（原固定为工作区根），
      // 且键位标签与键位系统同源
      { label: t("menu.file.newFile"), shortcut: kb.bindingLabel("new_file") || undefined, action: () => void createFileInteractive() },
      { label: t("menu.file.newFolder"), action: () => { if (app.workspaceRoot) void createDirAt(rootEntry()); } },
      { sep: true, label: "" },
      { label: t("menu.file.openWorkspace"), shortcut: "Ctrl+K Ctrl+O", action: () => void openFolderFromToolbar() },
      { label: t("menu.file.openWorkspaceInNewWindow"), action: () => void openFolderInNewWindow() },
      { label: t("menu.file.save"), shortcut: kb.bindingLabel("save") || undefined, action: () => void saveActive() },
      { sep: true, label: "" },
      {
        label: t("menu.file.recentWorkspaces"),
        submenu: async () => {
          const recents = await getRecentWorkspaces();
          if (recents.length === 0) return [{ label: t("menu.file.noRecentWorkspaces") }];
          const items: MenuEntry[] = recents.map((p) => ({
            label: basename(p),
            detail: p,
            action: () => openWorkspace(p).catch(console.error),
          }));
          items.push({ sep: true, label: "" });
          items.push({ label: t("menu.file.clearRecentWorkspaces"), action: () => void clearRecentWorkspaces() });
          return items;
        },
      },
      // MB-12：「最近的文件」自「视图」迁入（与「最近的工作区」同区，属文件范畴）
      { label: t("menu.file.openRecentFiles"), shortcut: kb.bindingLabel("recent_files") || undefined, action: () => void openRecentFiles() },
      { sep: true, label: "" },
      { label: t("menu.file.closeWorkspace"), action: () => void closeWorkspace() },
      // MB-12：偏好设置归「文件」（VS Code File→Preferences / PyCharm File→Settings 同位），
      // 自「视图」迁入；Live Templates 本就是设置面板 templates 分类
      { sep: true, label: "" },
      {
        label: t("menu.file.preferences"),
        submenu: () => [
          { label: t("menu.file.settings"), shortcut: kb.bindingLabel("open_settings") || undefined, action: () => openSettingsPanel() },
          { label: "Live Templates", action: () => openSettingsPanel("templates") },
        ],
      },
    ];
    case "edit": return [
      { label: t("menu.edit.undo"), shortcut: "Ctrl+Z", action: () => { app.editor.trigger("menu", "undo", null); } },
      { label: t("menu.edit.redo"), shortcut: "Ctrl+Shift+Z", action: () => { app.editor.trigger("menu", "redo", null); } },
      { sep: true, label: "" },
      // MB-15：注释切换（Monaco 内建，PyCharm Ctrl+/ 同款高频项）
      { label: t("menu.edit.toggleComment"), shortcut: "Ctrl+/", action: () => { app.editor.trigger("menu", "editor.action.commentLine", null); } },
      { sep: true, label: "" },
      { label: t("menu.edit.find"), shortcut: "Ctrl+F", action: () => { app.editor.trigger("menu", "actions.find", null); } },
      { label: t("menu.edit.replace"), shortcut: "Ctrl+H", action: () => { app.editor.trigger("menu", "editor.action.startFindReplaceAction", null); } },
      // MB-15：全局搜索入口（复用 global_search 键位；搜索侧栏目前无替换 UI，「在文件中查找/替换」
      // 落地为切侧栏 + 聚焦，与 Ctrl+Shift+F 行为一致——侧栏补替换框属另一条独立需求）
      { label: t("menu.edit.findInFiles"), shortcut: kb.bindingLabel("global_search") || undefined, action: () => { setSidebarTab("search"); ($("search-input") as HTMLInputElement).focus(); } },
      { sep: true, label: "" },
      { label: t("menu.edit.formatDocument"), shortcut: "Shift+Alt+F", action: () => { void app.editor.getAction("editor.action.formatDocument")?.run(); } },
      // P0：Optimize Imports（PyCharm「编辑 → Optimize Imports」同位置）
      {
        label: t("menu.edit.optimizeImports"),
        shortcut: kb.bindingLabel("optimize_imports") || undefined,
        action: () => void optimizeImportsActive(),
      },
    ];
    case "view": return [
      { label: t("menu.view.fileTree"), action: () => setSidebarTab("files") },
      { label: t("menu.view.search"), shortcut: kb.bindingLabel("global_search") || undefined, action: () => setSidebarTab("search") },
      // P2：本地历史是工具窗入口，归属「视图」（MB-11 口径：布局开关 + 工具窗）
      { label: t("menu.view.localHistory"), shortcut: kb.bindingLabel("local_history") || undefined, action: () => void openLocalHistory() },
      { sep: true, label: "" },
      // P2：书签 / 运行历史
      { label: t("menu.view.bookmarkList"), shortcut: kb.bindingLabel("bookmark_list") || undefined, action: () => void openBookmarks() },
      { sep: true, label: "" },
      { label: t("menu.view.markdownPreview"), shortcut: kb.bindingLabel("markdown_preview") || undefined, action: () => mdPreview.togglePreview() },
      // P1（UX 审查）：面板开关 + 设置补键位标签，菜单与快捷键同源（改键后自动跟随）
      { label: t("menu.view.toggleSidebar"), shortcut: kb.bindingLabel("toggle_sidebar") || undefined, action: () => toggleSidebar() },
      { label: t("menu.view.toggleBottomPanel"), shortcut: kb.bindingLabel("toggle_bottom") || undefined, action: () => toggleBottomPanel() },
      // 问题面板（PyCharm Problems View 同位，Alt+0）
      { label: t("menu.view.problemsPanel"), shortcut: kb.bindingLabel("open_problems") || undefined, action: () => openProblemsPanel() },
    ];
    // MB-11：前往（Go）——收编原「视图」的导航/跳转类命令（VS Code Go / PyCharm Navigate 同位）。
    // 口径：命令面板 / Search Everywhere 属「搜索式导航」，归此处而非 VS Code View 菜单
    case "go": return [
      { label: t("menu.go.gotoFile"), shortcut: kb.bindingLabel("goto_file") || undefined, action: () => void openQuickOpen("files") },
      // PR-G：文件内符号（PyCharm Navigate → File Structure 同位；与命令面板同走键位 handler）
      { label: t("menu.go.gotoSymbolInFile"), shortcut: kb.bindingLabel("goto_symbol") || undefined, action: () => kb.triggerEditorKeybindingAction("goto_symbol") },
      { label: t("menu.go.gotoLine"), shortcut: kb.bindingLabel("goto_line") || undefined, action: () => void openQuickOpen("line") },
      { label: "Search Everywhere", shortcut: "Double Shift", action: () => void openQuickOpen("all") },
      { label: t("menu.go.commandPalette"), shortcut: kb.bindingLabel("command_palette") || undefined, action: () => void openQuickOpen("commands") },
      { sep: true, label: "" },
      { label: t("menu.go.back"), shortcut: kb.bindingLabel("nav_back") || undefined, action: () => void goBack() },
      { label: t("menu.go.forward"), shortcut: kb.bindingLabel("nav_forward") || undefined, action: () => void goForward() },
    ];
    // MB-10：运行——运行 + 调试合并为一级菜单（裁决 2026-09-21）。运行区 / 调试区 / 收尾三分区，
    // action 全部复用既有函数（与命令面板 / 标题栏图标同源）；单步三命令走命令面板同款动态导入
    case "run": return [
      { label: t("menu.run.runScript"), shortcut: kb.bindingLabel("run_script") || undefined, action: () => { if (app.activeTab) void runScript(app.activeTab.path); } },
      { label: t("menu.run.runProject"), shortcut: kb.bindingLabel("run_project") || undefined, action: () => void runProject() },
      { label: t("menu.run.runConfig"), action: () => openRunConfig() },
      { label: t("menu.run.stop"), shortcut: kb.bindingLabel("stop") || undefined, action: () => void stopRun() },
      { sep: true, label: "" },
      { label: t("menu.run.startDebug"), shortcut: kb.bindingLabel("debug") || undefined, action: () => void runDebug() },
      { label: t("menu.run.stopDebug"), shortcut: kb.bindingLabel("debug_stop") || undefined, action: () => void stopDebugSession() },
      { label: t("menu.run.stepOver"), shortcut: kb.bindingLabel("debug_step_over") || undefined, action: () => void import("./dap/client").then((m) => m.dapNext(1)) },
      { label: t("menu.run.stepInto"), shortcut: kb.bindingLabel("debug_step_into") || undefined, action: () => void import("./dap/client").then((m) => m.dapStepIn(1)) },
      { label: t("menu.run.stepOut"), shortcut: kb.bindingLabel("debug_step_out") || undefined, action: () => void import("./dap/client").then((m) => m.dapStepOut(1)) },
      { label: t("menu.run.runToCursor"), shortcut: kb.bindingLabel("debug_run_to_cursor") || undefined, action: () => void runToCursorAtCursor() },
      { label: t("menu.run.evaluateExpression"), shortcut: kb.bindingLabel("debug_evaluate") || undefined, action: () => void onEvaluateShortcut() },
      { sep: true, label: "" },
      { label: t("menu.run.runHistory"), shortcut: kb.bindingLabel("run_history") || undefined, action: () => openRunHistory() },
    ];
    // PR-1（plugin_system_design §9.8）：工具菜单按 category 分组 flyout 子菜单，
    // 渲染走 menuBar.ts 既有 submenu 机制（悬停延时展开 + →/← 键盘导航），此处只组装数据
    case "tools": return buildToolsMenu();
    // MB-13：帮助菜单（裁决 2026-09-21）——关于走 openAlert 轻量档；日志/数据目录复用设置页
    // 既有 invoke 命令；作者指南复用插件 tab 的 openGuide（同一份指南文档，导出复用）。
    // PR-S1/S2（onboarding plan）：新增「新手指南」（指南落盘打开）与「欢迎页」（force-show toggle，
    // 收掉 MB-13「欢迎页一期不纳入」登记）。
    case "help": return [
      {
        label: t("menu.help.onboardingGuide"),
        action: () => void openOnboardingGuide(),
      },
      {
        label: t("menu.help.welcomePage"),
        action: () => {
          // toggle（方案 §3.2c 关闭途径 ①）：force 态再点一次解除；否则置位显示完整版覆盖层
          if (isWelcomeForced()) dismissWelcomeOverlay();
          else showWelcomeOverlay();
        },
      },
      { sep: true, label: "" },
      {
        label: t("menu.help.about"),
        action: () => {
          void getVersion()
            .then((v) => {
              void openAlert({
                title: t("main.about.title"),
                message: t("main.about.body", { version: v }),
                okLabel: t("main.tab.close"),
              });
            })
            .catch((e) => toastFail(t("main.about.versionFail"), e));
        },
      },
      { sep: true, label: "" },
      { label: t("menu.help.authorGuide"), action: () => void openGuide() },
      { sep: true, label: "" },
      { label: t("menu.help.openLogDir"), action: () => invoke("open_log_dir").catch((e) => toastFail(t("main.about.openLogDir"), e)) },
      { label: t("menu.help.openDataDir"), action: () => invoke("open_data_dir").catch((e) => toastFail(t("main.about.openDataDir"), e)) },
    ];
    // P0-2：Git 一级菜单（报告 D10）——此前 git 操作只能从侧栏「更多操作」二级菜单触达
    case "git": return [
      { label: t("menu.git.initRepo"), action: () => void gitInitRepo() },
      { sep: true, label: "" },
      { label: t("menu.git.stageAll"), action: () => void stageAllChanges() },
      { label: t("menu.git.discardAll"), action: () => void discardAllChanges() },
      {
        label: t("menu.git.commit"),
        action: () => { setSidebarTab("git"); ($("git-commit-msg") as HTMLTextAreaElement).focus(); },
      },
      { label: t("menu.git.commitAll"), action: () => void commitAll() },
      { sep: true, label: "" },
      // MB-14：同步 / 贮藏归组子菜单（原 5 项平铺 → 2 个父项），视觉长度减半；action 原样迁移
      {
        label: t("menu.git.sync"),
        submenu: () => [
          { label: t("menu.git.fetch"), action: () => void gitRemoteOp("fetch") },
          { label: t("menu.git.pull"), action: () => void gitRemoteOp("pull") },
          { label: t("menu.git.push"), action: () => void gitRemoteOp("push") },
        ],
      },
      {
        label: t("menu.git.stash"),
        submenu: () => [
          { label: t("menu.git.stashChanges"), action: () => void gitStash() },
          { label: t("menu.git.stashPop"), action: () => void gitStashPop() },
        ],
      },
      { sep: true, label: "" },
      { label: t("menu.git.switchBranch"), action: () => { setSidebarTab("git"); toggleBranchList(); } },
      { label: t("menu.git.commitHistory"), action: () => { setSidebarTab("git"); toggleHistory(); } },
      { sep: true, label: "" },
      { label: t("menu.git.openGitPanel"), action: () => setSidebarTab("git") },
    ];
    default: return [];
  }
}

// Monaco standalone 无文件系统：Ctrl+hover 定义预览（goToDefinitionAtPosition）会 createModelReference
// 报 "Model not found"（未打开的文件无法建 model）。F12/菜单跳转走 pylume 自己的 handler，不受影响；
// 这里静默该已知限制的 unhandled rejection，避免控制台噪音。
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason as { message?: string } | string | undefined;
  const msg = typeof reason === "string" ? reason : reason?.message ?? "";
  if (msg.includes("Model not found")) e.preventDefault();
});

// ---------- 初始化 ----------

async function init(): Promise<void> {
  // i18n 首屏：把语言包套到 index.html 的静态骨架（菜单条 / 设置面板 / 各模态的 data-i18n* 标记）。
  // 必须早于首个 await——否则静态文案会先以 HTML 里的中文原值闪一帧再跳成用户语言。
  // 放在这里而非模块顶层：套用需要 DOM 已就绪（顶层解析 DOM 违反本项目铁律）。
  initI18n();
  // TD-14 / TD-13：功能域解环注入（须先于任何事件与运行调用）
  setTracebackOpenFile(openFile);
  setGitReloadHandler(reloadFileFromDisk);
  setGitEditorBridge({
    // git 改写磁盘前落盘受影响脏文件（autosave 语义：不跑 ruff，保存动作只跟显式保存走）
    saveTabsBeforeGit: async (paths) => {
      for (const p of paths) {
        const tab = app.tabs.find((t) => t.path === p && t.dirty && t.kind !== "diff");
        if (tab) await saveTab(tab, { runOnSaveActions: false });
      }
    },
    // 未跟踪文件被丢弃删除：先留本地历史快照再关 tab（防 autosave 把缓冲写回复活文件）
    closeTabOf: (p) => {
      const tab = app.tabs.find((t) => t.path === p);
      if (!tab || tab.kind === "diff") return;
      // P1-10（2026-09-29 review）：snapshotHistory 的 invoke 往返期间该 tab 的 autosave
      // 计时器仍存活（closeTabSilent 内的 clearAutosave 要等快照回来才执行）——窗口内
      // 到期会把缓冲写回**已删除的路径**（文件复活）。入口先清计时器。
      editorTimers.clearAutosave(tab.path);
      void snapshotHistory(tab.path, tab.model.getValue()).then(() => closeTabSilent(tab));
    },
    // autosave 开启时批量改写后的 dirty tab：缓冲留历史 → 强制从磁盘重载（覆盖旧缓冲）
    reloadDirtyWithHistory: async (p) => {
      const tab = app.tabs.find((t) => t.path === p);
      if (!tab || tab.kind === "diff") return;
      // P1-10：同 closeTabOf——快照往返窗口内 autosave 写回旧缓冲会顶掉 git 改写结果。
      editorTimers.clearAutosave(tab.path);
      await snapshotHistory(tab.path, tab.model.getValue());
      await reloadFileFromDisk(p, true);
    },
  });
  setGitOpenFileHandler(openFile);
  setRunFlowHandlers({ openFile, activateTab, renderTabs, saveActive, saveTab });
  setFileTreeHandlers({ openFile, renderTabs, closeTabSilent, insertHeaderTemplate, runScript: (p) => void runScript(p) });
  setSettingsPanelHandlers({ startLsp });
  // 阶段 4：Pydantic 诊断 handlers 必须先于 openWorkspace（autoOpenRecentWorkspace 在
  // init 更深处才走到这里之前已可能触发首次扫描——扫描完成时 handlers 为 null 会被静默丢弃，
  // marker 永远挂不上；与 setRuffLintHandlers 不同，ruff 首扫由用户编辑触发无此时序问题）
  setPydanticDiagnosticsHandlers({ setMarkers });
  // A-5：会话恢复（session.ts 不反向 import main，能力经注入）
  setSessionHandlers({
    openFile,
    activateTabByPath: (p) => {
      const t = app.tabs.find((x) => samePath(x.path, p));
      if (t) activateTab(t);
    },
    renderTabs,
  });
  // UI-25：欢迎页快捷键网格改由键位系统渲染，必须在首个 await（Monaco 动态包，首屏最慢的一步）
  // 之前同步画一次，否则覆盖层会露出空的「快捷键」区。此刻 app.settings 仍是 DEFAULT_SETTINGS，
  // 画的是出厂键位；loadSettings 完成后由 updateEditorOverlay 刷成真实值（多数用户二者相同）。
  renderWelcomeShortcuts();
  // Monaco 动态加载（首屏 UI 先渲染，编辑器包并行下载）
  const monacoModule = await import("./monaco");
  app.monaco = monacoModule.default;
  // 批 4：注入主题钩子（settingsPanel / markdownPreview 经 app 调，不静态 import 本模块——
  // 那会把 ~3 MB 的 monaco-editor 拖进冷路径的按需加载链，抵消 monaco.ts 静态引入语言包的意义）。
  app.applyEditorTheme = monacoModule.applyEditorTheme;
  app.withEditorTheme = monacoModule.withEditorTheme;
  lsp.setMonaco(app.monaco);
  await loadSettings(); // 设置先于编辑器创建（字号/主题，P25-T08）
  // 批 3：等随包等宽字体真正就绪再建编辑器。Monaco 用 canvas measureText 测字符宽度并缓存
  // （CharConfig），字体异步到位后宽度与缓存不符会让网格/光标列整体错位，且 0.52 不会自动重测；
  // font-display: swap 下浏览器先画回退字体再交换，不等就是这个窗口。
  // 实测本地 4 个 woff2 共 75 KB，load 约 8ms；函数内另有 1.5s 超时兜底，绝不把 init 拖死。
  await ensureEditorFontLoaded(app.settings);
  app.applyEditorTheme(app.settings.theme); // 批 4：重注册（读 loadSettings 已切好的 data-theme 快照）+ setTheme
  // 快捷键域：注册稳定命令 + 按设置建立键 → 命令映射（设置保存后可重建）
  kb.initKeybindingCommands(app.monaco);
  kb.applyEditorKeybindings();
  app.editor = app.monaco.editor.create($("editor"), {
    model: null,
    language: "python",
    theme: app.settings.theme,
    automaticLayout: true,
    glyphMargin: true, // 断点/运行 glyph 依赖 glyph 边距，保留
    ...buildEditorOptions(app.settings), // P1：字号/连字/缩进/换行/迷你地图/字体族由设置统一注入
    lightbulb: { enabled: app.monaco.editor.ShowLightbulbIconMode.Off }, // 关闭快速修复灯泡图标（保留 Ctrl+. 菜单）
    wordBasedSuggestions: "off", // 踩坑 #3
    quickSuggestions: { other: true, comments: false, strings: false },
  });
  // A-5：光标移动同样刷新会话快照（防抖），恢复时才落回原处
  app.editor.onDidChangeCursorPosition(() => scheduleSessionSave());
  applyFontStatus();

  // C-4：分屏域接线（buildOptions 注入防 settingsPanel ⇄ splitEditor 成环；
  // 右键动作入 lspProviders 随编辑器生命周期统一释放）
  splitEditor.setSplitEditorHandlers({ buildOptions: () => buildEditorOptions(app.settings) });
  splitEditor.wireSplitEditor();
  lspProviders.add(splitEditor.initSplitEditorAction(app.editor));
  

  // 字体缩放：Ctrl+滚轮 8-32px，状态栏显示，存全局配置（P25-T08）
  app.editor.getDomNode()?.addEventListener("wheel", (e: WheelEvent) => {
    if (!e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -1 : 1;
    const next = Math.max(8, Math.min(32, app.settings.font_size + delta));
    if (next === app.settings.font_size) return;
    app.settings.font_size = next;
    app.editor.updateOptions({ fontSize: next });
    applyFontStatus();
    void saveSettings();
  }, { passive: false });

  // 标签栏滚轮横滚（标签多时鼠标滚轮纵向增量转横向滚动，与触控板行为一致）
  tabbarEl.addEventListener("wheel", (e: WheelEvent) => {
    if (e.ctrlKey) return; // Ctrl+滚轮留给编辑器字体缩放语义
    if (tabbarEl.scrollWidth <= tabbarEl.clientWidth) return;
    e.preventDefault();
    tabbarEl.scrollLeft += e.deltaY + e.deltaX;
  }, { passive: false });

  // 失焦自动保存（P25-T08）：runOnSaveActions=false，与 delay 模式同口径（不跑 ruff）
  app.editor.onDidBlurEditorText(() => {
    // P1-10（2026-09-29 review）：模态打开时的失焦是弹窗夺焦（focus trap），不是用户
    // 离开编辑器——此刻 blur autosave 会与 git 确认后的丢弃/改写操作竞速（write_file
    // 晚于删除落地即「复活」文件）。跳过；模态关闭后用户回到编辑器再自然触发。
    if (document.querySelector(".modal:not(.hidden)")) return;
    if (app.settings.autosave === "blur" && app.activeTab?.dirty) {
      saveActive({ runOnSaveActions: false }).catch((e) => toastFail(t("main.save.autosave"), e));
    }
  });

  liveTemplatesHandle = await initLiveTemplates(app.monaco, app.editor, {
    getWorkspaceRoot: () => app.workspaceRoot,
    fetchDocumentSymbols: (path) => lsp.documentSymbols(path), // M2：符号上下文主路径
    getModelPath: (model) => lsp.modelPath(model),
  });
  ltUi.wirePanel({
    getHandle: () => liveTemplatesHandle,
    hasWorkspace: () => !!app.workspaceRoot,
  });
  // 开发工具框架（curl→Python / JSONPath 提取器…）：菜单「工具」+ 模态面板统一入口
  initDevTools({
    monaco: app.monaco,
    editor: app.editor,
    workspaceRoot: () => app.workspaceRoot,
  });
  // PR-2：插件加载内核（§9.5/§9.15）——依赖注入 → 首扫 → 目录监听 → inline 管线
  const pluginDeps = buildPluginFacadeDeps();
  initPluginLoader(pluginDeps, () => registerQuickOpenActions(buildQuickOpenActions()));
  initInlineRunner(pluginDeps, () => listPluginRecords());
  initInlineSelectionMenu(); // P2：编辑器右键「变换选区 ▸」（子菜单条目随注册表自动重建）
  // P0 DX：作者指南落盘后经 openFile 打开（.md 自动开预览）
  setPluginsTabHandlers({ openFile: (p) => openFile(p) });
  // PR-S1：新手指南落盘后经 openFile 打开（同 pluginsTab 模式）
  setWelcomeGuideHandlers({ openFile: (p) => openFile(p) });
  // PR-S2：欢迎页引导接线（指南链接 / force-close / 动作按钮自动解除 / 巡礼交互 + 首渲染）
  wireWelcomeGuide();
  // PR-S2c：force 态变化 → 刷新覆盖层（updateEditorOverlay 注入，防循环依赖）
  setWelcomeOverlayRefresh(() => updateEditorOverlay());
  void getVersion()
    .then((v) => setAppVersion(v))
    .then(() => scanPlugins())
    .then(() => registerQuickOpenActions(buildQuickOpenActions()))
    .catch((e) => console.warn("[extensions] 插件首扫失败", e));
  // 第二十批 i18n：命令面板 label 是注册时快照——语言切换后整体重注册（registerQuickOpenActions 为替换语义）
  onLocaleChange(() => registerQuickOpenActions(buildQuickOpenActions()));
  void invoke("watch_plugins_dir").catch(() => undefined); // 监听失败静默（设置页「重新扫描」兜底）
  await listen("plugins-dir-changed", () => schedulePluginRescan());
  // 模板入口快捷键（可配置，默认 Ctrl+J / Ctrl+Alt+T）
  kb.setKeybindingHandler("template_palette", () => liveTemplatesHandle?.openPalette());
  kb.setKeybindingHandler("surround", () => liveTemplatesHandle?.openSurround());
  // PR-G：转到文件内符号（Ctrl+F12，editor 级）——handler 放这里避免 keybindings.ts 反向依赖
  // quickOpen 成环；命令面板 / 前往菜单走同一 handler（消除双写漂移）
  kb.setKeybindingHandler("goto_symbol", () => void openQuickOpen("symbol"));
  // 运行选区 / 行（默认 Alt+Shift+E）
  kb.setKeybindingHandler("run_selection", () => void runSelection());
  // P0：Optimize Imports（默认 Ctrl+Alt+O，PyCharm 同款）
  kb.setKeybindingHandler("optimize_imports", () => void optimizeImportsActive());
  // P1：查找引用（默认 Alt+F7，PyCharm 同款）——完整列表落底部「引用」面板
  kb.setKeybindingHandler("find_usages", () => void findUsagesAtCursor());
  // P2：跨文件重命名（默认 Shift+F6，PyCharm 同款）——定义 + 所有引用同步改名
  kb.setKeybindingHandler("rename_symbol", () => void renameSymbolAtCursor());
  // 库支持 PR-2：正则测试器（默认 Ctrl+Alt+R，editor 级）——与右键/lens 同一入口
  kb.setKeybindingHandler("open_regex_tester", () => openRegexTesterAtCursor());
  // CR-24：LSP providers 统一入应用级 DisposableStore——不再丢弃句柄。
  // providers 与引擎实例无关（内部按 engineStatus 短路），init 只注册一次；
  // store 便于应用级 teardown / 测试中整体清理，防句柄泄漏累积。
  lspProviders.dispose();
  lspProviders.add(lsp.registerLspCompletion());
  lspProviders.add(registerImportAliasCompletion(app.monaco)); // import 别名（纯前端静态，与引擎无关）
  lspProviders.add(registerAutoImportCompletion(app.monaco)); // PR-E：auto-import（自研 G-1 索引数据源，与引擎无关）
  lspProviders.add(lsp.registerLspHover());
  lspProviders.add(lsp.registerLspDefinition());
  lspProviders.add(lsp.registerLspReferences()); // Shift+F12 查找引用（peek 视图）
  lspProviders.add(initCodeVision(app.editor)); // 引用计数 Code Vision（声明行上方「N 处引用」）
  lspProviders.add(initFindUsagesAction(app.editor)); // 右键菜单「查找引用」
  // PR-I：Ctrl+Shift+双击 = 查找引用（PyCharm 手势对标，鼠标事件因而按 into DisposableStore）
  lspProviders.add(installCtrlShiftDblclickUsages(app.editor));
  lspProviders.add(initRenameWidget(app.editor)); // F2 就地重命名 + 右键菜单「重命名…」
  // 库支持 PR-2：正则字面量 lens / 高亮装饰 / pylume-libs 诊断（与 codeVision 引用 lens 并存，D-2）
  lspProviders.add(initDslLens(app.editor));
  lspProviders.add(initJsonLiteral(app.editor)); // 库支持 P1 §7-3：JSON 字面量高亮/折叠/诊断/右键
  lspProviders.add(initClipboardDiffAction(app.editor)); // C-5：右键菜单「与剪贴板对比」
  lspProviders.add(initNoqaAction(app.editor)); // D-4：右键菜单「忽略此规则（# noqa）」
  lspProviders.add(installPasteJson(app.editor)); // PR-M：粘贴 JSON → Python 字面量（onDidPaste 拦截）
  initQuickFixActions(); // P4：D-1/D-2 自研快速修复（Ctrl+. 灯泡；registerCodeActionProvider 自持 dispose 无需入 store）
  lspProviders.add(lsp.registerLspSignatureHelp()); // 签名帮助（参数提示）
  lspProviders.add(lsp.registerLspCodeAction()); // Ctrl+. 快速修复
  lspProviders.add(lsp.registerLspInlayHints()); // 运行时类型标注（pylume-intel）
  // 零引擎关键字补全：非 LSP 的静态兜底（无引擎语言才生效，python 由上面三段负责），
  // 段位 `3xx` 最低。与 LSP providers 同入应用级 store，便于统一 teardown。
  // 开关初值在此读一次；设置保存路径会再刷一次（与 intel 开关同模式）。
  setKeywordCompletionEnabled(app.settings.keyword_completion);
  lspProviders.add(registerKeywordCompletion(app.monaco));
  // 文档词补全按语言开关：python 恒 off（避免淹没语义补全），其余语言取当前文档的词。
  lspProviders.add(wireWordBasedSuggestions(app.editor));
  // 缺失包安装：注册全局命令供 CodeAction 的 command 引用（灯泡「安装 X」→ pip install）。
  // CodeAction 的 command 走 commandService.executeCommand(id)，必须用 registerCommand 全局注册 id；
  // 不能用 editor.addAction——addAction 内部会把 id 加 editorId 前缀（`editorId:id`），导致 executeCommand 找不到。
  app.monaco.editor.registerCommand(lsp.INSTALL_PACKAGE_COMMAND, (_accessor, ...args: unknown[]) => {
    const pkg = args[0];
    console.debug(`[pylume-install] 命令触发 pkg=${String(pkg)}`);
    if (typeof pkg === "string" && pkg) void installMissingPackage(pkg);
  });
  // 依赖健康 M3（§6.3）：「安装 X 并加入 pyproject」灯泡动作（E4/E3 → uv add，diff 数据源）
  app.monaco.editor.registerCommand(lsp.DECLARE_PACKAGE_COMMAND, (_accessor, ...args: unknown[]) => {
    const spec = args[0];
    if (typeof spec === "string" && spec) void declarePackage(spec);
  });
  registerRuffFormatter(app.monaco); // Shift+Alt+F / 右键「Format Document」
  setFormatErrorHandler((msg) => appendOutputLine(outputEl, msg, "stderr", gotoFromLink));
  setOpenMatchHandler((m) => openSearchMatch(m).catch(console.error));
  // 查找引用结果跳转：打开文件 + **选中标识符**（范围来自引用 Location）+ 居中聚焦，
  // 对齐 PyCharm「点击引用后落点一目了然」的体验（复用 openFile 的 tab/model 管理）
  setOpenRefHandler((path, line, col, endLine, endCol) => {
    void openFile(path, line).then(() => {
      const sel = {
        startLineNumber: line,
        startColumn: col,
        endLineNumber: endLine ?? line,
        endColumn: endCol ?? col,
      };
      app.editor.setSelection(sel);
      app.editor.revealLineInCenter(line);
      app.editor.focus();
    });
  });
  // 就地重命名落盘后刷新引用面板（符号名已变，位置仍在原符号处）；Code Vision 计数
  // 需等引擎重索引完成，延迟刷两次拿最终值（引擎侧慢时第二次兜底）
  setAfterRenameHandler(() => {
    const model = app.editor.getModel();
    const pos = app.editor.getPosition();
    if (model && pos) void queryAndRender(model, pos);
    window.setTimeout(() => refreshCodeVision(), 1500);
    window.setTimeout(() => refreshCodeVision(), 4000);
  });
  // 问题面板（对标 PyCharm Problems）：marker 驱动 + 点击条目跳转（openFile 复用 tab/model 管理）
  setOpenProblemHandler((path, line, column) => {
    void openFile(path, line).then(() => {
      app.editor.setPosition({ lineNumber: line, column });
      app.editor.revealLineInCenter(line);
      app.editor.focus();
    });
  });
  // 面板显示经回调注入（problemsPanel 不 import termUi，避免其 git→DOM 依赖链进单测）
  setShowPanelHandler(() => setBottomTab("problems"));
  lspProviders.add(wireProblemsPanel()); // marker 订阅入应用级 DisposableStore 收口（CR-24 纪律）
  // P1-BUG-002：补全请求前冲刷防抖窗口内未同步的 didChange——`.` 触发的补全请求会赶在
  // 200ms 防抖同步之前到达引擎，引擎按旧文档计算（补全位置越界 → 空结果）
  lsp.setBeforeCompletionHook(async (model) => {
    const t = app.tabs.find((x) => x.model === model);
    if (t && app.pendingChanges.has(t.path)) {
      await syncPendingChanges(); // CR-13：串行冲刷（含本文件在内的全部待同步变更，保 FIFO）
    }
  });
  // 语义请求（references / rename / prepareRename / documentSymbol）同理前置冲刷：
  // 引擎按旧缓冲算 rename 会漏改/错位，引用计数也会错
  lsp.setBeforeSemanticHook(() => syncPendingChanges());
  lsp.wireGotoTriggers(app.editor); // F12 / Ctrl+点击 显式跳转（Ctrl+悬停不跳）
  lsp.setGotoDefinitionHandler((path, line, col) => {
    openFile(path, line).then(() => app.editor.setPosition({ lineNumber: line, column: col }));
  });
  // 跳转定义可配置键（默认 Ctrl+B，PyCharm 风格；F12 / Ctrl+点击固定保留）
  kb.setKeybindingHandler("goto_definition", () => void lsp.gotoDefinitionAtCursor(app.editor));
  lsp.onNotification("textDocument/publishDiagnostics", (params, engine) => {
    lsp.handleDiagnostics(params, engine, setMarkers);
  });
  lsp.onEngineStatus((s) => {
    setEngineBusy(s === "starting"); // E-2：引擎启动期 chip 显示忙碌态
    if (s === "ready") {
      // 阶段 4 子项 1c：引擎切换只清了引擎桶，重放自研桶（pydantic 等）的缓存诊断
      lsp.replayPersistentDiagnostics(setMarkers, app.tabs.map((t) => t.path));
    }
    const map: Record<lsp.EngineStatus, string> = {
      off: t("main.lsp.off"), starting: t("main.lsp.starting"), ready: t("main.lsp.ready"),
      error: t("main.lsp.error"), exited: t("main.lsp.exited"),
    };
    // D3 P-09：状态点（灰未启动 / 黄启动中 / 绿就绪 / 红错误）
    const dotClass: Record<lsp.EngineStatus, string> = {
      off: "dot-off", starting: "dot-starting", ready: "dot-ready",
      error: "dot-error", exited: "dot-off",
    };
    const dot = document.createElement("span");
    dot.className = `lsp-dot ${dotClass[s]}`;
    statusLspEl.replaceChildren(dot, map[s]);
  });

  // window 级快捷键（保存 / 运行 / 全局搜索 / 调试五件套，PyCharm 风格）：经键位表实时匹配，可在设置中自定义
  window.addEventListener("keydown", (e) => {
    // 焦点在表单控件时不触发全局键（搜索框 / 提交框等）；
    // Monaco 编辑器内部也是 textarea，经 .monaco-editor 判定排除
    const ae = document.activeElement as HTMLElement | null;
    const inMonaco = !!ae?.closest(".monaco-editor");
    if (!inMonaco && ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable)) return;
    const id = kb.matchWindowBinding(e);
    if (!id) return;
    e.preventDefault();
    if (id === "save") void saveActive();
    else if (id === "run_script") void runScript();
    else if (id === "run_project") void runProject();
    else if (id === "stop") void stopRun();
    else if (id === "global_search") setSidebarTab("search");
    // P0：最近打开的文件（Ctrl+E）——后端数据早已在写，此前前端没有消费入口
    else if (id === "recent_files") void openRecentFiles();
    else if (id === "markdown_preview") mdPreview.togglePreview();
    // 调试五件套（debug dev plan §6.6）：F5 启动/继续、Shift+F5 停止、F10/F11/Shift+F11 步进
    else if (id === "debug") {
      const phase = dap.currentPhase();
      if (phase === "stopped") import("./dap/client").then((m) => void m.dapContinue(1));
      else if (phase === "idle" || phase === "exited") void runDebug();
    } else if (id === "debug_stop") void stopDebugSession();
    else if (id === "debug_step_over") import("./dap/client").then((m) => void m.dapNext(1));
    else if (id === "debug_step_into") import("./dap/client").then((m) => void m.dapStepIn(1));
    else if (id === "debug_step_out") import("./dap/client").then((m) => void m.dapStepOut(1));
    // P1：Search Everywhere 三入口 + 导航历史 + 本地历史 + 求值表达式
    else if (id === "goto_file") void openQuickOpen("files");
    else if (id === "goto_line") void openQuickOpen("line");
    else if (id === "nav_back") void goBack();
    else if (id === "nav_forward") void goForward();
    else if (id === "local_history") void openLocalHistory();
    else if (id === "debug_evaluate") void onEvaluateShortcut();
    // P2：Run to Cursor / 书签 / 草稿 / 运行历史
    else if (id === "debug_run_to_cursor") void runToCursorAtCursor();
    else if (id === "bookmark_toggle") void toggleBookmarkAtCursor();
    else if (id === "bookmark_list") void openBookmarks();
    else if (id === "scratch_new") void newScratch();
    else if (id === "run_history") openRunHistory();
    // P1（UX 审查）：高频操作键位（关闭标签 / 新建文件 / 设置 / 侧栏 / 底部面板）
    else if (id === "close_tab") { if (app.activeTab) void closeTab(app.activeTab); }
    // 标签页循环切换（Ctrl+Tab / Ctrl+Shift+Tab）
    else if (id === "next_tab") cycleTab(1);
    else if (id === "prev_tab") cycleTab(-1);
    else if (id === "new_file") void createFileInteractive();
    else if (id === "open_settings") openSettingsPanel();
    else if (id === "toggle_sidebar") toggleSidebar();
    else if (id === "toggle_bottom") toggleBottomPanel();
    // 问题面板（PyCharm Problems View 同款 Alt+0）
    else if (id === "open_problems") openProblemsPanel();
    // 命令面板直达（VS Code Ctrl+Shift+P 同款）：不注册时该组合会触发浏览器/系统「打印」
    else if (id === "command_palette") void openQuickOpen("commands");
    // PR-1：开发工具面板 + picker（Ctrl+Shift+T，toggle 语义）
    else if (id === "open_devtools") openDevToolsPanel();
    // PR-A（dx_features_backlog §6.1）：重开关闭的标签（Ctrl+Shift+Alt+T；Ctrl+Shift+T 已被 DevTools 占用）
    else if (id === "reopen_tab") {
      if (!reopenClosedTab()) toast(t("main.cmd.reopenNone"), "info");
    }
    // PR-D：最近编辑位置（Ctrl+Shift+Backspace，PyCharm Last Edit Location 同款）
    else if (id === "recent_edit_locations") {
      if (!jumpToLastEdit()) toast(t("main.cmd.noEarlierEdit"), "info");
    }
  });

  // P1：Double Shift → Search Everywhere（键位表无法表达双击手势，故固定在此）。
  // 误触防护：两次 Shift 之间若按下过任何**其它**键（如打大写字母 A 的 Shift+A），
  // 计时器立即作废——否则连续输入大写字母会被误判成双击 Shift。
  // keydown 必须 capture：焦点在 Monaco 内时编辑器会 stopPropagation 非认领键，
  // 冒泡阶段到不了 window——「Shift+End 选行后紧接着 Shift+F10 开右键菜单」会被误判成
  // Double Shift（F10 keydown 被吞、reset 不发生，两次 Shift keyup 落进 400ms 窗口）。
  let lastShiftUpAt = 0;
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Shift") lastShiftUpAt = 0;
    },
    { capture: true },
  );
  window.addEventListener("keyup", (e) => {
    if (e.key !== "Shift") return;
    const now = Date.now();
    if (lastShiftUpAt > 0 && now - lastShiftUpAt < DOUBLE_SHIFT_MS) {
      lastShiftUpAt = 0;
      if (!isQuickOpenOpen()) void openQuickOpen("all");
    } else {
      lastShiftUpAt = now;
    }
  });

  // didChange 全量同步（200ms 防抖，技术方案 §2.4）
  app.editor.onDidChangeModelContent(() => {
    if (!app.activeTab) return;
    // Markdown 预览：预览开启时才挂防抖渲染（关闭时零开销；仅活动 md tab 实际重渲染）
    if (mdPreview.isPreviewOpen()) mdPreview.schedulePreviewRender();
    window.clearTimeout(editorTimers.change);
    // C5：▶ 位置随内容变化 300ms 防抖重算（与 didChange 的 changeTimer 各管各的，不复用）
    window.clearTimeout(editorTimers.gutter);
    editorTimers.gutter = window.setTimeout(() => refreshRunGutter(), 300);
    // D3：断点行随内容变化防抖重算（行增删后断点按 Monaco 当前行号定位，不随行迁移）
    // P1-8：入 editorTimers 集中管理（先 clear 前值，防连点叠加全量重算）
    window.clearTimeout(editorTimers.debug);
    editorTimers.debug = window.setTimeout(() => refreshDebugGutter(), 300);
    // CR-13：changeTimer 回调改串行 await——原来循环内并发 fire-and-forget，多 invoke
    // 到达顺序不保证 → version 乱序，引擎状态错乱
    editorTimers.change = window.setTimeout(() => {
      void syncPendingChanges();
    }, 200);
    // 大纲随编辑防抖刷新（500ms，P25-T07）
    window.clearTimeout(editorTimers.outline);
    editorTimers.outline = window.setTimeout(() => {
      if (activeView() === "files") refreshOutline();
    }, 500);
    // P2：面包屑的符号树随编辑过期（缓存丢弃 → 下次刷新重查）
    invalidateBreadcrumbs();
    scheduleBreadcrumbs();
    // P2：ruff 实时 lint（停手 800ms 后跑一次）
    scheduleRuffLint();
    // P2：书签按行号定位，行增删后装饰要跟着重算（与断点红点同款处理）
    // P1-8：入 editorTimers 集中管理（先 clear 前值）
    window.clearTimeout(editorTimers.bookmark);
    editorTimers.bookmark = window.setTimeout(() => refreshBookmarkGutter(), 300);
    // 迭代 2 · P0-5：git 行级装饰随编辑防抖重算（dirty 文件实时反映新增/修改行）
    scheduleGitGutter();
    // （autosave delay 模式已迁移到 model 级监听 doOpenFile → scheduleAutosave：
    //  每个脏 tab 独立计时，不再只针对活动 tab）
  });

  // 各功能域事件接线（TD-007 域拆分后由各域自行提供）
  restoreLayout(); // D2 P-03：先恢复上次的侧栏宽度 / 底部面板高度
  wireSplitters();
  restoreReduceMotion(); // D3 P-06：恢复「减少动画」设置
  wireTooltip(); // D3 P-11：自绘 tooltip（data-tip 委托）
  $("tab-search").dataset.tipKey = kb.bindingLabel("global_search"); // tooltip 快捷键副文本（跟随自定义键位）
  wireBottomPanel();
  wireFileTree();
  // Ctrl+F：活动标签内查找（无活动标签则吞键，且永不弹 WebView2 原生查找条）
  setFindDiffEditorProvider(() => currentDiffEditor()?.getModifiedEditor() ?? null);
  installFindShortcut();
  // 其余浏览器加速器护栏（Ctrl+R 重载 / Ctrl+P 打印 / Ctrl+W 关窗口 …）
  installBrowserKeyGuard();
  // P0：最近打开的文件（Ctrl+E 弹窗）
  initRecentFiles();
  setRecentFilesHandlers({ openFile: (p) => void openFile(p) });
  // P1：Search Everywhere（Double Shift / Ctrl+Shift+N / Ctrl+G）
  initQuickOpen();
  setQuickOpenHandlers({
    openFile: (p, line) => void openFile(p, line),
    gotoLine: (line, column) => {
      app.editor.setPosition({ lineNumber: line, column });
      app.editor.revealLineInCenter(line);
      app.editor.focus();
    },
  });
  registerQuickOpenActions(buildQuickOpenActions());
  // P1：导航历史（Ctrl+Alt+←/→）——跳转闭环的另一半
  setNavHistoryHandlers({ openFile: (p, line) => openFile(p, line) });
  // PR-A：重开关闭的标签（Ctrl+Shift+Alt+T）——openFile 注入同 navHistory 模式
  setTabReopenHandlers({ openFile: (p) => void openFile(p) });
  // PR-D：最近编辑位置（Ctrl+Shift+Backspace）——独立监听 + openFile 注入
  initEditPoints(app.editor, { openFile: (p, line) => void openFile(p, line) });
  // P1：本地历史（Ctrl+Shift+H）——无 Git 工作区的回滚兜底
  initLocalHistory();
  setLocalHistoryHandlers({ reloadFile: (p) => reloadFileFromDisk(p, true) }); // 用户主动回滚：强制替换
  // P2：ruff 实时 lint（诊断第三桶，owner = pylume-ruff）
  setRuffLintHandlers({ setMarkers });
  // P2：书签（Ctrl+F11 切换 / Ctrl+Shift+F11 列表）
  initBookmarks(app.editor, app.monaco);
  setBookmarkHandlers({ openFile: (p, line) => void openFile(p, line) });
  void loadBookmarks().then(() => refreshBookmarkGutter());
  // P2-11（UX 审查）：启动恢复上次会话的断点（与书签同源同模式）
  void loadBreakpoints().then(() => refreshDebugGutter());
  // P2：运行历史（v3.4 M3-3.8：chip 标签条已删，Ctrl+Shift+R 列表；M4 收口：P2-O
  // 保存输出随历史列表行，原 #run-tabs-row 的「保存当前」按钮一并删除）
  initRunHistory();
  setRunHistoryHandlers({
    // P2：历史重放回填前重置 channel 过滤——历史行是 all，停在「调试/Git」过滤态下回放会看不到内容
    clearOutput: () => {
      resetOutputChannelUi();
      clearOutput(outputEl);
    },
    appendLine: (cls, text) => appendOutputLine(outputEl, text, cls, gotoFromLink),
    rerun: (r) => void rerunRecord(r),
  });
  // P2：Breadcrumbs 面包屑（编辑区顶部层级链）
  initBreadcrumbs();
  setBreadcrumbHandlers({
    gotoLine: (line) => {
      app.editor.setPosition({ lineNumber: line, column: 1 });
      app.editor.revealLineInCenter(line);
      app.editor.focus();
    },
  });
  app.editor.onDidChangeCursorPosition(() => scheduleBreadcrumbs());
  // 编辑历史采集（低延迟编辑预测数据源 V1）：行对事件，攒语料，仅采集不预测
  initEditHistory(app.editor);
  // P0：TODO 工具窗
  initTodoView();
  setTodoViewHandlers({ openFile: (path, line) => void openFile(path, line) });
  // F1：端点工具窗（渲染与动作见 endpointView.ts；扫描在 Rust fs_cmds::scan_endpoints）
  initEndpointView();
  setEndpointViewHandlers({ openFile: (path, line) => void openFile(path, line) });
  // B3：数据库工具窗（侧栏资源管理器见 sqliteView.ts；编辑器 Tab 见 sqliteTabs.ts；引擎在 Rust db_cmds.rs）
  initDbView();
  setDbTabHandlers({ activateTab, buildOptions: () => buildEditorOptions(app.settings) });
  $("ew-open-folder").addEventListener("click", () => void openFolderFromToolbar());
  $("ew-new-project").addEventListener("click", () => openNewProjectPanel());
  $("ew-recent-clear").addEventListener("click", () => void clearRecentWorkspaces());
  mdPreview.setMarkdownLinkHandler((path) => void openFile(path)); // 相对 .md 链接 → openFile（注入回调，避免循环依赖）
  mdPreview.wireMarkdownClicks(); // 预览点击委托（#锚点 / 相对 .md / http(s)）
  mdPreview.wireMarkdownControls(); // 方案A：右上角开关按钮 + 方案D：一次性引导关闭
  wireMenuBar(getMenuItems); // TD-14：菜单机制在 menuBar.ts，菜单项数据仍由本层组装
  void checkFirstRunStorage(); // 首启数据落位提示（disk-space-plan.md P2-a；内部判断触发条件，多数启动为 no-op）

  // 自绘标题栏（decorations: false）：窗口控制按钮 + 拖拽区 + 边缘 resize 兜底
  const appWindow = getCurrentWindow();
  const winMaxBtn = $("win-max") as HTMLButtonElement;
  // UI-01：切换 codicon 类名而非覆盖 textContent——保住 HTML 里的 <i aria-hidden> 节点，
  // 与最小化/关闭按钮（同为 codicon）风格一致，也不再依赖 "Segoe UI Symbol" 字体渲染裸字符。
  const winMaxIcon = winMaxBtn.querySelector("i.codicon");
  const syncMaxIcon = async (): Promise<void> => {
    try {
      const max = await appWindow.isMaximized();
      winMaxIcon?.classList.toggle("codicon-chrome-maximize", !max);
      winMaxIcon?.classList.toggle("codicon-chrome-restore", max);
      // UI-09：与 index.html 的静态 data-tip 同轨。动态改写必须同时更新 aria-label——
      // 只改 tip 的话，最大化后读屏仍会报「最大化」，与已切换成还原态的图标不符。
      const label = max ? t("main.win.restore") : t("main.win.maximize");
      winMaxBtn.dataset.tip = label;
      winMaxBtn.setAttribute("aria-label", label);
    } catch { /* 忽略 */ }
  };
  $("win-min").addEventListener("click", () => void appWindow.minimize());
  winMaxBtn.addEventListener("click", () => {
    void appWindow.toggleMaximize();
    void syncMaxIcon();
  });
  $("win-close").addEventListener("click", () => void appWindow.close());
  // 自绘标题栏：整个 menubar 的空白区可拖拽 / 双击最大化。
  // 用 mousedown 手动接管（data-tauri-drag-region 会吞掉双击且只对直接元素生效），
  // 交互元素（菜单按钮、引擎下拉、窗口控制按钮）不拦截。
  ($("menubar") as HTMLElement).addEventListener("mousedown", (ev) => {
    if (ev.buttons !== 1) return; // 仅响应左键
    const target = ev.target as HTMLElement;
    if (target.closest("button, select, input, #win-controls")) return;
    if (ev.detail === 2) {
      void appWindow.toggleMaximize();
      void syncMaxIcon();
    } else {
      void appWindow.startDragging();
    }
  });
  void syncMaxIcon();
  // 尺寸变化（含 snap 吸附 / 拉伸）后刷新最大化/还原图标
  void appWindow.onResized(() => void syncMaxIcon());

  // 边缘 resize 兜底：decorations:false 下部分 Windows 版本失去原生边缘缩放，
  // 用透明热区 + startResizeDragging 手动接管。
  const resizeEdges: Array<[ResizeDirection, string]> = [
    ["North", "n"], ["South", "s"], ["East", "e"], ["West", "w"],
    ["NorthEast", "ne"], ["NorthWest", "nw"], ["SouthEast", "se"], ["SouthWest", "sw"],
  ];
  for (const [dir, cls] of resizeEdges) {
    const h = document.createElement("div");
    h.className = `rs-handle rs-${cls}`;
    h.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return; // 仅响应左键
      ev.preventDefault();
      void appWindow.startResizeDragging(dir);
    });
    document.body.appendChild(h);
  }
  // 引擎 chip（C2）：状态栏身份展示 + 切换入口；真值已收敛到 app.settings.lsp_engine
  setEngineChipHandlers({ startLsp, saveSettings });
  wireEngineChip();
  renderEngineChip();
  // A-1：资源可观测（状态栏 MEM 芯片 + 面板；明细采样仅面板打开时进行）
  wireResourcePanel({ restartLsp: startLsp });

  // 运行组（v3.4 §8 / M3-3.4）：四控件 [▶ 运行脚本] [▶ 运行项目] [⏹ 停止] [⚙ 运行配置…]。
  // main 拥有运行动作，runWidget 只负责渲染与派发
  setRunWidgetHandlers({
    runScript: () => void runScript(),
    runProject: () => void runProject(),
    // 调试态联动（D4）：运行组 ⏹ 在调试中路由到 debug_stop，避免「调试中误触停止脚本」
    stop: () => {
      const phase = dap.currentPhase();
      if (phase === "starting" || phase === "running" || phase === "stopped") void stopDebugSession();
      else void stopRun();
    },
    // 面板为工作区级：没有活动标签也可打开（活动文件仅用于脚本分区预选，见 openRunConfig）
    openRunConfig: () => void openRunConfig(app.activeTab?.path),
  });
  wireRunWidget();
  setRunWidgetRepaint(() => renderRunWidget(runWidgetState()));

  // gutter 运行图标（C5）：__main__ 守卫行的 ▶，点击运行整个文件、右键弹出运行组同源菜单
  wireRunGutter(app.editor, app.monaco);
  // 迭代 2 · P0-5：git 行级变更装饰（绿/蓝条 + 删除红三角）
  wireGitGutter(app.editor, app.monaco);
  // gutter 悬停预示（方案 1/2）：把真正可点的 glyph 那一档画出来 + 悬停行显示淡化断点，
  // 否则用户会点在行号两侧的空白上而以为「断点坏了」（CSS 侧见 style.css 同段注释）
  wireGutterHover(app.editor, app.monaco);
  setRunGutterHandlers({
    // gutter ▶ 的语义是「运行这个文件」（v3.4 §2：gutter ▶ = 运行脚本）
    run: () => { if (app.activeTab) void runScript(app.activeTab.path); },
    menuItems: () => buildRunMenuItems(),
    state: () => {
      const tab = app.activeTab;
      const isPy = !!tab && (tab.path.endsWith(".py") || tab.path.endsWith(".pyw"));
      // v3.4 M3 复查修复：gutter ▶ 的置灰只看**脚本运行**（项目实例不互斥，§12）+
      // 调试态（§13.2 调试 ↔ 脚本运行互斥）——原 isRunning() 含项目实例会误置灰
      const dbgPhase = dap.currentPhase();
      const debugging = dbgPhase === "starting" || dbgPhase === "running" || dbgPhase === "stopped";
      return { canRun: !!app.workspaceRoot && !!tab && isPy, running: scriptRunActive() || debugging, targetName: tab ? basename(tab.path) : "" };
    },
  });

  // 调试域接线（debug dev plan §6.7）：DAP 事件 + gutter 断点 + 侧栏视图 + 工具栏按钮。
  // 隔离性：任何一步失败只放弃调试功能，**不得中断 init 后续接线**——wireDebugGutter
  // 若未执行，行号断点点击将整体失效（用户实测坑：init 中途抛错 → 断点不出现）。
  try {
    void dap.wireDapEvents().catch((e) => console.error("[debug] DAP 事件监听失败:", e));
    // 注入「守卫行归属」判定：debugGutter 需让出 __main__ 行的 glyph（方案 A），
    // 但不直接 import runGutter（会带进 menu 的顶层 document 监听），故由此注入。
    wireDebugGutter(app.editor, app.monaco, isRunGutterLine);
    // P0：断点右键菜单（条件 / 命中次数 / Logpoint）——菜单构造需要 menu.ts 与 dialog.ts，
    // 由 main 注入以保持 debugGutter 的可测试性（同 runGutter 的 menuItems 注入范式）。
    setBreakpointMenuHandler((path, line, x, y) => void showBreakpointMenu(path, line, x, y));
    initDebugView();
    // P1：调试控制台（求值表达式 + Logpoint 输出承接）——必须挂在 initDebugView 之后，
    // 它往 #view-debug 末尾追加节点，先建会被 initDebugView 的 textContent = "" 清掉
    initDebugConsole();
    // P2：行内变量值（与 inlay hints 同一套注入文本装饰）
    initInlineValues(app.editor, app.monaco);
    wireDebugViewEvents();
    // 调试 phase 变化 → 运行组按钮同步（调试中 ⏹ 可用并路由 debug_stop，D4）
    dap.onPhase(() => {
      renderRunWidget(runWidgetState());
    });
    setDebugViewHandlers({
      start: () => void runDebug(),
      stop: () => void stopDebugSession(),
      openFile: (path, line) => { void openFile(path, line); },
      refreshGutter: () => refreshDebugGutter(),
    });
    $("btn-debug").addEventListener("click", () => {
      // 调试中点击 = 无操作（停止走工具栏/快捷键）；空闲 = 启动调试
      const phase = dap.currentPhase();
      if (phase === "idle" || phase === "exited") void runDebug();
    });
  } catch (e) {
    console.error("[debug] 调试域接线失败（调试功能不可用，其余功能不受影响）:", e);
  }

  // 环境面板（P25-T05）：DOM 接线 + 装包后重启引擎（restartEngine = startLsp，TD-14 注入解环）
  initEnvPanel({ restartEngine: startLsp });
  // 依赖健康面板（dep plan M3）：tab/刷新/状态栏图标接线；openEnvPanel 与包列表刷新经此注入
  //（depHealthPanel 单向 import envPanel 的 shortInterpreter，反向调用全部走注入——无环）
  initDepHealthPanel({ openEnvPanel: () => void openEnvPanel(), refreshPackagesIfOpen, repaintPackagesIfOpen: repaintPkgBadgesIfOpen });
  // 面板打开即重绘健康分区（envPanel 的 openedHooks，避免 envPanel ↔ depHealthPanel 循环依赖）
  onEnvPanelOpened(() => void renderDepHealth());
  // 依赖健康域（dep plan M2/M3）：引擎重启器 + M3 UI 钩子（状态栏体检图标 / toast「查看」入口）
  initDepHealth({
    restartEngine: startLsp,
    // toast「查看」入口语义是「看问题」——展开依赖明细再开面板（明细默认收起）
    openHealthPanel: () => { expandDepDetail(); void openEnvPanel(); },
    onScanStart: () => setHealthStatus("scanning"),
    onScanComplete: handleScanComplete,
  });
  // 依赖健康 M4-3（§6.4 traceback 一键安装）：toast「安装」入口 → envPanel.installMissingPackage
  //（内部走 runDepFix 统一编排 + M4-4 候选选择）；输出面板 stderr 行 → ModuleNotFoundError 检测。
  setDepInstallHandler((module) => installMissingPackage(module));
  setOutputTracebackHandler((line) => handleTracebackLine(line));

  // 侧栏视图注册表（TD-001）：单根容器 + 生命周期钩子，切换只操作注册表根节点
  registerSidebarView({
    id: "files",
    rootId: "view-files",
    tabId: "tab-files",
    onShow: () => { refreshOutline(); },
  });
  registerSidebarView({
    id: "search",
    rootId: "view-search",
    tabId: "tab-search",
    onShow: () => ($("search-input") as HTMLInputElement).focus(),
    onHide: () => cancelSearch(),
  });
  // P0：TODO 工具窗——切到该视图才扫描（大仓库遍历不占用启动路径）
  registerSidebarView({
    id: "todo",
    rootId: "view-todo",
    tabId: "tab-todo",
    onShow: () => void refreshTodos(),
  });
  // F1：端点工具窗——同 TODO：切到该视图才扫描
  registerSidebarView({
    id: "endpoints",
    rootId: "view-endpoints",
    tabId: "tab-endpoints",
    onShow: () => void refreshEndpoints(),
  });
  registerSidebarView({
    id: "git",
    rootId: "view-git",
    tabId: "tab-git",
    onShow: () => {
      refreshGitStatus().then(() => {
        renderGitPanel();
        void refreshBranchPanel();
      });
    },
  });
  registerSidebarView({
    id: "debug",
    rootId: "view-debug",
    tabId: "tab-debug",
    onShow: () => renderDebugView(),
  });
  // B3：数据库侧栏——同 TODO/端点：切到该视图才拉连接列表（不在启动路径上做 IO）
  registerSidebarView({
    id: "database",
    rootId: "view-database",
    tabId: "tab-database",
    onShow: () => void onDbViewShow(),
  });

  // Activity Bar 图标（FILES / SEARCH / GIT / DEBUG）
  $("tab-files").addEventListener("click", () => setSidebarTab("files"));
  $("tab-search").addEventListener("click", () => setSidebarTab("search"));
  $("tab-todo").addEventListener("click", () => setSidebarTab("todo"));
  $("tab-endpoints").addEventListener("click", () => setSidebarTab("endpoints"));
  $("tab-git").addEventListener("click", () => setSidebarTab("git"));
  $("tab-debug").addEventListener("click", () => setSidebarTab("debug"));
  $("tab-database").addEventListener("click", () => setSidebarTab("database"));
  // 大纲折叠 / 展开（OUTLINE 并入文件视图，TD-001 附带考虑）
  // UI-16：disclosure 语义——aria-expanded 与 .collapsed 类同源切换（单一写入点），
  // 并给这个可点击 div 补键盘激活（role=button + tabindex 已在 index.html 静态声明）
  const outlineHeader = $("outline-header");
  const toggleOutline = () => {
    const collapsed = $("outline-section").classList.toggle("collapsed");
    outlineHeader.setAttribute("aria-expanded", String(!collapsed));
    try {
      localStorage.setItem("pylume.outline_collapsed", collapsed ? "1" : "0"); // B 批：写穿持久化
    } catch {
      // 存储不可用：本次会话内仍生效
    }
  };
  outlineHeader.addEventListener("click", toggleOutline);
  outlineHeader.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleOutline();
    }
  });
  // B 批：恢复上次的大纲折叠态（存 "1" 且默认展开 → 切一次即折叠）
  if (localStorage.getItem("pylume.outline_collapsed") === "1") toggleOutline();
  // 初始化激活视图：优先恢复上次会话的选择（B 批持久化），无记录/非法值回退 files
  restoreSidebarView("files");
  // Git 域 UI 接线（SCM 工具栏 / 历史 / diff / 提交 / 分支，TD-007）
  wireGitUI();
  // 第 2 步迁移：diff tab 生命周期回调（git.ts 的 showDiff/关闭链 → main 的 tab 统一路径）
  setDiffTabHandlers({
    activate: (tab) => activateTab(tab),
    close: (tab) => closeTabSilent(tab),
  });
  const searchInputEl = $("search-input") as HTMLInputElement;
  // 回车确认搜索；清空输入则清空搜索结果（并使进行中的搜索作废，避免旧结果回填）
  searchInputEl.addEventListener("input", () => {
    if (!searchInputEl.value.trim()) {
      executeSearch().catch(console.error);
    }
  });
  searchInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      executeSearch().catch(console.error);
    }
  });
  $("search-case").addEventListener("click", () => {
    searchCaseSensitive = !searchCaseSensitive;
    $("search-case").classList.toggle("active", searchCaseSensitive);
    // UI-16：开关按钮的按下态用 aria-pressed 表达，与 .active 类同源切换
    $("search-case").setAttribute("aria-pressed", String(searchCaseSensitive));
    if (searchInputEl.value.trim()) executeSearch().catch(console.error);
  });
  // PR-H：正则开关（与 Aa 同款接线）
  $("search-regex").addEventListener("click", () => {
    searchUseRegex = !searchUseRegex;
    $("search-regex").classList.toggle("active", searchUseRegex);
    $("search-regex").setAttribute("aria-pressed", String(searchUseRegex));
    if (searchInputEl.value.trim()) executeSearch().catch(console.error);
  });
  // PR-H：文件掩码——change 而非 per-keystroke（掩码是「限定条件」，逐键重搜既吵又贵）；
  // 回车即时触发一次，方便边写边验证
  const searchMaskEl = $("search-mask") as HTMLInputElement;
  searchMaskEl.addEventListener("change", () => {
    searchFileGlob = searchMaskEl.value.trim();
    if (searchInputEl.value.trim()) executeSearch().catch(console.error);
  });
  searchMaskEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    searchFileGlob = searchMaskEl.value.trim();
    if (searchInputEl.value.trim()) executeSearch().catch(console.error);
  });
  // E-5：scope 切换即重搜（当前文件 / 打开的标签 / 整个工作区）
  $("search-scope").addEventListener("change", () => {
    if (searchInputEl.value.trim()) executeSearch().catch(console.error);
  });

  // 设置面板（P25-T09）——菜单栏右侧图标
  wireSettingsPanel();

  // 新建项目（文件菜单入口）——面板接线在 newProject.ts，openWorkspace / openFile 由本层注入
  wireNewProject({ openWorkspace, openFile });
  wireCloneRepository({ openWorkspace, openFile, openPanel: openNewProjectPanel });

  // 运行配置面板（P0-C 配置列表编辑器；stdin 重定向 S1）——接线在 runConfigPanel.ts
  wireRunConfigPanel();

  // P2 并行运行 + S4 交互输入行 + 输出面板钩子——接线在 runFlow.ts
  wireRunFlow();

  // S3：终端里的 traceback 也可点击（坑 4）——复用输出面板同一个正则与跳转逻辑；
  // 顺带让在 shell 终端里手敲 `uv run` 产生的 traceback 同样可点（PTY 路线的额外收益）
  setTerminalLinkHandler(gotoFromLink);
  // P2-L：终端里的 URL 可点开（uvicorn/FastAPI 等），与输出面板 URL / 自动开浏览器共用 open_external
  setTerminalUrlHandler((url) => {
    invoke("open_external", { url }).catch((e) => toastFail(t("main.url.openBrowser"), e));
  });
  // P2-L：输出中的 URL 可点开（invoke open_external 仅放行 http/https，后端二次校验）
  setOutputUrlHandler((url) => {
    invoke("open_external", { url }).catch((e) => toastFail(t("main.url.openBrowser"), e));
  });
  // 库支持 P1：`log_level_colors` 开关注入（research §11.9；output.ts 保持无 state 依赖可单测）
  setOutputLevelColorsEnabled(() => app.settings.log_level_colors !== false);
  // v3.4 §9（M3-3.9）：FastAPI 服务就绪（Uvicorn running on http://…）自动开浏览器
  // ——与输出面板 URL 点击共用同一 open_external 通道
  setExternalUrlOpener((url) => {
    invoke("open_external", { url }).catch((e) => toastFail(t("main.url.openBrowser"), e));
  });

  // 文件监听事件（增量刷新树）
  await getCurrentWindow().listen<string[]>("fs-changed", (e) => {
    handleFsChanged(e.payload);
  });

  // 调试输出事件（debug-stdout / debug-stderr → 输出面板，§13.3）——接线在 runFlow.ts
  await initRunEvents();

  // 包安装 / 工具链引导事件流（pip-* / toolchain-*）——在 envPanel.ts
  await initEnvPanelEvents();

  // 终端事件（P2-7 多会话）：按 id 分发到对应终端实例
  await wireTerminalEvents();

  // 依赖健康失效矩阵（dep plan M2）：watcher 的 dep-fs-changed / dep-env-changed 事件接线
  await wireDepHealthEvents();

  // 首次启动环境引导（第 4 步）：缺失 uv/pyrefly 时弹窗引导一键安装
  await maybePromptToolchain();

  // 多窗口：项目窗口按其绑定目录打开；主窗口回落「恢复最近」
  await openInitialWorkspace();
  updateEditorOverlay();
  renderRunWidget(runWidgetState()); // 首次渲染（无工作区时 renderTabs 不被调用，需显式补一次）
}

init().catch((e) => console.error("init 失败", e));
