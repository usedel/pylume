import { describe, expect, it } from "vitest";
import { headerTemplateApplies } from "../newFileTemplate";

// PR-K（dx_features_backlog §6.6）：新建 .py 文件自动插 header 模板的门控纯函数
describe("headerTemplateApplies", () => {
  it("开关关：一律不插（即使 .py）", () => {
    expect(headerTemplateApplies("main.py", false)).toBe(false);
  });

  it("开关开：.py / .pyw 命中（含嵌套路径）", () => {
    expect(headerTemplateApplies("main.py", true)).toBe(true);
    expect(headerTemplateApplies("pkg/mod.pyw", true)).toBe(true);
  });

  it("开关开：大小写不敏感", () => {
    expect(headerTemplateApplies("MAIN.PY", true)).toBe(true);
  });

  it("开关开：非 Python 后缀不插（避免污染草稿流语义的外延）", () => {
    expect(headerTemplateApplies("notes.txt", true)).toBe(false);
    expect(headerTemplateApplies("README.md", true)).toBe(false);
    expect(headerTemplateApplies("script", true)).toBe(false);
    expect(headerTemplateApplies("data.py.bak", true)).toBe(false);
  });

  it("空路径 / 目录名不插", () => {
    expect(headerTemplateApplies("", true)).toBe(false);
  });
});
