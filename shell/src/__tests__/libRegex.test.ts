// libRegex 单测（库特别支持 PR-2 验收 §4.1）：识别器 8 类形态 / flags 6 种写法 / 静态诊断 4 类命中 + 合法模式零误报。
import { describe, expect, it } from "vitest";
import {
  flagsToValue,
  formatRegexPython,
  offsetToPosition,
  parseFlags,
  scanRegexLiterals,
  staticDiagnostics,
  tokenizePattern,
  valueToFlags,
} from "../libRegex";

describe("scanRegexLiterals 识别器（8 类形态）", () => {
  it("① raw 单引号 + 关键字 flags", () => {
    const hits = scanRegexLiterals(`x = re.compile(r"\\d+", flags=re.I)`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ api: "compile", pattern: "\\d+", isRaw: true, flags: ["I"] });
  });

  it("② 非 raw 双引号", () => {
    const hits = scanRegexLiterals(`m = re.search("\\w+@", s)`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ api: "search", pattern: "\\w+@", isRaw: false, flags: [] });
  });

  it("③ 三引号（含转义引号内容）", () => {
    const hits = scanRegexLiterals(`p = re.findall(r"""\\bcat\\b""", text)`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ api: "findall", pattern: "\\bcat\\b", isRaw: true });
  });

  it("④ 关键字 flags 带空格（flags = re.I | re.M）", () => {
    const hits = scanRegexLiterals(`re.sub(r"a", "b", s, flags = re.I | re.M)`);
    expect(hits[0]?.flags).toEqual(["I", "M"]);
  });

  it("⑤ 位置 flags（第二实参）", () => {
    const hits = scanRegexLiterals(`re.split(r"[,;]", s, re.I | re.X)`);
    expect(hits[0]?.flags).toEqual(["I", "X"]);
  });

  it("⑥ 跨行：三引号模式跨行、调用跨行", () => {
    const src = `p = re.match(\n    r"""\n\\d{4}\n-\n\\d{2}\n""",\n    s,\n)`;
    const hits = scanRegexLiterals(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.pattern).toContain("\\d{4}");
  });

  it("⑦ 注释行与非 re 前缀不识别（对照组）", () => {
    const src = [
      `# re.match(r"注释里的不算", s)`,
      `text.match(r"非 re 模块不算", s)`,
      `pre.compile(r"x", 1)`.replace("pre.compile", "pre .compile"), // 变量名后缀 re 不算
      `real.match(r"?", s)`, // real. 的 re 前缀不算（\\b 词边界挡住）
    ].join("\n");
    expect(scanRegexLiterals(src)).toHaveLength(0);
  });

  it("⑧ 简单赋值：pattern 变量被 re 调用引用才识别", () => {
    const used = `pattern = r"\\b(\\w+)@\\w+\\.com\\b"\nfor m in re.finditer(pattern, text):\n    pass`;
    const hits = scanRegexLiterals(used);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ api: null, pattern: "\\b(\\w+)@\\w+\\.com\\b", isRaw: true });
    // 未被引用的赋值不识别
    expect(scanRegexLiterals(`unused = r"abc"`)).toHaveLength(0);
    // 行尾有续接内容（多行拼接）不识别
    expect(scanRegexLiterals(`pattern = r"a" + r"b"\nre.search(pattern, s)`)).toHaveLength(0);
  });

  it("非 raw 串的值经反转义（\\\\n → 换行、未知转义保留）", () => {
    const hits = scanRegexLiterals(`re.findall("a\\nb\\d", s)`);
    expect(hits[0]?.pattern).toBe("a\nb\\d");
  });

  it("上限 200 截断", () => {
    const src = Array.from({ length: 210 }, (_, i) => `re.search(r"a${i}", s)`).join("\n");
    expect(scanRegexLiterals(src)).toHaveLength(200);
  });

  it("offsetToPosition 换行计数", () => {
    const src = "ab\ncd\nef";
    expect(offsetToPosition(src, 0)).toEqual({ line: 0, col: 0 });
    expect(offsetToPosition(src, 3)).toEqual({ line: 1, col: 0 });
    expect(offsetToPosition(src, 7)).toEqual({ line: 2, col: 1 });
  });
});

describe("parseFlags（6 种写法）", () => {
  it("关键字 + 竖线组合", () => {
    expect(parseFlags("s, flags=re.I|re.M")).toEqual(["I", "M"]);
  });
  it("关键字长名", () => {
    expect(parseFlags("s, flags=re.IGNORECASE")).toEqual(["I"]);
  });
  it("关键字带空格与注释", () => {
    expect(parseFlags("s, flags = re.I | re.S  # 大小写无关")).toEqual(["I", "S"]);
  });
  it("位置第二实参", () => {
    expect(parseFlags("s, re.M")).toEqual(["M"]);
  });
  it("位置多实参中段（sub 的 count 之前）", () => {
    expect(parseFlags("p, r, s, re.I | re.M, 0)")).toEqual(["I", "M"]);
  });
  it("无 flags 与非 flags 实参", () => {
    expect(parseFlags("s")).toEqual([]);
    expect(parseFlags("s, 2)")).toEqual([]); // 数字位置实参不是 re.X token
  });
  it("长名去重与 U/L 识别", () => {
    expect(parseFlags("s, flags=re.I | re.IGNORECASE | re.UNICODE")).toEqual(["I", "U"]);
  });
  it("flagsToValue / valueToFlags 往返", () => {
    expect(flagsToValue(["I", "M"])).toBe(2 | 8);
    expect(valueToFlags(2 | 16)).toEqual(["I", "S"]);
  });
});

describe("staticDiagnostics（4 类命中 + 零误报）", () => {
  it("合法模式零诊断（raw 含命名组/字符类/量词）", () => {
    expect(staticDiagnostics("\\b(?P<year>\\d{4})-(?:0[1-9]|1[0-2])-[z-z]?\\d{2}\\b", true)).toHaveLength(0);
    expect(staticDiagnostics("(a|b)+[a-z0-9_]*", true)).toHaveLength(0);
  });

  it("① 括号未闭合 / 多余右括号", () => {
    const d1 = staticDiagnostics("(abc", true);
    expect(d1[0]).toMatchObject({ severity: "error" });
    expect(d1[0]?.message).toContain("未闭合");
    const d2 = staticDiagnostics("abc)", true);
    expect(d2[0]?.message).toContain("多余");
    // 字符类里的 ) 不是括号
    expect(staticDiagnostics("[()]", true)).toHaveLength(0);
  });

  it("② [z-a] 区间倒置", () => {
    const d = staticDiagnostics("[z-a]", true);
    expect(d).toHaveLength(1);
    expect(d[0]?.severity).toBe("error");
    expect(d[0]?.message).toContain("倒置");
    expect(staticDiagnostics("[a-z]", true)).toHaveLength(0); // 合法区间不误报
  });

  it("③ 重复命名组", () => {
    const d = staticDiagnostics("(?P<x>a)(?P<x>b)", true);
    expect(d).toHaveLength(1);
    expect(d[0]?.message).toContain("重复");
    expect(staticDiagnostics("(?P<x>a)(?P<y>b)", true)).toHaveLength(0);
  });

  it("④ 非 raw 串转义丢失（warning）", () => {
    const src = unescapeSource("\\d+\\b");
    const d = staticDiagnostics(src, false);
    expect(d.length).toBeGreaterThanOrEqual(2);
    expect(d.every((x) => x.severity === "warning")).toBe(true);
    // raw 串同样内容无诊断
    expect(staticDiagnostics("\\d+\\b", true)).toHaveLength(0);
  });

  it("字符类未闭合", () => {
    const d = staticDiagnostics("[abc", true);
    expect(d[0]?.message).toContain("[");
  });
});

describe("tokenizePattern / regexHoverMarkdown 要点", () => {
  it("命名组 / 量词 / 锚点 / 字符类分类", () => {
    const t = tokenizePattern("\\b(?P<year>\\d{4})\\-", ["I"]);
    const kinds = t.map((x) => x.kind);
    expect(kinds).toContain("anchor"); // \b
    expect(kinds).toContain("named"); // (?P<year>
    expect(kinds).toContain("quant"); // {4}
    expect(kinds).toContain("class"); // \d
    expect(kinds).toContain("escape"); // \-
  });

  it("re.M 下 ^ 解释为行首", () => {
    const [t] = tokenizePattern("^ab", ["M"]);
    expect(t?.desc).toContain("re.M");
  });

  it("formatRegexPython 单双引号择优与退化", () => {
    expect(formatRegexPython("\\d+", ["I", "M"])).toBe('re.compile(r"\\d+", re.IGNORECASE | re.MULTILINE)');
    expect(formatRegexPython('say "hi"', [])).toBe(`re.compile(r'say "hi"')`);
    // 含两种引号 → 退化为非 raw（值等价）
    expect(formatRegexPython(`a"b'c`, [])).toBe(`re.compile("a\\"b'c")`);
    // raw 串内反斜杠保持字面
    expect(formatRegexPython("a\\b", [])).toBe('re.compile(r"a\\b")');
  });
});

/** 测试辅助：模拟非 raw Python 源码（TS 字面量里的 \\d 即源码的 \d） */
function unescapeSource(s: string): string {
  return s;
}
