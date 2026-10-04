// 表达式引擎：解析 + 求值（纯 TS，零依赖，可单测）
// 语法：字符串常量（双引号）/ 变量引用 / 函数调用，如 concat(fileName(), " — ", date("yyyy-MM-dd"))

import type { TemplateDef } from "./schema";

export type EvalValue =
  | { kind: "text"; text: string }
  | { kind: "choices"; choices: string[] }
  | { kind: "complete" };

export interface EngineContext {
  fileName: string;
  filePath: string;
  fileRelativePath: string;
  className: string | null;
  methodName: string | null;
  lineNumber: number;
  userName: string;
  /** 剪贴板文本由胶水层异步预取后注入（保持引擎同步纯净） */
  clipboardText: string | null;
  /** 本变量之前（按 variables 数组序）已求值成功的变量值 */
  variableValues: ReadonlyMap<string, string>;
}

// ---------- AST 与解析 ----------

export type Expr =
  | { kind: "str"; value: string }
  | { kind: "ref"; name: string }
  | { kind: "call"; name: string; args: Expr[] };

interface Token {
  type: "str" | "ident" | "lparen" | "rparen" | "comma";
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) throw new Error(`字符串未闭合（位置 ${i}）`);
      tokens.push({ type: "str", value: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === "(") {
      tokens.push({ type: "lparen", value: c });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "rparen", value: c });
      i++;
      continue;
    }
    if (c === ",") {
      tokens.push({ type: "comma", value: c });
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ type: "ident", value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`非法字符 '${c}'（位置 ${i}）`);
  }
  return tokens;
}

/** 解析表达式；语法错误抛 Error */
export function parseExpression(src: string): Expr {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token => {
    const t = tokens[pos++];
    if (!t) throw new Error("表达式意外结束");
    return t;
  };

  function parseExpr(): Expr {
    const t = next();
    if (t.type === "str") return { kind: "str", value: t.value };
    if (t.type !== "ident") throw new Error(`期望标识符或字符串，得到 '${t.value}'`);
    if (peek()?.type === "lparen") {
      next(); // (
      const args: Expr[] = [];
      if (peek()?.type !== "rparen") {
        args.push(parseExpr());
        while (peek()?.type === "comma") {
          next(); // ,
          args.push(parseExpr());
        }
      }
      const close = next();
      if (close.type !== "rparen") throw new Error("期望 ')'");
      return { kind: "call", name: t.value, args };
    }
    return { kind: "ref", name: t.value };
  }

  const expr = parseExpr();
  if (pos < tokens.length) throw new Error(`表达式末尾有多余内容（'${tokens[pos].value}'）`);
  return expr;
}

// ---------- 函数集 ----------

type EngineFn = (args: EvalValue[], ctx: EngineContext) => EvalValue | null;

const text = (s: string): EvalValue => ({ kind: "text", text: s });
const argText = (args: EvalValue[], i: number): string | null =>
  args[i]?.kind === "text" ? args[i].text : null;

/** 按大小写边界 + 非字母数字切词：myTextFile → [my, Text, File]；HTTPServer → [HTTP, Server] */
export function splitWords(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(/[^A-Za-z0-9]+/)) {
    if (!part) continue;
    const words = part.match(/[A-Z]+(?=[A-Z][a-z0-9])|[A-Z]?[a-z0-9]+|[A-Z]+/g);
    if (words) out.push(...words);
  }
  return out;
}

const cap = (w: string): string => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w);

export function toCamelCase(s: string): string {
  const ws = splitWords(s);
  return ws.map((w, i) => (i === 0 ? w.toLowerCase() : cap(w))).join("");
}

export function toSnakeCase(s: string): string {
  return splitWords(s).map((w) => w.toLowerCase()).join("_");
}

export function toKebabCase(s: string): string {
  return splitWords(s).map((w) => w.toLowerCase()).join("-");
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 格式 token 子集：yyyy MM dd HH mm ss EEE */
export function formatDate(d: Date, fmt: string): string {
  return fmt
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/MM/g, pad2(d.getMonth() + 1))
    .replace(/dd/g, pad2(d.getDate()))
    .replace(/HH/g, pad2(d.getHours()))
    .replace(/mm/g, pad2(d.getMinutes()))
    .replace(/ss/g, pad2(d.getSeconds()))
    .replace(/EEE/g, WEEKDAYS[d.getDay()]);
}

const caseFn = (f: (s: string) => string): EngineFn => (args) => {
  const s = argText(args, 0);
  return s === null ? null : text(f(s));
};

/** v1 函数注册表（方案 §7.2）；未知函数求值返回 null → 走 defaultValue */
const FUNCTIONS: Record<string, EngineFn> = {
  // 字符串变换
  camelCase: caseFn(toCamelCase),
  snakeCase: caseFn(toSnakeCase),
  kebabCase: caseFn(toKebabCase),
  capitalize: caseFn((s) => (s ? s[0].toUpperCase() + s.slice(1) : s)),
  decapitalize: caseFn((s) => (s ? s[0].toLowerCase() + s.slice(1) : s)),
  upper: caseFn((s) => s.toUpperCase()),
  lower: caseFn((s) => s.toLowerCase()),
  firstWord: caseFn((s) => s.trim().split(/\s+/)[0] ?? ""),
  spacesToUnderscores: caseFn((s) => s.replace(/ /g, "_")),
  underscoresToCamelCase: caseFn((s) => toCamelCase(s.replace(/_/g, " "))),

  // 文件上下文
  fileName: (_args, ctx) => text(ctx.fileName),
  fileNameWithoutExtension: (_args, ctx) => {
    const i = ctx.fileName.lastIndexOf(".");
    return text(i > 0 ? ctx.fileName.slice(0, i) : ctx.fileName);
  },
  filePath: (_args, ctx) => text(ctx.filePath),
  fileRelativePath: (_args, ctx) => text(ctx.fileRelativePath),

  // 代码上下文（M1 缩进启发式，M2 升级 documentSymbol）
  className: (_args, ctx) => (ctx.className ? text(ctx.className) : null),
  methodName: (_args, ctx) => (ctx.methodName ? text(ctx.methodName) : null),

  // 时间
  date: (args) => text(formatDate(new Date(), argText(args, 0) ?? "yyyy-MM-dd")),
  time: (args) => text(formatDate(new Date(), argText(args, 0) ?? "HH:mm:ss")),

  // 用户 / 环境
  user: (_args, ctx) => (ctx.userName ? text(ctx.userName) : null),
  clipboard: (_args, ctx) => (ctx.clipboardText !== null ? text(ctx.clipboardText) : null),
  lineNumber: (_args, ctx) => text(String(ctx.lineNumber)),

  // 组合 / 枚举 / 补全 / 正则
  concat: (args) => {
    let out = "";
    for (const a of args) {
      if (a.kind !== "text") return null;
      out += a.text;
    }
    return text(out);
  },
  // regularExpression(String, Pattern, Replacement)：全局替换；替换串支持 $1 组引用（M4 增量）
  regularExpression: (args) => {
    const s = argText(args, 0);
    const pattern = argText(args, 1);
    const replacement = argText(args, 2) ?? "";
    if (s === null || pattern === null) return null;
    try {
      return text(s.replace(new RegExp(pattern, "g"), replacement));
    } catch {
      return null;
    }
  },
  enum: (args) => {
    const choices: string[] = [];
    for (const a of args) {
      if (a.kind !== "text") return null;
      choices.push(a.text);
    }
    return choices.length > 0 ? { kind: "choices", choices } : null;
  },
  complete: () => ({ kind: "complete" }),
};

// ---------- 求值 ----------

function evalExpr(expr: Expr, ctx: EngineContext): EvalValue | null {
  switch (expr.kind) {
    case "str":
      return text(expr.value);
    case "ref": {
      const v = ctx.variableValues.get(expr.name);
      return v !== undefined ? text(v) : null;
    }
    case "call": {
      const fn = FUNCTIONS[expr.name];
      if (!fn) return null;
      const args: EvalValue[] = [];
      for (const a of expr.args) {
        const v = evalExpr(a, ctx);
        if (v === null) return null;
        args.push(v);
      }
      return fn(args, ctx);
    }
  }
}

/** 解析 + 求值；任何失败返回 null（调用方走 defaultValue，保证模板总能展开） */
export function evalExpression(src: string, ctx: EngineContext): EvalValue | null {
  try {
    return evalExpr(parseExpression(src), ctx);
  } catch {
    return null;
  }
}

/** 模板是否引用指定函数（供胶水层按需预取剪贴板等异步资源） */
export function templateReferences(tpl: TemplateDef, fnName: string): boolean {
  const re = new RegExp(`\\b${fnName}\\s*\\(`);
  return (tpl.variables ?? []).some((v) => v.expression && re.test(v.expression));
}
