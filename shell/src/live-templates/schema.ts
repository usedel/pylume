// Live Templates Schema v2：数据模型 + 宽松校验 + v1 配置迁移
// 位置轴（positions）语义见 live_templates上下文轴修订稿（v1.1）§2

export type TemplateKind = "normal" | "surround" | "postfix";

/** 语法位置轴（上下文位置轴修订稿 §1）：模板适用位置 */
export type PositionKind = "statement" | "expression" | "name";

/** 未显式声明 positions 时的缺省：语句位 + 表达式位（排除名字位，避免起名时误触发） */
export const DEFAULT_POSITIONS: PositionKind[] = ["statement", "expression"];

export interface TemplateVariableDef {
  name: string;
  /** 表达式：字符串常量（双引号）/ 函数调用 / 变量引用 / concat 组合 */
  expression?: string;
  /** 表达式缺省或求值失败时的占位符默认值 */
  defaultValue?: string;
  /** 表达式求值成功时跳过用户输入（注入字面文本，不产生占位符） */
  skipIfDefined?: boolean;
}

export interface TemplateDef {
  id: string;
  abbreviation: string;
  description: string;
  /** 模板体：$VAR$ 命名变量 + $END$ 终点 + $$ 字面美元符（环绕模板另有 $SELECTION$） */
  body: string;
  /** 作用域列表，如 ["python:module", "python:class", "python:function"] */
  scopes: string[];
  /** 领域分组（如 "crawler"）；可选，未填 = 默认组。显示名经 groupLabel() 映射 */
  group?: string;
  kind: TemplateKind;
  /** kind=postfix 时 `.` 后的触发键（M3） */
  postfixKey?: string;
  enabled: boolean;
  /** 是否允许「缩写+Tab」直接展开（关键字类缩写建议关闭，避免与正常编码冲突） */
  tabExpand: boolean;
  /** 适用「位置」（语法位置轴，见上下文位置轴修订稿 §1）；缺省 DEFAULT_POSITIONS */
  positions?: PositionKind[];
  /** 字符串 / 注释内默认不展开，除非模板显式开启 */
  allowInStrings?: boolean;
  allowInComments?: boolean;
  /** 变量定义；数组顺序 = Tab 跳转顺序 */
  variables?: TemplateVariableDef[];
}

export interface TemplatesFile {
  version: 2;
  templates: TemplateDef[];
  /** 各 scope 内补全排序（缩写数组）；未列出的模板排后 */
  ordering?: Record<string, string[]>;
}

export interface ParseResult {
  file: TemplatesFile;
  /** 被跳过条目的原因（不整体失败，仅告警） */
  errors: string[];
}

const ABBR_RE = /^[A-Za-z0-9._-]+$/;
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VALID_SCOPES = new Set([
  "python:module",
  "python:class",
  "python:function",
  "python:expression",
]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 宽松解析 Schema v2 文件：非法条目跳过并记录原因 */
export function parseTemplatesFile(raw: string): ParseResult | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(json)) return null;
  // v1 格式（无 version 字段，templates 为对象映射）→ 迁移
  if (json.version === undefined && isObj(json.templates)) {
    return { file: migrateV1(json), errors: [] };
  }
  if (json.version !== 2 || !Array.isArray(json.templates)) return null;

  const errors: string[] = [];
  const templates: TemplateDef[] = [];
  const seen = new Set<string>();

  for (const [i, t] of (json.templates as unknown[]).entries()) {
    const where = `templates[${i}]`;
    if (!isObj(t)) {
      errors.push(`${where}: 非对象，跳过`);
      continue;
    }
    const abbr = typeof t.abbreviation === "string" ? t.abbreviation : "";
    if (!ABBR_RE.test(abbr)) {
      errors.push(`${where}: abbreviation 非法（${abbr || "缺失"}），跳过`);
      continue;
    }
    if (typeof t.body !== "string" || t.body.length === 0) {
      errors.push(`${where}(${abbr}): body 缺失，跳过`);
      continue;
    }
    const scopes = Array.isArray(t.scopes)
      ? (t.scopes as unknown[]).filter((s): s is string => typeof s === "string" && VALID_SCOPES.has(s))
      : [];
    if (scopes.length === 0) {
      errors.push(`${where}(${abbr}): scopes 为空或全部非法，跳过`);
      continue;
    }
    const kind: TemplateKind = t.kind === "surround" || t.kind === "postfix" ? t.kind : "normal";
    // kind 专属校验：环绕必须含 $SELECTION$；后缀必须有合法 postfixKey（方案 §9.3/§9.4）
    let postfixKey: string | undefined;
    if (kind === "surround" && !t.body.includes("$SELECTION$")) {
      errors.push(`${where}(${abbr}): 环绕模板缺少 $SELECTION$，跳过`);
      continue;
    }
    if (kind === "postfix") {
      postfixKey = typeof t.postfixKey === "string" ? t.postfixKey : "";
      if (!ABBR_RE.test(postfixKey)) {
        errors.push(`${where}(${abbr}): postfix 模板缺少合法 postfixKey，跳过`);
        continue;
      }
    }
    const variables: TemplateVariableDef[] = [];
    if (Array.isArray(t.variables)) {
      for (const v of t.variables as unknown[]) {
        if (!isObj(v) || typeof v.name !== "string" || !VAR_NAME_RE.test(v.name)) continue;
        variables.push({
          name: v.name,
          expression: typeof v.expression === "string" && v.expression ? v.expression : undefined,
          defaultValue: typeof v.defaultValue === "string" ? v.defaultValue : undefined,
          skipIfDefined: v.skipIfDefined === true,
        });
      }
    }
    const positions: PositionKind[] = [];
    if (Array.isArray(t.positions)) {
      for (const p of t.positions as unknown[]) {
        if (p === "statement" || p === "expression" || p === "name") positions.push(p);
      }
    }
    const id = typeof t.id === "string" && t.id ? t.id : abbr;
    const group = typeof t.group === "string" && t.group.trim() ? t.group.trim() : undefined;
    // kind 参与去重键：同缩写允许分属不同范式（如 normal `try` 与 surround `try` 共存）
    const dedupeKey = `${id}|${kind}|${abbr}`;
    if (seen.has(dedupeKey)) {
      errors.push(`${where}(${abbr}): id/kind/abbreviation 重复，跳过`);
      continue;
    }
    seen.add(dedupeKey);
    templates.push({
      id,
      abbreviation: abbr,
      description: typeof t.description === "string" ? t.description : abbr,
      body: t.body,
      scopes,
      group,
      kind,
      postfixKey,
      enabled: t.enabled !== false,
      tabExpand: t.tabExpand !== false,
      allowInStrings: t.allowInStrings === true,
      allowInComments: t.allowInComments === true,
      positions: positions.length > 0 ? positions : undefined,
      variables: variables.length > 0 ? variables : undefined,
    });
  }

  const ordering: Record<string, string[]> = {};
  if (isObj(json.ordering)) {
    for (const [scope, list] of Object.entries(json.ordering)) {
      if (Array.isArray(list)) {
        ordering[scope] = (list as unknown[]).filter((x): x is string => typeof x === "string");
      }
    }
  }

  return { file: { version: 2, templates, ordering }, errors };
}

// ---------- v1 → v2 迁移 ----------

/**
 * v1 格式：{ templates: { key: { label, body } }, priority: { module|class|function: key[] } }
 * body 为 VSCode snippet 语法（${1:ph} / $0）。
 * 开发期无真实用户数据负担：迁移尽力而为，失败条目直接丢弃。
 */
export function migrateV1(json: Record<string, unknown>): TemplatesFile {
  const templates: TemplateDef[] = [];
  const tpls = json.templates as Record<string, unknown>;

  for (const [key, t] of Object.entries(tpls)) {
    if (!isObj(t) || typeof t.body !== "string") continue;
    const { body, variables } = vscodeSnippetToDollarVars(t.body);
    templates.push({
      id: `builtin.${key}`,
      abbreviation: key,
      description: typeof t.label === "string" ? t.label : key,
      body,
      scopes: ["python:module", "python:class", "python:function"],
      kind: "normal",
      enabled: true,
      // v1 模板全部可 Tab 展开（保持迁移前的补全插入体验）
      tabExpand: true,
      variables: variables.length > 0 ? variables : undefined,
    });
  }

  const ordering: Record<string, string[]> = {};
  if (isObj(json.priority)) {
    for (const [ctx, list] of Object.entries(json.priority)) {
      if (Array.isArray(list)) {
        ordering[`python:${ctx}`] = (list as unknown[]).filter((x): x is string => typeof x === "string");
      }
    }
  }

  return { version: 2, templates, ordering };
}

/** ${1:ph} / $1 → $PH$ 命名变量；$0 → $END$；同一编号 = 同一变量（保留镜像） */
export function vscodeSnippetToDollarVars(src: string): { body: string; variables: TemplateVariableDef[] } {
  const indexToName = new Map<number, string>();
  const variables: TemplateVariableDef[] = [];
  const usedNames = new Set<string>();

  const nameFor = (index: number, placeholder: string): string => {
    const hit = indexToName.get(index);
    if (hit) return hit;
    let base = placeholder
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!base || !/^[A-Z_]/.test(base)) base = `V${index}`;
    let name = base;
    let n = 2;
    while (usedNames.has(name)) name = `${base}_${n++}`;
    usedNames.add(name);
    indexToName.set(index, name);
    variables.push({ name, defaultValue: placeholder || undefined });
    return name;
  };

  let body = src.replace(/\$\{(\d+):([^}]*)\}/g, (_m, idx: string, ph: string) => {
    const i = Number(idx);
    if (i === 0) return "$END$";
    return `$${nameFor(i, ph)}$`;
  });
  body = body.replace(/\$(\d+)/g, (_m, idx: string) => {
    const i = Number(idx);
    if (i === 0) return "$END$";
    return `$${nameFor(i, "")}$`;
  });
  return { body, variables };
}
