// PR-A（dx_features_backlog §6.1）：重开关闭标签——栈纯逻辑 + 模块级行为单测。
// 对应实现 shell/src/tabReopen.ts（TD-014：独立功能域模块）。

import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_CLOSED_TABS,
  _resetForTest,
  pushClosedPath,
  recordClosedTab,
  reopenClosedTab,
  setTabReopenHandlers,
} from "../tabReopen";

describe("pushClosedPath（纯函数）", () => {
  it("后入栈顶：最近关闭的路径在末位", () => {
    expect(pushClosedPath(["a.py", "b.py"], "c.py", 20)).toEqual(["a.py", "b.py", "c.py"]);
  });

  it("去重：同路径重复关闭时移除旧条目，重开命中最近一次关闭", () => {
    expect(pushClosedPath(["a.py", "b.py", "c.py"], "a.py", 20)).toEqual(["b.py", "c.py", "a.py"]);
  });

  it("有界截断：超过上限从栈底丢最旧的", () => {
    const stack = ["a.py", "b.py"];
    const next = pushClosedPath(stack, "c.py", 2);
    expect(next).toEqual(["b.py", "c.py"]);
    expect(next.length).toBeLessThanOrEqual(MAX_CLOSED_TABS);
  });

  it("不改入参（返回新数组）", () => {
    const stack = ["a.py"];
    pushClosedPath(stack, "b.py", 20);
    expect(stack).toEqual(["a.py"]);
  });
});

describe("模块级 record/reopen", () => {
  afterEach(() => _resetForTest());

  it("reopen 弹出最近关闭并调用注入的 openFile（LIFO）", () => {
    const opened: string[] = [];
    setTabReopenHandlers({ openFile: (p) => opened.push(p) });
    recordClosedTab("a.py");
    recordClosedTab("b.py");
    expect(reopenClosedTab()).toBe(true);
    expect(opened).toEqual(["b.py"]); // 栈顶=最后关闭
    expect(reopenClosedTab()).toBe(true);
    expect(opened).toEqual(["b.py", "a.py"]);
    expect(reopenClosedTab()).toBe(false); // 栈空
  });

  it("未注入 handler 时 reopen 不抛错", () => {
    recordClosedTab("a.py");
    expect(() => reopenClosedTab()).not.toThrow();
  });

  it("空栈 reopen 返回 false（调用方 toast 提示的依据）", () => {
    expect(reopenClosedTab()).toBe(false);
  });
});
