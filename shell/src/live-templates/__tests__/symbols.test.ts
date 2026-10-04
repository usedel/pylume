import { describe, expect, it } from "vitest";
import { resolveScopeFromSymbols } from "../scope";
import { flattenSymbols, SYMBOL_KIND_CLASS, SYMBOL_KIND_FUNCTION, SYMBOL_KIND_METHOD, type RawSymbol } from "../symbols";

const range = (sl: number, el: number) => ({
  start: { line: sl, character: 0 },
  end: { line: el, character: 0 },
});

describe("flattenSymbols", () => {
  it("层级展开 + 0-based → 1-based 行号；range 缺失时用 selectionRange", () => {
    const raw: RawSymbol[] = [
      {
        name: "Foo",
        kind: SYMBOL_KIND_CLASS,
        range: range(0, 9),
        selectionRange: range(0, 0),
        children: [
          { name: "bar", kind: SYMBOL_KIND_METHOD, selectionRange: range(2, 2), range: range(2, 5) },
          { name: "helper", kind: SYMBOL_KIND_FUNCTION, selectionRange: range(7, 7) },
        ],
      },
    ];
    expect(flattenSymbols(raw)).toEqual([
      { name: "Foo", kind: SYMBOL_KIND_CLASS, startLine: 1, endLine: 10 },
      { name: "bar", kind: SYMBOL_KIND_METHOD, startLine: 3, endLine: 6 },
      { name: "helper", kind: SYMBOL_KIND_FUNCTION, startLine: 8, endLine: 8 },
    ]);
  });
});

describe("resolveScopeFromSymbols", () => {
  // class Foo:        L1-10
  //   def bar():      L3-6
  //   x = 1           L8（类体内、方法外）
  const symbols = flattenSymbols([
    {
      name: "Foo",
      kind: SYMBOL_KIND_CLASS,
      range: range(0, 9),
      selectionRange: range(0, 0),
      children: [{ name: "bar", kind: SYMBOL_KIND_METHOD, range: range(2, 5), selectionRange: range(2, 2) }],
    },
    { name: "top_fn", kind: SYMBOL_KIND_FUNCTION, range: range(12, 15), selectionRange: range(12, 12) },
  ]);

  it("方法内 → function + 方法名 + 类名", () => {
    expect(resolveScopeFromSymbols(symbols, 4)).toEqual({
      syntax: "function",
      className: "Foo",
      methodName: "bar",
    });
  });

  it("类体内方法外 → class + 类名", () => {
    expect(resolveScopeFromSymbols(symbols, 8)).toEqual({
      syntax: "class",
      className: "Foo",
      methodName: null,
    });
  });

  it("模块级函数内 → function，无类名", () => {
    expect(resolveScopeFromSymbols(symbols, 14)).toEqual({
      syntax: "function",
      className: null,
      methodName: "top_fn",
    });
  });

  it("模块层 → module", () => {
    expect(resolveScopeFromSymbols(symbols, 20)).toEqual({
      syntax: "module",
      className: null,
      methodName: null,
    });
  });

  it("空符号集 → null（调用方回落启发式）", () => {
    expect(resolveScopeFromSymbols([], 1)).toBeNull();
  });

  it("嵌套函数取最内层", () => {
    const nested = flattenSymbols([
      {
        name: "outer",
        kind: SYMBOL_KIND_FUNCTION,
        range: range(0, 9),
        selectionRange: range(0, 0),
        children: [{ name: "inner", kind: SYMBOL_KIND_FUNCTION, range: range(2, 5), selectionRange: range(2, 2) }],
      },
    ]);
    expect(resolveScopeFromSymbols(nested, 4)?.methodName).toBe("inner");
    expect(resolveScopeFromSymbols(nested, 8)?.methodName).toBe("outer");
  });
});
