import { describe, expect, it } from "vitest";
import { migrateV1, parseTemplatesFile, vscodeSnippetToDollarVars } from "../schema";

describe("parseTemplatesFile（Schema v2）", () => {
  it("合法条目保留，非法条目跳过并记录原因", () => {
    const raw = JSON.stringify({
      version: 2,
      templates: [
        {
          id: "u1",
          abbreviation: "foo",
          description: "foo tpl",
          body: "print($END$)",
          scopes: ["python:module"],
          tabExpand: false,
        },
        { abbreviation: "bad abbr!", body: "x" }, // 缩写非法
        { abbreviation: "nobody", scopes: ["python:module"] }, // body 缺失
        { abbreviation: "badscope", body: "x", scopes: ["java:module"] }, // scope 非法
      ],
      ordering: { "python:module": ["foo"] },
    });
    const parsed = parseTemplatesFile(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.file.templates).toHaveLength(1);
    expect(parsed!.file.templates[0].abbreviation).toBe("foo");
    expect(parsed!.file.templates[0].tabExpand).toBe(false);
    expect(parsed!.errors).toHaveLength(3);
    expect(parsed!.file.ordering).toEqual({ "python:module": ["foo"] });
  });

  it("variables 宽松校验：非法变量丢弃，skipIfDefined 归一", () => {
    const raw = JSON.stringify({
      version: 2,
      templates: [
        {
          abbreviation: "t",
          body: "$A$",
          scopes: ["python:function"],
          variables: [
            { name: "A", expression: "fileName()", defaultValue: "x", skipIfDefined: true },
            { name: "1bad" },
            "junk",
          ],
        },
      ],
    });
    const parsed = parseTemplatesFile(raw)!;
    expect(parsed.file.templates[0].variables).toEqual([
      { name: "A", expression: "fileName()", defaultValue: "x", skipIfDefined: true },
    ]);
  });

  it("JSON 非法 / 结构不符 → null", () => {
    expect(parseTemplatesFile("{oops")).toBeNull();
    expect(parseTemplatesFile(JSON.stringify({ version: 3 }))).toBeNull();
    expect(parseTemplatesFile(JSON.stringify([1, 2]))).toBeNull();
  });

  it("M3 范式校验：环绕须含 $SELECTION$，后缀须有合法 postfixKey", () => {
    const raw = JSON.stringify({
      version: 2,
      templates: [
        { abbreviation: "s1", body: "no selection marker", scopes: ["python:module"], kind: "surround" },
        { abbreviation: "s2", body: "[$SELECTION$]", scopes: ["python:module"], kind: "surround" },
        { abbreviation: "p1", body: "$EXPR$", scopes: ["python:module"], kind: "postfix" },
        { abbreviation: "p2", body: "$EXPR$", scopes: ["python:module"], kind: "postfix", postfixKey: "if" },
      ],
    });
    const parsed = parseTemplatesFile(raw)!;
    expect(parsed.file.templates.map((t) => t.abbreviation)).toEqual(["s2", "p2"]);
    expect(parsed.file.templates[1].postfixKey).toBe("if");
    expect(parsed.errors).toHaveLength(2);
  });

  it("同缩写不同 kind 可共存（去重键含 kind）", () => {
    const raw = JSON.stringify({
      version: 2,
      templates: [
        { abbreviation: "try", body: "x", scopes: ["python:module"] },
        { abbreviation: "try", body: "$SELECTION$", scopes: ["python:module"], kind: "surround" },
      ],
    });
    const parsed = parseTemplatesFile(raw)!;
    expect(parsed.file.templates).toHaveLength(2);
    expect(parsed.errors).toHaveLength(0);
  });

  it("group 字段解析：非空字符串保留并 trim，缺失/空白为 undefined", () => {
    const raw = JSON.stringify({
      version: 2,
      templates: [
        { abbreviation: "g1", body: "x", scopes: ["python:module"], group: "crawler" },
        { abbreviation: "g2", body: "x", scopes: ["python:module"], group: "  " },
        { abbreviation: "g3", body: "x", scopes: ["python:module"] },
      ],
    });
    const parsed = parseTemplatesFile(raw)!;
    expect(parsed.file.templates[0].group).toBe("crawler");
    expect(parsed.file.templates[1].group).toBeUndefined();
    expect(parsed.file.templates[2].group).toBeUndefined();
  });
});

describe("vscodeSnippetToDollarVars", () => {
  it("${n:ph} → $PH$；$0 → $END$", () => {
    const { body, variables } = vscodeSnippetToDollarVars("def ${1:name}(${2:args}):\n    $0");
    expect(body).toBe("def $NAME$($ARGS$):\n    $END$");
    expect(variables).toEqual([
      { name: "NAME", defaultValue: "name" },
      { name: "ARGS", defaultValue: "args" },
    ]);
  });
  it("同一编号 → 同一变量名（镜像保留）；空占位符命名 V2", () => {
    const { body, variables } = vscodeSnippetToDollarVars("try:\n    $1\nexcept $1\n$2");
    expect(body).toBe("try:\n    $V1$\nexcept $V1$\n$V2$");
    expect(variables.map((v) => v.name)).toEqual(["V1", "V2"]);
  });
});

describe("migrateV1", () => {
  it("priority → python: 前缀 ordering；模板转换", () => {
    const file = migrateV1({
      templates: {
        main: { label: "if __name__", body: 'if __name__ == "__main__":\n    $0' },
      },
      priority: { module: ["main"], class: ["main"] },
    });
    expect(file.version).toBe(2);
    expect(file.templates[0]).toMatchObject({
      id: "builtin.main",
      abbreviation: "main",
      description: "if __name__",
      body: 'if __name__ == "__main__":\n    $END$',
      scopes: ["python:module", "python:class", "python:function"],
      tabExpand: true,
    });
    expect(file.ordering).toEqual({
      "python:module": ["main"],
      "python:class": ["main"],
    });
  });

  it("v1 文件经 parseTemplatesFile 自动走迁移分支", () => {
    const raw = JSON.stringify({
      templates: { def: { label: "def function", body: "def ${1:name}():\n    $0" } },
      priority: { function: ["def"] },
    });
    const parsed = parseTemplatesFile(raw)!;
    expect(parsed.file.templates[0].abbreviation).toBe("def");
    expect(parsed.file.templates[0].body).toBe("def $NAME$():\n    $END$");
  });
});
