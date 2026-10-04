/**
 * E2E：Ctrl+F 查找（窗口级，editorFind.ts）
 *
 * 断言：
 *  1. 焦点不在编辑器（侧栏文件树）时按 Ctrl+F → 打开 Monaco 查找条（而非浏览器原生查找）；
 *  2. 焦点已在编辑器内时按 Ctrl+F → 同样是 Monaco 查找条（不重复开/关）；
 *  3. 无活动标签（关闭全部标签）时按 Ctrl+F → 不出现任何查找条（吞键，无反应）。
 */
import { test, expect } from "@playwright/test";
import { equipPage, makePlainDir } from "../helpers";

/** 打开工作区内的 main.py（标签出现即就绪） */
async function openMain(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().dblclick();
  await expect(page.locator("#tabbar .tab", { hasText: "main.py" })).toBeVisible({ timeout: 10_000 });
}

test.beforeEach(async ({ page }) => {
  const repo = await makePlainDir({ "main.py": "alpha = 1\nbeta = 2\ngamma = 3\n" });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#tree .tree-item .name", { hasText: "main.py" }).first()).toBeVisible({ timeout: 20_000 });
});

test("焦点在侧栏时按 Ctrl+F → 打开当前标签的 Monaco 查找条", async ({ page }) => {
  await openMain(page);
  // 焦点移出编辑器：单击文件树条目（此时 Ctrl+F 若无人处理，会落到浏览器原生查找）
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().click();
  expect(await page.evaluate(() => !!document.activeElement?.closest(".monaco-editor"))).toBe(false);

  await page.keyboard.press("Control+f");
  const widget = page.locator(".monaco-editor .find-widget.visible");
  await expect(widget).toBeVisible({ timeout: 5_000 });
  // 焦点应落在查找框（可直接输入），且查找的是活动标签内容
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest(".find-widget")))
    .toBe(true);
  await expect(page.locator("#tabbar .tab.active")).toContainText("main.py");
});

test("焦点在编辑器内时按 Ctrl+F → 同样打开 Monaco 查找条（不被吞、不重复触发）", async ({ page }) => {
  await openMain(page);
  await page.locator(".monaco-editor").first().click();
  await page.keyboard.press("Control+f");
  await expect(page.locator(".monaco-editor .find-widget.visible")).toBeVisible({ timeout: 5_000 });
});

test("无活动标签时按 Ctrl+F → 无反应（不出现查找条）", async ({ page }) => {
  await openMain(page);
  await page.locator("#tabbar .tab.active .close").click();
  await expect(page.locator("#tabbar .tab")).toHaveCount(0, { timeout: 5_000 });

  await page.keyboard.press("Control+f");
  await expect(page.locator(".monaco-editor .find-widget.visible")).toHaveCount(0);
  // 也没有误开全局搜索 / 命令面板等其它覆盖层（容器常驻 DOM，按可见性判定）
  await expect(page.locator("#quick-open-input")).toBeHidden();
});
