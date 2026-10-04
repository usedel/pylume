// 编辑器分屏（P4 · C-4，PyCharm / VS Code Split Right 对标）。
//
// 语义：**钉住式分屏**——打开分屏时把当前活动 tab 的 model 装进第二个 Monaco 实例
// （同一 model 共享，两侧编辑实时同显，cursor/滚动/选区各自独立）；此后主编辑器
// 随 tab 切换换 model，分屏保持钉住不动。分屏所显 model 的 tab 被关闭（model
// dispose）时自动收起分屏；工作区切换 / diff tab 激活时同步隐藏。
//
// 实例策略：分屏编辑器懒创建、常驻复用（G-1：不随开随弃）；关闭只 setModel(null)
// 并隐藏面板，再次打开直接复用（viewState 由 Monaco 实例自持——同 model 不重设即不丢）。
// 快照兼容：分屏状态**不**进 sessions 快照（工作区重开分屏收起，属预期行为）。
//
// 依赖注入：buildOptions（编辑器构造参数）由 main 注入（本模块不 import settingsPanel，
// 防与 settingsPanel 的 refresh 调用成环）。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { app, $, lazyEl } from "./state";
import { basename } from "./util";
import { hideEl, showEl } from "./anim";
import { toast } from "./toast";

const panelEl = lazyEl("split-editor-panel");
const labelEl = lazyEl("split-editor-label");
// 注意：host 不能用 lazyEl Proxy——Monaco 的 automaticLayout 会把容器直接喂给
// ResizeObserver.observe()，Proxy 不是真实 Element 会被原生 API 拒绝（实测踩坑）。
// 故 ensureEditor() 里运行时用 $ 解析真实元素。

export interface SplitEditorHandlers {
  /** 与主编辑器同源的构造参数（main 注入 buildEditorOptions，防循环导入） */
  buildOptions: () => MonacoApi.editor.IEditorOptions;
}

let handlers: SplitEditorHandlers | null = null;
let splitEditorInstance: MonacoApi.editor.IStandaloneCodeEditor | null = null;
/** 分屏当前钉住的 model（null = 分屏关闭） */
let splitModel: MonacoApi.editor.ITextModel | null = null;
/** diff tab 激活期间主编辑器被隐藏，分屏随之隐藏（open 状态保留，切回文件 tab 恢复） */
let hiddenByDiff = false;

export function setSplitEditorHandlers(h: SplitEditorHandlers): void {
  handlers = h;
}

export function isSplitOpen(): boolean {
  return splitModel !== null;
}

function ensureEditor(): MonacoApi.editor.IStandaloneCodeEditor {
  if (splitEditorInstance) return splitEditorInstance;
  splitEditorInstance = app.monaco.editor.create($("split-editor-host"), {
    automaticLayout: true,
    model: null,
    ...handlers?.buildOptions(),
  });
  return splitEditorInstance;
}

/** 打开/重钉分屏：显示活动 tab 的 model。已钉同 model 时提示（幂等）。 */
export function openSplit(): void {
  wireSplitEditor(); // 关闭按钮接线（首开一次）
  const tab = app.activeTab;
  if (!tab || tab.kind === "diff") {
    toast("当前没有可分屏的文件标签", "info");
    return;
  }
  if (splitModel === tab.model) {
    toast("分屏已在显示当前文件", "info");
    return;
  }
  splitModel = tab.model;
  labelEl.textContent = basename(tab.path);
  ensureEditor().setModel(tab.model);
  // 面板宽度：有记忆则恢复（layout.ts 拖拽落 localStorage），否则走 CSS 默认 50%
  const saved = localStorage.getItem("pylume-split-w");
  if (saved) panelEl.style.setProperty("--split-w", `${saved}px`);
  showEl(panelEl);
  hiddenByDiff = false; // 从文件 tab 打开必然不在 diff 态
  updateDiffVisibility();
}

/** 关闭分屏（实例保留，G-1：不随开随弃；model 置空解除钉住） */
export function closeSplit(): void {
  if (splitModel === null) return;
  splitModel = null;
  hideEl(panelEl);
  splitEditorInstance?.setModel(null);
}

/** 开 ↔ 关（键位 / 命令面板入口） */
export function toggleSplit(): void {
  const tab = app.activeTab;
  if (splitModel !== null && tab && tab.model === splitModel) closeSplit();
  else openSplit();
}

/** diff tab 激活/切回时由 main 调用：diff 占满编辑区期间分屏隐藏（open 态保留） */
export function setDiffActive(diffActive: boolean): void {
  hiddenByDiff = diffActive;
  updateDiffVisibility();
}

function updateDiffVisibility(): void {
  if (splitModel === null) return; // 关闭态本就隐藏，不干预
  if (hiddenByDiff) hideEl(panelEl);
  else showEl(panelEl);
}

/** 主编辑器侧 model 被销毁（tab 关闭 / 工作区清理）时同步收起——
 *  共享 model 若已 dispose 而分屏仍挂着，编辑器会渲染已释放内容（必须硬关联） */
export function onModelDisposed(model: MonacoApi.editor.ITextModel): void {
  if (splitModel === model) closeSplit();
}

/** 工作区切换兜底（批量关 tab 时 onModelDisposed 已逐个触发，此处防御性再清一次） */
export function resetSplitEditor(): void {
  closeSplit();
}

/** 主编辑器右键「向右分屏」（可发现性入口；键位 Ctrl+Backslash 并行） */
export function initSplitEditorAction(editor: MonacoApi.editor.IStandaloneCodeEditor): MonacoApi.IDisposable {
  return editor.addAction({
    id: "pylume.splitRight",
    label: "向右分屏",
    contextMenuGroupId: "1_modification",
    contextMenuOrder: 4,
    run: () => openSplit(),
  });
}

/** 设置保存后的参数同步（字号/主题/连字等即时生效，与主编辑器同源 options） */
export function refreshSplitEditorOptions(): void {
  splitEditorInstance?.updateOptions(handlers?.buildOptions() ?? {});
}

// 面板关闭按钮（首开时接线一次；lazyEl 惰性解析保证 import 无副作用）
let wired = false;
export function wireSplitEditor(): void {
  if (wired) return;
  wired = true;
  lazyEl<HTMLButtonElement>("split-editor-close").addEventListener("click", closeSplit);
}
