// 补全弹窗路径（方案 §9.2）：三层合并契约 sortText `0xx` 段 + preselect + 缩写过滤
// 成员访问上下文（`.` 后）让位 LSP/后缀（M3），⚡ 强制全显除外（P1-BUG-002 语义保留）

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import type { TemplateRegistry } from "./registry";
import type { TemplateDef } from "./schema";
import type { SyntaxContext } from "./scope";
import { compileTemplate } from "./compiler";
import type { EngineContext } from "./engine";
import { buildPostfixItems } from "./postfix";

type Monaco = typeof MonacoApi;

export interface CompletionHost {
  buildEngineContext(
    model: MonacoApi.editor.ITextModel,
    position: MonacoApi.Position,
    tpl: TemplateDef,
  ): Promise<EngineContext>;
  /** 上下文判定（M2：符号优先 + 启发式兜底，由 index.ts 注入；含位置轴） */
  resolveScopeInfo(model: MonacoApi.editor.ITextModel, position: MonacoApi.Position): SyntaxContext;
}

/** 强制全显开关（⚡ 工具栏，M2 恢复入口）：下一次补全忽略成员访问门控，展示全部模板 */
let forceShowAll = false;
export function setForceShowAll(v: boolean): void {
  forceShowAll = v;
}

export function registerTemplateCompletion(
  monaco: Monaco,
  registry: TemplateRegistry,
  host: CompletionHost,
): MonacoApi.IDisposable {
  return monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: ["."], // 为 M3 后缀补全预留
    async provideCompletionItems(model: MonacoApi.editor.ITextModel, position: MonacoApi.Position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      // 成员访问上下文（`.` 后）：普通语句模板不进入（P1-BUG-002 语义），
      // 改由后缀模板接管（M3）；⚡ 强制全显是用户显式动作，放行普通模板。
      if (!forceShowAll) {
        const line = model.getLineContent(position.lineNumber);
        const beforeWord = word.startColumn > 1 ? line[word.startColumn - 2] : "";
        if (beforeWord === ".") {
          const suggestions = await buildPostfixItems(monaco, model, position, word, registry, host);
          return { suggestions };
        }
      }

      const scopeInfo = host.resolveScopeInfo(model, position);
      const templates = registry.templatesForContext(scopeInfo);

      // 踩坑 #1：枚举必须在补全回调内读取 + 数值回退（monaco 动态加载时序）
      const KIND_SNIPPET =
        (monaco.languages.CompletionItemKind && monaco.languages.CompletionItemKind.Snippet) ?? 14;
      // Monaco 0.52 类型名：CompletionItemInsertTextRule（单数）；运行时回退数值 4
      const INSERT_AS_SNIPPET =
        ((monaco.languages as any).CompletionItemInsertTextRule?.InsertAsSnippet) ?? 4;

      const suggestions: MonacoApi.languages.CompletionItem[] = [];
      for (let i = 0; i < templates.length; i++) {
        const tpl = templates[i];
        const ctx = await host.buildEngineContext(model, position, tpl);
        suggestions.push({
          label: tpl.abbreviation,
          kind: KIND_SNIPPET,
          insertText: compileTemplate(tpl, ctx),
          insertTextRules: INSERT_AS_SNIPPET,
          sortText: "0" + String(i).padStart(2, "0"), // 三层合并契约：0xx 段，升序
          preselect: i === 0,
          filterText: tpl.abbreviation,
          detail: `⟳ ${scopeInfo.syntax} · ${tpl.group ? `[${tpl.group}] ` : ""}${tpl.description}`,
          documentation: tpl.body,
          range,
        });
      }

      if (forceShowAll) {
        for (const s of suggestions) s.filterText = word.word;
        forceShowAll = false;
      }

      return { suggestions };
    },
  });
}
