// 注入规则表（库特别支持 P1 §7-4）：把正则（PR-2）/ 格式串（PR-3）/ JSON 字面量（§7-3）的
// 识别规则收敛成一张规则表 + 统一 dispatcher。编辑器侧（dslLens / jsonLiteral）只遍历规则表，
// 不再各自维护扫描循环——后续新增注入语言（YAML / SQL 等）在这里加一条规则即可。
//
// 分工边界：识别 / hover / 静态诊断的纯函数仍住在 libRegex / libFormat / libJson（可独立单测），
// 本模块只做「注册 + 统一遍历」，不搬实现（§2 纪律：禁止复制一份）。

import { app } from "./state";
import { regexHoverMarkdown, scanRegexLiterals, staticDiagnostics, type RegexHit } from "./libRegex";
import { formatDiagnostics, formatHoverMarkdown, scanFormatLiterals, type FormatHit } from "./libFormat";
import { jsonHoverSummary, jsonParseError, scanJsonLiterals, type JsonHit } from "./libJson";
import { t } from "./i18n"; // 第十八批 i18n：库文案走语言包

export type InjectRuleId = "regex" | "format" | "json";

/** 统一诊断形态：offset 已换算为文档绝对偏移 */
export interface InjectDiag {
  offset: number;
  message: string;
  isError: boolean;
  length: number;
}

/** 规则携带的原始 hit（RegexHit / FormatHit / JsonHit）按 rule.id 收窄后取用 */
export interface InjectLiteral {
  rule: InjectRuleId;
  start: number;
  end: number;
  contentStart: number;
  source: string;
  data: unknown;
}

export interface InjectRuleDef {
  id: InjectRuleId;
  /** 装饰 inline 类名；undefined = 本规则不做高亮装饰（如 format：有诊断与 hover、无装饰） */
  decorClass?: string;
  enabled(): boolean;
  scan(text: string): InjectLiteral[];
  /** hover markdown（可选） */
  hover?(data: unknown): string | null;
  /** 静态诊断（可选） */
  diagnostics?(data: unknown): InjectDiag[];
}

export const INJECT_RULES: readonly InjectRuleDef[] = [
  {
    id: "regex",
    decorClass: "oc-regex-literal",
    enabled: () => app.settings.libs_regex !== false,
    scan: (text) =>
      scanRegexLiterals(text).map((h: RegexHit) => ({
        rule: "regex" as const, start: h.start, end: h.end, contentStart: h.contentStart, source: h.source, data: h,
      })),
    hover: (data) => regexHoverMarkdown(data as RegexHit),
    diagnostics: (data) => {
      const h = data as RegexHit;
      return staticDiagnostics(h.source, h.isRaw).map((d) => ({
        // d.pos 是 pattern 值内位置；非 raw 串的转义诊断落在源码 contentStart + pos（近似定位）
        offset: Math.min(h.contentStart + d.pos, Math.max(h.end - 1, h.contentStart)),
        message: d.message,
        isError: d.severity === "error",
        length: d.length,
      }));
    },
  },
  {
    id: "format",
    enabled: () => app.settings.libs_format !== false,
    scan: (text) =>
      scanFormatLiterals(text).map((h: FormatHit) => ({
        rule: "format" as const, start: h.start, end: h.end, contentStart: h.contentStart, source: h.source, data: h,
      })),
    hover: (data) => {
      const h = data as FormatHit;
      return formatHoverMarkdown(h.mode, h.fmt);
    },
    diagnostics: (data) => {
      const h = data as FormatHit;
      return formatDiagnostics(h.mode, h.fmt).map((d) => ({
        offset: h.contentStart + d.pos,
        message: d.message,
        isError: false,
        length: d.length,
      }));
    },
  },
  {
    id: "json",
    decorClass: "oc-json-literal",
    enabled: () => app.settings.libs_json_inject !== false, // §11.9 开关（v1.4 补齐漏接线）
    scan: (text) =>
      scanJsonLiterals(text).map((h: JsonHit) => ({
        rule: "json" as const, start: h.start, end: h.end, contentStart: h.contentStart, source: h.source, data: h,
      })),
    hover: (data) => jsonHoverSummary((data as JsonHit).value), // §11.6：`object · N 键 · D 层` 摘要
    diagnostics: (data) => {
      const h = data as JsonHit;
      const err = jsonParseError(h.value);
      if (!err) return [];
      return [{ offset: h.contentStart, message: t("devtools.common.jsonParseFailed", { msg: err.message }), isError: false, length: Math.min(80, Math.max(1, h.end - h.contentStart - 1)) }];
    },
  },
];

function ruleOf(id: InjectRuleId): InjectRuleDef {
  return INJECT_RULES.find((r) => r.id === id)!;
}

/** 统一扫描：按规则表顺序汇总所有启用规则的识别结果 */
export function scanInjectLiterals(text: string): InjectLiteral[] {
  const out: InjectLiteral[] = [];
  for (const rule of INJECT_RULES) {
    if (!rule.enabled()) continue;
    out.push(...rule.scan(text));
  }
  return out;
}

/** 统一 hover：光标偏移所在字面量的规则 hover（按规则表顺序取先命中者） */
export function injectHoverAt(text: string, offset: number): string | null {
  for (const rule of INJECT_RULES) {
    if (!rule.enabled() || !rule.hover) continue;
    const hit = rule.scan(text).find((h) => offset >= h.start && offset <= h.end);
    if (hit) {
      const md = rule.hover(hit.data);
      if (md) return md;
    }
  }
  return null;
}

/** 统一诊断收集：所有启用规则的静态诊断 */
export function collectInjectDiagnostics(text: string): InjectDiag[] {
  const out: InjectDiag[] = [];
  for (const rule of INJECT_RULES) {
    if (!rule.enabled() || !rule.diagnostics) continue;
    for (const lit of rule.scan(text)) out.push(...rule.diagnostics(lit.data));
  }
  return out;
}

export { ruleOf };
