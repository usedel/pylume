import { describe, expect, it } from "vitest";
import { prepareSelectionIndent, selectionLinePrefix } from "../surround";

describe("selectionLinePrefix", () => {
  it("取 $SELECTION$ 所在行的空白前缀", () => {
    expect(selectionLinePrefix("try:\n    $SELECTION$\nexcept:\n    pass")).toBe("    ");
    expect(selectionLinePrefix('"$SELECTION$"')).toBe("");
  });
  it("无 $SELECTION$ → 空串", () => {
    expect(selectionLinePrefix("print($END$)")).toBe("");
  });
});

describe("prepareSelectionIndent", () => {
  it("单行选区原样返回", () => {
    expect(prepareSelectionIndent("foo()", "", "    ", true)).toBe("foo()");
  });

  it("模块层行首选区：扣最小缩进 → 后续行补 基础缩进+模板前缀", () => {
    const sel = "    x = 1\n    y = 2";
    expect(prepareSelectionIndent(sel, "", "    ", true)).toBe("x = 1\n    y = 2");
  });

  it("函数内行首选区：基础缩进 4 + 模板前缀 4，相对缩进保留", () => {
    const sel = "    x = 1\n    if a:\n        y = 2";
    expect(prepareSelectionIndent(sel, "    ", "    ", true)).toBe(
      "x = 1\n        if a:\n            y = 2",
    );
  });

  it("空行保持空", () => {
    const sel = "    a\n\n    b";
    expect(prepareSelectionIndent(sel, "", "    ", true)).toBe("a\n\n    b");
  });

  it("行中选取 → 原样保留（绝对缩进已相对选取点格式化）", () => {
    const sel = "foo(\n        b,\n    )";
    expect(prepareSelectionIndent(sel, "    ", "", false)).toBe(sel);
  });
});
