// @vitest-environment happy-dom
// P2-11（UX 审查）回归：断点表随工作区持久化（与书签同模式）。
//
// 核心不变量：
// 1. 任何断点表变更（toggle / update / remove / setLines / clear）都经 notifyChange 全量落盘；
// 2. 落盘 payload 用空串表达「无高级属性」，加载时空串归一为 undefined——保持「空 spec 即普通断点」；
// 3. resetBreakpoints 只清内存不写盘（盘上数据按工作区隔离）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { app } from "../state";
import {
  getBreakpointSpec, getBreakpoints, hasAnyBreakpoint, loadBreakpoints,
  removeBreakpoint, resetBreakpoints, toggleBreakpoint, updateBreakpoint,
} from "../debugGutter";

const ROOT = "F:/proj";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined); // 默认实现：落盘调用返回成功 Promise
  app.workspaceRoot = ROOT;
});

afterEach(() => {
  resetBreakpoints();
  app.workspaceRoot = null;
});

/** 取最近一次 set_breakpoints 的 payload */
function lastPersist(): Array<Record<string, unknown>> {
  const calls = invokeMock.mock.calls.filter((c) => c[0] === "set_breakpoints");
  expect(calls.length, "应已调用 set_breakpoints 落盘").toBeGreaterThan(0);
  return calls[calls.length - 1][1].breakpoints as Array<Record<string, unknown>>;
}

describe("断点持久化（P2-11）", () => {
  it("toggle 断点即落盘：全量覆盖写，普通断点的高级属性为空串（B-6 起 payload 恒含 enabled）", () => {
    toggleBreakpoint(`${ROOT}/a.py`, 5);
    const list = lastPersist();
    expect(list).toEqual([
      { path: `${ROOT}/a.py`, line: 5, condition: "", hitCondition: "", logMessage: "", enabled: true },
    ]);
  });

  it("updateBreakpoint 的高级属性进入落盘 payload；removeBreakpoint 同步落盘", () => {
    toggleBreakpoint(`${ROOT}/a.py`, 5);
    updateBreakpoint(`${ROOT}/a.py`, 5, { condition: "i > 10", logMessage: "hit {i}" });
    let list = lastPersist();
    expect(list).toEqual([
      { path: `${ROOT}/a.py`, line: 5, condition: "i > 10", hitCondition: "", logMessage: "hit {i}", enabled: true },
    ]);
    removeBreakpoint(`${ROOT}/a.py`, 5);
    expect(lastPersist()).toEqual([]);
    expect(hasAnyBreakpoint()).toBe(false);
  });

  it("loadBreakpoints 回填内存表；空串归一为 undefined（普通断点语义不丢）", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_breakpoints") {
        return Promise.resolve([
          { path: `${ROOT}/a.py`, line: 7, condition: "i>1", hitCondition: "", logMessage: "" },
          { path: `${ROOT}/b.py`, line: 2, condition: "", hitCondition: "", logMessage: "" },
        ]);
      }
      return Promise.resolve(null);
    });
    await loadBreakpoints();
    // 条件断点：属性回填
    expect(getBreakpointSpec(`${ROOT}/a.py`, 7)).toEqual({ condition: "i>1" });
    // 空串字段不出现在 spec 里（否则 breakpointKind 会误判 / UI 会渲染空徽标）
    expect(getBreakpointSpec(`${ROOT}/b.py`, 2)).toEqual({});
    expect(getBreakpoints(`${ROOT}/b.py`)).toEqual([{ line: 2 }]);
    // 落盘路径带当前工作区根
    expect(invokeMock).toHaveBeenCalledWith("get_breakpoints", { workspaceRoot: ROOT });
  });

  it("resetBreakpoints 只清内存、不写盘（工作区切换时盘上数据保持隔离）", async () => {
    invokeMock.mockResolvedValue([]);
    await loadBreakpoints();
    toggleBreakpoint(`${ROOT}/a.py`, 3);
    const before = invokeMock.mock.calls.filter((c) => c[0] === "set_breakpoints").length;
    resetBreakpoints();
    expect(hasAnyBreakpoint()).toBe(false);
    const after = invokeMock.mock.calls.filter((c) => c[0] === "set_breakpoints").length;
    expect(after).toBe(before); // 未新增落盘调用
  });

  it("无工作区时变更不落盘（单测/关闭工作区场景无副作用）", () => {
    app.workspaceRoot = null;
    toggleBreakpoint(`${ROOT}/a.py`, 9);
    expect(invokeMock).not.toHaveBeenCalled();
    // 内存表仍可用（调试能力不依赖持久化）
    expect(getBreakpointSpec(`${ROOT}/a.py`, 9)).toEqual({});
  });
});
