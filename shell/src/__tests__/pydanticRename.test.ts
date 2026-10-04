// @vitest-environment happy-dom
// renameWidget 依赖 state.ts（顶层 lazyEl DOM 绑定），纯 node 环境跑不了；
// 被测对象 mergeCtorRefsIntoFiles / summarizeRenameTargets / pydanticModelNameOf 本身是纯函数。
import { describe, expect, it } from "vitest";
import { mergeCtorRefsIntoFiles, pydanticModelNameOf, summarizeRenameTargets } from "../renameWidget";
import type { RenameFileEdits } from "../lsp/client";

describe("mergeCtorRefsIntoFiles（阶段 4 子项 2b：Pydantic 改名传播合并）", () => {
  const files = (path: string, edits: [number, number][]): RenameFileEdits => ({
    path,
    edits: edits.map(([l, c]) => ({ startLine: l, startColumn: c, endLine: l, endColumn: c + 4, text: "new" })),
  });

  it("引擎结果优先：同位置（路径归一 + 行 + 列）不重复追加", () => {
    const engine = [files("F:/ws/models.py", [[5, 5]])];
    const merged = mergeCtorRefsIntoFiles(engine, [{ file: "f:/ws/models.py", line: 5, column: 5, len: 4 }], "new");
    expect(merged).toHaveLength(1);
    expect(merged[0].edits).toHaveLength(1); // 未追加
  });

  it("补充点追加进既有文件分组；新文件建新分组", () => {
    const engine = [files("F:/ws/models.py", [[5, 5]])];
    const refs = [
      { file: "F:/ws/usage.py", line: 3, column: 10, len: 4 },
      { file: "F:/ws/usage.py", line: 7, column: 10, len: 4 },
    ];
    const merged = mergeCtorRefsIntoFiles(engine, refs, "full_name");
    expect(merged).toHaveLength(2);
    const usage = merged.find((f) => f.path.endsWith("usage.py"));
    expect(usage?.edits).toHaveLength(2);
    expect(usage?.edits[0]).toEqual({
      startLine: 3, startColumn: 10, endLine: 3, endColumn: 14, text: "full_name",
    });
  });

  it("空 refs 与全重复 refs：内容不变（不追加、不丢编辑）", () => {
    const engine = [files("F:/ws/m.py", [[1, 1]])];
    expect(mergeCtorRefsIntoFiles(engine, [], "x")).toStrictEqual(engine);
    const dup = mergeCtorRefsIntoFiles(engine, [{ file: "F:/ws/m.py", line: 1, column: 1, len: 1 }], "x");
    expect(dup).toStrictEqual(engine);
  });

  it("跨路径分隔符归一（反斜杠 vs 正斜杠）视为同位置", () => {
    const engine = [files("F:/ws/m.py", [[3, 8]])];
    const merged = mergeCtorRefsIntoFiles(
      engine,
      [{ file: "F:\\ws\\m.py", line: 3, column: 8, len: 2 }],
      "x",
    );
    expect(merged[0].edits).toHaveLength(1);
  });
});

describe("pydanticModelNameOf（阶段 4 复核：子类链定位）", () => {
  const SRC = [
    "from pydantic import BaseModel",
    "",
    "class User(BaseModel):",
    "    name: str",
    "",
    "",
    "class Admin(User):",
    "    level: int = 1",
    "",
    "",
    "class Plain:",
    "    x: int = 1",
  ];

  it("基类字段 → 直接命中 User", () => {
    expect(pydanticModelNameOf(SRC, 3)).toBe("User");
  });

  it("子类自有字段 → 沿继承链定位 Admin（其父是 BaseModel）", () => {
    expect(pydanticModelNameOf(SRC, 7)).toBe("Admin");
  });

  it("普通类字段 → null（不补充）", () => {
    expect(pydanticModelNameOf(SRC, 12)).toBeNull();
  });

  it("越界 / 非类内行 → null", () => {
    expect(pydanticModelNameOf(SRC, 0)).toBeNull();
    expect(pydanticModelNameOf(SRC, -1)).toBeNull();
  });
});

describe("summarizeRenameTargets（既有回归：补充 refs 后摘要可见）", () => {
  it("合并后的文件集计入摘要", () => {
    const files: RenameFileEdits[] = [
      { path: "F:/ws/models.py", edits: [{ startLine: 5, startColumn: 5, endLine: 5, endColumn: 9, text: "x" }] },
      { path: "F:/ws/usage.py", edits: [{ startLine: 3, startColumn: 10, endLine: 3, endColumn: 14, text: "x" }] },
    ];
    const s = summarizeRenameTargets(files, "F:/ws");
    expect(s.total).toBe(2);
    expect(s.lines.some((l) => l.includes("usage.py"))).toBe(true);
  });
});
