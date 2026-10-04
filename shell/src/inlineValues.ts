// 行内变量值（P2 · PyCharm Inline Values 对标）：调试暂停时，在变量出现的行尾
// 直接显示它的当前值。
//
// **为什么不用 Monaco 的 InlineValuesProvider**：本项目锁定的 monaco-editor 0.52
// standalone 构建并未在 monaco.d.ts 暴露 `languages.registerInlineValuesProvider`
// （那是 VS Code 侧的调试集成 API，Monaco 只在 VS Code 里接了 DAP）。
// 故改用与 inlay hints / 运行时类型标注**同一套注入文本装饰**实现
// （`IModelDecorationOptions.after`），渲染机制一致、视觉语言统一，零上游依赖。
//
// 取值来源：已停帧的 locals 变量（`debugView` 刷新变量时一并喂进来），
// 不再额外发 DAP 请求——一次 `variables` 请求的结果两处复用。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { app, type MonacoModule } from "./state";

let editorRef: MonacoApi.editor.IStandaloneCodeEditor | null = null;
let monacoRef: MonacoModule | null = null;
let collection: MonacoApi.editor.IEditorDecorationsCollection | null = null;

/** 单文件最多渲染多少处（超大文件的同名变量可能上百处，全渲染既卡又糊屏） */
const MAX_HINTS = 120;
/** 单个值的显示上限（超出截断，全文仍在变量面板与 tooltip 里） */
const MAX_VALUE_LEN = 48;

export function initInlineValues(
  editor: MonacoApi.editor.IStandaloneCodeEditor,
  monaco: MonacoModule,
): void {
  editorRef = editor;
  monacoRef = monaco;
}

/** 截断过长的值（保持单行：换行会破坏注入文本的布局） */
export function trimValue(v: string): string {
  const oneLine = v.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_VALUE_LEN ? `${oneLine.slice(0, MAX_VALUE_LEN - 1)}…` : oneLine;
}

/**
 * 刷新行内变量值。
 * @param path 暂停所在文件（与当前激活 tab 不一致时直接清空——避免把 A 文件的变量贴到 B 文件）
 * @param vars 变量列表（name + value）
 */
export function updateInlineValues(path: string, vars: Array<{ name: string; value: string }>): void {
  clearInlineValues();
  const editor = editorRef;
  const monaco = monacoRef;
  if (!editor || !monaco) return;
  const tab = app.activeTab;
  if (!tab || tab.path !== path) return;

  // 只保留合法标识符名（debugpy 的 locals 里可能出现 "<lambda>"、"[0]" 之类）
  const names = vars
    .map((v) => v.name)
    .filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  if (names.length === 0) return;
  const valueOf = new Map(vars.map((v) => [v.name, trimValue(v.value)]));

  // 长名优先：否则 `x` 会先吃掉 `x_y` 的前缀（正则交替按最左匹配）
  names.sort((a, b) => b.length - a.length);
  const re = new RegExp(`\\b(?:${names.map(escapeRe).join("|")})\\b`, "g");

  const model = editor.getModel();
  if (!model) return;
  const lineCount = model.getLineCount();
  const found: MonacoApi.editor.IModelDeltaDecoration[] = [];

  for (let line = 1; line <= lineCount && found.length < MAX_HINTS; line++) {
    const text = model.getLineContent(line);
    if (text.length === 0) continue;
    re.lastIndex = 0;
    // 单行内多处同名：全部标注（与 PyCharm 一致），但受 MAX_HINTS 总量约束
    const hits: Array<{ col: number; name: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push({ col: m.index + 1, name: m[0] });
      if (m.index === re.lastIndex) re.lastIndex++; // 防御零宽匹配
    }
    for (const hit of hits) {
      if (found.length >= MAX_HINTS) break;
      const value = valueOf.get(hit.name);
      if (value === undefined) continue;
      const endCol = hit.col + hit.name.length;
      found.push({
        range: new monaco.Range(line, endCol, line, endCol),
        options: {
          after: { content: ` = ${value}`, inlineClassName: "debug-inline-value" },
        },
      });
    }
  }

  if (found.length > 0) collection = editor.createDecorationsCollection(found);
}

export function clearInlineValues(): void {
  collection?.clear();
  collection = null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
