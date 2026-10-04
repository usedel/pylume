// @vitest-environment happy-dom
// 回归（方案 A）：运行 ▶ 与断点红点共用同一 glyph margin，且 Monaco onMouseDown 多订阅
// 互不阻断。若 debugGutter 不显式让出 __main__ 守卫行，点一次 ▶ 会「既运行又设断点」，
// 红点装饰还会因 CSS 书写顺序盖掉 ▶ —— 表现为「点运行图标后变成断点图标」。
//
// 本测试固化两条不变量：
// 1. glyph 点击落在守卫行 → 不切换断点（其余行照常）；
// 2. refreshDebugGutter 不渲染守卫行上的历史断点（否则红点压过 ▶）。
import { beforeEach, describe, expect, it } from "vitest";
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { app, type MonacoModule } from "../state";
import { clearBreakpoints, getBreakpointLines, setBreakpointLines, refreshDebugGutter, wireDebugGutter } from "../debugGutter";

const GLYPH = 6; // 任意稳定值即可，只要求与 fake monaco 的 MouseTargetType 一致
const PATH = "/ws/app.py";
const RUN_LINE = 3;

type MouseHandler = (e: unknown) => void;

/** 只实现本测试触及的最小面：onMouseDown 收集器 + createDecorationsCollection 记录器 */
function makeEditor(): { editor: MonacoApi.editor.IStandaloneCodeEditor; handlers: MouseHandler[]; rendered: number[][] } {
  const handlers: MouseHandler[] = [];
  const rendered: number[][] = [];
  const editor = {
    onMouseDown: (h: MouseHandler) => { handlers.push(h); },
    createDecorationsCollection: (descs: Array<{ range: { startLineNumber: number } }>) => {
      rendered.push(descs.map((d) => d.range.startLineNumber));
      return { clear: () => {} };
    },
  } as unknown as MonacoApi.editor.IStandaloneCodeEditor;
  return { editor, handlers, rendered };
}

const monaco = {
  editor: { MouseTargetType: { GUTTER_GLYPH_MARGIN: GLYPH } },
  Range: class { startLineNumber: number; constructor(l: number) { this.startLineNumber = l; } },
} as unknown as MonacoModule;

function click(handlers: MouseHandler[], line: number, rightButton = false): void {
  for (const h of handlers) h({ target: { type: GLYPH, position: { lineNumber: line } }, event: { rightButton } });
}

describe("方案 A：▶ 守卫行的 glyph 归运行图标独享", () => {
  let handlers: MouseHandler[];
  let rendered: number[][];

  beforeEach(() => {
    clearBreakpoints(PATH);
    const made = makeEditor();
    handlers = made.handlers;
    rendered = made.rendered;
    app.activeTab = { path: PATH, model: null } as unknown as typeof app.activeTab;
    // 注入判定：仅 RUN_LINE 被视为 ▶ 占用行
    wireDebugGutter(made.editor, monaco, (line) => line === RUN_LINE);
  });

  it("普通行 glyph 左键 → 正常切换断点", () => {
    click(handlers, 5);
    expect(getBreakpointLines(PATH)).toEqual([5]);
  });

  it("守卫行 glyph 左键 → 不设断点（让给 runGutter）", () => {
    click(handlers, RUN_LINE);
    expect(getBreakpointLines(PATH)).toEqual([]);
  });

  it("右键不触发断点（与 run gutter 菜单语义区分）", () => {
    click(handlers, 5, true);
    expect(getBreakpointLines(PATH)).toEqual([]);
  });

  it("守卫行上的历史断点不渲染红点（否则会压过 ▶）", () => {
    setBreakpointLines(PATH, [RUN_LINE, 7]);
    refreshDebugGutter();
    expect(rendered.at(-1)).toEqual([7]);
  });
});
