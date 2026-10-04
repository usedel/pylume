// 上下文解析：语法位置（module/class/function + 名称）+ 词法环境（字符串/注释）
// 双路判定（方案 §6.2）：documentSymbol 符号解析（M2，主）+ 改良缩进启发式（M1，兜底）

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { SYMBOL_KIND_CLASS, SYMBOL_KIND_FUNCTION, SYMBOL_KIND_METHOD, type FlatSymbol } from "./symbols";
import type { PositionKind } from "./schema";

type Monaco = typeof MonacoApi;

const FUNCTION_LIKE_KINDS = new Set([SYMBOL_KIND_METHOD, SYMBOL_KIND_FUNCTION]);

export type PythonSyntaxScope = "module" | "class" | "function";

export interface ScopeInfo {
  syntax: PythonSyntaxScope;
  className: string | null;
  methodName: string | null;
}

/** 三维上下文：容器（ScopeInfo）+ 位置（PositionKind）；词法维仍由 lexicalEnvAt 单独承载 */
export interface SyntaxContext extends ScopeInfo {
  position: PositionKind;
}

const DEF_RE = /^\s*def\s+([A-Za-z_]\w*)/;
const CLASS_RE = /^\s*class\s+([A-Za-z_]\w*)/;
// 块头关键字：包围语句但不改变 def/class 嵌套，上溯时透明跳过
const BLOCK_HEADER_RE = /^(if|elif|else|for|while|try|except|finally|with|match|case)\b/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** 续行/结构碎片行：`)` `]` `}` `.` 开头，或以 `,` `(` `[` `{` `\` 结尾 */
function isContinuation(trimmed: string): boolean {
  return (
    /^[)\]}]/.test(trimmed) ||
    trimmed.startsWith(".") ||
    /[,([{\\]$/.test(trimmed)
  );
}

/** 空行缩进借用：先向下找最近非空行，再向上；均无则 0 */
function effectiveIndent(model: MonacoApi.editor.ITextModel, lineNumber: number): number {
  const cur = model.getLineContent(lineNumber);
  if (cur.trim()) return indentOf(cur);
  const count = model.getLineCount();
  for (let l = lineNumber + 1; l <= count; l++) {
    const t = model.getLineContent(l);
    if (t.trim()) return indentOf(t);
  }
  for (let l = lineNumber - 1; l >= 1; l--) {
    const t = model.getLineContent(l);
    if (t.trim()) return indentOf(t);
  }
  return 0;
}

/**
 * 语法位置判定：
 * 1. 当前位置有效缩进为 0 → module；
 * 2. 向上找最近的更低缩进行：def → function（再继续上溯找包围 class）；class → class；
 *    块头/续行/装饰器透明跳过；其他语句行 → module。
 */
export function resolveScope(model: MonacoApi.editor.ITextModel, position: MonacoApi.Position): ScopeInfo {
  const none: ScopeInfo = { syntax: "module", className: null, methodName: null };
  const curIndent = effectiveIndent(model, position.lineNumber);
  if (curIndent === 0) return none;

  let methodName: string | null = null;
  let methodLine = -1;
  let methodIndent = -1;

  for (let l = position.lineNumber - 1; l >= 1; l--) {
    const t = model.getLineContent(l);
    const trimmed = t.trim();
    if (!trimmed) continue;
    const ti = indentOf(t);
    if (ti >= curIndent) continue;

    const defM = DEF_RE.exec(t);
    if (defM) {
      methodName = defM[1];
      methodLine = l;
      methodIndent = ti;
      break;
    }
    const classM = CLASS_RE.exec(t);
    if (classM) {
      return { syntax: "class", className: classM[1], methodName: null };
    }
    if (trimmed.startsWith("@") || isContinuation(trimmed) || BLOCK_HEADER_RE.test(trimmed)) continue;
    return none;
  }

  if (methodName === null) return none;

  // 继续上溯找包围 class（跳过外层 def / 块头 / 续行）
  let className: string | null = null;
  for (let l = methodLine - 1; l >= 1; l--) {
    const t = model.getLineContent(l);
    const trimmed = t.trim();
    if (!trimmed) continue;
    const ti = indentOf(t);
    if (ti >= methodIndent) continue;
    const classM = CLASS_RE.exec(t);
    if (classM) {
      className = classM[1];
      break;
    }
    if (DEF_RE.test(t) || trimmed.startsWith("@") || isContinuation(trimmed) || BLOCK_HEADER_RE.test(trimmed)) {
      continue;
    }
    break;
  }

  return { syntax: "function", className, methodName };
}

const span = (s: FlatSymbol): number => s.endLine - s.startLine;

/**
 * 符号解析（M2 主路径）：在扁平符号集中找包含当前行的最内层 function 与 class。
 * 符号集为空（LSP 未就绪/请求失败）返回 null → 调用方回落启发式。
 */
export function resolveScopeFromSymbols(symbols: FlatSymbol[], line: number): ScopeInfo | null {
  if (symbols.length === 0) return null;
  let fn: FlatSymbol | null = null;
  let cls: FlatSymbol | null = null;
  for (const s of symbols) {
    if (line < s.startLine || line > s.endLine) continue;
    if (s.kind === SYMBOL_KIND_CLASS) {
      if (!cls || span(s) < span(cls)) cls = s;
    } else if (FUNCTION_LIKE_KINDS.has(s.kind)) {
      if (!fn || span(s) < span(fn)) fn = s;
    }
  }
  if (fn) {
    const enclosing = cls && cls.startLine <= fn.startLine && fn.endLine <= cls.endLine ? cls : null;
    return { syntax: "function", className: enclosing?.name ?? null, methodName: fn.name };
  }
  if (cls) return { syntax: "class", className: cls.name, methodName: null };
  return { syntax: "module", className: null, methodName: null };
}

/** 符号优先、启发式兜底（方案 §6.2 双路判定） */
export function resolveScopeWithSymbols(
  model: MonacoApi.editor.ITextModel,
  position: MonacoApi.Position,
  symbols: FlatSymbol[] | null,
): ScopeInfo {
  if (symbols) {
    const fromSymbols = resolveScopeFromSymbols(symbols, position.lineNumber);
    if (fromSymbols) return fromSymbols;
  }
  return resolveScope(model, position);
}

// ---------- 位置轴判定（上下文位置轴修订稿 §3） ----------

/** 缩写词字符集（与 tabExpand 的 ABBR_CHAR_RE 对齐；`.` 让位成员访问） */
const WORD_CHAR_RE = /[A-Za-z0-9_-]/;

/** 定义头前缀：词起点之前紧邻 def/class（或 async def）头 */
const DEF_HEAD_PREFIX_RE = /^\s*(?:async\s+)?(?:def|class)\s+$/;

/** 行末悬挂符：语句显式续行（行连接符 / 左悬挂运算符与标点）。
 * `:` 单独处理（见 isBlockHeaderColon）：块头 `:`（def/class/if/... 或其跨行签名的 `):` / `]:`）
 * 不是续行符——块体首行应是 statement；仅值分隔冒号（字典键值 / 切片）才是续行。 */
const CONT_SUFFIX_RE = /(,|\(|\[|\{|\.|=|\+|-|\*|\/|%|@|<|>|&|\||\^|~)$/;

/** 行末悬挂关键词：二元/一元运算符后需右操作数，或引入子句后需主体 */
const CONT_KEYWORD_RE =
  /\b(and|or|not|in|is|if|elif|else|for|while|return|yield|import|from|as|assert|del|raise|with|lambda|await)\s*$/;

/** 单行块头引入关键字（含 def/class/async def），用于区分「块头 `:`」与「续行 `:`」 */
const BLOCK_HEAD_START_RE =
  /^(?:async\s+)?(?:def|class|if|elif|else|for|while|try|except|finally|with|match|case)\b/;

/** 以 `:` 结尾的上一非空行是否为「块头」：块头的 `:` 引入缩进块体（下一行是 statement 位），
 * 而非续行。覆盖单行块头与跨行签名的闭合行（去掉 `:` 后以 `)` / `]` 结尾，如 `):`）。 */
function isBlockHeaderColon(trimmed: string): boolean {
  if (BLOCK_HEAD_START_RE.test(trimmed)) return true;
  return /[)\]]$/.test(trimmed.slice(0, -1));
}

/**
 * 语法位置判定（纯 model + position，无 Monaco 依赖，可单测）。
 * 以「光标所属缩写词的起点」为界判定前后文，而非光标列本身——
 * 触发补全/展开时光标紧贴缩写词（`if`/`def`/`class` 左侧自然非空白），
 * 语句位应看向「词起点之前」：
 * 1. 定义名位：词起点前是 def/class/async def 头
 * 2. 语句位：词起点到行首仅空白，且上一非空行为完整语句
 * 3. 其余 → 表达式位
 */
export function classifyPosition(
  model: MonacoApi.editor.ITextModel,
  position: MonacoApi.Position,
): PositionKind {
  const line = model.getLineContent(position.lineNumber);
  const col0 = Math.max(0, position.column - 1);

  let wordStart = col0;
  while (wordStart > 0 && WORD_CHAR_RE.test(line[wordStart - 1])) wordStart--;
  const prefix = line.slice(0, wordStart);

  // 1. 定义名位
  if (col0 > wordStart && DEF_HEAD_PREFIX_RE.test(prefix)) return "name";

  // 2. 语句位
  if (prefix.trim() === "" && !continuesPrevious(model, position.lineNumber)) return "statement";

  // 3. 表达式位
  return "expression";
}

/** 上一非空行是否以悬挂符/行连接符结尾（续行 → 当前行不宜作为语句起点） */
function continuesPrevious(model: MonacoApi.editor.ITextModel, lineNumber: number): boolean {
  for (let l = lineNumber - 1; l >= 1; l--) {
    const prev = model.getLineContent(l);
    const trimmed = prev.trim();
    if (!trimmed) continue;
    const te = prev.trimEnd();
    if (te.endsWith("\\")) return true;
    if (CONT_KEYWORD_RE.test(trimmed)) return true;
    if (CONT_SUFFIX_RE.test(te)) return true;
    // `:` 结尾：仅值分隔冒号（非块头）算续行；块头 `:` 的下一行是语句位
    if (te.endsWith(":") && !isBlockHeaderColon(trimmed)) return true;
    return false;
  }
  return false;
}

/** 符号优先、启发式兜底的「容器 + 位置」合并判定 */
export function resolveSyntaxContext(
  model: MonacoApi.editor.ITextModel,
  position: MonacoApi.Position,
  symbols: FlatSymbol[] | null,
): SyntaxContext {
  const base = resolveScopeWithSymbols(model, position, symbols);
  return { ...base, position: classifyPosition(model, position) };
}

export type LexicalEnv = "code" | "string" | "comment";

/**
 * 词法环境判定（单行 tokenize；多行字符串内部为已知局限，方案 §6.2）。
 * 位置落在 comment/string token 内 → 对应环境，否则 code。
 */
export function lexicalEnvAt(
  monaco: Monaco,
  model: MonacoApi.editor.ITextModel,
  position: MonacoApi.Position,
): LexicalEnv {
  const line = model.getLineContent(position.lineNumber);
  let tokens: MonacoApi.Token[];
  try {
    tokens = monaco.editor.tokenize(line, "python")[0] ?? [];
  } catch {
    return "code";
  }
  const col0 = position.column - 1;
  for (let i = 0; i < tokens.length; i++) {
    // 公开 Token 仅含起始 offset，结束 = 下一 token 起点（或行尾）
    const start = tokens[i].offset;
    const end = i + 1 < tokens.length ? tokens[i + 1].offset : line.length;
    if (col0 >= start && col0 < end) {
      if (tokens[i].type.startsWith("comment")) return "comment";
      if (tokens[i].type.startsWith("string")) return "string";
      return "code";
    }
  }
  return "code";
}
