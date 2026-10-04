// re 三件套纯函数层（库特别支持 PR-2，docs/python_library_support_dev_plan.md §4.1）。
// i18n（第十八批）：诊断 / token 解释 / hover 文案在调用点取词；FLAG_DEFS 表随语言重建。

import { onLocaleChange, t } from "./i18n";
// 职责：识别 Python 源码中的正则字面量（re.<api> 首个字符串实参 + 同文件简单赋值）、
// 解析 flags、逐 token 人话解释、纯静态诊断。**零子进程、离线可用**（对齐 fs_cmds::scan_endpoints 先例）。
// 已知边界（§4.4）：多行拼接 / 变量引用（仅识别「赋值后又被 re 调用引用」的最简形态）、
// import re as r 别名不识别；re.X 下离线解释与真实语义有偏差（真值以测试器面板为准）。

// ---------- 类型 ----------

/** re.<api> 白名单（§4.1） */
export const RE_APIS = [
  "compile",
  "match",
  "search",
  "fullmatch",
  "findall",
  "finditer",
  "sub",
  "subn",
  "split",
] as const;

export interface RegexHit {
  /** null = 简单赋值形态（pattern = r"…" 且该变量被 re 调用引用） */
  api: string | null;
  /** 模式的 Python 字符串值（非 raw 串已反转义） */
  pattern: string;
  /** 源码字面量内容（含转义序列；raw 串与 pattern 相同） */
  source: string;
  isRaw: boolean;
  /** 短名 flags（I/M/S/X/A/U/L） */
  flags: string[];
  /** 字面量起始偏移（含 r 前缀与引号；lens/装饰/hover 的定位依据） */
  start: number;
  /** 字面量结束偏移（exclusive） */
  end: number;
  /** 首个内容字符的偏移（诊断 pos → 文档偏移） */
  contentStart: number;
  /** 0-based；CodeLens 挂载行（re 调用 / 赋值所在行） */
  callLine: number;
}

export interface RegexDiag {
  severity: "warning" | "error";
  message: string;
  /** 在 pattern 字符串值内的位置（caret 定位用） */
  pos: number;
  length: number;
}

export type PatternTokenKind =
  | "group"
  | "named"
  | "noncap"
  | "look"
  | "ref"
  | "quant"
  | "class"
  | "anchor"
  | "escape"
  | "any"
  | "alt"
  | "char";

export interface PatternToken {
  text: string;
  desc: string;
  kind: PatternTokenKind;
}

// ---------- flags ----------

export const FLAG_SHORT_TO_VALUE: Record<string, number> = {
  I: 2,
  M: 8,
  S: 16,
  X: 64,
  A: 256,
  U: 32,
  L: 4,
};

const FLAG_LONG_TO_SHORT: Record<string, string> = {
  IGNORECASE: "I",
  MULTILINE: "M",
  DOTALL: "S",
  VERBOSE: "X",
  ASCII: "A",
  UNICODE: "U",
  LOCALE: "L",
};

/** flags 短名 → 位掩码值（py_eval 的 regex_test 需要） */
export function flagsToValue(flags: string[]): number {
  let v = 0;
  for (const f of flags) v |= FLAG_SHORT_TO_VALUE[f] ?? 0;
  return v;
}

/** 位掩码值 → 短名列表（稳定顺序 I/M/S/X/A） */
export function valueToFlags(value: number): string[] {
  return ["I", "M", "S", "X", "A"].filter((f) => (value & (FLAG_SHORT_TO_VALUE[f] ?? 0)) !== 0);
}

/**
 * 解析 re 调用实参区中的 flags（§4.1：关键字与位置两种写法 + 空格变体）。
 * 只认 `re.X` / `re.LONG` 形态的 token（`from re import I` 裸名属边界外）。
 */
export function parseFlags(argsText: string): string[] {
  let expr: string | null = null;
  // 关键字写法：depth-0 的 flags=（简化：直接搜 flags\s*=，取到下一个 depth-0 逗号或串尾）
  const kw = /flags\s*=\s*/.exec(argsText);
  if (kw) {
    expr = argsText.slice(kw.index + kw[0].length);
    const cut = topLevelComma(expr);
    if (cut >= 0) expr = expr.slice(0, cut);
  } else {
    // 位置写法：任一 depth-0 实参整体只由 re.X token 与 | 组成
    for (const arg of splitTopLevel(argsText).slice(1)) {
      const stripped = stripComments(arg);
      if (!/re\s*\./.test(stripped)) continue;
      const without = stripped.replace(/\bre\s*\.\s*[A-Za-z_][A-Za-z0-9_]*/g, "");
      if (/^[|\s]*$/.test(without)) {
        expr = stripped;
        break;
      }
    }
  }
  if (expr === null) return [];
  const out: string[] = [];
  for (const m of expr.matchAll(/\bre\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const short = FLAG_LONG_TO_SHORT[m[1]] ?? (FLAG_SHORT_TO_VALUE[m[1]] ? m[1] : null);
    if (short && !out.includes(short)) out.push(short);
  }
  return out;
}

// ---------- 源码扫描 ----------

/** 单文件识别上限（长文件满屏 lens 的闸门，§4.2） */
export const MAX_REGEX_HITS = 200;

const CALL_RE = new RegExp(`\\bre\\s*\\.\\s*(${RE_APIS.join("|")})\\s*\\(`, "g");

interface ParsedLiteral {
  content: string; // 源码内容（引号之间，未反转义）
  isRaw: boolean;
  triple: boolean;
  start: number; // 含前缀（r/b）
  end: number; // exclusive（含闭合引号）
  /** 首个内容字符的偏移（诊断 pos → 文档偏移换算用） */
  contentStart: number;
}

/** 字符串字面量解析结果的公开形状（libFormat 等复用） */
export type PyStringLiteral = ParsedLiteral;

/** 解析 pos 处的字符串字面量（raw 前缀 / 单双引号 / 三引号 / 跨行）；非字面量返回 null */
export function parsePyStringLiteral(text: string, pos: number): PyStringLiteral | null {
  return parseStringLiteral(text, pos);
}

/** 解析 pos 处的字符串字面量（raw 前缀 / 单双引号 / 三引号 / 跨行） */
function parseStringLiteral(text: string, pos: number): ParsedLiteral | null {
  let i = pos;
  let isRaw = false;
  // 前缀：r / b / rb / rb / u（u 无语义）
  for (;;) {
    const c = text[i];
    if ((c === "r" || c === "R") && !isRaw) {
      isRaw = true;
      i++;
    } else if (c === "b" || c === "B" || c === "u" || c === "U") {
      i++;
    } else break;
  }
  const q3 = text.slice(i, i + 3);
  if (q3 === '"""' || q3 === "'''") {
    const end = scanString(text, i + 3, q3, true);
    if (end < 0) return null;
    return { content: text.slice(i + 3, end), isRaw, triple: true, start: pos, end: end + 3, contentStart: i + 3 };
  }
  const q = text[i];
  if (q !== '"' && q !== "'") return null;
  const end = scanString(text, i + 1, q, false);
  if (end < 0) return null;
  return { content: text.slice(i + 1, end), isRaw, triple: false, start: pos, end: end + 1, contentStart: i + 1 };
}

/** 返回闭合引号的下标（未闭合返回 -1）。raw 与非 raw 的反斜杠都不终止字符串（r"\"" 语义）。 */
function scanString(text: string, from: number, quote: string, triple: boolean): number {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      // raw 串的反斜杠同样不终止字符串（r"\"" 语义），跳过转义对
      i += 2;
      continue;
    }
    if (text.startsWith(quote, i)) return i;
    if (!triple && c === "\n") return -1; // 单引号串不跨行
    i++;
  }
  return -1;
}

/** 匹配 openIdx 处 '(' 的闭合下标（跳过字符串与注释；未找到返回 null） */
function findMatchingParen(text: string, openIdx: number): number | null {
  let depth = 1; // 调用自身的 '(' 已入栈
  let i = openIdx + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "#") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) return null;
      i = nl + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const lit = parseStringLiteral(text, i);
      if (!lit) return null;
      i = lit.end;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return null;
    }
    i++;
  }
  return null;
}

/** 代码掩码：1 = 注释或字符串字面量内（CALL_RE / 赋值扫描只认代码区，防文档与注释误报） */
export function buildCodeMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "#") {
      const nl = text.indexOf("\n", i);
      const end = nl < 0 ? text.length : nl + 1;
      mask.fill(1, i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const lit = parseStringLiteral(text, i);
      if (!lit) {
        i++;
        continue;
      }
      mask.fill(1, i, lit.end);
      i = lit.end;
      continue;
    }
    i++;
  }
  return mask;
}

/** 跳过空白（可选跳过注释），解析紧随其后的字符串字面量；无则返回 null（可能是变量实参） */
function parseFirstArg(text: string, pos: number, skipComments = true): ParsedLiteral | null {
  let i = pos;
  for (;;) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if (skipComments && c === "#") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) return null;
      i = nl + 1;
    } else break;
  }
  return parseStringLiteral(text, i);
}

/** depth-0 逗号切分（跳过字符串/注释/嵌套） */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const lit = parseStringLiteral(s, i);
      if (!lit) break;
      i = lit.end;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(last, i));
      last = i + 1;
    }
    i++;
  }
  parts.push(s.slice(last));
  return parts;
}

/** 首个 depth-0 逗号位置（无则 -1） */
function topLevelComma(s: string): number {
  const parts = splitTopLevel(s);
  if (parts.length < 2) return -1;
  return parts[0].length;
}

function stripComments(s: string): string {
  return s.replace(/#[^\n]*/g, "");
}

/** flags 实参区 = 跳过第一个实参后的剩余部分（含首逗号后内容） */
function argsAfterFirst(text: string, openIdx: number, closeIdx: number | null, litEnd: number): string {
  if (closeIdx === null) return "";
  const inner = text.slice(Math.max(openIdx + 1, litEnd), closeIdx);
  const cut = topLevelComma(inner);
  return cut >= 0 ? inner.slice(cut + 1) : "";
}

/** offset → { line, col }（均 0-based；col 按 UTF-16 code unit，Monaco 列 = col + 1） */
export function offsetToPosition(text: string, offset: number): { line: number; col: number } {
  let line = 0;
  let lastNl = -1;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNl = i;
    }
  }
  return { line, col: offset - lastNl - 1 };
}

/**
 * 识别 Python 源码中的正则字面量（§4.1）：
 * 1) `re.<api>(<首个字符串实参>, …)` —— flags 从其余实参解析；
 * 2) 简单赋值 `name = r"…"`（仅当 name 被 re 调用作为首参引用）。
 * 纯文本/词法扫描；超 MAX_REGEX_HITS 截断。
 */
export function scanRegexLiterals(text: string): RegexHit[] {
  const hits: RegexHit[] = [];
  const usedVars = new Set<string>();
  const mask = buildCodeMask(text);

  // pass 1a：收集「re 调用的变量首参」（供赋值形态反查）
  for (const m of text.matchAll(CALL_RE)) {
    if (mask[m.index] === 1) continue;
    const openIdx = m.index + m[0].length - 1;
    let i = openIdx + 1;
    while (/\s/.test(text[i] ?? "")) i++;
    const idMatch = /^[A-Za-z_]\w*/.exec(text.slice(i));
    if (!idMatch) continue;
    // 必须是完整实参（后随 depth-0 逗号或闭括号），排除 f(x.part) 之类的误收
    const after = i + idMatch[0].length;
    const rest = text.slice(after, after + 4);
    if (/^\s*[,)\]]/.test(rest)) usedVars.add(idMatch[0]);
  }

  const push = (api: string | null, lit: ParsedLiteral, callOffset: number, argsTail: string): void => {
    if (hits.length >= MAX_REGEX_HITS) return;
    hits.push({
      api,
      pattern: lit.isRaw ? lit.content : unescapePythonString(lit.content),
      source: lit.content,
      isRaw: lit.isRaw,
      flags: parseFlags(argsTail),
      start: lit.start,
      end: lit.end,
      contentStart: lit.contentStart,
      callLine: offsetToPosition(text, callOffset).line,
    });
  };

  // pass 1b：re.<api>(<字面量>, …)
  for (const m of text.matchAll(CALL_RE)) {
    if (hits.length >= MAX_REGEX_HITS) break;
    if (mask[m.index] === 1) continue;
    const api = m[1];
    const openIdx = m.index + m[0].length - 1;
    const lit = parseFirstArg(text, openIdx + 1);
    if (!lit) continue;
    const closeIdx = findMatchingParen(text, openIdx);
    const tail = argsAfterFirst(text, openIdx, closeIdx, lit.end);
    push(api, lit, m.index, tail);
  }

  // pass 2：简单赋值 name = r"…"（name 须被 pass 1a 收集；行尾只允许空白，不跨注释续接）
  const lineRe = /^[ \t]*([A-Za-z_]\w*)[ \t]*=/gm;
  for (const m of text.matchAll(lineRe)) {
    if (hits.length >= MAX_REGEX_HITS) break;
    if (mask[m.index] === 1) continue;
    if (!usedVars.has(m[1])) continue;
    const lit = parseFirstArg(text, (m.index ?? 0) + m[0].length, false);
    if (!lit) continue;
    // 行尾只允许空白（多行拼接/续行属边界外；注释尾允许——字面量已解析完）
    const lineEnd = text.indexOf("\n", lit.end);
    const rest = text.slice(lit.end, lineEnd < 0 ? text.length : lineEnd);
    if (!/^\s*(#.*)?$/.test(rest)) continue;
    push(null, lit, m.index ?? 0, "");
  }

  return hits;
}

// ---------- Python 字符串反转义（非 raw 串的字符串值还原） ----------

/** 非 raw 串源码 → Python 字符串值（未知转义保留反斜杠原样，对齐 CPython 語义） */
export function unescapePythonString(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    const n = src[i + 1];
    if (n === undefined) {
      out += "\\";
      break;
    }
    i += 2;
    switch (n) {
      case "\\":
        out += "\\";
        break;
      case "'":
        out += "'";
        break;
      case '"':
        out += '"';
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "v":
        out += "\v";
        break;
      case "a":
        out += "\a";
        break;
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7": {
        // 八进制转义（\N 1-3 位；N 本位已消费）
        let oct = n;
        while (oct.length < 3 && src[i] >= "0" && src[i] <= "7") oct += src[i++];
        out += String.fromCharCode(parseInt(oct, 8));
        break;
      }
      case "x": {
        const hex = src.slice(i, i + 2);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 2;
        } else out += "\\x";
        break;
      }
      case "u": {
        const hex = src.slice(i, i + 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else out += "\\u";
        break;
      }
      case "\n":
        break; // 行续接
      default:
        out += "\\" + n; // 未知转义：CPython 保留原样（DeprecationWarning）
        break;
    }
  }
  return out;
}

// ---------- 静态诊断（§4.2：括号闭合 / 区间倒置 / 重复命名组 / 非 raw 转义丢失） ----------

const RISKY_ESCAPES = "dDwWsSbBfnrtva";

/**
 * 纯静态检查（不发子进程）。pattern 值内的位置用于 caret 定位。
 * @param source 字面量源码内容（引号之间）
 * @param isRaw 是否 raw 串
 */
export function staticDiagnostics(source: string, isRaw: boolean): RegexDiag[] {
  const diags: RegexDiag[] = [];
  const pattern = isRaw ? source : unescapePythonString(source);

  // 1. 括号 / 字符类闭合 + [z-a] 区间倒置（一遍扫描）
  const stack: Array<{ c: string; pos: number }> = [];
  let inClass = false;
  let classStart = 0;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") {
        inClass = false;
      } else if (c === "-" && i > classStart + 1 && pattern[i + 1] !== "]" && pattern[i + 1] !== undefined) {
        const lo = pattern[i - 1];
        const hi = pattern[i + 1];
        if (lo !== "\\" && lo !== "[" && lo !== "^" && hi !== "\\" && hi !== "]" && lo.codePointAt(0)! > hi.codePointAt(0)!) {
          diags.push({
            severity: "error",
            message: t("devtools.rx.intervalInvert", { lo: lo, hi: hi }),
            pos: i - 1,
            length: 3,
          });
        }
      }
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      classStart = i;
      i++;
      continue;
    }
    if (c === "(") {
      stack.push({ c, pos: i });
    } else if (c === ")") {
      if (stack.length === 0) {
        diags.push({ severity: "error", message: t("devtools.rx.extraCloseParen"), pos: i, length: 1 });
      } else {
        stack.pop();
      }
    }
    i++;
  }
  if (inClass) {
    diags.push({ severity: "error", message: t("devtools.rx.classUnclosed"), pos: classStart, length: 1 });
  }
  for (const open of stack) {
    diags.push({ severity: "error", message: t("devtools.rx.parenUnclosed"), pos: open.pos, length: 1 });
  }

  // 2. 重复命名组（Python re 直接抛 re.error）
  const names = new Map<string, number>();
  for (const m of pattern.matchAll(/\(\?P<([A-Za-z_]\w*)>/g)) {
    const prev = names.get(m[1]);
    if (prev !== undefined) {
      diags.push({
        severity: "error",
        message: t("devtools.rx.dupNamedGroup", { name: m[1], pos: prev }),
        pos: m.index ?? 0,
        length: m[0].length,
      });
    } else {
      names.set(m[1], m.index ?? 0);
    }
  }

  // 3. 非 raw 串的转义丢失（warning：\b 变退格、\d\w\s 依赖 CPython 的容错保留）
  if (!isRaw) {
    for (let k = 0; k < source.length - 1; k++) {
      if (source[k] !== "\\") continue;
      const n = source[k + 1];
      if (n && RISKY_ESCAPES.includes(n)) {
        const detail = "bBfnrtva".includes(n)
          ? t("devtools.rx.ctrlChar")
          : t("devtools.rx.fallbackKept");
        diags.push({
          severity: "warning",
          message: t("devtools.rx.nonRawWarn", { n: n, detail: detail }),
          pos: k,
          length: 2,
        });
      }
      k++; // 跳过被转义字符
    }
  }

  return diags;
}

// ---------- 逐 token 解释（离线，§4.1 / §11.3.4 hover 卡） ----------

/** 逐 token 切分正则（人话解释；re.X 下忽略裸空白与 # 注释） */
export function tokenizePattern(pattern: string, flags: string[] = []): PatternToken[] {
  const verbose = flags.includes("X");
  const multiline = flags.includes("M");
  const dotall = flags.includes("S");
  const tokens: PatternToken[] = [];
  let i = 0;
  let unnamed = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (verbose && (c === " " || c === "\t" || c === "\n" || c === "\r")) {
      i++;
      continue;
    }
    if (verbose && c === "#") {
      const end = pattern.indexOf("\n", i);
      i = end < 0 ? pattern.length : end + 1;
      continue;
    }
    if (c === "\\") {
      const n = pattern[i + 1];
      if (n === undefined) {
        tokens.push({ text: "\\", desc: t("devtools.rx.danglingBackslash"), kind: "escape" });
        break;
      }
      if (/[0-9]/.test(n)) {
        tokens.push({ text: pattern.slice(i, i + 2), desc: t("devtools.rx.backrefN", { n: n }), kind: "ref" });
        i += 2;
        continue;
      }
      if (n === "g") {
        const m = /^\\g(<\w+>|\d+)/.exec(pattern.slice(i));
        const tok = m ? m[0] : "\\g"; // 命名避开 t（i18n 取词函数，踩坑 ⑤）
        tokens.push({ text: tok, desc: t("devtools.rx.backref"), kind: "ref" });
        i += tok.length;
        continue;
      }
      if (n === "A") {
        tokens.push({ text: "\\A", desc: t("devtools.rx.anchorStart"), kind: "anchor" });
        i += 2;
        continue;
      }
      if (n === "Z") {
        tokens.push({ text: "\\Z", desc: t("devtools.rx.anchorEnd"), kind: "anchor" });
        i += 2;
        continue;
      }
      if (n === "b") {
        tokens.push({ text: "\\b", desc: t("devtools.rx.wordBoundary"), kind: "anchor" });
        i += 2;
        continue;
      }
      if (n === "B") {
        tokens.push({ text: "\\B", desc: t("devtools.rx.notWordBoundary"), kind: "anchor" });
        i += 2;
        continue;
      }
      if (n === "d" || n === "D") {
        tokens.push({ text: pattern.slice(i, i + 2), desc: n === "d" ? t("devtools.rx.digitClass") : t("devtools.rx.notDigitClass"), kind: "class" });
        i += 2;
        continue;
      }
      if (n === "w" || n === "W" || n === "s" || n === "S") {
        const desc: Record<string, string> = { w: t("devtools.rx.wordChars"), W: t("devtools.rx.notWordChars"), s: t("devtools.rx.spaceChars"), S: t("devtools.rx.notSpaceChars") };
        tokens.push({ text: pattern.slice(i, i + 2), desc: desc[n]!, kind: "class" });
        i += 2;
        continue;
      }
      tokens.push({ text: pattern.slice(i, i + 2), desc: t("devtools.rx.escapeChar", { ch: n }), kind: "escape" });
      i += 2;
      continue;
    }
    if (c === "(") {
      if (pattern.startsWith("(?P<", i)) {
        const end = pattern.indexOf(">", i);
        const name = end > 0 ? pattern.slice(i + 4, end) : "?";
        tokens.push({ text: pattern.slice(i, (end < 0 ? pattern.length : end) + 1), desc: t("devtools.rx.namedGroup", { name: name, ref: name }), kind: "named" });
        unnamed++;
        i = (end < 0 ? pattern.length : end) + 1;
        continue;
      }
      if (pattern.startsWith("(?P=", i)) {
        const end = pattern.indexOf(")", i);
        tokens.push({ text: pattern.slice(i, (end < 0 ? pattern.length : end) + 1), desc: t("devtools.rx.namedBackref"), kind: "ref" });
        i = (end < 0 ? pattern.length : end) + 1;
        continue;
      }
      if (pattern.startsWith("(?:", i)) {
        tokens.push({ text: "(?:", desc: t("devtools.rx.noncapGroup"), kind: "noncap" });
        i += 3;
        continue;
      }
      if (pattern.startsWith("(?=", i) || pattern.startsWith("(?!", i)) {
        tokens.push({ text: pattern.slice(i, i + 3), desc: t("devtools.rx.lookahead"), kind: "look" });
        i += 3;
        continue;
      }
      if (pattern.startsWith("(?<=", i) || pattern.startsWith("(?<!", i)) {
        tokens.push({ text: pattern.slice(i, i + 4), desc: t("devtools.rx.lookbehind"), kind: "look" });
        i += 4;
        continue;
      }
      unnamed++;
      tokens.push({ text: "(", desc: t("devtools.rx.groupStart", { n: unnamed }), kind: "group" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ text: ")", desc: t("devtools.rx.groupEnd"), kind: "group" });
      i++;
      continue;
    }
    if (c === "[") {
      // 字符类：扫描到未转义 ]（首字符 ] 视为字面量）
      let j = i + 1;
      if (pattern[j] === "^") j++;
      if (pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") {
        if (pattern[j] === "\\") j++;
        j++;
      }
      const end = j < pattern.length ? j + 1 : pattern.length;
      tokens.push({ text: pattern.slice(i, end), desc: t("devtools.rx.charClass"), kind: "class" });
      i = end;
      continue;
    }
    if (c === "*" || c === "+" || c === "?" || c === "{") {
      if (c === "{") {
        const m = /^\{(\d*)(,?)(\d*)\}/.exec(pattern.slice(i));
        if (!m) {
          tokens.push({ text: "{", desc: t("devtools.lib.literalLBrace"), kind: "char" });
          i++;
          continue;
        }
        const lazy = pattern[i + m[0].length] === "?";
        // 嵌套模板手工拆段取词（第十八批踩坑 ⑥：嵌套反引号不走 apply_ts 映射）
        const rep = m[2]
          ? t("devtools.rx.quantRange", { from: m[1] || "0", to: m[3] || "∞" })
          : t("devtools.rx.quantExact", { n: m[1] || "0" });
        tokens.push({ text: pattern.slice(i, i + m[0].length + (lazy ? 1 : 0)), desc: `${rep}${lazy ? t("devtools.rx.quantLazy") : t("devtools.rx.quantGreedy")}`, kind: "quant" });
        i += m[0].length + (lazy ? 1 : 0);
        continue;
      }
      const lazy = pattern[i + 1] === "?";
      const name = c === "*" ? t("devtools.rx.quant0") : c === "+" ? t("devtools.rx.quant1") : t("devtools.rx.quant01");
      tokens.push({ text: pattern.slice(i, i + (lazy ? 2 : 1)), desc: `${name}${lazy ? t("devtools.rx.quantLazy") : t("devtools.rx.quantGreedy")}`, kind: "quant" });
      i += lazy ? 2 : 1;
      continue;
    }
    if (c === "^") {
      tokens.push({ text: "^", desc: multiline ? t("devtools.rx.anchorLineStart") : t("devtools.rx.anchorStart"), kind: "anchor" });
      i++;
      continue;
    }
    if (c === "$") {
      tokens.push({ text: "$", desc: multiline ? t("devtools.rx.anchorLineEnd") : t("devtools.rx.anchorEnd"), kind: "anchor" });
      i++;
      continue;
    }
    if (c === ".") {
      tokens.push({ text: ".", desc: dotall ? t("devtools.rx.anyDotall") : t("devtools.rx.anyNoNl"), kind: "any" });
      i++;
      continue;
    }
    if (c === "|") {
      tokens.push({ text: "|", desc: t("devtools.rx.alt"), kind: "alt" });
      i++;
      continue;
    }
    // 普通字符（含连续字面量合并）
    let j = i;
    while (j < pattern.length && !"\\()[]{}*+?^$.|".includes(pattern[j]!)) j++;
    if (j === i) j++;
    tokens.push({ text: pattern.slice(i, j), desc: t("devtools.lib.literal"), kind: "char" });
    i = j;
  }
  return tokens;
}

/** hover 卡 markdown（§11.3.4：首行摘要 → 逐 token 解释 → 底行入口提示） */
export function regexHoverMarkdown(hit: { api: string | null; pattern: string; flags: string[]; isRaw: boolean }): string {
  // 嵌套模板手工拆段取词（第十八批踩坑 ⑥）：api/flags 后缀保持 markdown 形态，词条只管「Python 正则…**」框架
  const head = t("devtools.rx.hoverHead", {
    api: hit.api ? ` · re.${hit.api}` : "",
    flags: hit.flags.length ? ` · flags: ${hit.flags.join(", ")}` : "",
  });
  const tokens = tokenizePattern(hit.pattern, hit.flags).slice(0, 24);
  const lines = tokens.map((t) => `\`${escapeMarkdownCode(t.text)}\` — ${t.desc}`);
  if (tokens.length >= 24) lines.push(t("devtools.rx.truncated24"));
  if (!hit.isRaw) lines.push(t("devtools.rx.nonRawHint"));
  lines.push("---");
  lines.push(t("devtools.rx.openTester"));
  return [head, ...lines].join("\n\n");
}

function escapeMarkdownCode(s: string): string {
  return s.replace(/`/g, "\\`").replace(/\n/g, "\\n");
}

/** 供面板「复制为 Python 代码」：re.compile(r"…", re.I | re.M)。
 *  raw 串内反斜杠保持字面（不转义）；模式含分隔引号时换引号；含两种引号 / 换行 / 尾反斜杠时退化为非 raw。 */
export function formatRegexPython(pattern: string, flags: string[]): string {
  const flagsArg = flags.filter((f) => f !== "U" && f !== "L").map((f) => `re.${longFlagName(f)}`);
  const suffix = flagsArg.length ? `, ${flagsArg.join(" | ")}` : "";
  const rawSafe = !pattern.includes('"') && !/\\$/.test(pattern) && !/[\n\r]/.test(pattern);
  if (rawSafe) return `re.compile(r"${pattern}"${suffix})`;
  if (!pattern.includes("'") && !/\\$/.test(pattern) && !/[\n\r]/.test(pattern)) return `re.compile(r'${pattern}'${suffix})`;
  // 退化为非 raw：值等价由转义保证
  const body = pattern
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `re.compile("${body}"${suffix})`;
}

function longFlagName(short: string): string {
  const LONG: Record<string, string> = { I: "IGNORECASE", M: "MULTILINE", S: "DOTALL", X: "VERBOSE", A: "ASCII" };
  return LONG[short] ?? short;
}

// ---------- flags 速查（面板 chip 用） ----------

// i18n（第十八批）：desc 是展示文案——构建函数 + let + onLocaleChange 重建（对齐 libFormat 码表模式）
function buildFlagDefs(): Array<{ key: string; desc: string }> {
  return [
  { key: "I", desc: t("devtools.rx.flagI") },
  { key: "M", desc: t("devtools.rx.flagM") },
  { key: "S", desc: t("devtools.rx.flagS") },
  { key: "X", desc: t("devtools.rx.flagX") },
  { key: "A", desc: t("devtools.rx.flagA") },
  ];
}

export let FLAG_DEFS: Array<{ key: string; desc: string }> = buildFlagDefs();

onLocaleChange(() => {
  FLAG_DEFS = buildFlagDefs();
});
