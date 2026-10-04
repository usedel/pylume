/**
 * E2E：P2 调试补齐（对标调研 §6-B）
 *
 *  - P2-1 Watches：添加监视表达式 → 暂停态自动求值（context="watch"）→ 删除
 *  - P2-2 异常断点：uncaught 默认开；切换 raised 即时生效（setExceptionBreakpoints）
 *  - P2-3 断点启禁：面板取消勾选 → gutter 灰点（不下发 debugger）；重新勾选 → 恢复
 *
 * 复用 01-functional 的 DAP mock 罐头：evaluate 返回 `<expr> ⇒ <value>`。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

const SCRIPT = `def compute(x):
    y = x + 1
    return y

def main():
    a = compute(10)
    b = a * 2
    print(a, b)
    return b

if __name__ == "__main__":
    main()
`;

let repo: GitRepo;
const pageErrors: string[] = [];

async function openScript(page: Page): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: "script.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 10_000 });
}

/** 确定性下断点（复刻 gutter 点击的 toggleBreakpoint 逻辑，同 01-functional） */
async function setBp(page: Page, line: number): Promise<void> {
  await page.evaluate((l) => (window as any).__OC_DEBUG_TEST__.toggleActive(l), line);
}

/** 启动调试并停在第一个断点 */
async function debugToStop(page: Page): Promise<void> {
  await page.locator("#btn-debug").click();
  await expect(page.locator("#tab-debug")).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
  await expect(page.locator("#debug-stack .debug-stack-frame.active")).toContainText("script.py:6", {
    timeout: 15_000,
  });
  await expect(page.locator("#debug-vars .debug-var-row").first()).toBeVisible({ timeout: 10_000 });
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makeGitRepo({ files: { "script.py": SCRIPT }, commitMsg: "baseline" });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("P2-1 Watches：暂停态添加监视并自动求值，可删除", async ({ page }) => {
  await openScript(page);
  await setBp(page, 6);
  await debugToStop(page);

  const input = page.locator("#debug-watches .debug-watch-input");
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill("x + 1");
  await input.press("Enter");

  // mock evaluate 罐头：`<表达式> ⇒ <value>`；暂停态（x=10）→ 11
  const row = page.locator("#debug-watches .debug-watch-row", { hasText: "x + 1" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("⇒", { timeout: 10_000 });

  // 单步后随帧重新求值（仍保留）
  await page.locator("#debug-step-over").click();
  await expect(page.locator("#debug-watches .debug-watch-row", { hasText: "x + 1" })).toBeVisible({
    timeout: 10_000,
  });

  // 删除
  await row.locator(".debug-watch-del").click();
  await expect(page.locator("#debug-watches .debug-watch-row", { hasText: "x + 1" })).toHaveCount(0);
});

test("P2-2 异常断点：uncaught 默认开，raised 可即时切换", async ({ page }) => {
  await openScript(page);
  await setBp(page, 6);
  await debugToStop(page);

  const uncaught = page.locator("#debug-exc-uncaught");
  const raised = page.locator("#debug-exc-raised");
  await expect(uncaught).toBeChecked({ timeout: 5_000 }); // 默认：未捕获才停
  await expect(raised).not.toBeChecked();

  // 切换 raised（运行/暂停中 setExceptionBreakpoints 即时下发）——不崩、状态保持
  await raised.check();
  await expect(raised).toBeChecked();
  await expect(uncaught).toBeChecked();
  await raised.uncheck();
  await expect(raised).not.toBeChecked();
  // 调试会话仍然存活（调用栈还在）
  await expect(page.locator("#debug-stack .debug-stack-frame.active")).toBeVisible();
});

test("P2-3 断点启禁：面板取消勾选 → gutter 灰点；重新勾选 → 恢复", async ({ page }) => {
  await openScript(page);
  await setBp(page, 6);
  await debugToStop(page);

  const bpRow = page.locator("#debug-breakpoints .debug-bp-row", { hasText: "script.py:6" });
  await expect(bpRow).toBeVisible();
  const chk = bpRow.locator('input[type="checkbox"]');
  await expect(chk).toBeChecked();

  // 禁用：gutter 红点变灰点（类名切换）
  await chk.uncheck();
  await expect(page.locator(".gutter-breakpoint-disabled")).toHaveCount(1, { timeout: 5_000 });
  await expect(page.locator(".gutter-breakpoint:not(.gutter-breakpoint-disabled)")).toHaveCount(0);

  // 重新启用：灰点消失，普通红点回来
  await chk.check();
  await expect(page.locator(".gutter-breakpoint-disabled")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator(".gutter-breakpoint")).toHaveCount(1);
});
