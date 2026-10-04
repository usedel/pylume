// libFormat 单测（库特别支持 PR-3 验收 §5）：码表覆盖 / 分段解释 / 未知码判定 / 边界 / 源码识别。
import { describe, expect, it } from "vitest";
import {
  formatDiagnostics,
  formatHoverMarkdown,
  formatSample,
  scanFormatLiterals,
  segmentFormat,
  STRFTIME_CHIP_ORDER,
  STRFTIME_CODES,
  LOGGING_CHIP_ORDER,
  LOGGING_FIELDS,
} from "../libFormat";

describe("strftime 分段", () => {
  it("码表覆盖常用指令（chips 前六位均为已知码）", () => {
    for (const code of STRFTIME_CHIP_ORDER.slice(0, 6)) {
      expect(STRFTIME_CODES[code], code).toBeTruthy();
    }
    // chips 顺序 %Y %m %d %H %M %S 在前（§11.4 频率排序）
    expect(STRFTIME_CHIP_ORDER.slice(0, 6)).toEqual(["Y", "m", "d", "H", "M", "S"]);
  });

  it("分段：字面量 + 指令交替", () => {
    const t = segmentFormat("strftime", "%Y-%m-%d %H:%M:%S");
    expect(t.filter((x) => x.text === "%Y")[0]?.desc).toContain("年份");
    expect(t.filter((x) => x.text === "-")[0]?.desc).toBe("字面量");
    expect(t.every((x) => !x.unknown)).toBe(true);
  });

  it("%% 字面量转义", () => {
    const t = segmentFormat("strftime", "100%%");
    expect(t.some((x) => x.text === "%%" && x.desc.includes("字面量"))).toBe(true);
    expect(t.every((x) => !x.unknown)).toBe(true);
  });

  it("%Q 未知码判定", () => {
    const t = segmentFormat("strftime", "%Q");
    expect(t[0]?.unknown).toBe(true);
    expect(formatDiagnostics("strftime", "%Q")).toHaveLength(1);
  });

  it("悬空 % 判定", () => {
    expect(segmentFormat("strftime", "abc%").some((x) => x.unknown)).toBe(true);
  });
});

describe("logging 分段", () => {
  it("码表覆盖 chips（频率序）", () => {
    for (const f of LOGGING_CHIP_ORDER) expect(LOGGING_FIELDS[f], f).toBeTruthy();
    expect(LOGGING_CHIP_ORDER.slice(0, 4)).toEqual(["asctime", "levelname", "name", "message"]);
  });

  it("分段解释 + 未知字段", () => {
    const t = segmentFormat("logging", "%(asctime)s %(levelname)s [%(nope)s]");
    expect(t[0]?.desc).toContain("时间");
    expect(t.find((x) => x.text === "%(nope)s")?.unknown).toBe(true);
    expect(formatDiagnostics("logging", "%(asctime)s %(nope)s")).toHaveLength(1);
  });
});

describe("格式规范分段", () => {
  it("{:>10,.2f} 分段说明（对齐/宽度/千分位/精度/类型）", () => {
    const t = segmentFormat("format", "{:>10,.2f}");
    const field = t.find((x) => x.text.startsWith("{"))!;
    expect(field.desc).toContain("对齐 >");
    expect(field.desc).toContain("宽度 10");
    expect(field.desc).toContain("千分位");
    expect(field.desc).toContain("精度 2");
    expect(field.desc).toContain("定点");
  });

  it("{:q} 未知类型判定", () => {
    const t = segmentFormat("format", "{:q}");
    expect(t.find((x) => x.text === "{:q}")?.unknown).toBe(true);
    expect(formatDiagnostics("format", "{:q}")).toHaveLength(1);
  });

  it("边界：{} 自动编号 / {!r} 转换 / {0!s:>10} 全量", () => {
    const t1 = segmentFormat("format", "{}");
    expect(t1.find((x) => x.text === "{}")?.desc).toContain("自动编号");
    const t2 = segmentFormat("format", "{x!r}");
    expect(t2.find((x) => x.text === "{x!r}")?.desc).toContain("!r");
    const t3 = segmentFormat("format", "{0!s:>10}");
    const f3 = t3.find((x) => x.text === "{0!s:>10}")!;
    expect(f3.desc).toContain("字段 0");
    expect(f3.desc).toContain("!s");
    expect(f3.desc).toContain("对齐 >");
    expect(f3.unknown).toBeUndefined();
  });

  it("{{ }} 转义与未闭合 {", () => {
    expect(segmentFormat("format", "{{x}}").every((x) => !x.unknown)).toBe(true);
    expect(segmentFormat("format", "{x")[0]?.unknown).toBe(true);
  });

  it("纯 spec 输入（无 {}）：未知类型", () => {
    expect(segmentFormat("format", ">10,.2f")[0]?.desc).toContain("宽度 10");
    expect(segmentFormat("format", "q")[0]?.unknown).toBe(true);
  });
});

describe("hover markdown", () => {
  it("首行模式标签 + 分段 + 未知码提示", () => {
    const md = formatHoverMarkdown("strftime", "%Y-%m-%d");
    expect(md).toContain("日期 strftime");
    expect(md).toContain("%Y");
    const bad = formatHoverMarkdown("strftime", "%Q");
    expect(bad).toContain("未知格式码");
    expect(bad).toContain("常见码");
  });

  // §11.4：hover 给「示例输出」；未知码 / tz·locale 依赖码一律不给示例（I-3 不臆测）
  it("hover 示例输出（固定样本）", () => {
    expect(formatHoverMarkdown("strftime", "%Y-%m-%d")).toContain("示例：`2026-09-26`");
    expect(formatHoverMarkdown("strftime", "%Y-%m-%d %H:%M:%S")).toContain("2026-09-26 14:03:11");
    expect(formatHoverMarkdown("format", ">10,.2f")).toContain("1,234.57");
    expect(formatHoverMarkdown("logging", "%(levelname)s %(message)s")).toContain("INFO started");
  });

  it("未知码 / tz 依赖码不给示例", () => {
    expect(formatHoverMarkdown("strftime", "%Q")).not.toContain("示例");
    expect(formatSample("strftime", "%Y-%m-%dT%H:%M:%S%z")).toBeNull();
    expect(formatSample("strftime", "%Y %Q")).toBeNull();
    expect(formatSample("format", "{:q}")).toBeNull();
    expect(formatSample("logging", "%(nope)s")).toBeNull();
  });

  it("离线示例与真值口径分离：标注样本来源", () => {
    expect(formatHoverMarkdown("strftime", "%Y")).toContain("样本 2026-09-26 14:03:11");
    expect(formatHoverMarkdown("format", ".2f")).toContain("样本 1234.5678");
  });
});

describe("scanFormatLiterals 源码识别", () => {
  it("strftime 实参识别（含 strptime 第二实参）", () => {
    const src = `now.strftime("%Y-%m-%d")\ndt.strptime(s, "%H:%M")`;
    const hits = scanFormatLiterals(src);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ mode: "strftime", fmt: "%Y-%m-%d" });
    expect(hits[1]).toMatchObject({ mode: "strftime", fmt: "%H:%M" });
  });

  it("format 调用的含 {} 字面量；无 {} 不识别", () => {
    const src = `"{} items".format(n)\n"log msg".format(n)\nformat(x, ".2f")`;
    const hits = scanFormatLiterals(src);
    expect(hits.map((h) => h.mode)).toEqual(["format", "format"]);
  });

  it("logging：含已知字段的字面量（含 basicConfig 形态）", () => {
    const src = `logging.basicConfig(format="%(asctime)s %(levelname)s %(message)s")`;
    const hits = scanFormatLiterals(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.mode).toBe("logging");
    // 未知字段-only 的串不误报
    expect(scanFormatLiterals(`s = "%(whatever)s"`)).toHaveLength(0);
  });

  it("注释 / 文档字符串内不识别", () => {
    const src = `# now.strftime("%Y")\n"""\n%(asctime)s\n"""\nx = 1`;
    expect(scanFormatLiterals(src)).toHaveLength(0);
  });
});
