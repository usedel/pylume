/**
 * E2E：PR-J 触发补全建议备选键 Alt+/（dx_features_backlog §6.6）
 *
 * 背景：Ctrl+Space 是 Monaco 内建固定键，Windows 中文 IME 下被输入法切换热键吞掉
 * （2026-09-27 人工验证），故注册可配置键位 trigger_suggest = Alt+/（editor 级）。
 *
 * 被测边界 = 键位解析与 handler 接线：输入 "s." 让 mock 引擎自动弹补全 → Escape 关掉
 * → Alt+/ 重新唤起（证明 Alt+/ 等价于 triggerSuggest，与 IME 无关、mock 环境可复现）。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

let repo: GitRepo;
const pageErrors: string[] = [];

/** 打开 a.py、另起一行输入 "result = s."（成员补全由 trigger char 自动弹出） */
async function typeMemberAccess(page: Page): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: "a.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
  await page.locator("#editor .monaco-editor").click(); // dblclick 后焦点在文件树，必须点进编辑器
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("result = s.");
  const suggest = page.locator("#editor .suggest-widget");
  await expect(suggest).toBeVisible({ timeout: 10_000 });
  return;
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "a.py": 's = "hello"\n' });
  await equipPage(page, repo);
  await page.goto("/");
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-DX-TS1 Alt+/ 重新唤起补全 widget（Ctrl+Space 被中文 IME 吞键的保底入口）", async ({ page }) => {
  await typeMemberAccess(page);
  const suggest = page.locator("#editor .suggest-widget");
  // Escape 关掉自动弹出的 widget，确认进入「无补全」态
  await page.keyboard.press("Escape");
  await expect(suggest).toBeHidden({ timeout: 5_000 });
  // Alt+/ = trigger_suggest（出厂默认）→ widget 重新出现
  await page.keyboard.press("Alt+/");
  await expect(suggest).toBeVisible({ timeout: 10_000 });
  await expect(suggest).toContainText("upper", { timeout: 10_000 });
});
