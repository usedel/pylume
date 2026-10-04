// v1.1 工具备选的纯函数库（plugin_system_design §9.7 备选清单 · 2026-09-30 批次）：
// 进制转换 / HTML 实体 / Unicode⇄中文 / 大小写 / 字数统计 / 排序去重 / 颜色转换 / 密码生成 / 文本 Diff。
// 全部零 DOM 依赖；数值与字符串边界行为由 __tests__/textfns.test.ts 钉死。

import { t } from "../../i18n";
// ---------- 进制转换 ----------

/** 解析进制输入：支持 0x/0X 前缀十六进制、0b/0B 二进制、0o/0O 八进制、十进制与可选下划线分隔；
 *  一律返回 BigInt（消除 Number 精度问题）；非法返回 null。 */
export function parseRadixInput(raw: string): bigint | null {
  const t = raw.trim().replace(/_/g, "");
  if (!t) return null;
  if (!/^(0x[0-9a-f]+|0b[01]+|0o[0-7]+|[+-]?\d+)$/i.test(t)) return null;
  try {
    return BigInt(t);
  } catch {
    return null;
  }
}

/** BigInt → 目标进制字符串（小写；负数带 -；无前缀——前缀显示由 UI 决定） */
export function bigIntToRadix(n: bigint, radix: 2 | 8 | 10 | 16): string {
  return n.toString(radix);
}

/** 进制面板的「智能识别」：输入任意进制形式 → 输出四种进制表示 */
export function radixAllFormats(raw: string): { bin: string; oct: string; dec: string; hex: string } | null {
  const n = parseRadixInput(raw);
  if (n === null) return null;
  return { bin: n.toString(2), oct: n.toString(8), dec: n.toString(10), hex: n.toString(16) };
}

/** inline：选区数字 → 十六进制（保留 0x 前缀；非法输入抛错保留原文） */
export function selectionToHex(text: string): string {
  const n = parseRadixInput(text);
  if (n === null) throw new Error(t("devtools.textfns.badNumber"));
  return `0x${n.toString(16)}`;
}

// ---------- HTML 实体 ----------

/** 需转义的 5 个字符（HTML 规范命名实体；其余直接 charCodeAt → &#n;） */
const NAMED_ENTITIES: Record<string, string> = { "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "apos" };

/** HTML 实体编码（命名实体优先，其余非 ASCII → &#n;） */
export function htmlEncode(text: string): string {
  let out = "";
  for (const ch of text) {
    if (NAMED_ENTITIES[ch]) out += `&${NAMED_ENTITIES[ch]};`;
    else if (ch.codePointAt(0)! > 127) out += `&#${ch.codePointAt(0)};`;
    else out += ch;
  }
  return out;
}

/** HTML 实体解码（支持命名五实体 + 数字 &#n; / &#xh;；未知实体原样保留） */
export function htmlDecode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-f]+);/gi, (full, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#x")) {
      const cp = parseInt(name.slice(2), 16);
      return safeCp(cp, full);
    }
    if (lower.startsWith("#")) {
      const cp = parseInt(name.slice(1), 10);
      return safeCp(cp, full);
    }
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[lower];
    return named ?? full;
  });
}

/** 数字实体 → 字符（代理区/超平面非法值返回原文，防 String.fromCharCode 乱码） */
function safeCp(cp: number, fallback: string): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return fallback;
  return String.fromCodePoint(cp);
}

// ---------- Unicode ⇄ 中文 ----------

/** 明文 → \uXXXX 转义（BMP 内 \uXXXX；BMP 外先拆代理对再各自 \u；与 Python repr 的默认形态一致） */
export function unicodeEscape(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0xffff) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else {
      const h = Math.floor((cp - 0x10000) / 0x400) + 0xd800;
      const l = ((cp - 0x10000) % 0x400) + 0xdc00;
      out += `\\u${h.toString(16).padStart(4, "0")}\\u${l.toString(16).padStart(4, "0")}`;
    }
  }
  return out;
}

/** Unicode 转义串 → 明文；支持 \uXXXX（含代理对自动合并）、\UXXXXXXXX、\u{...}；
 *  非法序列原样保留。代理对分支用字符类锁定高位/低位区段（防止普通 BMP 连写被误吞）。 */
export function unicodeUnescape(text: string): string {
  return text.replace(
    /\\u(d[89ab][0-9a-f]{2})\\u(d[cdef][0-9a-f]{2})|\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})|\\U([0-9a-f]{8})/gi,
    (full, hi?: string, lo?: string, brace?: string, u4?: string, u8?: string) => {
      if (hi !== undefined && lo !== undefined) {
        const h = parseInt(hi, 16), l = parseInt(lo, 16);
        return String.fromCodePoint((h - 0xd800) * 0x400 + (l - 0xdc00) + 0x10000);
      }
      const hex = brace ?? u4 ?? u8;
      if (hex === undefined) return full;
      return safeCp(parseInt(hex, 16), full);
    },
  );
}

// ---------- 大小写 ----------

export type CaseMode = "upper" | "lower" | "title" | "snake" | "camel";

/** 大小写变换（title：每词首字母大写；snake：空格/连字符 → 下划线小写；camel：小驼峰） */
export function transformCase(text: string, mode: CaseMode): string {
  switch (mode) {
    case "upper": return text.toUpperCase();
    case "lower": return text.toLowerCase();
    case "title": return text.toLowerCase().replace(/(^|[\s\-_]\s*)([a-z\u00e0-\u024f])/g, (_m, p1: string, p2: string) => p1 + p2.toUpperCase());
    case "snake": return text.trim().replace(/[\s\-]+/g, "_").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    case "camel": {
      const parts = text.trim().split(/[\s\-_]+/).filter(Boolean);
      if (parts.length === 0) return "";
      return parts[0]!.toLowerCase() + parts.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("");
    }
  }
}

// ---------- 字数统计 ----------

/** 字数统计：字符数（含/不含空白）、词数（Unicode 词边界）、行数、CJK 字数 */
export interface TextStats {
  chars: number;
  charsNoSpace: number;
  words: number;
  cjk: number;
  lines: number;
}

export function textStats(text: string): TextStats {
  const chars = [...text].length;
  const charsNoSpace = [...text.replace(/\s/g, "")].length;
  const words = (text.match(/\p{L}[\p{L}\p{M}\p{N}'’-]*/gu) ?? []).length;
  const cjk = (text.match(/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/gu) ?? []).length;
  const lines = text === "" ? 0 : text.split(/\r\n|\r|\n/).length;
  return { chars, charsNoSpace, words, cjk, lines };
}

// ---------- 排序去重 ----------

export type SortMode = "asc" | "desc" | "shuffle" | "reverse";

/** 行级排序去重（keepDuplicates=false 时去重；空行可选保留；shuffle 用 crypto 随机） */
export function sortLines(text: string, mode: SortMode, opts?: { dedupe?: boolean; keepEmpty?: boolean; caseSensitive?: boolean }): string {
  const dedupe = opts?.dedupe ?? false;
  const keepEmpty = opts?.keepEmpty ?? true;
  const caseSensitive = opts?.caseSensitive ?? true;
  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  let lines = keepEmpty ? rawLines : rawLines.filter((l) => l.trim() !== "");
  const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: caseSensitive ? "variant" : "base" });
  switch (mode) {
    case "asc": lines = [...lines].sort((a, b) => collator.compare(a, b)); break;
    case "desc": lines = [...lines].sort((a, b) => collator.compare(b, a)); break;
    case "reverse": lines = [...lines].reverse(); break;
    case "shuffle": {
      // Fisher-Yates（crypto 随机源）：从高位到低位无偏采样
      for (let i = lines.length - 1; i > 0; i--) {
        const r = secureRandomInt(i + 1);
        [lines[i], lines[r]] = [lines[r]!, lines[i]!];
      }
      break;
    }
  }
  if (dedupe) {
    if (mode === "asc" || mode === "desc") {
      // 已排序：相邻去重即可 O(n)（collator 视作等价的行保留首个）
      lines = lines.filter((l, i) => i === 0 || collator.compare(lines[i - 1]!, l) !== 0);
    } else {
      const seen = new Set<string>();
      lines = lines.filter((l) => {
        const key = caseSensitive ? l : l.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }
  return lines.join("\n");
}

/** crypto 无偏 [0, n) 随机整数（rejection sampling，消除模偏差） */
export function secureRandomInt(n: number): number {
  if (n <= 0 || !Number.isSafeInteger(n)) throw new Error(t("devtools.textfns.badRandom", { n: n }));
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  let v = 0;
  do {
    crypto.getRandomValues(buf);
    v = buf[0]!;
  } while (v >= limit);
  return v % n;
}

// ---------- 颜色转换 ----------

/** 任意颜色串 → [r,g,b]（支持 #rgb #rgba #rrggbb #rrggbbaa；非法返回 null） */
export function parseHexColor(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.toLowerCase();
  const pick = (i: number): number => parseInt(h.slice(i * 2, i * 2 + 2), 16);
  if (h.length === 3) return [parseInt(h[0]! + h[0], 16), parseInt(h[1]! + h[1], 16), parseInt(h[2]! + h[2], 16)];
  if (h.length === 6) return [pick(0), pick(1), pick(2)];
  if (h.length === 8) return [pick(0), pick(1), pick(2)]; // alpha 忽略（RGB 转换场景）
  return null; // 4/5/7 位非法
}

/** RGB → Hex（小写 #rrggbb） */
export function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number): string => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** parseHexColor 的语义别名（颜色面板的「Hex → RGB」方向读起来更直白） */
export const hexToRgbAlias = parseHexColor;

/** RGB → HSL（h: 0-360, s/l: 0-100；四舍五入整数） */
export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) * 60;
    else if (max === gg) h = ((bb - rr) / d + 2) * 60;
    else h = ((rr - gg) / d + 4) * 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** HSL → RGB（h: 0-360, s/l: 0-100） */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const ss = s / 100, ll = l / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = ll - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** RGB → ANSI 256 色号（终端配色调试用；标准 xterm 立方体，与 pygments 同式） */
export function rgbToAnsi256(r: number, g: number, b: number): number {
  // xterm 立方体档位：0(<48) / 1(<115) / 2-5((v-35)/40 整除)。round 会把 255 算成 6（越界）。
  const q = (x: number): number => (x < 48 ? 0 : x < 115 ? 1 : Math.floor((x - 35) / 40));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

// ---------- 密码生成 ----------

/** 密码字符集（明确定义，避免「看似随机实则缺段」的陷阱） */
export const PASSWORD_SETS = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digits: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.<>?/~",
} as const;

export type PasswordOpts = {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  excludeSimilar: boolean; // 排除 il1Lo0O`'"|
};

/** 生成密码（crypto 随机；保证每类选中字符集至少出现 1 次；非法配置抛错） */
export function generatePassword(opts: PasswordOpts): string {
  const sim = /[il1Lo0O`'"|]/g;
  let pool = [
    opts.lower ? PASSWORD_SETS.lower : "",
    opts.upper ? PASSWORD_SETS.upper : "",
    opts.digits ? PASSWORD_SETS.digits : "",
    opts.symbols ? PASSWORD_SETS.symbols : "",
  ]
    .join("")
    .replace(opts.excludeSimilar ? sim : /$/g, "");
  if (!pool) throw new Error(t("devtools.textfns.needCharset"));
  const len = Math.floor(opts.length);
  if (len < 4 || len > 256) throw new Error(t("devtools.textfns.badLength"));
  // 各选中类各保证 1 个（排除相似后可能为空集则跳过该类保证）
  const groups = [opts.lower, opts.upper, opts.digits, opts.symbols].map((on, i) => {
    const set = [PASSWORD_SETS.lower, PASSWORD_SETS.upper, PASSWORD_SETS.digits, PASSWORD_SETS.symbols][i]!
      .replace(opts.excludeSimilar ? sim : /$/g, "");
    return on && set ? set : "";
  });
  const chars: string[] = [];
  const takeFrom = (set: string): void => {
    chars.push(set[secureRandomInt(set.length)]!);
  };
  for (const g of groups) if (g) takeFrom(g);
  while (chars.length < len) takeFrom(pool);
  // Fisher-Yates 打乱（保证位不集中在前 N 位）
  for (let i = chars.length - 1; i > 0; i--) {
    const r = secureRandomInt(i + 1);
    [chars[i], chars[r]] = [chars[r]!, chars[i]!];
  }
  return chars.slice(0, len).join("");
}

// ---------- 文本 Diff ----------

/** LCS 行级 diff：返回标记了 +/-/= 的行序列。
 *  完整 DP 表 + 回溯（O(n·m) 空间换实现清晰；行列积超 2500 万抛错防 UI 卡死）。 */
export interface DiffLine {
  type: "+" | "-" | "=";
  text: string;
}

export function diffLines(a: string, b: string): DiffLine[] {
  const A = a.replace(/\r\n/g, "\n").split("\n");
  const B = b.replace(/\r\n/g, "\n").split("\n");
  const n = A.length, m = B.length;
  if (n * m > 25_000_000) throw new Error(t("devtools.textfns.tooLarge"));
  // dp[x][y] = A[x:] 与 B[y:] 的 LCS 长度（逆序填表）
  const dp: Int32Array[] = [];
  for (let x = 0; x <= n; x++) dp.push(new Int32Array(m + 1));
  for (let x = n - 1; x >= 0; x--) {
    for (let y = m - 1; y >= 0; y--) {
      dp[x]![y] = A[x] === B[y] ? dp[x + 1]![y + 1]! + 1 : Math.max(dp[x + 1]![y]!, dp[x]![y + 1]!);
    }
  }
  // 回溯：相等走对角（=）；否则删除优先于插入（- 优先 +，贴近 unified diff 删除在前的观感）
  const out: DiffLine[] = [];
  let x = 0, y = 0;
  while (x < n && y < m) {
    if (A[x] === B[y]) { out.push({ type: "=", text: A[x]! }); x++; y++; }
    else if (dp[x + 1]![y]! >= dp[x]![y + 1]!) { out.push({ type: "-", text: A[x]! }); x++; }
    else { out.push({ type: "+", text: B[y]! }); y++; }
  }
  while (x < n) { out.push({ type: "-", text: A[x]! }); x++; }
  while (y < m) { out.push({ type: "+", text: B[y]! }); y++; }
  return out;
}

/** Diff 行 → 渲染文本（+ / - / 空格前缀，贴近 unified diff 观感） */
export function formatDiff(lines: DiffLine[]): string {
  return lines.map((l) => (l.type === "+" ? "+ " : l.type === "-" ? "- " : "  ") + l.text).join("\n");
}
