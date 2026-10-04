// JSON 字面量扫描（库特别支持 P1 §7-3）：识别 `json.loads(<字符串字面量>)` 的第一个实参，
// 反转义为 JSON 文本并校验。纯文本/词法扫描，零子进程、零 DOM（对齐 libRegex 先例）。
// v1 口径：只认 `json.loads(…)` 调用点的字符串字面量（变量/拼接不识别，与正则识别器同边界）。

import { t } from "./i18n"; // 第十八批 i18n：库文案走语言包
export interface JsonHit {
  /** 字面量起始偏移（含前缀引号，不含 r 前缀之前的部分） */
  start: number;
  /** 字面量结束偏移（含闭合引号之后） */
  end: number;
  /** 内容首字符偏移（开引号之后） */
  contentStart: number;
  /** 源码字面量全文（含引号） */
  source: string;
  /** 反转义后的 JSON 文本 */
  value: string;
  /** r 前缀（raw 串，内容不经转义还原） */
  raw: boolean;
  /** 三引号字面量（内容可含真实换行，折叠的目标） */
  triple: boolean;
  /** 引号字符（" 或 '） */
  quote: string;
  /** 起始 / 结束行（0 基） */
  startLine: number;
  endLine: number;
}

const LOADS_RE = /\bjson\.loads\s*\(\s*/g;

/** Python 字符串反转义：处理 JSON 场景常见转义；未知转义按 Python 语义保留原样 */
function unescapeContent(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "\\" || i + 1 >= s.length) {
      out += ch;
      continue;
    }
    const n = s[i + 1];
    switch (n) {
      case "n": out += "\n"; i++; break;
      case "t": out += "\t"; i++; break;
      case "r": out += "\r"; i++; break;
      case "b": out += "\b"; i++; break;
      case "f": out += "\f"; i++; break;
      case "\\": out += "\\"; i++; break;
      case "'": out += "'"; i++; break;
      case '"': out += '"'; i++; break;
      case "x": {
        const hex = s.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 3;
        } else out += ch;
        break;
      }
      case "u": {
        const hex = s.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
        } else out += ch;
        break;
      }
      default: out += ch + n; i++; break; // 未知转义：保留 \x 原样（Python 会给 deprecation，但语义如此）
    }
  }
  return out;
}

/** 从 pos 起读一个字符串字面量；f-string / bytes / 非字符串 → null（prefix 含 f/b 跳过） */
function readStringLiteral(text: string, pos: number): {
  start: number; end: number; contentStart: number; content: string;
  raw: boolean; triple: boolean; quote: string;
} | null {
  const m = /^[rRbBuUfF]{0,3}/.exec(text.slice(pos, pos + 3));
  if (!m) return null;
  const prefix = m[0];
  let p = pos + prefix.length;
  const raw = /[rR]/.test(prefix);
  if (/[fFbBuU]/.test(prefix)) return null; // f-string 无法静态取值；bytes 不是 JSON 载体
  const q3 = text.slice(p, p + 3);
  let triple = false;
  let quote: string;
  if (q3 === '"""' || q3 === "'''") {
    triple = true;
    quote = q3[0];
    p += 3;
  } else if (text[p] === '"' || text[p] === "'") {
    quote = text[p];
    p += 1;
  } else {
    return null;
  }
  const contentStart = p;
  let content = "";
  while (p < text.length) {
    const ch = text[p];
    if (!raw && ch === "\\") {
      // 非 raw：转义对整体吞入（防 \" 提前终止）
      content += ch + (text[p + 1] ?? "");
      p += 2;
      continue;
    }
    if (raw && ch === "\\" && text[p + 1] === quote) {
      // raw 串中 \q 引号：不终止，两个字符都保留在源码里
      content += ch + quote;
      p += 2;
      continue;
    }
    if (ch === quote && (!triple || text.slice(p, p + 3) === quote.repeat(3))) {
      const end = triple ? p + 3 : p + 1;
      return { start: pos, end, contentStart, content, raw, triple, quote };
    }
    if (!triple && (ch === "\n" || ch === "\r")) return null; // 单引号串不允许跨行（语法错误域，交由引擎）
    content += ch;
    p++;
  }
  return null; // 未闭合
}

/** 识别文本中所有 json.loads 字符串字面量（按出现顺序） */
export function scanJsonLiterals(text: string): JsonHit[] {
  const hits: JsonHit[] = [];
  LOADS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOADS_RE.exec(text)) !== null) {
    const lit = readStringLiteral(text, m.index + m[0].length);
    if (!lit) continue;
    hits.push({
      start: lit.start,
      end: lit.end,
      contentStart: lit.contentStart,
      source: text.slice(lit.start, lit.end),
      value: lit.raw ? lit.content : unescapeContent(lit.content),
      raw: lit.raw,
      triple: lit.triple,
      quote: lit.quote,
      startLine: 0,
      endLine: 0,
    });
    LOADS_RE.lastIndex = lit.end; // 从字面量之后继续
  }
  // 行号回填（折叠区间用；hit 数量有限，逐 hit 数换行成本可忽略）
  for (const h of hits) {
    h.startLine = lineOf(text, h.start);
    h.endLine = lineOf(text, Math.max(h.start, h.end - 1));
  }
  return hits;
}

function lineOf(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset; i++) if (text[i] === "\n") line++;
  return line;
}

/** JSON 校验：非法时返回 { message, pos }（pos = value 内错误位置，尽力解析）；合法返回 null */
export function jsonParseError(value: string): { message: string; pos: number } | null {
  try {
    JSON.parse(value);
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const m = /position (\d+)/.exec(msg);
    return { message: msg, pos: m ? parseInt(m[1], 10) : 0 };
  }
}

/** JSON 摘要 hover（research §11.6）：`object · 14 键 · 3 层` / `array · 128 项` / 标量给类型。
 *  解析失败返回 null（错误由静态诊断呈现，hover 不重复报错）。 */
export function jsonHoverSummary(value: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(value);
  } catch {
    return null;
  }
  // 嵌套深度：根为 0 层，每进一层 +1；空容器（{} / []）算 1 层
  const depth = (x: unknown, d: number): number => {
    if (x === null || typeof x !== "object") return d;
    const children = Array.isArray(x) ? x : Object.values(x);
    if (children.length === 0) return d + 1;
    return Math.max(...children.map((c) => depth(c, d + 1)));
  };
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return t("devtools.json.hoverObject", { keys: Object.keys(v).length, depth: depth(v, 0) });
  }
  if (Array.isArray(v)) return t("devtools.json.hoverArray", { count: v.length });
  if (v === null) return "**JSON** · null";
  return `**JSON** · ${typeof v}`;
}

/** 把解析后的 JSON 值重新编码为 Python 字符串字面量（保持原引号形态）。
 *  单行形态：JSON.stringify 整体再剥壳——\n / \" 等转义天然兼容 Python 字符串语法；
 *  JSON.stringify 不转义 '，单引号形态须补 \'，否则内容会截断字面量。
 *  三引号形态：保留真实换行（格式化可读性）。 */
export function pythonLiteralFor(value: unknown, quote: string, triple: boolean, indent: number): string {
  const formatted = JSON.stringify(value, null, indent > 0 ? indent : undefined) ?? "null";
  if (triple) return `${quote.repeat(3)}${formatted}${quote.repeat(3)}`;
  const content = JSON.stringify(formatted).slice(1, -1);
  return `${quote}${quote === "'" ? content.replace(/'/g, "\\'") : content}${quote}`;
}
