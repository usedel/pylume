// 库支持面板桥（库特别支持 PR-2）：编辑器入口（lens / 右键 / 键位）向 devtools 面板
// 传递「当前正则」上下文的轻量中转。独立小模块，避免 dslLens ↔ devtools/builtin 循环依赖。

export interface RegexPanelRequest {
  /** 模式的 Python 字符串值（非 raw 串已反转义） */
  pattern: string;
  isRaw: boolean;
  flags: string[];
  /** 「替换字面量」写回定位：模式串首字符在文档中的偏移（-1 = 非编辑器来源，写回置灰） */
  contentOffset: number;
  /** 源码字面量全文（含引号），替换字面量时使用 */
  source: string;
}

/**
 * 带入请求的有效期（§11.2 sourceDirty ②）：
 * 面板被 LRU 逐出 / 关闭后重新挂载时，不套用几分钟前点 lens 产生的陈旧编辑器上下文。
 */
const PENDING_TTL_MS = 30_000;

let pending: { req: RegexPanelRequest; at: number } | null = null;

export function setPendingRegexRequest(req: RegexPanelRequest): void {
  pending = { req, at: Date.now() };
}

/** 面板挂载时取走（取后清空，避免下次打开误用旧上下文）；超过 TTL 视为陈旧，返回 null */
export function takePendingRegexRequest(): RegexPanelRequest | null {
  const p = pending;
  pending = null;
  if (!p) return null;
  if (Date.now() - p.at > PENDING_TTL_MS) return null;
  return p.req;
}

// ---------- JSONPath 面板请求（库特别支持 P1 §7-3：编辑器右键「JSONPath 提取」入口） ----------

export interface JsonPathPanelRequest {
  /** 字面量反转义后的 JSON 文本 */
  json: string;
}

let pendingJsonPath: JsonPathPanelRequest | null = null;

export function setPendingJsonPathRequest(req: JsonPathPanelRequest): void {
  pendingJsonPath = req;
}

/** 面板挂载时取走（取后清空） */
export function takePendingJsonPathRequest(): JsonPathPanelRequest | null {
  const p = pendingJsonPath;
  pendingJsonPath = null;
  return p;
}

// ---------- 格式串面板请求（§11.1-2 聚合 lens：lens 点击带入选中模式与格式串） ----------

export interface FormatPanelRequest {
  /** 格式串模式（由识别规则给出：strftime / format / logging） */
  mode: "strftime" | "format" | "logging";
  /** 格式串值（非 raw 串已反转义） */
  fmt: string;
}

let pendingFormat: { req: FormatPanelRequest; at: number } | null = null;

export function setPendingFormatRequest(req: FormatPanelRequest): void {
  pendingFormat = { req, at: Date.now() };
}

/** 面板挂载时取走（取后清空）；超过 PENDING_TTL_MS 视为陈旧，返回 null */
export function takePendingFormatRequest(): FormatPanelRequest | null {
  const p = pendingFormat;
  pendingFormat = null;
  if (!p) return null;
  if (Date.now() - p.at > PENDING_TTL_MS) return null;
  return p.req;
}
