import { describe, expect, it } from "vitest";
import { RUFF_HINTS, withRuffHint } from "../ruffHints";

// PR-L（dx_features_backlog §6.6）：ruff 规则中文速释
describe("withRuffHint", () => {
  it("命中速释表：code 前缀 + 空行分隔的〔速释〕段", () => {
    const out = withRuffHint("E501", "Line too long (100 > 88)");
    expect(out.startsWith("E501 Line too long (100 > 88)")).toBe(true);
    expect(out).toContain("\n\n〔速释〕");
    expect(out).toContain("88 字符");
  });

  it("未命中的规则码：保持原 `<code> <message>` 形态，不追加空段", () => {
    expect(withRuffHint("X999", "未知规则")).toBe("X999 未知规则");
  });

  it("无规则码（code=null/undefined）：返回原始 message", () => {
    expect(withRuffHint(null, "裸消息")).toBe("裸消息");
    expect(withRuffHint(undefined, "裸消息")).toBe("裸消息");
  });

  it("message 原文不因速释被改写（只追加，不替换）", () => {
    const raw = "local variable 'x' is assigned to but never used";
    const out = withRuffHint("F841", raw);
    expect(out).toContain(raw);
  });
});

describe("RUFF_HINTS 表卫生（防手写漂移）", () => {
  it("条目量在首发规模（30~70 条），防止表被意外清空/无限膨胀", () => {
    const n = Object.keys(RUFF_HINTS).length;
    expect(n).toBeGreaterThanOrEqual(30);
    expect(n).toBeLessThanOrEqual(70);
  });

  it("键为精确规则码：类别字母（1~3 个，UP/RUF/ERA 等多字母类别存在）+ 数字，无空白/通配/小写", () => {
    for (const key of Object.keys(RUFF_HINTS)) {
      expect(key).toMatch(/^[A-Z]{1,3}[0-9]{2,4}$/);
    }
  });

  it("解释非空且以句号收尾（文案纪律）", () => {
    for (const [key, hint] of Object.entries(RUFF_HINTS)) {
      expect(hint.trim().length, key).toBeGreaterThan(4);
      expect(hint.endsWith("。"), key).toBe(true);
    }
  });

  it("常见高频规则在表内（E501/F401/F821/I001/W291）", () => {
    for (const code of ["E501", "F401", "F821", "I001", "W291"]) {
      expect(RUFF_HINTS[code], code).toBeTruthy();
    }
  });
});
