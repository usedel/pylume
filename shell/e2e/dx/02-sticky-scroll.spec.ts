/**
 * E2E：PR-B Sticky Scroll（dx_features_backlog §6.2）
 *
 *  - E-DX-ST1 默认开：长文件滚动过作用域头部后，编辑器顶部出现 sticky 容器
 *  - E-DX-ST2 设置开关可关：关闭后 sticky 容器消失，重新勾选恢复
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

/** 生成足够长的 Python 文件（每个 def 都是一个独立作用域） */
function longSource(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 40; i++) {
    lines.push(`def func_${i}(value):`);
    lines.push(`    total = value * ${i}`);
    lines.push(`    return total + ${i}`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

let repo: GitRepo;
const pageErrors: string[] = [];

/** 滚到第 38 行（func_10 的函数体内部，def 头部已滚出视口顶）——sticky 显示 def func_10 */
function scrollToBody(page: Page): Promise<void> {
  return page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const lh = app.editor.getOption(app.monaco.editor.EditorOption.lineHeight) as number;
    // 首个可见行 = floor(scrollTop/lh)+1；滚过 def 行（37）落在函数体内 sticky 才非空
    app.editor.setScrollTop(37 * lh + 4);
  });
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "long.py": longSource() });
  await equipPage(page, repo);
  await page.goto("/");
  await page.locator("#tree .tree-item .name", { hasText: "long.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-DX-ST1 默认开：滚动过作用域头部后 sticky 容器出现", async ({ page }) => {
  await scrollToBody(page);
  await expect(page.locator(".monaco-editor .sticky-widget")).toBeVisible({ timeout: 10_000 });
});

test("E-DX-ST2 设置开关可关再开", async ({ page }) => {
  await scrollToBody(page);
  await expect(page.locator(".monaco-editor .sticky-widget")).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press("Control+Alt+S");
  await expect(page.locator("#settings-modal, .modal:has(#settings-save)").first()).toBeVisible({ timeout: 5_000 });
  await page.locator('.settings-nav-item[data-cat="editor"]').click();
  const toggle = page.locator("#settings-sticky-scroll");
  await expect(toggle).toBeVisible({ timeout: 5_000 });
  await toggle.uncheck();
  await page.locator("#settings-save").click();
  // 关闭后：容器不再渲染（保存路径经 buildEditorOptions → updateOptions 即时生效）
  await expect.poll(async () => page.locator(".monaco-editor .sticky-widget").count(), { timeout: 5_000 }).toBe(0);

  await page.keyboard.press("Control+Alt+S");
  await page.locator('.settings-nav-item[data-cat="editor"]').click();
  await toggle.check();
  await page.locator("#settings-save").click();
  await expect(page.locator(".monaco-editor .sticky-widget")).toBeVisible({ timeout: 10_000 });
});
