// @vitest-environment happy-dom
// 钉住 gutter 字形尺寸（方案 2：随编辑器字号缩放）的两条跨文件不变量。
// 这两处都是「改了也不报错、只在肉眼上退化」的静默漂移点：
// 1. 三个 gutter 字形必须共用同一条 font-size 规则。漏掉任何一个，它就拿不到
//    --editor-font-size，掉回继承的 body 13px（codicon 基础规则只认 `codicon-*` 类名，
//    本项目用自命名类，命中不到那条 16px）——这正是之前红点偏小的成因。
// 2. :root 里 --editor-font-size 的兜底值必须等于默认字号。applyFontStatus 要到 init 里才写
//    该变量，首屏那一下用的是兜底值；两者不一致会在启动瞬间闪一次错误尺寸。
// 每条断言都读 style.css 原文，样式侧改动会立刻在此暴露（不依赖浏览器生效）。
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../state";

/** 读 style.css 原文——不能用 `new URL(..., import.meta.url)`：vite 转换后它不再是 file: URL。
 *  vitest 的 cwd 通常是 shell/（npm test）；同时兼容从仓库根带 --root 启动的情况。 */
function readStyleCss(): string {
  for (const rel of ["src/style.css", "shell/src/style.css"]) {
    const p = resolve(process.cwd(), rel);
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }
  throw new Error(`找不到 style.css（cwd=${process.cwd()}）`);
}

const css = readStyleCss();

/** Monaco fontInfo.js 的 GOLDEN_LINE_HEIGHT_RATIO：行高 = 1.5 × 字号 */
const GOLDEN_LINE_HEIGHT_RATIO = 1.5;
/** 字形占行高的比例（光学取值，见 style.css 该规则注释） */
const GLYPH_TO_LINE_RATIO = 0.75;

/** gutter 字形类名（新增第 4 个字形时必须加进这条尺寸规则，否则本测试会红） */
const GUTTER_GLYPHS = ["gutter-breakpoint", "gutter-run", "gutter-hover"];

/** 取出「字号走 calc(var(--editor-font-size) * N)」的那条规则 */
function findSizeRule(): { selectors: string; factor: number } | null {
  const m = /([^{}]+)\{[^{}]*font-size:\s*calc\(var\(--editor-font-size\)\s*\*\s*([\d.]+)\)[^{}]*\}/.exec(css);
  if (!m) return null;
  return { selectors: m[1], factor: Number(m[2]) };
}

describe("gutter 字形尺寸（方案 2）", () => {
  it(":root 的 --editor-font-size 兜底值 = 默认字号（首屏写变量前用）", () => {
    const m = /--editor-font-size:\s*(\d+)px/.exec(css);
    expect(m, "style.css :root 应声明 --editor-font-size 兜底值").not.toBeNull();
    expect(Number(m![1])).toBe(DEFAULT_SETTINGS.font_size);
  });

  it("三个 gutter 字形共用同一条字号规则（漏一个即掉回继承的 13px）", () => {
    const rule = findSizeRule();
    expect(rule, "style.css 应有 font-size: calc(var(--editor-font-size) * N) 规则").not.toBeNull();
    for (const cls of GUTTER_GLYPHS) {
      expect(rule!.selectors, `${cls} 未纳入 gutter 字形尺寸规则`).toContain(`.${cls}::after`);
    }
  });

  it("倍率 = 行高比例 × 字形占行高比例（1.5 × 0.75 = 1.125，默认档 16px）", () => {
    const rule = findSizeRule();
    expect(rule!.factor).toBeCloseTo(GOLDEN_LINE_HEIGHT_RATIO * GLYPH_TO_LINE_RATIO, 3);
    expect(rule!.factor * DEFAULT_SETTINGS.font_size).toBeCloseTo(16, 0); // 默认档落在 codicon 设计尺寸
  });
});
