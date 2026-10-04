// 由解析出的 CurlCommand 生成 Python requests 代码（风格对齐内置爬虫模板 reqget/reqpost）。

import type { CurlCommand } from "./parse";
import { pythonLiteralOf } from "../../pyLiteral";

/** 生成 Python 字符串字面量（JSON 字符串与 Python 双引号字符串转义一致） */
function pyStr(s: string): string {
  return JSON.stringify(s);
}

/** 尝试把 body 字符串按 JSON 解析 */
function tryJson(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

/** -u "user:pass" → ("user", "pass") */
function pyAuth(u: string): string {
  const idx = u.indexOf(":");
  const name = idx === -1 ? u : u.slice(0, idx);
  const pass = idx === -1 ? "" : u.slice(idx + 1);
  return `(${pyStr(name)}, ${pyStr(pass)})`;
}

/** "a=1; b=2" → {a: "1", b: "2"} */
function parseCookies(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(";")) {
    const t = part.trim();
    if (!t) continue;
    const idx = t.indexOf("=");
    if (idx === -1) out[t] = "";
    else out[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return out;
}

/** "a=1&b=2"（urlencoded）→ dict */
function parseQuery(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split("&")) {
    const t = part.trim();
    if (!t) continue;
    const idx = t.indexOf("=");
    const rawK = idx === -1 ? t : t.slice(0, idx);
    const rawV = idx === -1 ? "" : t.slice(idx + 1);
    try {
      out[decodeURIComponent(rawK)] = decodeURIComponent(rawV);
    } catch {
      out[rawK] = rawV;
    }
  }
  return out;
}

/** 格式化 dict（pyLiteral 单一实现：true/false/null → True/False/None。
 *  原 JSON.stringify 实现对 JSON body 产出非法 Python——缺陷收口，登记见
 *  dx_features_backlog §6.6 PR-M 关联登记） */
function fmtDict(obj: unknown): string {
  return pythonLiteralOf(obj);
}

export function generatePython(input: CurlCommand): string {
  const method = input.method.toLowerCase();
  const headers = [...input.headers];
  if (input.userAgent && !headers.some(([k]) => k.toLowerCase() === "user-agent")) {
    headers.push(["User-Agent", input.userAgent]);
  }

  const stmts: string[] = [];

  if (headers.length > 0) {
    const obj: Record<string, string> = {};
    for (const [k, v] of headers) obj[k] = v;
    stmts.push(`headers = ${fmtDict(obj)}`);
  }

  if (input.cookies) {
    stmts.push(`cookies = ${fmtDict(parseCookies(input.cookies))}`);
  }

  // 请求体 / 查询串
  let hasData = false;
  let hasJson = false;
  let hasParams = false;
  let hasFiles = false;
  let filesDict = "";

  if (input.form.length > 0) {
    const data: Record<string, string> = {};
    const files: Record<string, string> = {};
    for (const [k, v] of input.form) {
      if (v.startsWith("@")) files[k] = v.slice(1);
      else data[k] = v;
    }
    if (Object.keys(data).length > 0) {
      stmts.push(`data = ${fmtDict(data)}`);
      hasData = true;
    }
    if (Object.keys(files).length > 0) {
      const entries = Object.entries(files)
        .map(([k, v]) => `    ${pyStr(k)}: open(${pyStr(v)}, "rb")`)
        .join(",\n");
      filesDict = `files = {\n${entries},\n}`;
      hasFiles = true;
    }
  } else if (input.data !== null) {
    if (input.useGetQuery) {
      stmts.push(`params = ${fmtDict(parseQuery(input.data))}`);
      hasParams = true;
    } else if (input.dataAsJson) {
      const parsed = tryJson(input.data);
      if (parsed.ok) {
        stmts.push(`json = ${fmtDict(parsed.value)}`);
        hasJson = true;
      } else {
        stmts.push(`data = ${pyStr(input.data)}`);
        hasData = true;
      }
    } else {
      stmts.push(`data = ${pyStr(input.data)}`);
      hasData = true;
    }
  }

  if (filesDict) stmts.push(filesDict);

  // 构造调用参数
  const args: string[] = [pyStr(input.url)];
  if (headers.length > 0) args.push("headers=headers");
  if (input.cookies) args.push("cookies=cookies");
  if (hasParams) args.push("params=params");
  if (hasJson) args.push("json=json");
  if (hasData) args.push("data=data");
  if (hasFiles) args.push("files=files");
  if (input.user) args.push(`auth=${pyAuth(input.user)}`);
  if (input.insecure) args.push("verify=False");
  args.push("timeout=10");

  stmts.push(`resp = requests.${method}(${args.join(", ")})`);
  stmts.push("resp.raise_for_status()");

  return `import requests\n\n${stmts.join("\n")}\n`;
}