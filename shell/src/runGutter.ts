// gutter 运行图标（C5）：在 `if __name__ == "__main__":` 那一行的 glyph margin 显示 ▶，
// 点击 = 运行整个文件（等同 Ctrl+F10），右键 = 弹出与菜单栏 ▾ 同一份菜单。
//
// 范围界定（不要扩大）：只在 __main__ 守卫行显示 ▶，**不给每个函数/类显示 ▶**——
// 「运行单个函数」需要 debugger / eval 注入 harness，超出本项目功能范围。
// gutter ▶ 永远是补充入口，不是唯一入口：正则漏检只是没有图标，菜单栏 ▶ 照常工作。
//
// handlers 注入（同 runWidget / terminal 先例），main.ts 拥有运行动作与「菜单项 + 状态」，
// 本模块只负责装饰渲染与点击派发，不反向依赖 main.ts（无循环导入）。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { app, type MonacoModule } from "./state";
import { showMenu, type MenuItem } from "./menu";

export interface RunGutterHandlers {
  run: () => void;
  /** 右键时返回运行组同源菜单项（main 提供，保证两处菜单一致） */
  menuItems: () => MenuItem[];
  /** 当前是否可运行（决定图标亮/灰） */
  state: () => { canRun: boolean; running: boolean; targetName: string };
}

let handlers: RunGutterHandlers | null = null;
let decorations: MonacoApi.editor.IEditorDecorationsCollection | null = null;
let targetLine: number | null = null;
let editorRef: MonacoApi.editor.IStandaloneCodeEditor | null = null;
let monacoRef: MonacoModule | null = null;

export function setRunGutterHandlers(h: RunGutterHandlers): void {
  handlers = h;
}

/** 该行是否被 ▶ 占用的 `__main__` 守卫行（debugGutter 用于让出 glyph，避免同一次点击既运行又设断点）。
 *  未显示 ▶ 时（非 .py / 无工作区 / 无守卫 / 已清空）恒为 false。 */
export function isRunGutterLine(line: number): boolean {
  return targetLine === line;
}

/** 纯函数：取**第一个** `if __name__ == "__main__":` 匹配行（1 基），无守卫返回 null。
 *  仅覆盖常规写法，不穷尽反写 `if '__main__' == __name__:` 等奇异变体（漏检无碍，见文件头）。 */
export function findMainGuardLine(text: string): number | null {
  const m = /^[ \t]*if[ \t]+__name__[ \t]*==[ \t]*(['"])__main__\1[ \t]*:/m.exec(text);
  if (!m) return null;
  return text.slice(0, m.index).split("\n").length;
}

export function wireRunGutter(editor: MonacoApi.editor.IStandaloneCodeEditor, monaco: MonacoModule): void {
  editorRef = editor;
  monacoRef = monaco;
  // Monaco 支持多订阅：lsp/client.ts::wireGotoTriggers 已订过 onMouseDown（Ctrl+点击跳转），
  // 这里再订一个互不干扰，勿去改那个函数。
  editor.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    if (e.target.position?.lineNumber !== targetLine) return;
    const me = e.event;
    if (me.rightButton) {
      const items = handlers?.menuItems() ?? [];
      if (items.length > 0) {
        const bx = me.browserEvent?.clientX ?? me.posx;
        const by = me.browserEvent?.clientY ?? me.posy;
        showMenu(items, { x: bx, y: by });
      }
      return;
    }
    const st = handlers?.state();
    if (!st || !st.canRun || st.running) return; // 置灰：不触发
    handlers?.run();
  });
}

/** 重算当前文件的 ▶ 位置（切 tab / 内容变化 / 打开文件后调用） */
export function refreshRunGutter(): void {
  clearRunGutter();
  const editor = editorRef;
  const monaco = monacoRef;
  if (!editor || !monaco) return;
  const tab = app.activeTab;
  if (!tab) return;
  const isPy = tab.path.endsWith(".py") || tab.path.endsWith(".pyw");
  if (!isPy || !app.workspaceRoot) return;
  const line = findMainGuardLine(tab.model.getValue());
  if (line === null) return;
  targetLine = line;
  const st = handlers?.state() ?? { canRun: false, running: false, targetName: "" };
  const cls = st.canRun && !st.running ? "gutter-run" : "gutter-run disabled";
  decorations = editor.createDecorationsCollection([
    { range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: cls } },
  ]);
}

/** 清空装饰（关闭 tab / 非 .py / 无工作区 / 切工作区） */
export function clearRunGutter(): void {
  decorations?.clear();
  decorations = null;
  targetLine = null;
}