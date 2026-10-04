// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../state";
import {
  canGoBack, canGoForward, goBack, goForward, navHistorySize, noteOpen, resetNavHistory, setNavHistoryHandlers,
} from "../navHistory";

/**
 * `move()` 会操作编辑器（定位 + 聚焦），而 app.editor 是「初始化前访问即抛错」的
 * getter——测试里用最小桩件顶上，只断言本模块关心的「跳到哪个文件哪一行」。
 */
function stubEditor(): void {
  app.editor = {
    setPosition: () => undefined,
    revealLineInCenter: () => undefined,
    focus: () => undefined,
  } as never;
}

describe("导航历史（后退 / 前进）", () => {
  const opened: Array<{ path: string; line: number }> = [];

  beforeEach(() => {
    resetNavHistory();
    opened.length = 0;
    stubEditor();
    setNavHistoryHandlers({
      openFile: async (path, line) => {
        opened.push({ path, line });
      },
    });
  });

  it("两次导航后可后退到出发位置", async () => {
    noteOpen("/a.py", 10);
    noteOpen("/b.py", 42);
    expect(navHistorySize()).toBe(2);
    expect(canGoBack()).toBe(true);
    expect(canGoForward()).toBe(false);

    expect(await goBack()).toBe(true);
    expect(opened).toEqual([{ path: "/a.py", line: 10 }]);
    expect(canGoBack()).toBe(false);
    expect(canGoForward()).toBe(true);

    expect(await goForward()).toBe(true);
    expect(opened[1]).toEqual({ path: "/b.py", line: 42 });
  });

  it("回退本身不产生新历史（抑制标志生效）", async () => {
    noteOpen("/a.py", 1);
    noteOpen("/b.py", 2);
    await goBack();
    await goForward();
    // 若回退被误记为新导航，栈会被撑大且前进段被截断
    expect(navHistorySize()).toBe(2);
    expect(canGoForward()).toBe(false);
  });

  it("在中间位置发生新导航会截断前进段", async () => {
    noteOpen("/a.py", 1);
    noteOpen("/b.py", 2);
    noteOpen("/c.py", 3);
    await goBack(); // 回到 b
    noteOpen("/d.py", 4); // 新导航 → c 被丢弃
    expect(navHistorySize()).toBe(3);
    expect(canGoForward()).toBe(false);
    expect(await goBack()).toBe(true);
    expect(opened[opened.length - 1]).toEqual({ path: "/b.py", line: 2 });
  });

  it("栈空 / 到端点时移动失败且不跳转", async () => {
    expect(await goBack()).toBe(false);
    noteOpen("/only.py", 1);
    expect(await goBack()).toBe(false);
    expect(await goForward()).toBe(false);
    expect(opened).toHaveLength(0);
  });

  it("同一位置重复记录只更新列、不新增条目", () => {
    noteOpen("/a.py", 10);
    noteOpen("/a.py", 10);
    expect(navHistorySize()).toBe(1);
  });

  it("resetNavHistory 清空栈与游标", () => {
    noteOpen("/a.py", 1);
    noteOpen("/b.py", 2);
    resetNavHistory();
    expect(navHistorySize()).toBe(0);
    expect(canGoBack()).toBe(false);
    expect(canGoForward()).toBe(false);
  });
});
