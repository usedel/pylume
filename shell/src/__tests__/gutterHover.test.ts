// @vitest-environment happy-dom
// 回归（方案 1）：gutter 悬停预示只在「真正可点的那一档 + 可下断点的文件 + 该行无真实 glyph」时出现。
// 三条不变量各自对应一个已踩或易踩的坑：
// 1. 行号档不提示——那一档点了不会下断点（debugGutter 只认 glyph 档），画预示等于骗用户；
// 2. 该行已有断点 / ▶ / 灯泡时不叠加——Monaco 会把同行同 lane 的装饰 class 合并成一串
//    （glyphMargin.js::prepareRender），两条 ::after 会在同一元素上打架；
// 3. 预示装饰的 zIndex 必须低于默认值（兜底：同位置只渲染 zIndex 最高者，真图标不会被覆盖）。
import { beforeEach, describe, expect, it } from "vitest";
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { app, type MonacoModule } from "../state";
import { clearGutterHover, wireGutterHover } from "../gutterHover";

const GLYPH = 2; // MouseTargetType.GUTTER_GLYPH_MARGIN
const NUMBERS = 3; // MouseTargetType.GUTTER_LINE_NUMBERS
const CONTENT = 6; // MouseTargetType.CONTENT_TEXT
const PATH = "/ws/app.py";

type MouseHandler = (e: unknown) => void;

const monaco = {
  editor: { MouseTargetType: { GUTTER_GLYPH_MARGIN: GLYPH, GUTTER_LINE_NUMBERS: NUMBERS } },
  Range: class { startLineNumber: number; constructor(l: number) { this.startLineNumber = l; } },
} as unknown as MonacoModule;

interface FakeDecoration {
  range: { startLineNumber: number };
  options: { glyphMarginClassName?: string; zIndex?: number };
}

interface Rendered { className?: string; line: number; zIndex?: number }

/** 只实现本测试触及的最小面：onMouseMove 收集器 + 装饰记录器 + 已清除计数 */
function makeEditor() {
  const mouse: MouseHandler[] = [];
  const rendered: Rendered[] = [];
  let lineDecorations: Array<{ options: { glyphMarginClassName?: string | null } }> = [];
  let cleared = 0;
  const editor = {
    onMouseMove: (h: MouseHandler) => { mouse.push(h); },
    onMouseLeave: () => {},
    onDidChangeModel: () => {},
    getLineDecorations: () => lineDecorations,
    createDecorationsCollection: (descs: FakeDecoration[]) => {
      for (const d of descs) {
        rendered.push({ className: d.options.glyphMarginClassName, line: d.range.startLineNumber, zIndex: d.options.zIndex });
      }
      return { clear: () => { cleared++; } };
    },
  } as unknown as MonacoApi.editor.IStandaloneCodeEditor;
  return {
    editor,
    mouse,
    rendered,
    clears: () => cleared,
    setLineDecorations: (d: typeof lineDecorations) => { lineDecorations = d; },
  };
}

function moveTo(mouse: MouseHandler[], type: number, line: number): void {
  for (const h of mouse) h({ target: { type, position: { lineNumber: line } } });
}

describe("方案 1：gutter 悬停预示", () => {
  let ctx: ReturnType<typeof makeEditor>;

  beforeEach(() => {
    clearGutterHover();
    ctx = makeEditor();
    app.activeTab = { path: PATH, model: null } as unknown as typeof app.activeTab;
    wireGutterHover(ctx.editor, monaco);
  });

  it("悬停 glyph 档 → 在该行画预示，且 zIndex 为 -1（不覆盖真图标）", () => {
    moveTo(ctx.mouse, GLYPH, 5);
    expect(ctx.rendered).toEqual([{ className: "gutter-hover", line: 5, zIndex: -1 }]);
  });

  it("悬停行号档 → 不画（那一档点了不会下断点）", () => {
    moveTo(ctx.mouse, NUMBERS, 5);
    expect(ctx.rendered).toEqual([]);
  });

  it("该行已有真实 glyph（断点）→ 不画，避免同行同 lane 的 class 合并", () => {
    ctx.setLineDecorations([{ options: { glyphMarginClassName: "gutter-breakpoint" } }]);
    moveTo(ctx.mouse, GLYPH, 5);
    expect(ctx.rendered).toEqual([]);
  });

  it("非 .py 文件 → 不画", () => {
    app.activeTab = { path: "/ws/app.md", model: null } as unknown as typeof app.activeTab;
    moveTo(ctx.mouse, GLYPH, 5);
    expect(ctx.rendered).toEqual([]);
  });

  it("同一行内连续移动 → 只创建一次（mousemove 高频，靠行号短路）", () => {
    moveTo(ctx.mouse, GLYPH, 5);
    moveTo(ctx.mouse, GLYPH, 5);
    moveTo(ctx.mouse, GLYPH, 5);
    expect(ctx.rendered).toHaveLength(1);
  });

  it("移动到别的行 → 清掉旧的、在新行重建", () => {
    moveTo(ctx.mouse, GLYPH, 5);
    moveTo(ctx.mouse, GLYPH, 9);
    expect(ctx.rendered).toEqual([
      { className: "gutter-hover", line: 5, zIndex: -1 },
      { className: "gutter-hover", line: 9, zIndex: -1 },
    ]);
    expect(ctx.clears()).toBeGreaterThan(0);
  });

  it("移出 gutter（进入正文）→ 清除预示", () => {
    moveTo(ctx.mouse, GLYPH, 5);
    moveTo(ctx.mouse, CONTENT, 5);
    expect(ctx.clears()).toBeGreaterThan(0);
  });
});
