// @vitest-environment happy-dom
// 诊断导航域（2026-09-29 交付）纯函数单测：序列构建 / 起点锚定 / 保存错误分类与文案。
// gotoMarker / revealFirstError 依赖注入后的 monaco 实例，由 e2e 覆盖（tmp→正式 spec）。
import { describe, expect, it } from "vitest";
import { navTargetIndex, buildNavSequence, breakDownSaveErrors, isSyntaxErrorMarker, saveErrorToastMessage } from "../markerNavigation";

const ERR = 8; // MarkerSeverity.Error（Monaco 枚举值）
const WARN = 4; // MarkerSeverity.Warning

describe("buildNavSequence：过滤 + 行列升序", () => {
  it("只保留目标严重级（Info/Hint 剔除）", () => {
    const seq = buildNavSequence(
      [
        { startLineNumber: 3, startColumn: 1, severity: ERR, message: "e" },
        { startLineNumber: 4, startColumn: 1, severity: 2, message: "info" }, // Info，剔除
        { startLineNumber: 5, startColumn: 1, severity: 1, message: "hint" }, // Hint，剔除
        { startLineNumber: 6, startColumn: 1, severity: WARN, message: "w" },
      ],
      new Set([ERR, WARN]),
    );
    expect(seq.map((m) => m.line)).toEqual([3, 6]);
  });

  it("同 severity 内按行升序、同行按列升序", () => {
    const seq = buildNavSequence(
      [
        { startLineNumber: 10, startColumn: 5, severity: ERR, message: "b" },
        { startLineNumber: 2, startColumn: 9, severity: ERR, message: "a" },
        { startLineNumber: 10, startColumn: 2, severity: ERR, message: "c" },
      ],
      new Set([ERR]),
    );
    expect(seq.map((m) => m.column)).toEqual([9, 2, 5]); // (2,9) → (10,2) → (10,5)
  });

  it("空输入 → 空序列", () => {
    expect(buildNavSequence([], new Set([ERR, WARN]))).toEqual([]);
  });
});

describe("navTargetIndex：光标位置锚定（严格之前/之后 + 回绕）", () => {
  const seq = [
    { line: 10, column: 1, severity: ERR, message: "" },
    { line: 20, column: 5, severity: ERR, message: "" },
    { line: 20, column: 9, severity: ERR, message: "" },
    { line: 30, column: 1, severity: ERR, message: "" },
  ];

  it("下一个（dir=1）：光标严格之后的第一个（含列比较）", () => {
    expect(navTargetIndex(seq, { line: 1, column: 1 }, 1)).toBe(0); // 最前 → 第 0 项
    expect(navTargetIndex(seq, { line: 10, column: 1 }, 1)).toBe(1); // 正停在第 0 项上 → 下一项（不重复自身）
    expect(navTargetIndex(seq, { line: 15, column: 1 }, 1)).toBe(1); // 之间 → 第 1 项
    expect(navTargetIndex(seq, { line: 20, column: 5 }, 1)).toBe(2); // 同行停在列 5 → 列 9 那项
    expect(navTargetIndex(seq, { line: 20, column: 7 }, 1)).toBe(2); // 同行之间 → 列 9
    expect(navTargetIndex(seq, { line: 30, column: 1 }, 1)).toBe(0); // 末项上 → 回绕第 0 项
    expect(navTargetIndex(seq, { line: 99, column: 1 }, 1)).toBe(0); // 末尾之后 → 回绕
  });

  it("上一个（dir=-1）：光标严格之前的最后一个（含列比较）", () => {
    expect(navTargetIndex(seq, { line: 99, column: 1 }, -1)).toBe(3); // 末尾 → 第 3 项
    expect(navTargetIndex(seq, { line: 30, column: 1 }, -1)).toBe(2); // 正停在第 3 项上 → 第 2 项
    expect(navTargetIndex(seq, { line: 20, column: 7 }, -1)).toBe(1); // 同行之间 → 列 5 那项
    expect(navTargetIndex(seq, { line: 20, column: 5 }, -1)).toBe(0); // 同行停在列 5 → 第 0 项
    expect(navTargetIndex(seq, { line: 1, column: 1 }, -1)).toBe(3); // 最前 → 回绕末项
  });

  it("空序列 → -1", () => {
    expect(navTargetIndex([], { line: 1, column: 1 }, 1)).toBe(-1);
    expect(navTargetIndex([], { line: 1, column: 1 }, -1)).toBe(-1);
  });
});

describe("isSyntaxErrorMarker：两引擎 + ruff 的语法错误判定", () => {
  it("pyrefly：code='parse-error' 是语法错误；其它 code 不是", () => {
    expect(isSyntaxErrorMarker({ source: "pyrefly", code: "parse-error" })).toBe(true);
    expect(isSyntaxErrorMarker({ source: "pyrefly", code: "unknown-name" })).toBe(false);
    expect(isSyntaxErrorMarker({ source: "pyrefly", code: "invalid-argument-type" })).toBe(false);
  });

  it("basedpyright：语法错误无 code；语义错误带 reportXxx code", () => {
    // 实测（2026-09-29 裸 LSP 探测）：basedpyright 语法错误 code 为 null
    expect(isSyntaxErrorMarker({ source: "basedpyright", code: undefined })).toBe(true);
    expect(isSyntaxErrorMarker({ source: "basedpyright", code: "reportUndefinedVariable" })).toBe(false);
    expect(isSyntaxErrorMarker({ source: "basedpyright", code: "reportAssignmentType" })).toBe(false);
  });

  it("ruff：invalid-syntax 无 code 且 source 为规则码或 ruff", () => {
    expect(isSyntaxErrorMarker({ source: "invalid-syntax" })).toBe(true);
    expect(isSyntaxErrorMarker({ source: "ruff", code: undefined })).toBe(true);
    // ruff 语义类规则带 code → 非语法错误
    expect(isSyntaxErrorMarker({ source: "F401" })).toBe(false);
    expect(isSyntaxErrorMarker({ source: "E501" })).toBe(false);
  });

  it("自研桶（无 code）非语法错误", () => {
    expect(isSyntaxErrorMarker({ source: "pylume-pydantic" })).toBe(false);
    expect(isSyntaxErrorMarker({ source: "pylume-libs" })).toBe(false);
    expect(isSyntaxErrorMarker({ source: "pylume-intel" })).toBe(false);
  });

  it("source 缺失且无 code（兜底归语法）", () => {
    expect(isSyntaxErrorMarker({})).toBe(true);
  });
});

describe("breakDownSaveErrors + saveErrorToastMessage：保存 toast 分类", () => {
  it("语法/其他分类计数（只数 error 级）", () => {
    const b = breakDownSaveErrors(
      [
        { severity: ERR, source: "pyrefly", code: "parse-error" },
        { severity: ERR, source: "pyrefly", code: "parse-error" },
        { severity: ERR, source: "pyrefly", code: "invalid-argument-type" },
        { severity: WARN, source: "ruff", code: undefined }, // warning 不计入
      ],
      ERR,
    );
    expect(b).toEqual({ syntax: 2, other: 1 });
  });

  it("168 实案口径：23 语法 + 145 类型 → 文案两段并列", () => {
    const markers = [
      ...Array.from({ length: 23 }, () => ({ severity: ERR, source: "pyrefly", code: "parse-error" })),
      ...Array.from({ length: 145 }, () => ({ severity: ERR, source: "pyrefly", code: "invalid-argument-type" })),
    ];
    const b = breakDownSaveErrors(markers, ERR);
    expect(saveErrorToastMessage("cli.py", b)).toBe("cli.py：23 处语法错误，145 处类型/引用错误（已保存）");
  });

  it("纯语法错误 → 单段文案（保持旧语义）", () => {
    const b = breakDownSaveErrors(
      [
        { severity: ERR, source: "pyrefly", code: "parse-error" },
        { severity: ERR, source: "basedpyright", code: undefined },
      ],
      ERR,
    );
    expect(saveErrorToastMessage("bad.py", b)).toBe("bad.py：2 处语法错误（已保存）");
  });

  it("纯类型错误 → 单段文案（不再误称语法错误）", () => {
    const b = breakDownSaveErrors([{ severity: ERR, source: "pyrefly", code: "invalid-argument-type" }], ERR);
    expect(saveErrorToastMessage("a.py", b)).toBe("a.py：1 处类型/引用错误（已保存）");
  });
});
