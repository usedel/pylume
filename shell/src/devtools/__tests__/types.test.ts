// PR-1：category 分组纯函数测试（plugin_system_design §9.8 半开放约定）。
// groupToolsByCategory / categoryOrderKey 是菜单子菜单、picker 分组、命令面板前缀三处同源的排序依据。

import { describe, expect, it } from "vitest";
import { categoryOrderKey, groupToolsByCategory, type DevTool } from "../types";

function tool(id: string, category: string): DevTool {
  return {
    id,
    title: id,
    description: "",
    category,
    icon: "symbol-file",
    inlineLabel: null,
    mount: () => undefined,
  };
}

describe("categoryOrderKey", () => {
  it("预置值按预置序（编码 0 … 文本 6），「其他」恒垫底", () => {
    expect(categoryOrderKey("编码")[0]).toBe(0);
    expect(categoryOrderKey("哈希")[0]).toBe(1);
    expect(categoryOrderKey("格式化")[0]).toBe(2);
    expect(categoryOrderKey("转换")[0]).toBe(3);
    expect(categoryOrderKey("生成")[0]).toBe(4);
    expect(categoryOrderKey("提取")[0]).toBe(5);
    expect(categoryOrderKey("文本")[0]).toBe(6);
    expect(categoryOrderKey("其他")[0]).toBe(99);
  });

  it("自定义值排在「其他」之前（同档按名称字母序）", () => {
    const [tier] = categoryOrderKey("自定义");
    expect(tier).toBe(7); // 预置「文本」(6) 之后、「其他」之前
    expect(categoryOrderKey("其他")[0]).toBe(99); // 「其他」恒垫底
  });
});

describe("groupToolsByCategory", () => {
  it("按预置序分组，组内保持注册序", () => {
    const groups = groupToolsByCategory([
      tool("md5", "哈希"),
      tool("base64", "编码"),
      tool("sha256", "哈希"),
    ]);
    expect(groups.map(([c]) => c)).toEqual(["编码", "哈希"]);
    expect(groups[1][1].map((t) => t.id)).toEqual(["md5", "sha256"]);
  });

  it("自定义 category 追加在「其他」之前；空 category 归「其他」", () => {
    const groups = groupToolsByCategory([
      tool("other", ""),
      tool("zzz", "自定义Z"),
      tool("aaa", "自定义A"),
      tool("uuid", "生成"),
    ]);
    expect(groups.map(([c]) => c)).toEqual(["生成", "自定义A", "自定义Z", "其他"]);
  });

  it("空列表返回空数组", () => {
    expect(groupToolsByCategory([])).toEqual([]);
  });
});
