import { describe, expect, it } from "vitest";
import { buildMergedContent, parseMergeSegments, type MergeChoice } from "../gitMerge";

// 单个冲突块（不带末尾换行，避免末尾空 text 段干扰断言）
const ONE_CONFLICT = "line1\n<<<<<<< HEAD\nours-content\n=======\ntheirs-content\n>>>>>>> feature\nline2";

describe("parseMergeSegments（冲突块解析）", () => {
  it("无冲突标记 → 单个 text 段", () => {
    expect(parseMergeSegments("a\nb")).toEqual([{ kind: "text", text: "a\nb" }]);
  });

  it("单个冲突块切分为 [普通段, 冲突块, 普通段]", () => {
    const segs = parseMergeSegments(ONE_CONFLICT);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ kind: "text", text: "line1" });
    const conflict = segs[1];
    expect(conflict.kind).toBe("conflict");
    if (conflict.kind === "conflict") {
      expect(conflict.block.current).toBe("ours-content");
      expect(conflict.block.incoming).toBe("theirs-content");
    }
    expect(segs[2]).toEqual({ kind: "text", text: "line2" });
  });

  it("多个冲突块正确切分", () => {
    const content = "<<<<<<< HEAD\nA1\n=======\nB1\n>>>>>>> x\nmid\n<<<<<<< HEAD\nA2\n=======\nB2\n>>>>>>> x";
    const segs = parseMergeSegments(content);
    const conflicts = segs.filter((s) => s.kind === "conflict");
    expect(conflicts).toHaveLength(2);
    expect(segs.map((s) => s.kind)).toEqual(["conflict", "text", "conflict"]);
  });

  it("未闭合冲突标记 → 整段按普通文本保留，不丢数据", () => {
    const content = "a\n<<<<<<< HEAD\nunclosed\n";
    const segs = parseMergeSegments(content);
    expect(segs).toEqual([{ kind: "text", text: "a\n<<<<<<< HEAD\nunclosed\n" }]);
  });

  it("空内容 → 空数组", () => {
    expect(parseMergeSegments("")).toEqual([]);
  });

  // P0.5-A3：setext 标题下划线（单独成行的 =======）不是冲突标记，
  // 不得被误判（旧检测 /\n=======/ 会误伤，见 git.ts applyMergeResolve 注释）
  it("markdown setext 下划线（孤行 =======）不是冲突块", () => {
    const content = "标题\n=======\n正文";
    const segs = parseMergeSegments(content);
    expect(segs.filter((s) => s.kind === "conflict")).toHaveLength(0);
    expect(segs).toEqual([{ kind: "text", text: "标题\n=======\n正文" }]);
  });

  it("重组结果再解析：markdown 下划线文本不触发残留检测", () => {
    const content = "line1\n<<<<<<< HEAD\n标题\n=======\n正文\n>>>>>>> f\nline2";
    const segs = parseMergeSegments(content);
    const merged = buildMergedContent(segs, new Map([[0, "current"]]));
    // 保留 current（"标题"），重组后不应再被解析出冲突块
    expect(parseMergeSegments(merged).filter((s) => s.kind === "conflict")).toHaveLength(0);
  });
});

describe("buildMergedContent（按选择重组）", () => {
  const segs = parseMergeSegments(ONE_CONFLICT);

  it("默认（无显式选择）→ 保留当前", () => {
    expect(buildMergedContent(segs, new Map())).toBe("line1\nours-content\nline2");
  });

  it("选 incoming → 替换为传入", () => {
    const sel = new Map<number, MergeChoice>([[0, "incoming"]]);
    expect(buildMergedContent(segs, sel)).toBe("line1\ntheirs-content\nline2");
  });

  it("选 both → 当前 + 传入", () => {
    const sel = new Map<number, MergeChoice>([[0, "both"]]);
    expect(buildMergedContent(segs, sel)).toBe("line1\nours-content\ntheirs-content\nline2");
  });

  it("多个冲突块可按各自选择逐块重组，普通段原样保留", () => {
    const content = "<<<<<<< HEAD\nA1\n=======\nB1\n>>>>>>> x\nmid\n<<<<<<< HEAD\nA2\n=======\nB2\n>>>>>>> x";
    const s = parseMergeSegments(content);
    const sel = new Map<number, MergeChoice>([
      [0, "current"],
      [1, "incoming"],
    ]);
    expect(buildMergedContent(s, sel)).toBe("A1\nmid\nB2");
  });
});