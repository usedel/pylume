// 格式串工具纯函数层（库特别支持 PR-3，docs/python_library_support_dev_plan.md §5）。
// 三类码表（strftime / 格式规范 mini-language / logging %(…)s）+ 分段解释 + 未知码判定。
// 离线可用（分段与码表），预览真值走求值桥 format_preview（不做 JS 近似，口径统一 §5-降级）。

import { buildCodeMask, parsePyStringLiteral, unescapePythonString, type PyStringLiteral } from "./libRegex";
import { onLocaleChange, t } from "./i18n"; // 第十八批 i18n：码表随语言重建（let + 重建，见下）；分段/诊断/hover 文案调用点取词

// ---------- 模式 ----------

export type FormatMode = "strftime" | "format" | "logging";

export interface FormatToken {
  /** 分段文本（格式串值内） */
  text: string;
  /** 位置（格式串值内偏移；点击段 → 模式框内选中） */
  pos: number;
  length: number;
  desc: string;
  /** 未知码（诊断 warning；不臆测意图，只提示常见码） */
  unknown?: boolean;
}

// ---------- 码表 ----------
//
// i18n（第十八批）：码表值是渲染点（分段解释 / chips / hover）读的展示文案——
// 构建函数 + let + onLocaleChange 重建（第七批 ⑧ 模式），读取方经 ES live binding 拿到当前语言值。

/** strftime 指令表（值 = 人话说明） */
function buildStrftimeCodes(): Record<string, string> {
  return {
  Y: t("devtools.fmt.code.Y"),
  y: t("devtools.fmt.code.y"),
  m: t("devtools.fmt.code.m"),
  d: t("devtools.fmt.code.d"),
  H: t("devtools.fmt.code.H"),
  I: t("devtools.fmt.code.I"),
  M: t("devtools.fmt.code.M"),
  S: t("devtools.fmt.code.S"),
  f: t("devtools.fmt.code.f"),
  a: t("devtools.fmt.code.a"),
  A: t("devtools.fmt.code.A"),
  b: t("devtools.fmt.code.b"),
  B: t("devtools.fmt.code.B"),
  p: "AM / PM",
  j: t("devtools.fmt.code.j"),
  U: t("devtools.fmt.code.U"),
  W: t("devtools.fmt.code.W"),
  w: t("devtools.fmt.code.w"),
  u: t("devtools.fmt.code.u"),
  G: t("devtools.fmt.code.G"),
  V: t("devtools.fmt.code.V"),
  z: t("devtools.fmt.code.z"),
  Z: t("devtools.fmt.code.Z"),
  c: t("devtools.fmt.code.c"),
  x: t("devtools.fmt.code.x"),
  X: t("devtools.fmt.code.X"),
  "%": t("devtools.fmt.code.pct"),
  };
}

export let STRFTIME_CODES: Record<string, string> = buildStrftimeCodes();

/** 速查 chips 顺序（按使用频率，%Y %m %d %H %M %S 在前，§11.4） */
export const STRFTIME_CHIP_ORDER = ["Y", "m", "d", "H", "M", "S", "y", "a", "b", "B", "p", "z", "j", "f", "A", "w", "%"];

/** logging 记录字段表 */
function buildLoggingFields(): Record<string, string> {
  return {
  asctime: t("devtools.fmt.field.asctime"),
  levelname: t("devtools.fmt.field.levelname"),
  levelno: t("devtools.fmt.field.levelno"),
  name: t("devtools.fmt.field.name"),
  message: t("devtools.fmt.field.message"),
  module: t("devtools.fmt.field.module"),
  filename: t("devtools.fmt.field.filename"),
  pathname: t("devtools.fmt.field.pathname"),
  lineno: t("devtools.fmt.field.lineno"),
  funcName: t("devtools.fmt.field.funcName"),
  msecs: t("devtools.fmt.field.msecs"),
  thread: t("devtools.fmt.field.thread"),
  threadName: t("devtools.fmt.field.threadName"),
  process: t("devtools.fmt.field.process"),
  processName: t("devtools.fmt.field.processName"),
  created: t("devtools.fmt.field.created"),
  };
}

export let LOGGING_FIELDS: Record<string, string> = buildLoggingFields();

/** logging 速查 chips（按频率，§11.4） */
export const LOGGING_CHIP_ORDER = ["asctime", "levelname", "name", "message", "module", "lineno", "funcName", "pathname"];

/** 格式规范类型字符表 */
function buildFormatTypes(): Record<string, string> {
  return {
  s: t("devtools.fmt.type.s"),
  d: t("devtools.fmt.type.d"),
  b: t("devtools.fmt.type.b"),
  o: t("devtools.fmt.type.o"),
  x: t("devtools.fmt.type.x"),
  X: t("devtools.fmt.type.X"),
  e: t("devtools.fmt.type.e"),
  E: t("devtools.fmt.type.E"),
  f: t("devtools.fmt.type.f"),
  F: t("devtools.fmt.type.F"),
  g: t("devtools.fmt.type.g"),
  G: t("devtools.fmt.type.G"),
  n: t("devtools.fmt.type.n"),
  "%": t("devtools.fmt.type.pct"),
  };
}

let FORMAT_TYPES: Record<string, string> = buildFormatTypes();

// 语言切换：整体重建各码表（本模块的展示文案全部经表读取，无其他模块级取词）
onLocaleChange(() => {
  STRFTIME_CODES = buildStrftimeCodes();
  LOGGING_FIELDS = buildLoggingFields();
  FORMAT_TYPES = buildFormatTypes();
  MODE_LABEL = buildModeLabels();
  SAMPLE_HINT = buildSampleHints();
  COMMON_HINT = buildCommonHints();
});

/** 格式规范速查 chips（按频率） */
export const FORMAT_CHIP_ORDER = [".2f", "d", "s", ">10", "^10", "<10", ",", ".0%", "+.1e", "08.3f"];

// ---------- 分段解释 ----------

/** strftime：%X 指令分段（%% 字面量；未知码 → unknown） */
function tokenizeStrftime(fmt: string): FormatToken[] {
  const tokens: FormatToken[] = [];
  let i = 0;
  let plainStart = 0;
  const flushPlain = (end: number): void => {
    if (end > plainStart) tokens.push({ text: fmt.slice(plainStart, end), pos: plainStart, length: end - plainStart, desc: t("devtools.lib.literal") });
  };
  while (i < fmt.length) {
    if (fmt[i] !== "%") {
      i++;
      continue;
    }
    flushPlain(i);
    const next = fmt[i + 1];
    if (next === undefined) {
      tokens.push({ text: "%", pos: i, length: 1, desc: t("devtools.fmt.danglingPct"), unknown: true });
      i++;
      plainStart = i;
      continue;
    }
    const desc = STRFTIME_CODES[next];
    tokens.push({ text: fmt.slice(i, i + 2), pos: i, length: 2, desc: desc ?? t("devtools.fmt.unknownCode", { code: next }), unknown: desc === undefined });
    i += 2;
    plainStart = i;
  }
  flushPlain(fmt.length);
  return tokens;
}

/** logging：%(field)char 分段（%% 字面量；未知字段 → unknown） */
function tokenizeLogging(fmt: string): FormatToken[] {
  const tokens: FormatToken[] = [];
  const re = /%\((\w+)\)([sdfg])/g;
  let i = 0;
  let plainStart = 0;
  for (const m of fmt.matchAll(re)) {
    const idx = m.index;
    if (idx > plainStart) tokens.push({ text: fmt.slice(plainStart, idx), pos: plainStart, length: idx - plainStart, desc: t("devtools.lib.literal") });
    // 段内混入裸 % 字面量提示
    const field = m[1];
    const desc = LOGGING_FIELDS[field];
    tokens.push({
      text: m[0],
      pos: idx,
      length: m[0].length,
      desc: desc ?? t("devtools.fmt.unknownField", { field: field }),
      unknown: desc === undefined,
    });
    i = idx + m[0].length;
    plainStart = i;
  }
  if (plainStart < fmt.length) tokens.push({ text: fmt.slice(plainStart), pos: plainStart, length: fmt.length - plainStart, desc: t("devtools.lib.literal") });
  return tokens;
}

/**
 * 格式规范分段：模板里的 {field!conv:spec} 逐段展开；
 * spec 语法 [[fill]align][sign][#][0][width][,][.precision][type]，未知 type → unknown。
 * 单独的 spec（无 {}，如面板直接输入 ">10,.2f"）也按 spec 解析。
 */
function tokenizeFormat(fmt: string): FormatToken[] {
  const tokens: FormatToken[] = [];
  const hasBraces = fmt.includes("{");
  let plainStart = 0;
  const flushPlain = (end: number): void => {
    if (end > plainStart) tokens.push({ text: fmt.slice(plainStart, end), pos: plainStart, length: end - plainStart, desc: t("devtools.lib.literal") });
  };
  // 纯 spec 输入（无 {}，如面板直接输入 ">10,.2f"）：整体按 spec 解析
  if (!hasBraces) {
    const parts = parseSpec(fmt);
    tokens.push({
      text: fmt,
      pos: 0,
      length: fmt.length,
      desc: parts.unknownType ? t("devtools.fmt.unknownType", { type: parts.type ?? "" }) : specPartsDesc(parts) || t("devtools.fmt.defaultSpec"),
      unknown: parts.unknownType,
    });
    return tokens;
  }
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i];
    if (c === "{" && fmt[i + 1] === "{") {
      flushPlain(i);
      tokens.push({ text: "{{", pos: i, length: 2, desc: t("devtools.lib.literalLBrace") });
      i += 2;
      plainStart = i;
      continue;
    }
    if (c === "}" && fmt[i + 1] === "}") {
      flushPlain(i);
      tokens.push({ text: "}}", pos: i, length: 2, desc: t("devtools.fmt.literalRBrace") });
      i += 2;
      plainStart = i;
      continue;
    }
    if (c !== "{") {
      i++;
      continue;
    }
    const close = fmt.indexOf("}", i);
    if (close < 0) {
      flushPlain(i);
      tokens.push({ text: fmt.slice(i), pos: i, length: fmt.length - i, desc: t("devtools.fmt.unclosedBrace"), unknown: true });
      return tokens;
    }
    flushPlain(i);
    const field = fmt.slice(i, close + 1);
    const colon = field.indexOf(":");
    const spec = colon >= 0 ? field.slice(colon + 1, field.length - 1) : "";
    const convMatch = /^[^!]*!([rsa])/.exec(field);
    const head: string[] = [];
    const name = colon >= 0 ? field.slice(1, colon) : field.slice(1, field.length - 1);
    if (name) head.push(t("devtools.fmt.fieldLabel", { name: name }));
    if (convMatch) head.push(t("devtools.fmt.conv", { conv: convMatch[1], kind: convMatch[1] === "r" ? "repr" : convMatch[1] === "s" ? "str" : "ascii" }));
    const descParts: string[] = [];
    if (head.length) descParts.push(head.join(" · "));
    if (spec) {
      const parts = parseSpec(spec);
      if (parts.unknownType) {
        tokens.push({ text: field, pos: i, length: field.length, desc: t("devtools.fmt.unknownType", { type: parts.type ?? "" }), unknown: true });
        i = close + 1;
        plainStart = i;
        continue;
      }
      const sub = specPartsDesc(parts);
      if (sub) descParts.push(sub);
    } else if (!name && !convMatch) {
      descParts.push(t("devtools.fmt.autoNumber"));
    }
    tokens.push({ text: field, pos: i, length: field.length, desc: descParts.join(" · ") || t("devtools.fmt.placeholder") });
    i = close + 1;
    plainStart = i;
  }
  flushPlain(fmt.length);
  return tokens;
}

function specPartsDesc(parts: ReturnType<typeof parseSpec>): string {
  const descs: string[] = [];
  if (parts.align) descs.push(t("devtools.fmt.align", { align: parts.align, fill: parts.fill ?? t("devtools.fmt.fillSpace") }));
  if (parts.sign === "+") descs.push(t("devtools.fmt.signPlus"));
  if (parts.alt) descs.push(t("devtools.fmt.altForm"));
  if (parts.zero) descs.push(t("devtools.fmt.zeroPad"));
  if (parts.width) descs.push(t("devtools.fmt.width", { width: parts.width }));
  if (parts.grouping) descs.push(t("devtools.fmt.grouping"));
  if (parts.precision !== null) descs.push(t("devtools.fmt.precision", { prec: parts.precision }));
  if (parts.type) descs.push(FORMAT_TYPES[parts.type] ?? parts.type);
  return descs.join(" · ");
}

interface SpecParts {
  fill?: string;
  align?: string;
  sign?: string;
  alt: boolean;
  zero: boolean;
  width?: string;
  grouping: boolean;
  precision: number | null;
  type?: string;
  unknownType: boolean;
}

/** 解析格式规范语法（Python Format String Mini-Language） */
export function parseSpec(spec: string): SpecParts {
  const out: SpecParts = { alt: false, zero: false, grouping: false, precision: null, unknownType: false };
  let rest = spec;
  // [[fill]align]
  const alignM = /^(.)?([<>^])/.exec(rest);
  if (alignM) {
    if (alignM[1]) out.fill = alignM[1];
    out.align = alignM[2];
    rest = rest.slice(alignM[0].length);
  }
  // sign
  const signM = /^[+\- ]/.exec(rest);
  if (signM) {
    out.sign = signM[0];
    rest = rest.slice(1);
  }
  if (rest.startsWith("#")) {
    out.alt = true;
    rest = rest.slice(1);
  }
  if (rest.startsWith("0")) {
    out.zero = true;
    rest = rest.slice(1);
  }
  const widthM = /^\d+/.exec(rest);
  if (widthM) {
    out.width = widthM[0];
    rest = rest.slice(widthM[0].length);
  }
  if (rest.startsWith(",") || rest.startsWith("_")) {
    out.grouping = true;
    rest = rest.slice(1);
  }
  const precM = /^\.(\d+)?/.exec(rest);
  if (precM) {
    out.precision = precM[1] !== undefined ? Number(precM[1]) : 0;
    rest = rest.slice(precM[0].length);
  }
  if (rest.length > 0) {
    out.type = rest[0];
    if (FORMAT_TYPES[rest[0]!] === undefined && rest[0] !== "%") out.unknownType = true;
  }
  return out;
}

/** 分段解释入口（§5：三类码表 + 分段 + 未知码判定） */
export function segmentFormat(mode: FormatMode, fmt: string): FormatToken[] {
  if (!fmt) return [];
  if (mode === "strftime") return tokenizeStrftime(fmt);
  if (mode === "logging") return tokenizeLogging(fmt);
  return tokenizeFormat(fmt);
}

// ---------- 诊断（未知格式码 warning，§5） ----------

export interface FormatDiag {
  message: string;
  pos: number;
  length: number;
}

/** 未知码 warning（strftime %Q / format {:q} / logging %(nope)s）；不臆测意图 */
export function formatDiagnostics(mode: FormatMode, fmt: string): FormatDiag[] {
  return segmentFormat(mode, fmt)
    .filter((d) => d.unknown) // 参数名避开 t（i18n 取词函数，踩坑 ⑤）
    .map((d) => ({ message: t("devtools.fmt.diagUnknown", { token: d.text, desc: d.desc }), pos: d.pos, length: d.length }));
}

// ---------- 离线示例（§11.4 hover「示例输出」；固定样本，真值以面板求值桥为准） ----------

/** 固定样本：时刻 2026-09-26 14:03:11（周六）· 数字 1234.5678 */
const SAMPLE_NUM = 1234.5678;
const SAMPLE_STR = "1234.5678";
const SAMPLE_INT = 1234;
const WEEK_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
/** logging 固定记录（§11.4：示例值给一条模拟日志记录） */
const LOGGING_SAMPLE: Record<string, string> = {
  asctime: "2026-09-27 10:30:15,123",
  levelname: "INFO",
  levelno: "20",
  name: "app",
  message: "started",
  module: "main",
  filename: "main.py",
  pathname: "/ws/app/main.py",
  lineno: "42",
  funcName: "main",
  msecs: "123",
  thread: "140736",
  threadName: "MainThread",
  process: "8812",
  processName: "MainProcess",
  created: "1780000000.0",
};

/**
 * 离线示例渲染（固定样本）。**不支持的段一律返回 null**（不给示例，I-3：不臆测、不近似冒充真值）：
 * - strftime：%z %Z %c %x %X %U %W %G %V（时区 / locale 依赖）与未知码；
 * - 格式规范：未知类型、`#` 交替形式、g/G/n/c；
 * - logging：未知字段。
 */
export function formatSample(mode: FormatMode, fmt: string): string | null {
  if (!fmt) return null;
  if (mode === "strftime") return strftimeSample(fmt);
  if (mode === "logging") return loggingSample(fmt);
  return specSample(fmt);
}

function strftimeSample(fmt: string): string | null {
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== "%") {
      out += fmt[i];
      continue;
    }
    const c = fmt[i + 1];
    if (c === undefined) return null;
    i++;
    switch (c) {
      case "%": out += "%"; break;
      case "Y": out += "2026"; break;
      case "y": out += "26"; break;
      case "m": out += "09"; break;
      case "d": out += "26"; break;
      case "H": out += "14"; break;
      case "I": out += "02"; break;
      case "M": out += "03"; break;
      case "S": out += "11"; break;
      case "f": out += "000000"; break;
      case "a": out += WEEK_SHORT[6]; break;
      case "A": out += WEEK_FULL[6]; break;
      case "b": out += MONTH_SHORT[8]; break;
      case "B": out += MONTH_FULL[8]; break;
      case "p": out += "PM"; break;
      case "j": out += "269"; break;
      case "w": out += "6"; break;
      case "u": out += "6"; break;
      // %z %Z %c %x %X %U %W %G %V：时区 / locale 依赖，离线不给值
      default: return null;
    }
  }
  return out;
}

function loggingSample(fmt: string): string | null {
  let out = "";
  let last = 0;
  for (const m of fmt.matchAll(/%\((\w+)\)([sdfg])/g)) {
    const v = LOGGING_SAMPLE[m[1]!];
    if (v === undefined) return null; // 未知字段：不给示例
    out += fmt.slice(last, m.index) + v;
    last = (m.index ?? 0) + m[0].length;
  }
  return out + fmt.slice(last);
}

/** 格式规范 / 模板的离线示例；含 {} 时按模板展开，否则按 spec 渲染样本值 */
function specSample(fmt: string): string | null {
  if (!fmt.includes("{")) return renderSpec(fmt, SAMPLE_NUM);
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === "{" && fmt[i + 1] === "{") {
      out += "{";
      i++;
      continue;
    }
    if (c === "}" && fmt[i + 1] === "}") {
      out += "}";
      i++;
      continue;
    }
    if (c !== "{") {
      out += c;
      continue;
    }
    const close = fmt.indexOf("}", i);
    if (close < 0) return null;
    const inner = fmt.slice(i + 1, close);
    const spec = inner.includes(":") ? inner.slice(inner.indexOf(":") + 1) : "";
    const rendered = renderSpec(spec, SAMPLE_NUM);
    if (rendered === null) return null;
    out += rendered;
    i = close;
  }
  return out;
}

/** 按 spec 渲染样本（不支持的形态返回 null） */
function renderSpec(spec: string, sample: number): string | null {
  const parts = parseSpec(spec);
  if (parts.unknownType || parts.alt) return null;
  const type = parts.type ?? "";
  if (type === "g" || type === "G" || type === "n" || type === "c") return null;
  let body: string;
  let negative = false;
  const prec = parts.precision;
  switch (type) {
    case "":
    case "s":
      body = SAMPLE_STR;
      break;
    case "d":
      body = String(SAMPLE_INT);
      break;
    case "b":
      body = SAMPLE_INT.toString(2);
      break;
    case "o":
      body = SAMPLE_INT.toString(8);
      break;
    case "x":
      body = SAMPLE_INT.toString(16);
      break;
    case "X":
      body = SAMPLE_INT.toString(16).toUpperCase();
      break;
    case "e":
    case "E":
      body = sample.toExponential(prec ?? 6).replace("e", type === "E" ? "E" : "e");
      break;
    case "%":
      body = `${(sample * 100).toFixed(prec ?? 6)}%`;
      break;
    case "f":
    case "F":
      body = sample.toFixed(prec ?? 6);
      break;
    default:
      return null;
  }
  if (parts.grouping && /^\d/.test(body)) body = groupDigits(body);
  if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  }
  const sign = negative ? "-" : parts.sign === "+" ? "+" : parts.sign === " " ? " " : "";
  body = sign + body;
  const width = parts.width ? Number(parts.width) : 0;
  if (body.length >= width) return body;
  const fill = parts.fill ?? (parts.zero && !parts.align ? "0" : " ");
  const align = parts.align ?? (parts.zero ? "=" : type === "s" || type === "" ? "<" : ">");
  const padLen = width - body.length;
  if (align === "=") {
    const sgn = /^[+\- ]/.test(body) ? body[0] : "";
    return sgn + fill!.repeat(padLen) + body.slice(sgn.length);
  }
  if (align === "<") return body + fill!.repeat(padLen);
  if (align === ">") return fill!.repeat(padLen) + body;
  const left = Math.floor(padLen / 2);
  return fill!.repeat(left) + body + fill!.repeat(padLen - left);
}

/** 千分位分组（只处理整数部分；Python 的 `,` 与此处语义一致） */
function groupDigits(body: string): string {
  const m = /^([+]?|-)(\d+)(\D.*)?$/.exec(body);
  if (!m) return body;
  return `${m[1]}${m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${m[3] ?? ""}`;
}

// ---------- hover markdown（§11.4：示例输出 + 分段说明） ----------

function buildModeLabels(): Record<FormatMode, string> {
  return { strftime: t("devtools.fmt.modeStrftime"), format: t("devtools.fmt.modeSpec"), logging: t("devtools.fmt.modeLogging") };
}
let MODE_LABEL: Record<FormatMode, string> = buildModeLabels();

function buildSampleHints(): Record<FormatMode, string> {
  return {
  strftime: t("devtools.fmt.sampleTs"),
  format: t("devtools.fmt.sampleNum"),
  logging: t("devtools.fmt.sampleRec"),
  };
}
let SAMPLE_HINT: Record<FormatMode, string> = buildSampleHints();

function buildCommonHints(): Record<FormatMode, string> {
  return {
  strftime: t("devtools.fmt.hintStrftime"),
  format: t("devtools.fmt.hintFormat"),
  logging: t("devtools.fmt.hintLogging"),
  };
}
let COMMON_HINT: Record<FormatMode, string> = buildCommonHints();

/** hover 卡（R-1 结论：追加进 lsp/client.ts 合并管线）：§11.4 示例输出 + 分段说明 */
export function formatHoverMarkdown(mode: FormatMode, fmt: string): string {
  const tokens = segmentFormat(mode, fmt).slice(0, 20);
  const lines: string[] = [];
  // 示例输出（离线、固定样本；未知码 / tz·locale 依赖码一律不给示例，I-3 不臆测）
  const sample = tokens.every((t) => !t.unknown) ? formatSample(mode, fmt) : null;
  if (sample !== null) lines.push(t("devtools.fmt.sampleLine", { sample: escapeMd(sample), hint: SAMPLE_HINT[mode] }));
  for (const t of tokens) lines.push(`\`${escapeMd(t.text)}\` — ${t.desc}`);
  if (segmentFormat(mode, fmt).length > 20) lines.push(t("devtools.fmt.truncated20"));
  const hasUnknown = tokens.some((t) => t.unknown);
  if (hasUnknown) lines.push(t("devtools.fmt.unknownWarn", { hint: COMMON_HINT[mode] }));
  lines.push("---");
  lines.push(t("devtools.fmt.openTool"));
  return [`**Python ${MODE_LABEL[mode]}**`, ...lines].join("\n\n");
}

function escapeMd(s: string): string {
  return s.replace(/`/g, "\\`").replace(/\n/g, "\\n");
}

// ---------- 源码扫描（编辑器 hover / 诊断的识别层） ----------

export interface FormatHit {
  mode: FormatMode;
  fmt: string; // 字符串值（非 raw 已反转义）
  source: string;
  isRaw: boolean;
  start: number;
  end: number;
  contentStart: number;
  /** 0-based 行 */
  line: number;
}

/** 单文件识别上限 */
export const MAX_FORMAT_HITS = 200;

/**
 * 识别源码中的格式串字面量（保守白名单，避免误报刷屏）：
 * - strftime：`.strftime(<字面量>)` / `.strptime(<…>, <字面量>)` 的实参；
 * - format：`.format` 方法调用的**接收者字面量**（含 {}）/ `format(x, <spec 字面量>)` 内建形态；
 * - logging：含已知字段且**上下文可信**（format= kwarg / Formatter( 调用 / 赋值且 ≥2 已知字段）。
 */
export function scanFormatLiterals(text: string): FormatHit[] {
  const hits: FormatHit[] = [];
  const seen = new Set<number>();
  const mask = buildCodeMask(text);
  const push = (mode: FormatMode, lit: PyStringLiteral, at: number): void => {
    if (hits.length >= MAX_FORMAT_HITS || seen.has(lit.start)) return;
    seen.add(lit.start);
    hits.push({
      mode,
      fmt: lit.isRaw ? lit.content : unescapePythonString(lit.content),
      source: lit.content,
      isRaw: lit.isRaw,
      start: lit.start,
      end: lit.end,
      contentStart: lit.contentStart,
      line: lineColAt(text, at).line,
    });
  };

  // 收集全部字符串字面量（end 偏移索引，供 .format 接收者反查）
  const litByEnd = new Map<number, PyStringLiteral>();
  {
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === "#") {
        const nl = text.indexOf("\n", i);
        if (nl < 0) break;
        i = nl + 1;
        continue;
      }
      if (c === '"' || c === "'") {
        const lit = parsePyStringLiteral(text, i);
        if (!lit) {
          i++;
          continue;
        }
        litByEnd.set(lit.end, lit);
        i = lit.end;
        continue;
      }
      i++;
    }
  }

  // 1) strftime / strptime 实参
  for (const m of text.matchAll(/\.\s*(?:strftime|strptime)\s*\(/g)) {
    if (mask[m.index] === 1) continue;
    const open = m.index + m[0].length - 1;
    const lit = firstStringArg(text, open);
    if (lit) push("strftime", lit, m.index);
  }

  // 2) format：方法调用（接收者字面量）+ 内建调用（实参字面量）
  for (const m of text.matchAll(/format\s*\(/g)) {
    if (mask[m.index] === 1) continue;
    const isMethod = m.index > 0 && text[m.index - 1] === ".";
    if (isMethod) {
      // 接收者：.format 前的字符串字面量（允许中间空白，跨行 ".\n  format(" 不支持——边界外）
      const lit = litByEnd.get(m.index - 1);
      if (!lit) continue;
      const value = lit.isRaw ? lit.content : unescapePythonString(lit.content);
      if (value.includes("{") && value.includes("}")) push("format", lit, m.index);
    } else {
      // 内建：前一字符须非标识符（防 xformat( 误匹配）
      const prev = text[m.index - 1];
      if (prev && /[\w]/.test(prev)) continue;
      const open = m.index + m[0].length - 1;
      const lit = firstStringArg(text, open);
      if (!lit) continue;
      const value = lit.isRaw ? lit.content : unescapePythonString(lit.content);
      // 模板（含 {}）或 spec 形态（如 ".2f" / ">10"）；普通词串不误收
      const specLike = /^[<>^+\-#0.,_]/.test(value) || /^[sdefgnEFGXob%]$/.test(value);
      if ((value.includes("{") && value.includes("}")) || specLike) push("format", lit, m.index);
    }
  }

  // 3) logging：已知字段 + 上下文可信（kwarg / Formatter( 调用 / 赋值且 ≥2 已知字段）
  for (const [, lit] of litByEnd) {
    const value = lit.isRaw ? lit.content : unescapePythonString(lit.content);
    if (!/%\(\w+\)[sdfg]/.test(value)) continue;
    const fields = [...value.matchAll(/%\((\w+)\)[sdfg]/g)].map((x) => x[1]!);
    const knownCount = fields.filter((f) => LOGGING_FIELDS[f] !== undefined).length;
    if (knownCount === 0) continue;
    // 上下文：字面量前 200 字符内紧邻 format= / fmt= kwarg，或 Formatter( 调用
    const prefix = text.slice(Math.max(0, lit.start - 200), lit.start);
    const kwargCtx = /(?:format|fmt)\s*=\s*(?:[fFrRbBuU]{0,2}(['"]))$/.test(prefix.trimEnd());
    const formatterCtx = /Formatter\s*\(\s*$/.test(prefix.trimEnd());
    // 赋值兜底：NAME = "…" 且 ≥2 已知字段
    const assignCtx = /=\s*(?:[fFrRbBuU]{0,2}(['"]))?$/.test(prefix.trimEnd()) && knownCount >= 2;
    if (kwargCtx || formatterCtx || assignCtx) push("logging", lit, lit.start);
  }
  return hits;
}

function lineColAt(text: string, offset: number): { line: number; col: number } {
  let line = 0;
  let lastNl = -1;
  const limit = Math.min(offset, text.length);
  for (let k = 0; k < limit; k++) {
    if (text.charCodeAt(k) === 10) {
      line++;
      lastNl = k;
    }
  }
  return { line, col: offset - lastNl - 1 };
}

/** 调用括号内的首个字符串字面量（跳过空白/注释/简单位置实参如 datetime 对象） */
function firstStringArg(text: string, openIdx: number): PyStringLiteral | null {
  let i = openIdx + 1;
  for (;;) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if (c === "#") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) return null;
      i = nl + 1;
    } else break;
  }
  // strptime(x, fmt) / strftime(fmt)：允许跳过一个逗号前实参
  const first = parsePyStringLiteral(text, i);
  if (first) return first;
  // 跳过非逗号非括号内容找第二个实参（strptime 的 fmt 在第 2 位）
  let j = i;
  while (j < text.length && text[j] !== "," && text[j] !== ")" && text[j] !== "\n") j++;
  if (text[j] !== ",") return null;
  let k = j + 1;
  while (/\s/.test(text[k] ?? "")) k++;
  return parsePyStringLiteral(text, k);
}
