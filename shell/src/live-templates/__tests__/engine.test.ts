import { describe, expect, it } from "vitest";
import {
  evalExpression,
  formatDate,
  parseExpression,
  splitWords,
  toCamelCase,
  toKebabCase,
  toSnakeCase,
  templateReferences,
  type EngineContext,
} from "../engine";
import type { TemplateDef } from "../schema";

function ctx(over: Partial<EngineContext> = {}): EngineContext {
  return {
    fileName: "demo.py",
    filePath: "C:/proj/demo.py",
    fileRelativePath: "demo.py",
    className: null,
    methodName: null,
    lineNumber: 10,
    userName: "alice",
    clipboardText: null,
    variableValues: new Map(),
    ...over,
  };
}

const textOf = (src: string, c: EngineContext = ctx()): string | null => {
  const v = evalExpression(src, c);
  return v?.kind === "text" ? v.text : null;
};

describe("splitWords / 大小写变换", () => {
  it("camel 边界与非字母数字切词", () => {
    expect(splitWords("myTextFile")).toEqual(["my", "Text", "File"]);
    expect(splitWords("HTTPServer")).toEqual(["HTTP", "Server"]);
    expect(splitWords("foo_bar-baz")).toEqual(["foo", "bar", "baz"]);
  });
  it("camelCase / snakeCase / kebabCase", () => {
    expect(toCamelCase("my-text-file")).toBe("myTextFile");
    expect(toSnakeCase("MyExampleName")).toBe("my_example_name");
    expect(toKebabCase("MyExampleName")).toBe("my-example-name");
  });
  it("引擎内字符串函数", () => {
    expect(textOf('capitalize("name")')).toBe("Name");
    expect(textOf('decapitalize("Name")')).toBe("name");
    expect(textOf('upper("ab")')).toBe("AB");
    expect(textOf('firstWord("hello world")')).toBe("hello");
    expect(textOf('spacesToUnderscores("a b c")')).toBe("a_b_c");
    expect(textOf('underscoresToCamelCase("foo_bar_baz")')).toBe("fooBarBaz");
    expect(textOf('camelCase("my-text-file")')).toBe("myTextFile");
  });
});

describe("formatDate", () => {
  it("token 子集", () => {
    const d = new Date(2026, 7, 24, 9, 5, 3); // 2026-08-24 09:05:03
    expect(formatDate(d, "yyyy-MM-dd")).toBe("2026-08-24");
    expect(formatDate(d, "HH:mm:ss")).toBe("09:05:03");
    expect(formatDate(d, "yyyy/MM/dd EEE")).toBe("2026/08/24 Mon");
  });
});

describe("parseExpression", () => {
  it("字符串常量 / 函数调用 / 嵌套", () => {
    expect(parseExpression('"abc"')).toEqual({ kind: "str", value: "abc" });
    expect(parseExpression("fileName()")).toEqual({ kind: "call", name: "fileName", args: [] });
    expect(parseExpression('concat(fileName(), " — ", date("yyyy"))')).toEqual({
      kind: "call",
      name: "concat",
      args: [
        { kind: "call", name: "fileName", args: [] },
        { kind: "str", value: " — " },
        { kind: "call", name: "date", args: [{ kind: "str", value: "yyyy" }] },
      ],
    });
  });
  it("语法错误抛异常", () => {
    expect(() => parseExpression('concat("a"')).toThrow();
    expect(() => parseExpression('"未闭合')).toThrow();
    expect(() => parseExpression("1 + 1")).toThrow();
    expect(() => parseExpression('foo() bar')).toThrow();
  });
});

describe("evalExpression", () => {
  it("文件上下文", () => {
    expect(textOf("fileName()")).toBe("demo.py");
    expect(textOf("fileNameWithoutExtension()")).toBe("demo");
    expect(textOf("filePath()")).toBe("C:/proj/demo.py");
    expect(textOf("fileRelativePath()")).toBe("demo.py");
  });
  it("代码上下文：无类/方法时失败", () => {
    expect(textOf("className()")).toBeNull();
    expect(textOf("methodName()")).toBeNull();
    expect(textOf("className()", ctx({ className: "Foo" }))).toBe("Foo");
    expect(textOf("methodName()", ctx({ methodName: "bar" }))).toBe("bar");
  });
  it("环境函数", () => {
    expect(textOf("user()")).toBe("alice");
    expect(textOf("user()", ctx({ userName: "" }))).toBeNull();
    expect(textOf("lineNumber()")).toBe("10");
    expect(textOf("clipboard()")).toBeNull();
    expect(textOf("clipboard()", ctx({ clipboardText: "clip" }))).toBe("clip");
  });
  it("concat / enum / complete", () => {
    expect(textOf('concat("a", "b", "c")')).toBe("abc");
    expect(textOf('concat("a", className())')).toBeNull(); // 任一失败 → 整体失败
    const choices = evalExpression('enum("X", "Y")', ctx());
    expect(choices).toEqual({ kind: "choices", choices: ["X", "Y"] });
    expect(evalExpression("complete()", ctx())).toEqual({ kind: "complete" });
  });
  it("变量引用：已求值变量可被后续引用，未求值失败", () => {
    const c = ctx({ variableValues: new Map([["NAME", "foo"]]) });
    expect(textOf("NAME", c)).toBe("foo");
    expect(textOf("concat(NAME, \"_bar\")", c)).toBe("foo_bar");
    expect(textOf("MISSING", c)).toBeNull();
  });
  it("未知函数 / 日期默认格式", () => {
    expect(textOf("noSuchFn()")).toBeNull();
    expect(textOf("date()")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(textOf("time()")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
  it("regularExpression：全局替换 + 组引用 + 非法模式失败（M4）", () => {
    expect(textOf('regularExpression("foo123bar45", "[0-9]+", "#")')).toBe("foo#bar#");
    expect(textOf('regularExpression("abc", "(a)(b)c", "$2$1")')).toBe("ba");
    expect(textOf('regularExpression("abc", "[")')).toBeNull();
    expect(textOf('regularExpression("abc")')).toBeNull();
  });
});

describe("templateReferences", () => {
  const tpl = {
    variables: [{ name: "C", expression: "clipboard()" }],
  } as unknown as TemplateDef;
  it("识别函数引用", () => {
    expect(templateReferences(tpl, "clipboard")).toBe(true);
    expect(templateReferences(tpl, "date")).toBe(false);
  });
});
