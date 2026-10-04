// JSON → Python 模型生成器（P1 · 库支持 §7-2）：纯函数、零求值、零 DOM。
// 类型推断规则：bool / int / float / str / list / dict（嵌套 → 独立模型类）/ null（Optional 化）。
// 输出形态三选一：Pydantic BaseModel（别名经 Field(alias=…)）/ dataclass / TypedDict。
// 依赖顺序：嵌套类先于引用它的类输出（pydantic 在类创建时解析注解，被引用名必须已定义）。
//
// 与 curl2python/gen.ts 同层：面板（json2model.ts）只做 IO 与状态，转换逻辑全部在此可单测。

export type ModelStyle = "pydantic" | "dataclass" | "typeddict";

export interface GenOptions {
  /** 输出形态（默认 pydantic） */
  style?: ModelStyle;
  /** 根模型类名（默认 Model；非法字符自动 Pascal 化） */
  rootName?: string;
}

/** Python 硬关键字（作字段名须改写/加引号） */
const KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
  "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
  "return", "try", "while", "with", "yield",
]);

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 任意 JSON key → 合法 Python 标识符：非法字符折叠为 _、数字开头补 _、关键字补尾 _ */
export function toIdentifier(key: string): string {
  const snake = key.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^(\d)/, "_$1");
  if (!snake) return "_";
  return KEYWORDS.has(snake) ? `${snake}_` : snake;
}

/** 任意 JSON key → PascalCase 类名段（用于嵌套模型命名） */
export function toPascal(key: string): string {
  const parts = toIdentifier(key).split("_").filter(Boolean);
  const pascal = parts.map((s) => s[0].toUpperCase() + s.slice(1)).join("");
  return KEYWORDS.has(pascal) ? `${pascal}_` : pascal || "Model";
}

interface ClassDef {
  name: string;
  fields: string[];
}

interface Ctx {
  style: ModelStyle;
  classes: ClassDef[];
  used: Set<string>;
  typing: Set<string>;
  needField: boolean;
}

function uniqueName(base: string, ctx: Ctx): string {
  let name = base;
  for (let i = 2; ctx.used.has(name); i++) name = `${base}${i}`;
  ctx.used.add(name);
  return name;
}

/** 生成单字段行（含别名 / Optional 默认值的形态差异） */
function fieldLine(key: string, type: string, nullable: boolean, ctx: Ctx): string {
  if (nullable && type !== "Any") {
    // Optional[Any] 冗余（语义等同 Any）：仅非 Any 类型包 Optional
    ctx.typing.add("Optional");
    type = `Optional[${type}]`;
  }
  if (ctx.style === "typeddict") {
    // TypedDict 允许带引号的 key（total dict 字符串字面量键）
    return IDENT_RE.test(key) && !KEYWORDS.has(key) ? `    ${key}: ${type}` : `    ${JSON.stringify(key)}: ${type}`;
  }
  const name = toIdentifier(key);
  const renamed = name !== key;
  if (ctx.style === "pydantic") {
    if (!renamed) return `    ${name}: ${type}${nullable ? " = None" : ""}`;
    ctx.needField = true;
    return `    ${name}: ${type} = Field(${nullable ? "default=None, " : ""}alias=${JSON.stringify(key)})`;
  }
  // dataclass：无别名机制，只做合法化改名；Optional 给 None 默认值（合法，无需 field()）
  return `    ${name}: ${type}${nullable ? " = None" : ""}`;
}

/** 递归推断一个 JSON 值的 Python 类型表达式；dict 侧带出嵌套模型类 */
function infer(value: unknown, ctx: Ctx, hint: string): string {
  if (value === null) {
    ctx.typing.add("Any");
    return "Any";
  }
  if (Array.isArray(value)) {
    ctx.typing.add("List");
    if (value.length === 0) {
      ctx.typing.add("Any");
      return "List[Any]";
    }
    const items = [...new Set(value.map((v) => infer(v, ctx, `${hint}Item`)))];
    if (items.length === 1) return `List[${items[0]}]`;
    if (items.includes("Any")) return "List[Any]"; // 混入 null / 异质时退化为 Any，不硬造 Union
    ctx.typing.add("Union");
    return `List[Union[${items.join(", ")}]]`;
  }
  if (typeof value === "object") {
    const cls = modelFor(value as Record<string, unknown>, ctx, hint);
    return cls.name;
  }
  switch (typeof value) {
    case "boolean": return "bool";
    case "number": return Number.isInteger(value) ? "int" : "float";
    default: return "str"; // string 及兜底
  }
}

/** 为一个 JSON 对象建模型类（字段即键值推断）；返回类定义。nameOverride 供根模型复用已占位名 */
function modelFor(obj: Record<string, unknown>, ctx: Ctx, hint: string, nameOverride?: string): ClassDef {
  const name = nameOverride ?? uniqueName(toPascal(hint), ctx);
  const def: ClassDef = { name, fields: [] };
  ctx.classes.push(def);
  for (const [k, v] of Object.entries(obj)) {
    def.fields.push(fieldLine(k, infer(v, ctx, k), v === null, ctx));
  }
  return def;
}

function classBlock(def: ClassDef, ctx: Ctx): string {
  const header =
    ctx.style === "pydantic" ? `class ${def.name}(BaseModel):`
    : ctx.style === "dataclass" ? `@dataclass\nclass ${def.name}:`
    : `class ${def.name}(TypedDict):`;
  if (def.fields.length === 0) return `${header}\n    pass`;
  return `${header}\n${def.fields.join("\n")}`;
}

/** JSON 文本 → Python 模型代码；非法 JSON 原样抛 SyntaxError（面板展示解析失败） */
export function jsonToModelCode(json: string, opts: GenOptions = {}): string {
  const style = opts.style ?? "pydantic";
  const data: unknown = JSON.parse(json);
  const ctx: Ctx = { style, classes: [], used: new Set(), typing: new Set(), needField: false };
  if (style === "typeddict") ctx.typing.add("TypedDict");
  const rootHint = opts.rootName?.trim() || "Model";
  const rootName = uniqueName(toPascal(rootHint), ctx);

  let alias: string | null = null;
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    modelFor(data as Record<string, unknown>, ctx, rootName, rootName);
  } else {
    // 根为标量 / 数组：生成类型别名（数组元素若为对象，仍带出嵌套模型类）
    const t = infer(data, ctx, rootName);
    alias = `${rootName} = ${t}`;
  }

  const header: string[] = [];
  const typing = [...ctx.typing].sort();
  if (typing.length > 0) header.push(`from typing import ${typing.join(", ")}`);
  if (ctx.classes.length > 0) {
    // 纯类型别名（根为标量/空）时不输出框架 import
    if (style === "pydantic") {
      header.push(ctx.needField ? "from pydantic import BaseModel, Field" : "from pydantic import BaseModel");
    } else if (style === "dataclass") {
      header.push("from dataclasses import dataclass");
    }
  }

  const blocks = [...ctx.classes].reverse().map((c) => classBlock(c, ctx)); // 依赖方（嵌套）先输出
  if (alias) blocks.push(alias);

  return [...header, "", ...blocks.join("\n\n").split("\n")].join("\n").replace(/^\n+/, "") + "\n";
}
