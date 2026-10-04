// 重新打开已关闭的标签（PR-A · dx_features_backlog §6.1，对标 PyCharm/VSCode「Reopen Closed Editor」）。
//
// 归属：独立功能域模块（TD-014 禁止往 main.ts 堆模块级状态）；
// 跳转动作经 handler 注入 openFile（同 navHistory / recentFiles 模式，避免与 main.ts 循环依赖）。
// 只记**用户主动关闭**（closeTab / 批量关闭确认后由调用方上报）；工作区切换的批量清理
// （直调 closeTabSilent 的路径）不入栈，防止跨工作区重开出旧工作区的文件。
//
// 出厂键位 Ctrl+Shift+Alt+T（Ctrl+Shift+T 已被 open_devtools 占用，见 keybindingDefaults.ts）。

/** 栈条目上限（与 recentFiles/runHistory 的有界截断同风格） */
export const MAX_CLOSED_TABS = 20;

/**
 * 纯函数：路径入关闭栈（后入栈顶语义）。
 * - 去重：同路径重复关闭时移除旧条目再入栈顶（重开永远命中最近一次关闭）；
 * - 有界：超过 max 从栈底截断。
 */
export function pushClosedPath(stack: string[], path: string, max: number): string[] {
  const next = [...stack.filter((p) => p !== path), path];
  return next.length > max ? next.slice(next.length - max) : next;
}

const closed: string[] = [];
let openFile: ((path: string) => void) | null = null;

/** main.ts 注入打开动作（init 时调用一次） */
export function setTabReopenHandlers(h: { openFile: (path: string) => void }): void {
  openFile = h.openFile;
}

/** 用户主动关闭标签后上报（diff 虚拟标签由调用方过滤） */
export function recordClosedTab(path: string): void {
  const next = pushClosedPath(closed, path, MAX_CLOSED_TABS);
  closed.length = 0;
  closed.push(...next);
}

/** 工作区切换时清空（main.ts openWorkspace 接线）——否则存量旧工作区路径会被跨区重开 */
export function resetTabReopen(): void {
  closed.length = 0;
}

/** 重开最近关闭的标签；栈空返回 false（调用方负责 toast 提示） */
export function reopenClosedTab(): boolean {
  const path = closed.pop();
  if (!path) return false;
  openFile?.(path);
  return true;
}

/** 测试钩子：清空模块级栈（vitest 用例间隔离） */
export function _resetForTest(): void {
  closed.length = 0;
  openFile = null;
}
