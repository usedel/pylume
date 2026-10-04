// 模板编译器：$VAR$ 模板体 → Monaco snippet（方案文档 §8）
// 规则：$END$ → $0；$SELECTION$ → ${TM_SELECTED_TEXT}；$$ → 字面 $；
//       变量按 variables 数组序编号（= Tab 跳转序），未列出的按首现序排后；
//       skipIfDefined 且求值成功 → 字面注入；求值失败 → 占位符 + defaultValue。

import type { TemplateDef, TemplateVariableDef } from "./schema";
import { evalExpression, type EngineContext, type EvalValue } from "./engine";

export type Segment = { kind: "text"; text: string } | { kind: "var"; name: string };

const VAR_TOKEN_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)\$/;

/** 词法扫描：$$ → 字面 $；$NAME$ → 变量；未闭合 $ → 字面 */
export function parseBody(body: string): Segment[] {
  const segs: Segment[] = [];
  let buf = "";
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "$") {
      if (body[i + 1] === "$") {
        buf += "$";
        i += 2;
        continue;
      }
      const m = VAR_TOKEN_RE.exec(body.slice(i));
      if (m) {
        if (buf) {
          segs.push({ kind: "text", text: buf });
          buf = "";
        }
        segs.push({ kind: "var", name: m[1] });
        i += m[0].length;
        continue;
      }
      buf += "$";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf) segs.push({ kind: "text", text: buf });
  return segs;
}

/** Monaco snippet 字面文本转义 */
export function escapeSnippetText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\$/g, "\\$").replace(/}/g, "\\}");
}

/** choice 选项值转义（${1|a,b,c|} 语法内） */
export function escapeChoiceValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/\|/g, "\\|");
}

type VarResolution =
  | { kind: "literal"; text: string }
  | { kind: "placeholder"; defaultValue: string }
  | { kind: "choices"; choices: string[] };

/**
 * 编译模板体为 Monaco snippet。
 * ctx.variableValues 由编译过程内部维护（按 variables 数组序累积，供后续变量引用）。
 * literals：调用方预解析的字面注入（M3：后缀 $EXPR$、环绕 $SELECTION$）——
 *           命中变量直接替换为转义文本，不产生占位符、不参与求值/编号。
 */
export function compileTemplate(
  tpl: TemplateDef,
  ctx: EngineContext,
  literals?: Record<string, string>,
): string {
  const segs = parseBody(tpl.body);

  // body 中出现的变量名（按首现序去重；字面注入与特殊标记除外）
  const appeared: string[] = [];
  for (const s of segs) {
    if (
      s.kind === "var" &&
      s.name !== "END" &&
      s.name !== "SELECTION" &&
      !(literals && s.name in literals) &&
      !appeared.includes(s.name)
    ) {
      appeared.push(s.name);
    }
  }

  const defs = tpl.variables ?? [];
  const defByName = new Map<string, TemplateVariableDef>(defs.map((d) => [d.name, d]));
  const variableValues = new Map<string, string>();

  // 求值序 = variables 数组序（对齐 PyCharm Edit Variables），随后补 body 中未列出的变量
  const evalOrder: string[] = [
    ...defs.map((d) => d.name).filter((n) => appeared.includes(n)),
    ...appeared.filter((n) => !defByName.has(n)),
  ];

  const resolutions = new Map<string, VarResolution>();
  for (const name of evalOrder) {
    const def = defByName.get(name);
    let resolution: VarResolution = { kind: "placeholder", defaultValue: def?.defaultValue ?? "" };
    if (def?.expression) {
      const evalCtx: EngineContext = { ...ctx, variableValues };
      const value: EvalValue | null = evalExpression(def.expression, evalCtx);
      if (value?.kind === "text") {
        resolution = def.skipIfDefined
          ? { kind: "literal", text: value.text }
          : { kind: "placeholder", defaultValue: value.text };
        variableValues.set(name, value.text);
      } else if (value?.kind === "choices") {
        resolution = { kind: "choices", choices: value.choices };
      } else {
        // complete / 求值失败 → 占位符 + defaultValue（模板在任何上下文都能展开）
        resolution = { kind: "placeholder", defaultValue: def.defaultValue ?? "" };
        if (def.defaultValue !== undefined) variableValues.set(name, def.defaultValue);
      }
    } else if (def?.defaultValue !== undefined) {
      variableValues.set(name, def.defaultValue);
    }
    resolutions.set(name, resolution);
  }

  // 占位符编号：产生占位符/choice 的变量按 evalOrder 序；字面注入与 $END$/$SELECTION$ 不占编号
  const numbers = new Map<string, number>();
  let n = 0;
  for (const name of evalOrder) {
    const r = resolutions.get(name);
    if (r && r.kind !== "literal") numbers.set(name, ++n);
  }

  let out = "";
  for (const s of segs) {
    if (s.kind === "text") {
      out += escapeSnippetText(s.text);
      continue;
    }
    if (s.name === "END") {
      out += "$0";
      continue;
    }
    if (s.name === "SELECTION") {
      // 环绕调用方已预算选区（含缩进处理）→ 字面注入；否则保留 Monaco 选区变量
      out += literals && "SELECTION" in literals ? escapeSnippetText(literals.SELECTION) : "${TM_SELECTED_TEXT}";
      continue;
    }
    if (literals && s.name in literals) {
      out += escapeSnippetText(literals[s.name]);
      continue;
    }
    const r = resolutions.get(s.name);
    if (!r) {
      // 理论上不可达（appeared 全覆盖）；防御性按字面输出
      out += escapeSnippetText(`$${s.name}$`);
      continue;
    }
    if (r.kind === "literal") {
      out += escapeSnippetText(r.text);
      continue;
    }
    const num = numbers.get(s.name);
    if (num === undefined) {
      out += escapeSnippetText(`$${s.name}$`);
      continue;
    }
    if (r.kind === "choices") {
      out += `\${${num}|${r.choices.map(escapeChoiceValue).join(",")}|}`;
    } else {
      out += `\${${num}:${escapeSnippetText(r.defaultValue)}}`;
    }
  }
  return out;
}
