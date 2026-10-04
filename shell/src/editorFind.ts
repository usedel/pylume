// Ctrl+F：活动标签内查找（Monaco find widget）。
//
// 为什么要这个模块：Ctrl+F 是 WebView2 的浏览器加速器键之一，前端无人处理时
// WebView2 会弹出自带的查找条（与 Pylume 的视觉/交互完全脱节）。约定行为：
// - 有活动标签 → 打开**该标签**的查找条（普通文件走主编辑器，diff 标签走 diff 的 modified 侧）；
// - 无活动标签 → 吞掉按键，什么都不做；
// - 任何情况下都不再出现浏览器原生查找条。
//
// 与键位表的关系：焦点已在 Monaco 内时，Monaco 自带的 Ctrl+F（actions.find）本来就生效，
// 本模块只补「焦点不在编辑器内」的那条路径，故固定 Ctrl/Cmd+F、不进 KEYBINDING_META
// （与 Double Shift → Search Everywhere 同款处理）。
//
// 监听在 capture 阶段：必须赶在 WebView2 把按键当加速器之前阻断，也赶在各面板
// （终端 / 侧栏输入）之前，避免被局部处理拦掉。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { isQuickOpenOpen } from "./quickOpen";
import { app } from "./state";

/** diff 标签的编辑器由 git.ts 持有（避免本模块反向依赖 Git 域，防循环） */
let diffEditorProvider: (() => MonacoApi.editor.IStandaloneCodeEditor | null) | null = null;

/** main.ts 注入：返回当前 Git diff 编辑器可编辑侧（未创建时返回 null，不触发创建） */
export function setFindDiffEditorProvider(
  fn: () => MonacoApi.editor.IStandaloneCodeEditor | null,
): void {
  diffEditorProvider = fn;
}

/** Ctrl/Cmd + F（不带 Alt/Shift——Ctrl+Shift+F 是全局搜索）。多布局兜底：code 为主、key 为辅 */
function isFindShortcut(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
  return e.code === "KeyF" || e.key === "f" || e.key === "F";
}

/** 焦点已在某处 Monaco 内（主编辑器 / diff / 本地历史 / 已打开的查找条）→ 交给 Monaco 自带键位 */
function focusInMonaco(): boolean {
  const ae = document.activeElement as HTMLElement | null;
  return !!ae?.closest?.(".monaco-editor");
}

/** 有可见的自绘模态（confirm / prompt / 设置等）：此时不动编辑器，只吞键 */
function modalOpen(): boolean {
  return !!document.querySelector(".modal:not(.hidden):not(.closing)");
}

/** 活动标签对应的编辑器；无活动标签（欢迎页 / 全关）返回 null */
function editorOfActiveTab(): MonacoApi.editor.IStandaloneCodeEditor | null {
  const tab = app.activeTab;
  if (!tab) return null;
  if (tab.kind === "diff") return diffEditorProvider?.() ?? null;
  return app.editor;
}

/** 安装 window 级捕获监听（幂等由调用方保证：main.ts init 只调一次） */
export function installFindShortcut(): void {
  window.addEventListener(
    "keydown",
    (e) => {
      if (!isFindShortcut(e)) return;
      // 一律阻断：无活动标签 / 模态打开时也要吞掉，绝不留给浏览器原生查找条
      e.preventDefault();
      // Monaco 内不 stopPropagation，否则会掐断它自己的 Ctrl+F
      if (focusInMonaco()) return;
      e.stopPropagation();
      if (modalOpen() || isQuickOpenOpen()) return;
      const ed = editorOfActiveTab();
      if (!ed) return; // 无活动标签：无反应
      ed.focus();
      ed.getAction("actions.find")?.run();
    },
    true,
  );
}
