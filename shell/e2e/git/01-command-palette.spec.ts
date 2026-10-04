/**
 * E2E-01：命令面板 git 可达性（迭代 1 · P0-1 + command_palette 键位）
 *
 * 断言：
 *  1. Ctrl+Shift+P 打开命令面板（command_palette 键位；不注册时该组合触发浏览器「打印」）
 *     并拦截默认行为；
 *  2. 输入 git → 出现 Git 命令族（≥12 条）；
 *  3. 「Git: 提交历史」可执行并打开历史视图。
 */
import { test, expect } from "@playwright/test";
import { equipPage, makeGitRepo } from "../helpers";

test.beforeEach(async ({ page }) => {
  const repo = await makeGitRepo({
    files: { "main.py": "print('hello')\n" },
    commitMsg: "baseline",
  });
  await equipPage(page, repo);
  await page.goto("/");
  // 等 Git 状态就绪（工作区自动恢复 + 首次状态刷新完成）
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
});

test("Ctrl+Shift+P 打开命令面板（拦截浏览器打印）并出现 Git 命令族（≥12 条）", async ({ page }) => {
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator("#quick-open-input");
  await expect(input).toBeVisible({ timeout: 5_000 });
  // 命令直达模式：placeholder 是命令面板专属文案（区别于混搜模式）
  await expect(input).toHaveAttribute("placeholder", /命令/);
  await input.fill("git");
  const items = page.locator("#quick-open-list .quick-open-item");
  await expect(items.first()).toBeVisible({ timeout: 5_000 });
  const names = await page.locator("#quick-open-list .quick-open-name").allTextContents();
  // 「Git: *」前缀命令（迭代 1 新增 12 条）+ 原有「Git 面板」，合计 ≥12
  const gitCmds = names.filter((t) => t.startsWith("Git:"));
  expect(gitCmds.length).toBeGreaterThanOrEqual(11);
  expect(names.filter((t) => t.startsWith("Git")).length).toBeGreaterThanOrEqual(12);
});

test("执行「Git: 提交历史」打开历史视图", async ({ page }) => {
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator("#quick-open-input");
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill("Git: 提交历史");
  // 命中唯一命令项后回车执行
  await expect(page.locator("#quick-open-list .quick-open-item").first()).toBeVisible({ timeout: 5_000 });
  await page.keyboard.press("Enter");
  const history = page.locator("#git-history");
  await expect(history).toBeVisible({ timeout: 5_000 });
  // baseline 提交在历史列表中（含 refs 装饰 HEAD -> main）
  await expect(history.locator(".git-commit-item")).toHaveCount(1, { timeout: 5_000 });
  await expect(history.locator(".git-commit-refs")).toContainText("main");
});
