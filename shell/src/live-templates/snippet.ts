// Monaco snippet 注入助手（共享）：经公开 API editor.getContribution 访问
// SnippetController2（Monaco 0.52.2 ESM 未注册 editor.action.insertSnippet 命令，方案 §15.3）。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";

export interface SnippetControllerLike {
  insert(template: string, opts?: Record<string, unknown>): void;
}

/** 贡献 ID 为多年稳定的内部常量；Monaco 已锁 0.52.2（ci/versions.toml），升级回归覆盖 */
export const SNIPPET_CTRL_ID = "snippetController2";

/** 在当前选区插入 snippet 并进入占位符会话；贡献缺失返回 false（调用方兜底）。
 * CR-24：editor 放宽为 ICodeEditor（getContribution 是基础 API，非 standalone 专属） */
export function insertSnippet(
  editor: MonacoApi.editor.ICodeEditor,
  snippet: string,
): boolean {
  const ctrl = editor.getContribution(SNIPPET_CTRL_ID) as unknown as SnippetControllerLike | null;
  if (!ctrl) return false;
  ctrl.insert(snippet);
  return true;
}
