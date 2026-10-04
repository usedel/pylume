import { describe, expect, it } from "vitest";
import { jsonToPythonLiteral, looksLikeJson } from "../pasteJson";

// PR-M（dx_features_backlog §6.6）：粘贴 JSON → Python dict 字面量
describe("looksLikeJson", () => {
  it("对象/数组形似；标量与普通文本不形似", () => {
    expect(looksLikeJson('{"a": 1}')).toBe(true);
    expect(looksLikeJson("  [1, 2]  ")).toBe(true);
    expect(looksLikeJson("true")).toBe(false);
    expect(looksLikeJson("hello {world")).toBe(false);
  });
});

describe("jsonToPythonLiteral", () => {
  it("嵌套对象：true/false/null → True/False/None，4 空格缩进 + 尾逗号", () => {
    const out = jsonToPythonLiteral('{"a": true, "b": {"c": false, "d": null}}');
    expect(out).toBe(
      [
        "{",
        '    "a": True,',
        '    "b": {',
        '        "c": False,',
        '        "d": None,',
        "    },",
        // 顶层收尾无尾逗号（pad + "}"），内层闭合才有
        "}",
      ].join("\n"),
    );
  });

  it("数组（含空数组/空对象）", () => {
    expect(jsonToPythonLiteral("[1, \"x\", [2, 3]]")).toBe(
      ["[", '    1,', '    "x",', "    [", "        2,", "        3,", "    ],", "]"].join("\n"),
    );
    expect(jsonToPythonLiteral("[]")).toBe("[]");
    expect(jsonToPythonLiteral("{}")).toBe("{}");
  });

  it("字符串转义：引号/反斜杠/换行/Unicode 保留为 Python 合法字面量", () => {
    // JSON.parse 解码后 JSON.stringify 直接输出中文字符（不回写 \u 转义，同为 Python 合法字面量）
    const out = jsonToPythonLiteral('{"s": "a\\"b\\\\c\\n\\u4e2d"}');
    expect(out).toContain('"a\\"b\\\\c\\n中"');
  });

  it("数字原样（整数/浮点/负数/指数）", () => {
    expect(jsonToPythonLiteral('{"i": 42, "f": 3.5, "n": -1, "e": 1e3}')).toContain('"i": 42,');
    expect(jsonToPythonLiteral('{"f": 3.5}')).toContain('"f": 3.5,');
    expect(jsonToPythonLiteral('{"n": -1}')).toContain('"n": -1,');
  });

  it("非对象/数组标量返回 null（true / 42 / 「字符串」不改写）", () => {
    expect(jsonToPythonLiteral("true")).toBe(null);
    expect(jsonToPythonLiteral("42")).toBe(null);
    expect(jsonToPythonLiteral('"just a string"')).toBe(null);
    expect(jsonToPythonLiteral("null")).toBe(null);
  });

  it("非法 JSON 返回 null", () => {
    expect(jsonToPythonLiteral("{a: 1}")).toBe(null);
    expect(jsonToPythonLiteral('{"a": }')).toBe(null);
    expect(jsonToPythonLiteral('{"a": 1')).toBe(null);
  });

  it("转换结果经 Python 语义检查：无 true/false/null 残留（布尔键情形除外）", () => {
    const out = jsonToPythonLiteral('[{"ok": true, "err": false, "val": null}]');
    expect(out).not.toMatch(/:\s*true\b/);
    expect(out).not.toMatch(/:\s*false\b/);
    expect(out).toContain("True");
    expect(out).toContain("False");
    expect(out).toContain("None");
  });
});
