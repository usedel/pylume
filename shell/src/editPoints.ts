// 最近编辑位置（PR-D · dx_features_backlog §6.4，PyCharm Ctrl+Shift+Backspace「Last Edit Location」对标）。
//
// 归属：独立功能域模块（TD-014；自带 onDidChangeModelContent 监听，仿 editHistory.ts 的
// init 模式——不往 main.ts:2050 已承载多任务的编辑回调里追加任务）。
// 与 navHistory.ts 刻意不共用一套栈：navHistory 是「跳转闭环」语义（sameLoc 只比 path+line，
// 且随光标移动隐式推栈），编辑点是**时间轴**语义（只在内容变更时记录）。
//
// 跳转动作经 handler 注入 openFile（同 navHistory / tabReopen 模式，避免与 main.ts 循环依赖）。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { app } from "./state";

export interface EditPoint {
  path: string;
  line: number;
}

/**
 * 编辑点栈（纯逻辑，可单测）。
 * - 记录：内容变更时把当前文件+光标行入栈；连续同文件且行距 ≤ mergeLines 的多次变更
 *   合并为一个编辑点（输入过程中行号小范围漂移不炸栈）；
 * - 跳转：从游标处向更早回溯，跳过「当前位置所在编辑区域」；到栈底后循环回栈顶。
 *   任何新编辑都会重置导航游标（时间轴重新开始）。
 */
export class EditPointStack {
  private stack: EditPoint[] = [];
  private cursor = -1; // -1 = 导航未激活

  constructor(
    readonly max = 50,
    readonly mergeLines = 3,
  ) {}

  get size(): number {
    return this.stack.length;
  }

  /** 清空（工作区切换时调用） */
  clear(): void {
    this.stack = [];
    this.cursor = -1;
  }

  /** 编辑发生：合并/入栈 + 重置导航游标 */
  noteEdit(path: string, line: number): void {
    const top = this.stack[this.stack.length - 1];
    if (top && top.path === path && Math.abs(top.line - line) <= this.mergeLines) {
      top.line = line;
    } else {
      this.stack.push({ path, line });
      if (this.stack.length > this.max) this.stack.shift();
    }
    this.cursor = -1;
  }

  /**
   * 最近编辑位置跳转：返回目标点并把游标指过去。
   * 「当前位置区域」= 与 (path, line) 同文件且行距 ≤ mergeLines 的编辑点，回溯时跳过；
   * 整个栈都是当前位置时返回 null（无处可跳）。
   */
  jumpFrom(path: string | null, line: number | null): EditPoint | null {
    if (this.stack.length === 0) return null;
    const isCurrent = (p: EditPoint) =>
      p.path === path && line !== null && Math.abs(p.line - line) <= this.mergeLines;
    let idx = this.cursor === -1 ? this.stack.length - 1 : this.cursor - 1;
    for (let visited = 0; visited < this.stack.length; visited++) {
      if (idx < 0) idx = this.stack.length - 1; // 回溯到栈底：循环回栈顶
      const p = this.stack[idx];
      if (!isCurrent(p)) {
        this.cursor = idx;
        return p;
      }
      idx--;
    }
    return null;
  }
}

let stack: EditPointStack | null = null;
let openFileHandler: ((path: string, line?: number) => void) | null = null;

/** main.ts init 时调用一次：挂内容变更监听 + 注入跳转动作（与 WebView 同生命周期，无需 dispose） */
export function initEditPoints(
  editor: MonacoApi.editor.IStandaloneCodeEditor,
  handlers: { openFile: (path: string, line?: number) => void },
): void {
  stack = new EditPointStack();
  openFileHandler = handlers.openFile;
  editor.onDidChangeModelContent((e) => {
    const s = stack; // 闭包内 narrowing 失效：取本地引用
    const tab = app.activeTab;
    const pos = editor.getPosition();
    if (!s || !tab || tab.kind === "diff" || !pos) return;
    if (e.isUndoing || e.isRedoing) return; // 撤销/重做不是新编辑位置（review 建议 2）
    s.noteEdit(tab.path, pos.lineNumber);
  });
}

/** 工作区切换时清空（main.ts openWorkspace 接线）——否则跨工作区会跳回旧工作区文件 */
export function resetEditPoints(): void {
  stack?.clear();
}

/** 键位入口：跳到上一个编辑位置；无处可跳返回 false（调用方负责 toast） */
export function jumpToLastEdit(): boolean {
  if (!stack) return false;
  const tab = app.activeTab;
  const target = stack.jumpFrom(tab?.path ?? null, app.editor.getPosition()?.lineNumber ?? null);
  if (!target) return false;
  openFileHandler?.(target.path, target.line);
  return true;
}
