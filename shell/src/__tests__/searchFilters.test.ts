// PR-H（dx_features_backlog §6.6）：搜索筛选纯函数——行匹配器（子串/正则）+ 文件掩码。
// 掩码语义必须与 Rust 侧 `fs_cmds.rs::collect_files_glob` 保持一致（见 searchFilters.ts 头注）：
//   · 无斜杠 = 任意深度；含斜杠 = 相对根路径锚定；`*` 不跨 `/`，`**` 跨层级。
import { describe, it, expect } from "vitest";
import { buildLineMatcher, compileFileMask } from "../searchFilters";

describe("buildLineMatcher 子串模式", () => {
  it("大小写敏感/不敏感", () => {
    const cs = buildLineMatcher("hello", true, false);
    const ci = buildLineMatcher("hello", false, false);
    expect(cs("hello Hello")).toEqual([{ column: 1, length: 5 }]);
    expect(ci("hello Hello")).toEqual([{ column: 1, length: 5 }, { column: 7, length: 5 }]);
  });

  it("同一行多处命中列号递增", () => {
    const m = buildLineMatcher("aa", false, false);
    // "aa bbb aa"：第二处 "aa" 起于 index 7 → 第 8 列（1 基）
    expect(m("aa bbb aa")).toEqual([{ column: 1, length: 2 }, { column: 8, length: 2 }]);
  });

  it("无命中返回空", () => {
    expect(buildLineMatcher("zz", false, false)("nothing here")).toEqual([]);
  });
});

describe("buildLineMatcher 正则模式", () => {
  it("基本模式与列/长", () => {
    const m = buildLineMatcher("foo_\\w+", true, true);
    expect(m("x foo_abc y")).toEqual([{ column: 3, length: 7 }]);
  });

  it("gi 标志：不区分大小写", () => {
    const ci = buildLineMatcher("error", false, true);
    expect(ci("ERROR error").length).toBe(2);
    const cs = buildLineMatcher("error", true, true);
    expect(cs("ERROR error")).toEqual([{ column: 7, length: 5 }]);
  });

  it("同一正则对象重复调用不共享 lastIndex", () => {
    const m = buildLineMatcher("\\d+", true, true);
    expect(m("a1 b22")).toEqual([{ column: 2, length: 1 }, { column: 5, length: 2 }]);
    // 第二次调用结果必须与第一次相同（lastIndex 归零）
    expect(m("a1 b22")).toEqual([{ column: 2, length: 1 }, { column: 5, length: 2 }]);
  });

  it("空匹配模式不死循环", () => {
    const m = buildLineMatcher("x*", true, true);
    expect(m("ab").length).toBe(3); // 每处空匹配各算一次
  });

  it("非法正则抛出可读错误（不静默退回子串）", () => {
    expect(() => buildLineMatcher("foo(", true, true)).toThrow(/正则表达式无效/);
  });
});

describe("compileFileMask", () => {
  it("空掩码不过滤", () => {
    expect(compileFileMask(undefined)).toBeNull();
    expect(compileFileMask("   ")).toBeNull();
  });

  it("无斜杠掩码命中任意深度", () => {
    const m = compileFileMask("*.py")!;
    expect(m.test("main.py")).toBe(true);
    expect(m.test("pkg/deep/app.py")).toBe(true);
    expect(m.test("main.txt")).toBe(false);
    expect(m.test("pkg/main.txt")).toBe(false);
  });

  it("含斜杠掩码按相对路径锚定", () => {
    const m = compileFileMask("pkg/*.py")!;
    expect(m.test("pkg/app.py")).toBe(true);
    expect(m.test("main.py")).toBe(false);
    expect(m.test("deep/pkg/app.py")).toBe(false);
  });

  it("? 单字符、** 跨层级", () => {
    const q = compileFileMask("v?.py")!;
    expect(q.test("v1.py")).toBe(true);
    expect(q.test("v12.py")).toBe(false);
    const deep = compileFileMask("pkg/**/x.py")!;
    expect(deep.test("pkg/a/b/x.py")).toBe(true);
    expect(deep.test("other/x.py")).toBe(false);
  });

  it("Windows 反斜杠路径归一", () => {
    const m = compileFileMask("pkg/*.py")!;
    expect(m.test("pkg\\app.py")).toBe(true);
  });

  it("掩码中的正则元字符按字面处理", () => {
    const m = compileFileMask("a+b.py")!;
    expect(m.test("a+b.py")).toBe(true);
    expect(m.test("aab.py")).toBe(false); // `+` 不该被解释成量词
  });
});
