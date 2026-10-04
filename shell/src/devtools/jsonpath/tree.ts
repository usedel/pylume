// JSON → 树 + 路径生成（纯函数，可单测）。

export type JsonType = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface JsonNode {
  /** 对象键名；数组元素与根节点为 null */
  key: string | null;
  value: unknown;
  type: JsonType;
  /** 从根到该节点的路径段（数组下标以数字字符串存储） */
  segments: string[];
  /** 末段是否为数组下标 */
  isIndex: boolean;
  /** object/array 的子节点；标量为 null */
  children: JsonNode[] | null;
}

function typeOf(v: unknown): JsonType {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (Array.isArray(v)) return "array";
  return "object";
}

/** 解析 JSON 文本，失败返回错误信息 */
export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function buildNode(key: string | null, value: unknown, segments: string[], isIndex: boolean): JsonNode {
  const type = typeOf(value);
  let children: JsonNode[] | null = null;
  if (type === "object") {
    children = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      children.push(buildNode(k, v, [...segments, k], false));
    }
  } else if (type === "array") {
    children = (value as unknown[]).map((v, i) => buildNode(null, v, [...segments, String(i)], true));
  }
  return { key, value, type, segments, isIndex, children };
}

/** 由解析出的 JSON 值构建树 */
export function buildJsonTree(value: unknown): JsonNode {
  return buildNode(null, value, [], false);
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUM_RE = /^\d+$/;

/** 生成 JSONPath 路径：$.data.items[0].name（非标识符键用 ["key"]） */
export function toJsonPath(node: JsonNode): string {
  let out = "$";
  for (const seg of node.segments) {
    if (NUM_RE.test(seg)) out += `[${seg}]`;
    else if (IDENT_RE.test(seg)) out += `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

/** 生成 Python 下标路径：data["items"][0]["name"] */
export function toPythonSubscript(node: JsonNode, rootVar = "data"): string {
  let out = rootVar;
  for (const seg of node.segments) {
    out += NUM_RE.test(seg) ? `[${seg}]` : `[${JSON.stringify(seg)}]`;
  }
  return out;
}