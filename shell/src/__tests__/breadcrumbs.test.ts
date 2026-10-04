// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { symbolChainAt } from "../breadcrumbs";
import { LspSymbolKind } from "../util";
import type { LspDocumentSymbol } from "../lsp/client";

/** 0 基行号（LSP 口径）→ range；selectionRange 默认取 range 起点的 1 行 */
function sym(
  name: string,
  start0: number,
  end0: number,
  kind = LspSymbolKind.Function,
  children?: LspDocumentSymbol[],
): LspDocumentSymbol {
  const range = { start: { line: start0, character: 0 }, end: { line: end0, character: 0 } };
  return { name, kind, range, selectionRange: range, children };
}

describe("symbolChainAt 面包屑层级链", () => {
  it("光标不在任何符号内时返回空链（面包屑只剩文件名）", () => {
    const tree = [sym("f", 10, 20)];
    expect(symbolChainAt(tree, 1)).toEqual([]);
  });

  it("命中顶层符号返回单元素链", () => {
    const tree = [sym("f", 10, 20)];
    expect(symbolChainAt(tree, 15)).toEqual([{ name: "f", kind: LspSymbolKind.Function, line: 11 }]);
  });

  it("嵌套时返回由外到内的完整链", () => {
    const tree = [
      sym("Spider", 0, 30, LspSymbolKind.Class, [
        sym("parse", 5, 12),
        sym("run", 14, 28),
      ]),
    ];
    expect(symbolChainAt(tree, 7).map((x) => x.name)).toEqual(["Spider", "parse"]);
    expect(symbolChainAt(tree, 20).map((x) => x.name)).toEqual(["Spider", "run"]);
  });

  it("边界行取闭区间（首行 / 末行都算在符号内）", () => {
    const tree = [sym("f", 10, 20)];
    expect(symbolChainAt(tree, 11)).toHaveLength(1);
    expect(symbolChainAt(tree, 21)).toHaveLength(1);
    expect(symbolChainAt(tree, 10)).toHaveLength(0); // range 前一行
    expect(symbolChainAt(tree, 22)).toHaveLength(0); // range 后一行
  });

  it("range 缺失时退化为按 selectionRange 精确匹配", () => {
    const sel = { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } };
    const s: LspDocumentSymbol = { name: "x", kind: LspSymbolKind.Variable, selectionRange: sel };
    expect(symbolChainAt([s], 5).map((x) => x.name)).toEqual(["x"]);
    expect(symbolChainAt([s], 6)).toEqual([]);
  });

  it("多个顶层符号时只取覆盖光标的那个", () => {
    const tree = [sym("a", 0, 5), sym("b", 6, 12), sym("c", 13, 20)];
    expect(symbolChainAt(tree, 8).map((x) => x.name)).toEqual(["b"]);
  });
});
