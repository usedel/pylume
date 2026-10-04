import { describe, expect, it } from "vitest";
import { TemplateRegistry } from "../registry";
import type { TemplateDef, TemplatesFile } from "../schema";
import type { SyntaxContext } from "../scope";

// 注意：registry 合并时内置模板恒在底层，以下断言均按「包含内置」的生效集书写。

const PY = ["python:module", "python:class", "python:function"];

function tpl(partial: Partial<TemplateDef> & { abbreviation: string }): TemplateDef {
  return {
    id: partial.id ?? `t.${partial.kind ?? "normal"}.${partial.abbreviation}`,
    description: partial.abbreviation,
    body: partial.body ?? "x$END$",
    scopes: PY,
    kind: "normal",
    enabled: true,
    tabExpand: true,
    ...partial,
  };
}

function file(templates: TemplateDef[], ordering?: Record<string, string[]>): TemplatesFile {
  return { version: 2, templates, ordering };
}

function ctx(
  syntax: "module" | "class" | "function" = "module",
  position: SyntaxContext["position"] = "statement",
): SyntaxContext {
  return { syntax, position, className: null, methodName: null };
}

describe("TemplateRegistry（M3 kind 分域）", () => {
  it("同缩写可分属 插入/环绕/后缀 三范式且互不干扰", () => {
    const r = new TemplateRegistry();
    r.rebuild(
      file([
        tpl({ abbreviation: "try", kind: "normal", body: "custom$END$" }),
        tpl({ abbreviation: "newpf", kind: "postfix", postfixKey: "zz", body: "$EXPR$" }),
      ]),
      null,
    );
    // 用户层 normal try 覆盖内置（body 可辨识）
    expect(r.findByAbbreviation("try", ctx())?.body).toBe("custom$END$");
    // 内置环绕 try 不受 normal 覆盖影响，仍存在
    expect(r.findSurround("python:module").some((t) => t.abbreviation === "try")).toBe(true);
    // 后缀：内置 + 用户新增；前缀过滤生效
    expect(r.findPostfixByPrefix("python:module", "zz").map((t) => t.postfixKey)).toEqual(["zz"]);
    // templatesForScope 仅含插入模板
    expect(r.templatesForScope("python:module").every((t) => t.kind === "normal")).toBe(true);
  });

  it("后缀按已键入前缀过滤（含内置模板）", () => {
    const r = new TemplateRegistry();
    r.rebuild(null, null);
    const keysI = r.findPostfixByPrefix("python:module", "i").map((t) => t.postfixKey ?? "");
    expect(keysI).toContain("if");
    expect(keysI).toContain("int");
    expect(keysI).not.toContain("print");
    expect(r.findPostfixByPrefix("python:module", "noexistent")).toEqual([]);
  });

  it("工作区层墓碑可禁用内置模板，且不影响其他 kind", () => {
    const r = new TemplateRegistry();
    r.rebuild(
      null,
      file([tpl({ abbreviation: "try", kind: "normal", enabled: false })]),
    );
    expect(r.findByAbbreviation("try", ctx())).toBeNull();
    // 环绕 try（内置）不受插入 try 的墓碑影响
    expect(r.findSurround("python:module").some((t) => t.abbreviation === "try")).toBe(true);
  });

  it("listEffective 按 (kind, abbreviation) 聚合", () => {
    const r = new TemplateRegistry();
    r.rebuild(null, null);
    const tryEntries = r.listEffective().filter((e) => e.abbreviation === "try");
    // 内置含 插入/环绕/后缀 三个 try
    expect(tryEntries.map((e) => e.kind).sort()).toEqual(["normal", "postfix", "surround"]);
  });

  it("位置轴：name 位置抑制一切模板；expression 位置抑制 statement-only", () => {
    const r = new TemplateRegistry();
    r.rebuild(null, null);
    expect(r.templatesForContext(ctx("module", "name"))).toEqual([]);
    const exprAbbrs = r.templatesForContext(ctx("module", "expression")).map((t) => t.abbreviation);
    expect(exprAbbrs).not.toContain("main");
    expect(exprAbbrs).not.toContain("def");
    expect(exprAbbrs).toContain("print");
    expect(
      r.templatesForContext(ctx("module", "statement")).some((t) => t.abbreviation === "main"),
    ).toBe(true);
  });

  it("禁用模板仍保留其分组（墓碑携带 group），支撑整组筛选与整组恢复", () => {
    const r = new TemplateRegistry();
    // 用户层对内置爬虫模板 reqget 写墓碑；manager.makeTombstone 约定墓碑携带原模板 group
    r.rebuild(
      file([
        tpl({ abbreviation: "reqget", kind: "normal", enabled: false, body: "-", group: "爬虫" }),
      ]),
      null,
    );
    const entry = r.listEffective().find((e) => e.abbreviation === "reqget" && e.kind === "normal");
    expect(entry, "禁用模板仍应出现在管理面板").toBeTruthy();
    expect(entry?.enabled).toBe(false);
    expect(entry?.group, "禁用后仍属「爬虫」组，才能被分组筛选命中并整组恢复").toBe("爬虫");
  });
});
