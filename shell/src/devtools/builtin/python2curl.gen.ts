// Python → cURL 反向生成（库特别支持 P1 §7-5，v1.1 补排期）：
// 静态解析 `requests.get/post/…` / `httpx.get/post/…` 调用的**字面量实参** → 拼 cURL 命令，
// 与既有 cURL→Python（curl2python/）互为反向。零求值、零子进程、纯前端。
// 边界（R-8 同哲学）：变量 / 表达式实参一律抛错（不臆测），不 import 用户模块。

import { parsePyStringLiteral, unescapePythonString } from "../../libRegex";
import { t } from "../../i18n";

const CALL_RE = /\b(?:requests|httpx)\.(get|post|put|delete|patch|head|options)\s*\(/g;

/** cURL 单参数的 shell 安全包裹（单引号内含 ' → '\'' 惯例） */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function scalarToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new Error(t("devtools.p2c.scalarOnly"));
}

// ---------- Python 字面量解析（递归下降，只认字面量） ----------

class PyLiteralParser {
  private i: number;
  constructor(private readonly text: string, start: number) {
    this.i = start;
  }

  ws(): void {
    while (this.i < this.text.length && /[\s]/.test(this.text[this.i])) this.i++;
  }

  /** 解析一个字面量值；遇到变量 / 表达式抛错（不臆测） */
  value(): unknown {
    this.ws();
    const c = this.text[this.i];
    // 字符串
    const lit = parsePyStringLiteral(this.text, this.i);
    if (lit && this.text[this.i] !== "f" && this.text[this.i] !== "F") {
      this.i = lit.end;
      return lit.isRaw ? lit.content : unescapePythonString(lit.content);
    }
    if (c === "{") return this.dict();
    if (c === "[") return this.list();
    if (this.text.startsWith("True", this.i)) {
      this.i += 4;
      return true;
    }
    if (this.text.startsWith("False", this.i)) {
      this.i += 5;
      return false;
    }
    if (this.text.startsWith("None", this.i)) {
      this.i += 4;
      return null;
    }
    const num = /^-?\d+(?:\.\d+)?/.exec(this.text.slice(this.i));
    if (num) {
      this.i += num[0].length;
      return Number(num[0]);
    }
    throw new Error(t("devtools.p2c.nonLiteral", { col: this.i + 1 }));
  }

  /** 跳过 `=`（kwarg 名与值之间）；名本身由调用方用正则取 */
  peekOffset(): number {
    this.ws();
    return this.i;
  }

  skip(n: number): void {
    this.i += n;
  }

  atEnd(): boolean {
    this.ws();
    return this.i >= this.text.length;
  }

  peek(): string {
    this.ws();
    return this.text[this.i] ?? "";
  }

  expect(ch: string): void {
    this.ws();
    if (this.text[this.i] !== ch) {
      throw new Error(t("devtools.p2c.expectChar", { col: this.i + 1, ch: ch }));
    }
    this.i++;
  }

  private dict(): Record<string, unknown> {
    this.i++; // {
    const out: Record<string, unknown> = {};
    for (;;) {
      this.ws();
      if (this.text[this.i] === "}") {
        this.i++;
        return out;
      }
      const lit = parsePyStringLiteral(this.text, this.i);
      if (!lit) throw new Error(t("devtools.p2c.dictKey"));
      this.i = lit.end;
      const key = lit.isRaw ? lit.content : unescapePythonString(lit.content);
      this.expect(":");
      out[key] = this.value();
      this.ws();
      if (this.text[this.i] === ",") {
        this.i++;
      } else if (this.text[this.i] === "}") {
        this.i++;
        return out;
      } else {
        throw new Error(t("devtools.p2c.expectDictSep", { col: this.i + 1 }));
      }
    }
  }

  private list(): unknown[] {
    this.i++; // [
    const out: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.text[this.i] === "]") {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.ws();
      if (this.text[this.i] === ",") {
        this.i++;
      } else if (this.text[this.i] === "]") {
        this.i++;
        return out;
      } else {
        throw new Error(t("devtools.p2c.expectListSep", { col: this.i + 1 }));
      }
    }
  }
}

/** 跳过到匹配的右括号（字符串字面量整体跳过），返回右括号下标 */
function skipToCloseParen(text: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "#" ) {
      const nl = text.indexOf("\n", i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const lit = parsePyStringLiteral(text, i);
      if (!lit) break;
      i = lit.end;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error(t("devtools.p2c.unclosed"));
}

interface ParsedCall {
  method: string;
  url: string;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  json: unknown;
  data: unknown;
  cookies: Record<string, unknown>;
  timeout: number | null;
}

function parseCall(text: string, openIdx: number, method: string): ParsedCall {
  skipToCloseParen(text, openIdx); // 先校验括号闭合（未闭合抛错）
  const p = new PyLiteralParser(text, openIdx + 1);
  const call: ParsedCall = {
    method, url: "", query: {}, headers: {}, json: undefined, data: undefined, cookies: {}, timeout: null,
  };
  let positional = 0;
  for (;;) {
    p.ws();
    if (p.atEnd() || p.peek() === ")") break;
    const kw = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(text.slice(p.peekOffset()));
    if (kw) {
      p.skip(kw[0].length);
      const v = p.value();
      switch (kw[1]) {
        case "params":
          if (v !== null && typeof v === "object" && !Array.isArray(v)) call.query = v as Record<string, unknown>;
          else throw new Error(t("devtools.p2c.paramsDict"));
          break;
        case "headers":
          if (v !== null && typeof v === "object" && !Array.isArray(v)) call.headers = v as Record<string, unknown>;
          else throw new Error(t("devtools.p2c.headersDict"));
          break;
        case "json": call.json = v; break;
        case "data": call.data = v; break;
        case "cookies":
          if (v !== null && typeof v === "object" && !Array.isArray(v)) call.cookies = v as Record<string, unknown>;
          else throw new Error(t("devtools.p2c.cookiesDict"));
          break;
        case "timeout":
          if (typeof v === "number") call.timeout = v;
          else throw new Error(t("devtools.p2c.timeoutNum"));
          break;
        default: throw new Error(t("devtools.p2c.unsupportedKwarg", { name: kw[1] }));
      }
    } else {
      const v = p.value();
      if (positional === 0 && typeof v === "string") call.url = v;
      else if (positional === 1 && v !== null && typeof v === "object" && !Array.isArray(v)) {
        call.query = v as Record<string, unknown>; // requests.get(url, params) 位置形态
      } else throw new Error(t("devtools.p2c.tooManyPositional"));
      positional++;
    }
    p.ws();
    if (p.peek() === ",") {
      p.skip(1);
      continue;
    }
    break;
  }
  if (!call.url) throw new Error(t("devtools.p2c.noUrlArg"));
  return call;
}

// ---------- cURL 组装 ----------

function buildCurl(call: ParsedCall): string {
  const parts: string[] = ["curl"];
  const upper = call.method.toUpperCase();
  if (upper !== "GET") parts.push("-X", upper);
  let url = call.url;
  const qsEntries = Object.entries(call.query);
  if (qsEntries.length > 0) {
    const qs = qsEntries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(scalarToString(v))}`).join("&");
    url += (url.includes("?") ? "&" : "?") + qs;
  }
  parts.push(shellQuote(url));

  const hasJson = call.json !== undefined;
  for (const [k, v] of Object.entries(call.headers)) {
    parts.push("-H", shellQuote(`${k}: ${scalarToString(v)}`));
  }
  if (hasJson && !Object.keys(call.headers).some((k) => k.toLowerCase() === "content-type")) {
    parts.push("-H", shellQuote("Content-Type: application/json"));
  }
  const cookieEntries = Object.entries(call.cookies);
  if (cookieEntries.length > 0) {
    parts.push("-b", shellQuote(cookieEntries.map(([k, v]) => `${k}=${scalarToString(v)}`).join("; ")));
  }
  if (hasJson) {
    parts.push("-d", shellQuote(JSON.stringify(call.json)));
  } else if (call.data !== undefined) {
    if (typeof call.data === "string") {
      parts.push("-d", shellQuote(call.data));
    } else if (call.data !== null && typeof call.data === "object" && !Array.isArray(call.data)) {
      for (const [k, v] of Object.entries(call.data as Record<string, unknown>)) {
        parts.push("-d", shellQuote(`${k}=${scalarToString(v)}`));
      }
    } else {
      throw new Error(t("devtools.p2c.dataType"));
    }
  }
  if (call.timeout !== null) parts.push("--max-time", String(call.timeout));
  return parts.join(" ");
}

/** Python 代码 → cURL 命令（识别全部 requests/httpx 调用点，逐个生成；无调用点抛错） */
export function pythonToCurl(code: string): string {
  CALL_RE.lastIndex = 0;
  const lines: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(code)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    lines.push(buildCurl(parseCall(code, openIdx, m[1])));
    CALL_RE.lastIndex = openIdx + 1;
  }
  if (lines.length === 0) throw new Error(t("devtools.p2c.noCall"));
  return lines.join("\n\n");
}
