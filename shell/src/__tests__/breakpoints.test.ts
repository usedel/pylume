// @vitest-environment happy-dom
// P0（PyCharm 调研 D2/D3）回归：断点不再是「只有行号」——每行可挂 condition /
// hitCondition / logMessage（DAP SourceBreakpoint 原生字段）。
//
// 固化的核心不变量（都是「改起来顺手、坏起来无声」的点）：
// 1. 空 spec = 普通断点，既有「只有行号」的调用方语义不变；
// 2. setBreakpointLines（断点列表删行用）**必须保留剩余行原有的高级属性**——
//    否则删一个断点会把同文件其它条件断点清成普通断点；
// 3. log 优先于 condition（同一行两者并存时按 Logpoint 呈现）。
import { beforeEach, describe, expect, it } from "vitest";
import {
  breakpointKind,
  clearBreakpoints,
  getBreakpoints,
  getBreakpointSpec,
  hasAnyBreakpoint,
  removeBreakpoint,
  setBreakpointLines,
  toggleBreakpoint,
  updateBreakpoint,
} from "../debugGutter";

const FILE = "F:/proj/app.py";
const OTHER = "F:/proj/other.py";

beforeEach(() => {
  clearBreakpoints(FILE);
  clearBreakpoints(OTHER);
});

describe("断点表（P0：行 → 高级属性）", () => {
  it("左键切换出的新断点是普通断点（空 spec，与升级前同义）", () => {
    expect(toggleBreakpoint(FILE, 5)).toBe(true);
    expect(getBreakpoints(FILE)).toEqual([{ line: 5 }]);
    expect(breakpointKind(getBreakpointSpec(FILE, 5))).toBe("plain");
    // 再点一次即取消
    expect(toggleBreakpoint(FILE, 5)).toBe(false);
    expect(getBreakpoints(FILE)).toEqual([]);
    expect(hasAnyBreakpoint()).toBe(false);
  });

  it("条件断点：写入 condition 后推送给 debugger 的项带该字段", () => {
    toggleBreakpoint(FILE, 10);
    updateBreakpoint(FILE, 10, { condition: "i > 10" });
    expect(getBreakpoints(FILE)).toEqual([{ line: 10, condition: "i > 10" }]);
    expect(breakpointKind(getBreakpointSpec(FILE, 10))).toBe("condition");
  });

  it("命中次数与日志点同走一条路径（hitCondition / logMessage）", () => {
    toggleBreakpoint(FILE, 3);
    updateBreakpoint(FILE, 3, { hitCondition: ">3" });
    expect(getBreakpoints(FILE)[0]?.hitCondition).toBe(">3");

    updateBreakpoint(FILE, 3, { condition: "x", logMessage: "i={i}" });
    // log 优先于 condition（同一行两者并存 → 呈现为 Logpoint）
    expect(breakpointKind(getBreakpointSpec(FILE, 3))).toBe("log");
    expect(getBreakpoints(FILE)[0]).toEqual({ line: 3, condition: "x", logMessage: "i={i}" });
  });

  it("转为普通断点（spec = null）只清属性、不删断点", () => {
    updateBreakpoint(FILE, 7, { condition: "flag", hitCondition: "2", logMessage: "m" });
    updateBreakpoint(FILE, 7, null);
    expect(getBreakpoints(FILE)).toEqual([{ line: 7 }]);
    expect(breakpointKind(getBreakpointSpec(FILE, 7))).toBe("plain");
  });

  it("setBreakpointLines 保留剩余行的高级属性（删一个断点不能清掉同文件其它条件）", () => {
    updateBreakpoint(FILE, 3, { condition: "a" });
    updateBreakpoint(FILE, 8, { logMessage: "b={b}" });
    updateBreakpoint(FILE, 12, {});
    setBreakpointLines(FILE, [3, 12]); // 删掉 8
    expect(getBreakpoints(FILE)).toEqual([{ line: 3, condition: "a" }, { line: 12 }]);
  });

  it("removeBreakpoint 只动目标行，跨文件互不影响", () => {
    updateBreakpoint(FILE, 1, { condition: "c1" });
    updateBreakpoint(FILE, 2, { condition: "c2" });
    updateBreakpoint(OTHER, 1, { logMessage: "x" });
    removeBreakpoint(FILE, 1);
    expect(getBreakpoints(FILE)).toEqual([{ line: 2, condition: "c2" }]);
    expect(getBreakpoints(OTHER)).toEqual([{ line: 1, logMessage: "x" }]);
    expect(hasAnyBreakpoint()).toBe(true);
  });

  it("行号升序（setBreakpoints 推送顺序稳定）", () => {
    updateBreakpoint(FILE, 20, {});
    updateBreakpoint(FILE, 4, { condition: "z" });
    updateBreakpoint(FILE, 11, {});
    expect(getBreakpoints(FILE).map((b) => b.line)).toEqual([4, 11, 20]);
  });
});
