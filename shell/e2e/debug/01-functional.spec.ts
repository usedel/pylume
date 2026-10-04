/**
 * 调试功能测试（D-FUNC-*）：断点 → 启动 → 命中断点 → 调用栈/变量/当前行高亮 →
 * 步进（单步跳过/进入/退出）→ 继续跳断点 → 运行到结束 → 停止清场 → 重启。
 *
 * 桩实现：tauri-mock.js 的调试 DAP 模拟（stdio adapter 架构时序 + 步进/继续按断点行与
 * 帧深推演），不触达真实 debugpy，仅驱动前端状态机与渲染（与 LSP 静态桩同思路）。
 */
import { test, expect, type Page } from "@playwright/test";
import { clickGlyph, equipPage, makeGitRepo, type GitRepo } from "../helpers";

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

/** 确定性下/取消断点（复刻真实 gutter 点击进入的同一条 toggleBreakpoint 逻辑） */
async function setBp(page: Page, line: number): Promise<void> {
  await page.evaluate((l) => (window as any).__OC_DEBUG_TEST__.toggleActive(l), line);
}

/** 等待当前栈顶帧（激活帧）文本包含给定子串（用于断言「停在哪一行」） */
function activeFrame(page: Page) {
  return page.locator("#debug-stack .debug-stack-frame.active");
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
  // 任何未捕获异常都视为失败（DAP 模拟不应引发前端崩溃）
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("D-FUNC-1：gutter 真实点击设置断点并能取消", async ({ page }) => {
  await openScript(page);
  // clickGlyph 按渲染后的行定位（helpers 注释：view zone 会让 (line-1)*lh 取法点空）。
  // 仍保留重试：CodeLens 的 zone 是 LSP 异步插入的，极端时序下仍有点击噪声；
  // 重试前先清掉上次可能落在别的行的残留。
  await expect(async () => {
    const prev = await page.evaluate(() => (window as any).__OC_DEBUG_TEST__.list());
    for (const ls of Object.values(prev as Record<string, number[]>))
      for (const l of ls) await page.evaluate((x) => (window as any).__OC_DEBUG_TEST__.toggleActive(x), l);
    await clickGlyph(page, 6);
    await expect(page.locator(".gutter-breakpoint").first()).toBeVisible({ timeout: 2_000 });
    const info = await page.evaluate(() => (window as any).__OC_DEBUG_TEST__.list());
    const lines = Object.values(info as Record<string, number[]>)[0] as number[];
    expect(lines).toEqual([6]); // 渲染行定位下应精确命中目标行
  }, { timeout: 15_000 }).toPass();
  // 用同一 toggle 逻辑取消（真实点击 → 真实取消闭环）
  await page.evaluate((x) => (window as any).__OC_DEBUG_TEST__.toggleActive(x), 6);
  await expect(page.locator(".gutter-breakpoint")).toHaveCount(0, { timeout: 10_000 });
});

test("D-FUNC-2：断点 → 启动 → 命中断点：调用栈 / 变量 / 当前行高亮", async ({ page }) => {
  await openScript(page);
  await setBp(page, 6);
  await setBp(page, 9);
  await expect(page.locator(".gutter-breakpoint")).toHaveCount(2);

  await page.locator("#btn-debug").click();

  // 侧栏切到调试、栈顶帧停在断点行
  await expect(page.locator("#tab-debug")).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
  await expect(activeFrame(page)).toContainText("script.py:6", { timeout: 15_000 });
  // 当前执行行高亮
  await expect(page.locator(".debug-current-line").first()).toBeVisible();
  // 变量面板渲染了局部变量
  await expect(page.locator("#debug-vars .debug-var-row").first()).toBeVisible({ timeout: 10_000 });
});

test("D-FUNC-3：步进（单步跳过 / 进入 / 退出）逐行推进并联动栈帧", async ({ page }) => {
  await openScript(page);
  await setBp(page, 6);
  await setBp(page, 9);
  await page.locator("#btn-debug").click();
  await expect(activeFrame(page)).toContainText("script.py:6", { timeout: 15_000 });

  await page.locator("#debug-step-over").click();
  await expect(activeFrame(page)).toContainText("script.py:7", { timeout: 15_000 });

  await page.locator("#debug-step-into").click();
  await expect(activeFrame(page)).toContainText("script.py:8", { timeout: 15_000 });
  await expect(page.locator("#debug-stack .debug-stack-frame")).toHaveCount(2); // 进入后多一帧

  await page.locator("#debug-step-out").click();
  await expect(activeFrame(page)).toContainText("script.py:9", { timeout: 15_000 });
  await expect(page.locator("#debug-stack .debug-stack-frame")).toHaveCount(1); // 退出后回落
});

test("D-FUNC-4：继续（F5）跳到下一断点，再继续则运行到结束", async ({ page }) => {
  await openScript(page);
  await setBp(page, 6);
  await setBp(page, 9);
  await page.locator("#btn-debug").click();
  await expect(activeFrame(page)).toContainText("script.py:6", { timeout: 15_000 });

  await page.locator("#debug-continue").click();
  await expect(activeFrame(page)).toContainText("script.py:9", { timeout: 15_000 });

  // 再继续：无更多断点 → 会话结束，调用栈清空、当前行高亮消失
  await page.locator("#debug-continue").click();
  await expect(page.locator("#debug-stack .debug-stack-frame")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".debug-current-line")).toHaveCount(0, { timeout: 15_000 });
});

test("D-FUNC-5：停止调试清场且断点保留，可重启", async ({ page }) => {
  await openScript(page);
  await setBp(page, 6);
  await page.locator("#btn-debug").click();
  await expect(activeFrame(page)).toContainText("script.py:6", { timeout: 15_000 });

  await page.locator("#debug-stop").click();
  await expect(page.locator(".debug-current-line")).toHaveCount(0, { timeout: 15_000 }); // 高亮清场
  await expect(page.locator(".gutter-breakpoint")).toHaveCount(1); // 断点保留
  await expect(page.locator("#debug-step-over")).toHaveAttribute("aria-disabled", "true"); // 控件归位禁用

  // 可重启（互斥锁正确释放）
  await page.locator("#btn-debug").click();
  await expect(activeFrame(page)).toContainText("script.py:6", { timeout: 15_000 });
});

test("D-FUNC-6：变量面板可展开容器型变量（树形）", async ({ page }) => {
  await openScript(page);
  await setBp(page, 6);
  await page.locator("#btn-debug").click();
  await expect(page.locator("#debug-vars .debug-var-row").first()).toBeVisible({ timeout: 15_000 });

  const dataRow = page.locator("#debug-vars .debug-var-row", { hasText: "data" }).first();
  await expect(dataRow).toBeVisible();
  await dataRow.click(); // 展开 dict
  await expect(page.locator("#debug-vars .debug-var-children .debug-var-row").first()).toBeVisible({ timeout: 10_000 });
});
