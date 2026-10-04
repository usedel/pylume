// pyLiteral（JSON 值 → Python 字面量单一实现）纯函数单测：
// 覆盖 curl2python fmtDict 收口的三值缺陷（true/false/null）与嵌套/空容器/标量边界。
import { describe, expect, it } from "vitest";
import { pythonLiteralOf } from "../pyLiteral";

describe("pythonLiteralOf（JSON 值 → Python 字面量）", () => {
  it("三值转换：true→True / false→False / null→None", () => {
    expect(pythonLiteralOf({ active: true, off: false, x: null })).toBe(
      '{\n    "active": True,\n    "off": False,\n    "x": None,\n}',
    );
  });

  it("嵌套对象/数组保留结构，缩进 4 空格、尾逗号收内层", () => {
    expect(pythonLiteralOf({ a: [1, { b: "s" }] })).toBe(
      '{\n    "a": [\n        1,\n        {\n            "b": "s",\n        },\n    ],\n}',
    );
  });

  it("空容器与标量：{} / [] / 数字 / 字符串 / 顶层三值", () => {
    expect(pythonLiteralOf({})).toBe("{}");
    expect(pythonLiteralOf([])).toBe("[]");
    expect(pythonLiteralOf(42)).toBe("42");
    expect(pythonLiteralOf('he"llo')).toBe('"he\\"llo"');
    expect(pythonLiteralOf(true)).toBe("True");
    expect(pythonLiteralOf(null)).toBe("None");
  });
});
