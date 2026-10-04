// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  findQuickOpenAction,
  fuzzyScore,
  parseLineSuffix,
  parseTargetLine,
  registerQuickOpenActions,
} from "../quickOpen";

describe("fuzzyScore 子序列模糊匹配", () => {
  it("按序命中即得分为正；有字符找不到返回 null", () => {
    expect(fuzzyScore("main.py", "mn")).toBeGreaterThan(0);
    expect(fuzzyScore("main.py", "xyz")).toBeNull();
  });

  it("空 query 恒命中（0 分），空 text 恒不命中", () => {
    expect(fuzzyScore("main.py", "")).toBe(0);
    expect(fuzzyScore("", "abc")).toBeNull();
  });

  it("连续匹配优于散落命中", () => {
    const tight = fuzzyScore("client.py", "cli")!;
    const loose = fuzzyScore("collect_items.py", "cli")!;
    expect(tight).toBeGreaterThan(loose);
  });

  it("分段边界（路径分隔符 / 下划线 / 点）有加成", () => {
    // 同一批字符，落在目录边界上应比落在词中间更优
    const atBoundary = fuzzyScore("pkg/util.py", "u")!;
    const midWord = fuzzyScore("pkg/queue.py", "u")!;
    expect(atBoundary).toBeGreaterThan(midWord);
  });

  it("大小写不敏感，camelCase 大写字母有加成", () => {
    expect(fuzzyScore("Main.py", "main")).not.toBeNull();
    const camel = fuzzyScore("getData", "g")!;
    expect(camel).toBeGreaterThan(0);
  });

  it("长度不同的 query 不会误命中（字符必须够用）", () => {
    expect(fuzzyScore("ab", "aab")).toBeNull();
  });
});

describe("findQuickOpenAction 命令注册表读取器（onboarding 巡礼前置 P0）", () => {
  it("未注册任何条目时返回 null", () => {
    registerQuickOpenActions([]);
    expect(findQuickOpenAction("open_devtools")).toBeNull();
  });

  it("注册后按 id 命中，返回完整条目", () => {
    let ran = 0;
    registerQuickOpenActions([{ id: "open_devtools", label: "开发工具面板", run: () => { ran += 1; } }]);
    const a = findQuickOpenAction("open_devtools");
    expect(a?.label).toBe("开发工具面板");
    a?.run();
    expect(ran).toBe(1);
    expect(findQuickOpenAction("nope")).toBeNull();
  });

  it("registerQuickOpenActions 是整体替换语义：重建后实时查到新表（巡礼不缓存引用）", () => {
    registerQuickOpenActions([{ id: "todo_panel", label: "TODO 旧", run: () => undefined }]);
    registerQuickOpenActions([{ id: "todo_panel", label: "TODO 新", run: () => undefined }]);
    expect(findQuickOpenAction("todo_panel")?.label).toBe("TODO 新");
  });
});

describe("parseLineSuffix 行号后缀", () => {
  it("无后缀时原样返回", () => {
    expect(parseLineSuffix("main")).toEqual({ query: "main", line: null });
    expect(parseLineSuffix("")).toEqual({ query: "", line: null });
  });

  it("解析 file.py:12 形式", () => {
    expect(parseLineSuffix("main.py:12")).toEqual({ query: "main.py", line: 12 });
    expect(parseLineSuffix("  main.py:7  ")).toEqual({ query: "main.py", line: 7 });
  });

  it("单独 :12 也能定位（先按文件名搜，再跳行）", () => {
    expect(parseLineSuffix(":42")).toEqual({ query: "", line: 42 });
  });

  it("只认末尾的数字后缀，中间冒号不切", () => {
    expect(parseLineSuffix("a:b")).toEqual({ query: "a:b", line: null });
  });
});

describe("parseTargetLine 行号输入（Ctrl+G）", () => {
  it("纯行号", () => {
    expect(parseTargetLine("42")).toEqual({ line: 42, column: 1 });
  });

  it("行:列（半角与全角冒号都接受）", () => {
    expect(parseTargetLine("12:8")).toEqual({ line: 12, column: 8 });
    expect(parseTargetLine("12：8")).toEqual({ line: 12, column: 8 });
    expect(parseTargetLine("12 : 8")).toEqual({ line: 12, column: 8 });
  });

  it("非法输入返回 null（0 行 / 负数 / 非数字 / 空）", () => {
    expect(parseTargetLine("0")).toBeNull();
    expect(parseTargetLine("abc")).toBeNull();
    expect(parseTargetLine("")).toBeNull();
    expect(parseTargetLine("1:0")).toBeNull();
    expect(parseTargetLine("3.5")).toBeNull();
  });
});
