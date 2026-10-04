import { describe, expect, it } from "vitest";
import { extractExprBeforeDot } from "../postfix";

const extract = (line: string): ReturnType<typeof extractExprBeforeDot> =>
  extractExprBeforeDot(line, line.lastIndexOf("."));

describe("extractExprBeforeDot", () => {
  it("简单标识符 / 属性链", () => {
    expect(extract("foo.if")).toEqual({ expr: "foo", startCol0: 0 });
    expect(extract("foo.bar.if")).toEqual({ expr: "foo.bar", startCol0: 0 });
    expect(extract("x = foo.if")).toEqual({ expr: "foo", startCol0: 4 });
  });

  it("调用与下标（配对括号）", () => {
    expect(extract("foo().if")).toEqual({ expr: "foo()", startCol0: 0 });
    expect(extract("a[0].if")).toEqual({ expr: "a[0]", startCol0: 0 });
    expect(extract("f(g(x))[i].if")).toEqual({ expr: "f(g(x))[i]", startCol0: 0 });
  });

  it("字符串（含前缀）", () => {
    expect(extract('"hello".if')).toEqual({ expr: '"hello"', startCol0: 0 });
    expect(extract('f"hi".if')).toEqual({ expr: 'f"hi"', startCol0: 0 });
  });

  it("非法场景返回 null", () => {
    expect(extract(".if")).toBeNull(); // 点前无内容
    expect(extract("foo .if")).toBeNull(); // 空格隔开
    expect(extract("foo..if")).toBeNull(); // 连续点
    expect(extract("foo).if")).toBeNull(); // 右括号无配对
    expect(extract("a].if")).toBeNull(); // 右方括号无配对
    expect(extract('"abc.if')).toBeNull(); // 字符串未闭合
  });

  it("未闭合左括号不影响其后的合法表达式提取", () => {
    expect(extract("(foo.if")).toEqual({ expr: "foo", startCol0: 1 });
  });

  it("行中表达式起点正确（列号用于补全 range）", () => {
    const line = "result = items.filter(x).if";
    const dot = line.lastIndexOf(".");
    expect(extractExprBeforeDot(line, dot)).toEqual({ expr: "items.filter(x)", startCol0: 9 });
  });
});
