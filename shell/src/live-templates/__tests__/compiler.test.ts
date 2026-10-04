import { describe, expect, it } from "vitest";
import { compileTemplate, escapeSnippetText, parseBody } from "../compiler";
import type { EngineContext } from "../engine";
import type { TemplateDef } from "../schema";

function ctx(over: Partial<EngineContext> = {}): EngineContext {
  return {
    fileName: "demo.py",
    filePath: "C:/proj/demo.py",
    fileRelativePath: "demo.py",
    className: "Foo",
    methodName: "bar",
    lineNumber: 3,
    userName: "alice",
    clipboardText: null,
    variableValues: new Map(),
    ...over,
  };
}

function tpl(body: string, variables?: TemplateDef["variables"], over: Partial<TemplateDef> = {}): TemplateDef {
  return {
    id: "t",
    abbreviation: "t",
    description: "",
    body,
    scopes: ["python:module"],
    kind: "normal",
    enabled: true,
    tabExpand: true,
    variables,
    ...over,
  };
}

describe("parseBody", () => {
  it("$$ → 字面 $；未闭合 $ → 字面", () => {
    expect(parseBody("a$$b")).toEqual([
      { kind: "text", text: "a$b" },
    ]);
    expect(parseBody("price $5")).toEqual([{ kind: "text", text: "price $5" }]);
  });
  it("变量切分", () => {
    expect(parseBody("x=$V$ end")).toEqual([
      { kind: "text", text: "x=" },
      { kind: "var", name: "V" },
      { kind: "text", text: " end" },
    ]);
  });
});

describe("escapeSnippetText", () => {
  it("转义 \\ $ }", () => {
    expect(escapeSnippetText('a\\b$c}d')).toBe("a\\\\b\\$c\\}d");
  });
});

describe("compileTemplate", () => {
  it("编号按 variables 数组序；$END$ → $0", () => {
    const out = compileTemplate(
      tpl("def $NAME$($ARGS$):\n    $END$", [
        { name: "NAME", defaultValue: "name" },
        { name: "ARGS" },
      ]),
      ctx(),
    );
    expect(out).toBe("def ${1:name}(${2:}):\n    $0");
  });

  it("未列出的变量排在列出者之后（按首现序）", () => {
    const out = compileTemplate(
      tpl("$A$ $B$ $C$", [{ name: "C", defaultValue: "c" }]),
      ctx(),
    );
    expect(out).toBe("${2:} ${3:} ${1:c}");
  });

  it("同名变量多处出现 → 同一编号（镜像）", () => {
    const out = compileTemplate(tpl("$X$ and $X$", [{ name: "X", defaultValue: "v" }]), ctx());
    expect(out).toBe("${1:v} and ${1:v}");
  });

  it("表达式求值成功 → 占位符默认值；skipIfDefined → 字面注入", () => {
    const out = compileTemplate(
      tpl("# $FILE$ by $USER$\n$END$", [
        { name: "FILE", expression: "fileName()", skipIfDefined: true },
        { name: "USER", expression: "user()" },
      ]),
      ctx(),
    );
    expect(out).toBe("# demo.py by ${1:alice}\n$0");
  });

  it("字面注入内容被转义", () => {
    const out = compileTemplate(
      tpl("v=$V$", [{ name: "V", expression: 'concat("a$b", "}")', skipIfDefined: true }]),
      ctx(),
    );
    expect(out).toBe("v=a\\$b\\}");
  });

  it("表达式失败 → defaultValue", () => {
    const out = compileTemplate(
      tpl("c=$C$", [{ name: "C", expression: "className()", defaultValue: "Fallback" }]),
      ctx({ className: null }),
    );
    expect(out).toBe("c=${1:Fallback}");
  });

  it("enum → choice 语法", () => {
    const out = compileTemplate(
      tpl("except $EXC$:", [
        { name: "EXC", expression: 'enum("Exception", "ValueError")', defaultValue: "Exception" },
      ]),
      ctx(),
    );
    expect(out).toBe("except ${1|Exception,ValueError|}:");
  });

  it("$SELECTION$ → ${TM_SELECTED_TEXT}；$$ → \\$", () => {
    const out = compileTemplate(tpl("cost = $$5\n$SELECTION$", undefined), ctx());
    expect(out).toBe("cost = \\$5\n${TM_SELECTED_TEXT}");
  });

  it("变量引用：后定义变量可引用先定义变量的求值结果", () => {
    const out = compileTemplate(
      tpl("$A$ $B$", [
        { name: "A", expression: '"foo"', skipIfDefined: true },
        { name: "B", expression: "concat(A, \"_bar\")" },
      ]),
      ctx(),
    );
    expect(out).toBe("foo ${1:foo_bar}");
  });

  it("complete() → 空占位符", () => {
    const out = compileTemplate(tpl("x=$X$", [{ name: "X", expression: "complete()" }]), ctx());
    expect(out).toBe("x=${1:}");
  });

  it("literals 字面注入（M3）：$EXPR$ 替换为转义文本，不占编号", () => {
    const out = compileTemplate(
      tpl("for $ITEM$ in $EXPR$:\n    $END$", [{ name: "ITEM", defaultValue: "item" }]),
      ctx(),
      { EXPR: "items.get($k)" },
    );
    expect(out).toBe("for ${1:item} in items.get(\\$k):\n    $0");
  });

  it("literals.SELECTION 覆盖 ${TM_SELECTED_TEXT}", () => {
    const out = compileTemplate(tpl("try:\n    $SELECTION$\n$END$"), ctx(), { SELECTION: "foo()" });
    expect(out).toBe("try:\n    foo()\n$0");
  });
});
