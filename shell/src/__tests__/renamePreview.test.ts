// 跨文件重命名确认摘要单测（D-3）：summarizeRenameTargets 纯函数。
// happy-dom 环境（renameWidget 依赖链含 DOM 交互模块；元素仅被惰性解析，无需真实节点）。
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { summarizeRenameTargets } from "../renameWidget";

/** 构造 RenameFileEdits 形状的测试条目（edits 数量 = 命中数） */
function fe(path: string, n: number) {
  return {
    path,
    edits: Array.from({ length: n }, (_, i) => ({ startLine: i + 1, startColumn: 1, endLine: i + 1, endColumn: 2, text: "" })),
  };
}

describe("summarizeRenameTargets（D-3 跨文件确认摘要）", () => {
  it("按命中数降序列出文件 × 处数；total 汇总", () => {
    const { total, lines } = summarizeRenameTargets(
      [fe("D:/proj/main.py", 2), fe("D:/proj/lib.py", 1)],
      "D:/proj",
    );
    expect(total).toBe(3);
    expect(lines).toEqual(["· main.py × 2 处", "· lib.py × 1 处"]);
  });

  it("无工作区根时回落文件名（relativePathOrName 语义）", () => {
    const { lines } = summarizeRenameTargets([fe("D:/other/lib.py", 4)], null);
    expect(lines).toEqual(["· lib.py × 4 处"]);
  });

  it("超过 maxFiles 折叠为计数行（G-1 有界）", () => {
    const files = Array.from({ length: 13 }, (_, i) => fe(`D:/proj/f${i}.py`, i + 1));
    const { total, lines } = summarizeRenameTargets(files, "D:/proj");
    expect(total).toBe(files.reduce((n, f) => n + f.edits.length, 0));
    expect(lines).toHaveLength(11); // 10 条明细 + 1 条折叠
    expect(lines[10]).toBe("· …以及其他 3 个文件");
  });

  it("单文件也返回摘要（当前调用方不触发，但函数自洽）", () => {
    const { total, lines } = summarizeRenameTargets([fe("D:/proj/a.py", 5)], "D:/proj");
    expect(total).toBe(5);
    expect(lines).toEqual(["· a.py × 5 处"]);
  });
});
