// PR-M（dx_features_backlog §6.6）：粘贴 JSON → Python dict 字面量。
// 编辑器 paste 拦截（onDidPaste）：粘贴内容为完整合法 JSON 对象/数组时，就地改写为
// Python 字面量（true→True、false→False、null→None，引号转义/嵌套原样保留）。
//
// 设计决策：
//   · 只认**完整** JSON（trim 后以 { 或 [ 开头且可解析）——裸 true/"42"/字符串一律不动，
//     避免把用户想贴的原文误改写；
//   · 仅 .py/.pyw 文件触发（其他语言贴 JSON 是正常需求）；
//   · executeEdits 单次替换 = 单一撤销粒度，Ctrl+Z 一步回原文（非破坏性，故开关默认开）。
//
// 已知边界（登记不修）：JSON 字符串转义与 Python 兼容（\" \\ \n \uXXXX 同语义），
// 但 \/ 不会由 JSON.stringify 产出；键恒为带引号字符串（Python dict 允许，不改写成裸键）。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { app } from "./state";
import { toast } from "./toast";
import { pythonLiteralOf } from "./pyLiteral";

/** trim 后是否形似 JSON（对象/数组）——廉价前置判定，避免无效 JSON.parse */
export function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

/** JSON 文本 → Python dict/list 字面量（4 空格缩进）。
 *  返回 null = 不是完整合法 JSON 或不是对象/数组（标量不动）。纯函数（单测）。
 *  序列化实现在 pyLiteral.ts（单一实现，curl2python 同源复用）。 */
export function jsonToPythonLiteral(text: string): string | null {
  if (!looksLikeJson(text)) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null; // 标量 / JSON null 不动
  return pythonLiteralOf(value);
}

/** 编辑器 paste 拦截：返回 Disposable（入 lspProviders 统一收口）。 */
export function installPasteJson(editor: MonacoApi.editor.IStandaloneCodeEditor): MonacoApi.IDisposable {
  return editor.onDidPaste((e) => {
    if (app.settings.paste_json_to_python === false) return; // 默认开；显式关才停用
    const model = editor.getModel();
    if (!model) return;
    const p = model.uri.path.toLowerCase();
    if (!p.endsWith(".py") && !p.endsWith(".pyw")) return; // 仅 Python 文件
    const text = model.getValueInRange(e.range);
    const py = jsonToPythonLiteral(text);
    if (py === null || py === text.trim()) return;
    editor.executeEdits("pylume-paste-json", [{ range: e.range, text: py }]);
    toast("JSON 已转换为 Python 字面量（Ctrl+Z 可撤销）", "info");
  });
}
