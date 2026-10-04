import { describe, expect, it } from "vitest";
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { buildDocstring, enclosingSignature } from "../docstring";

type Model = MonacoApi.editor.ITextModel;

function model(lines: string[]): Model {
  return { getLineContent: (n: number) => lines[n - 1] ?? "" } as unknown as Model;
}

describe("`\"\"\"` + Enter docstring 自动生成", () => {
  it("单行 def 签名 → Args/Returns（过滤 self/cls、去注解/默认值/变参前缀）", () => {
    const m = model([
      "def scrape(self, url: str, timeout: int = 10, *args, **kwargs):",
      '    """',
    ]);
    const sig = enclosingSignature(m, 2);
    expect(sig).not.toBeNull();
    expect(sig!.kind).toBe("def");
    expect(sig!.args).toEqual(["url", "timeout", "args", "kwargs"]);
    expect(sig!.indent).toBe("    ");
  });

  it("async def 与返回注解", () => {
    const m = model(["async def fetch(url) -> dict:", '    """']);
    const sig = enclosingSignature(m, 2);
    expect(sig!.kind).toBe("def");
    expect(sig!.args).toEqual(["url"]);
  });

  it("class 签名 → Attributes", () => {
    const m = model(["class Scraper(Base):", '    """']);
    const sig = enclosingSignature(m, 2);
    expect(sig!.kind).toBe("class");
    expect(sig!.args).toEqual([]);
  });

  it("非块体首行（上一非空行非块头）→ null", () => {
    const m = model(["x = 1", '    """']);
    expect(enclosingSignature(m, 2)).toBeNull();
  });

  it("多行参数（默认值含顶层括号逗号）正确分割", () => {
    const m = model(["def f(a=(1, 2), b):", '    """']);
    const sig = enclosingSignature(m, 2);
    expect(sig!.args).toEqual(["a", "b"]);
  });

  it("buildDocstring def 输出形状", () => {
    const doc = buildDocstring({ indent: "    ", args: ["a", "b"], kind: "def" });
    expect(doc).toContain('    """');
    expect(doc).toContain("Args:");
    expect(doc).toContain("        a: ");
    expect(doc).toContain("        b: ");
    expect(doc).toContain("Returns:");
  });

  it("buildDocstring class 输出形状", () => {
    const doc = buildDocstring({ indent: "    ", args: [], kind: "class" });
    expect(doc).toContain("Attributes:");
  });
});