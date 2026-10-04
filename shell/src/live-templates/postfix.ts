// 后缀补全（M3，方案 §9.4）：`表达式.键` + 补全接受 → 转换已有表达式
// 表达式提取为向左启发式扫描（标识符/属性链/配对括号/字符串），不做类型门控（v1 边界）。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import type { TemplateRegistry } from "./registry";
import type { TemplateDef } from "./schema";
import type { ScopeInfo } from "./scope";
import { compileTemplate } from "./compiler";
import type { EngineContext } from "./engine";

type Monaco = typeof MonacoApi;

export interface PostfixHost {
  buildEngineContext(
    model: MonacoApi.editor.ITextModel,
    position: MonacoApi.Position,
    tpl: TemplateDef,
  ): Promise<EngineContext>;
  resolveScopeInfo(model: MonacoApi.editor.ITextModel, position: MonacoApi.Position): ScopeInfo;
}

const IDENT_CHAR_RE = /[A-Za-z0-9_]/;

export interface ExtractedExpr {
  expr: string;
  /** 表达式起点（0-based 列下标） */
  startCol0: number;
}

/**
 * 从 `.` 前位置向左扫描提取表达式。
 * 支持：标识符、属性链（foo.bar）、配对的 ()/[]、单双引号字符串（含 f"..." 前缀）。
 * 已知局限（v1）：括号内嵌字符串中的括号、三引号字符串可能误判。
 */
export function extractExprBeforeDot(line: string, dotIndex: number): ExtractedExpr | null {
  let i = dotIndex - 1;
  if (i < 0) return null;
  const c0 = line[i];
  // 必须紧邻 `.`，且以表达式合法字符结尾
  if (!(IDENT_CHAR_RE.test(c0) || c0 === ")" || c0 === "]" || c0 === '"' || c0 === "'")) {
    return null;
  }
  while (i >= 0) {
    const c = line[i];
    if (IDENT_CHAR_RE.test(c) || c === ".") {
      i--;
      continue;
    }
    if (c === ")" || c === "]") {
      const open = findMatchingOpen(line, i);
      if (open < 0) return null;
      i = open - 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const open = findStringOpen(line, i);
      if (open < 0) return null;
      i = open - 1;
      continue;
    }
    break;
  }
  const startCol0 = i + 1;
  const expr = line.slice(startCol0, dotIndex);
  // 首尾残留 `.`（如 `foo..if`）视为非法表达式
  if (!expr || expr.startsWith(".") || expr.endsWith(".")) return null;
  return { expr, startCol0 };
}

function findMatchingOpen(line: string, closeIdx: number): number {
  const close = line[closeIdx];
  const open = close === ")" ? "(" : "[";
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    const c = line[i];
    if (c === close) depth++;
    else if (c === open) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findStringOpen(line: string, closeQuoteIdx: number): number {
  const q = line[closeQuoteIdx];
  for (let i = closeQuoteIdx - 1; i >= 0; i--) {
    if (line[i] === q && line[i - 1] !== "\\") return i;
  }
  return -1;
}

/**
 * 成员访问上下文（`.` 后）构建后缀补全项：
 * range 覆盖「表达式起点 → 光标」，接受后整体替换为转换后的 snippet（$EXPR$ 已字面注入）。
 */
export async function buildPostfixItems(
  monaco: Monaco,
  model: MonacoApi.editor.ITextModel,
  position: MonacoApi.Position,
  word: { word: string; startColumn: number; endColumn: number },
  registry: TemplateRegistry,
  host: PostfixHost,
): Promise<MonacoApi.languages.CompletionItem[]> {
  const line = model.getLineContent(position.lineNumber);
  const dotCol0 = word.startColumn - 2;
  if (dotCol0 < 0 || line[dotCol0] !== ".") return [];
  // v1：仅在已键入键前缀时提供（空词让位成员补全，避免 `.` 后列表混浊）
  if (!word.word) return [];

  const extracted = extractExprBeforeDot(line, dotCol0);
  if (!extracted) return [];

  const scopeInfo = host.resolveScopeInfo(model, position);
  const templates = registry.findPostfixByPrefix(`python:${scopeInfo.syntax}`, word.word);
  if (templates.length === 0) return [];

  // 踩坑 #1：枚举必须在补全回调内读取 + 数值回退（monaco 动态加载时序）
  const KIND_SNIPPET =
    (monaco.languages.CompletionItemKind && monaco.languages.CompletionItemKind.Snippet) ?? 14;
  const INSERT_AS_SNIPPET =
    ((monaco.languages as any).CompletionItemInsertTextRule?.InsertAsSnippet) ?? 4;

  const suggestions: MonacoApi.languages.CompletionItem[] = [];
  for (let i = 0; i < templates.length; i++) {
    const tpl = templates[i];
    const ctx = await host.buildEngineContext(model, position, tpl);
    const key = tpl.postfixKey ?? tpl.abbreviation;
    const labelSrc = `${extracted.expr}.${key}`;
    suggestions.push({
      label: labelSrc.length > 44 ? "…" + labelSrc.slice(-43) : labelSrc,
      kind: KIND_SNIPPET,
      insertText: compileTemplate(tpl, ctx, { EXPR: extracted.expr }),
      insertTextRules: INSERT_AS_SNIPPET,
      sortText: "0" + String(i).padStart(2, "0"), // 三层合并契约：0xx 段
      preselect: i === 0,
      filterText: key,
      detail: `⟳ postfix · ${tpl.description}`,
      range: {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: extracted.startCol0 + 1,
        endColumn: word.endColumn,
      },
    });
  }
  return suggestions;
}
