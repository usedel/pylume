/**
 * E2E：批 3 · 随包等宽字体（JetBrains Mono）在 **Monaco 内**与外壳同时生效。
 *
 * 为什么必须有这条（ui_premium §5.3-3b 第 5 步「实测这一步不做等于没做」）：
 *  - 方案的验收判据是 `document.fonts.check('12px "JetBrains Mono"')` 为 true，但那只能证明
 *    **字体文件加载成功**，证明不了 **Monaco 用上了它**——Monaco 根本不读 CSS，
 *    字体来自 `settings.font_family` → `buildEditorOptions` 注入（`style.css --mono` 只管外壳）。
 *  - 判据「Monaco 实际渲染的字体」只能从 `.view-lines` 上读——Monaco 把 fontFamily /
 *    font-feature-settings 内联在该节点，是唯一权威来源（读 app.editor.getOption 也行，
 *    但那依赖模块实例同一性，不如 DOM 稳）。
 *
 * 字体栈经 `__E2E_SETTINGS_PRESET__` 预置（tauri-mock 的 get_settings 会把该对象合并进
 * 静态 SETTINGS）：**不改 mock 的全局默认 font_family**，否则会改变所有用例的字符宽度，
 *进而影响 E-BASIC-1/2 那类依赖坐标与选区范围的用例。
 */
import { test, expect } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

/** 与 state.ts DEFAULT_FONT_FAMILY / style.css --mono / settings.rs Default 同串（fontStack.test.ts 钉死四方一致） */
const FONT_STACK = '"JetBrains Mono", "Cascadia Code", "SF Mono", Consolas, monospace';

const SRC = "def f() -> int:\n    return 1\n";

let repo: GitRepo;

test.beforeEach(async ({ page }) => {
  repo = await makePlainDir({ "main.py": SRC });
  await page.addInitScript((stack) => {
    (window as unknown as { __E2E_SETTINGS_PRESET__?: Record<string, unknown> }).__E2E_SETTINGS_PRESET__ = {
      font_family: stack,
      font_ligatures: true,
    };
  }, FONT_STACK);
  await equipPage(page, repo);
  await page.goto("/");
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 30_000 });
  // 等 .view-lines 真正拿到字体（Monaco 首帧后才内联 font-family）
  await expect(page.locator(".monaco-editor .view-lines").first()).toBeAttached({ timeout: 30_000 });
});

test("F-B3-1 随包字体已加载且 Monaco 实际使用它（不只是 CSS 声明存在）", async ({ page }) => {
  // ① 字体文件真的到位（方案原文的验收判据）
  expect(
    await page.evaluate(() => document.fonts.check('14px "JetBrains Mono"')),
    "document.fonts.check 对 JetBrains Mono 应为 true（CSP / 路径错了会静默回落 Consolas）",
  ).toBe(true);

  // ② Monaco 实际渲染的字体栈 —— 本条才是「编辑器用上了随包字体」的证据
  const monacoFont = await page.evaluate(() => {
    const el = document.querySelector(".monaco-editor .view-lines");
    return el ? getComputedStyle(el).fontFamily : "";
  });
  expect(monacoFont, "Monaco 的 .view-lines 上应有 fontFamily").toContain("JetBrains Mono");

  // ③ 外壳等宽 token 同步（编辑器不读它，但输出/搜索/终端/DB 面板读）
  const monoToken = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--mono"),
  );
  expect(monoToken).toContain("JetBrains Mono");

  // ④ body 走 --font-ui（UI 字体**不**随包，批 3 刻意保持系统栈）
  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(bodyFont).not.toContain("JetBrains Mono");
});

test("F-B3-2 四个 woff2 子集均可达且 MIME 正确（静默 404 是本项最常见故障）", async ({ page }) => {
  const files = await page.evaluate(async () => {
    const names = [
      "JetBrainsMono-latin-400-normal.woff2",
      "JetBrainsMono-latin-400-italic.woff2",
      "JetBrainsMono-latin-700-normal.woff2",
      "JetBrainsMono-latin-ext-400-normal.woff2",
    ];
    const out: Record<string, string> = {};
    for (const n of names) {
      const r = await fetch(`/fonts/${n}`);
      out[n] = `${r.status} ${r.headers.get("content-type") ?? "?"} ${(await r.arrayBuffer()).byteLength}B`;
    }
    return out;
  });
  for (const [name, info] of Object.entries(files)) {
    expect(info, `${name} 应 200 + font/woff2`).toMatch(/^200 font\/woff2 \d+B$/);
  }
});
