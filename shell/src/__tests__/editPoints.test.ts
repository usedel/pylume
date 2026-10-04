// PR-D（dx_features_backlog §6.4）：最近编辑位置——EditPointStack 纯逻辑单测。

import { describe, expect, it } from "vitest";
import { EditPointStack } from "../editPoints";

describe("noteEdit 合并与上限", () => {
  it("连续同文件行距 ≤3 合并为一个编辑点（输入过程不炸栈）", () => {
    const s = new EditPointStack();
    s.noteEdit("a.py", 10);
    s.noteEdit("a.py", 11);
    s.noteEdit("a.py", 14); // 行距 3 仍合并
    expect(s.size).toBe(1);
    s.noteEdit("a.py", 18); // 行距 4 → 新编辑点
    expect(s.size).toBe(2);
  });

  it("不同文件的编辑点各自入栈", () => {
    const s = new EditPointStack();
    s.noteEdit("a.py", 5);
    s.noteEdit("b.py", 5);
    s.noteEdit("a.py", 5);
    expect(s.size).toBe(3);
  });

  it("上限截断：超过 max 从栈底丢最旧", () => {
    const s = new EditPointStack(3);
    s.noteEdit("a.py", 1);
    s.noteEdit("b.py", 1);
    s.noteEdit("c.py", 1);
    s.noteEdit("d.py", 1);
    expect(s.size).toBe(3);
    expect(s.jumpFrom(null, null)).toEqual({ path: "d.py", line: 1 }); // 栈顶是最新
  });
});

describe("jumpFrom 回溯语义", () => {
  it("第一次按：跳栈顶；当前位置就是栈顶区域时跳过到更早", () => {
    const s = new EditPointStack();
    s.noteEdit("a.py", 10);
    s.noteEdit("b.py", 20);
    // 当前在 b.py:21（栈顶编辑区域内）→ 跳过，回 a.py:10
    expect(s.jumpFrom("b.py", 21)).toEqual({ path: "a.py", line: 10 });
  });

  it("连续按循环回溯：到栈底后回栈顶", () => {
    const s = new EditPointStack();
    s.noteEdit("a.py", 1);
    s.noteEdit("b.py", 2);
    s.noteEdit("c.py", 3);
    expect(s.jumpFrom("c.py", 3)).toEqual({ path: "b.py", line: 2 });
    expect(s.jumpFrom("b.py", 2)).toEqual({ path: "a.py", line: 1 });
    expect(s.jumpFrom("a.py", 1)).toEqual({ path: "c.py", line: 3 }); // 循环回栈顶
  });

  it("新编辑重置导航游标（时间轴重新开始）", () => {
    const s = new EditPointStack();
    s.noteEdit("a.py", 1);
    s.noteEdit("b.py", 2);
    s.jumpFrom("b.py", 2); // 游标指到 a.py
    s.noteEdit("a.py", 99); // 新编辑（非合并区）→ 游标重置
    expect(s.jumpFrom("a.py", 99)).toEqual({ path: "b.py", line: 2 }); // 重新从栈顶回溯
  });

  it("跳过跨文件判定：同文件行距 ≤3 视为当前位置区域", () => {
    const s = new EditPointStack();
    s.noteEdit("a.py", 10);
    s.noteEdit("b.py", 50);
    expect(s.jumpFrom("a.py", 12)).toEqual({ path: "b.py", line: 50 }); // a.py:12 距栈…栈内 a.py:10 属当前区
  });

  it("空栈 / 全栈都是当前位置 → null", () => {
    const s = new EditPointStack();
    expect(s.jumpFrom("a.py", 1)).toBeNull();
    s.noteEdit("a.py", 10);
    expect(s.jumpFrom("a.py", 11)).toBeNull(); // 唯一点就是当前位置
    expect(s.jumpFrom(null, null)).toEqual({ path: "a.py", line: 10 }); // 无活动位置时不跳过
  });
});
