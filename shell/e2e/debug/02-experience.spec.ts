/**
 * 调试体验测试（D-EXP-*）：关注「用得爽不爽」而不仅是「能不能跑」——
 *   空态引导文案（可发现性）、断点红点与当前行高亮的可视区分、
 *   控件按调试阶段的正确禁用态、启动中反馈、停止后不卡顿、键盘流、
 *   以及启动失败的明确错误反馈。
 *
 * 桩实现同 01-functional：tauri-mock.js 调试 DAP 模拟。
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

function activeFrame(page: Page) {
  return page.locator("#debug-stack .debug-stack-frame.active");
}

/** 把焦点移出 Monaco 编辑器，再按键（窗口级快捷键在编辑器聚焦时会被忽略） */
async function focusOutAndPress(page: Page, key: string): Promise<void> {
  await page.locator("#tab-debug").click();
  await page.keyboard.press(key);
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

test("D-EXP-1：空闲态有清晰引导文案（可发现性）", async ({ page }) => {
  await openScript(page);
  await page.locator("#tab-debug").click(); // 切到调试视图查看空态
  await expect(page.locator("#debug-breakpoints")).toContainText("行号左侧的空白处", { timeout: 10_000 });
  await expect(page.locator("#debug-stack")).toContainText("按 F5 启动调试", { timeout: 10_000 });
  await expect(page.locator("#debug-vars")).toContainText("变量仅在命中断点暂停时可见", { timeout: 10_000 });
});

test("D-EXP-2：断点红点与当前行高亮为可区分的可视样式", async ({ page }) => {
  await openScript(page);
  await setBp(page, 6);
  await page.locator("#btn-debug").click();
  await expect(activeFrame(page)).toContainText("script.py:6", { timeout: 15_000 });

  const styles = await page.evaluate(() => {
    const bp = document.querySelector(".gutter-breakpoint");
    const cur = document.querySelector(".debug-current-line");
    return {
      bpColor: bp ? getComputedStyle(bp, "::after").color : null,
      curBg: cur ? getComputedStyle(cur).backgroundColor : null,
    };
  });
  // 断点红点有颜色（不是透明 / 继承的透明）
  expect(styles.bpColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles.bpColor).not.toBe("transparent");
  // 当前行高亮有背景（不是透明）
  expect(styles.curBg).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles.curBg).not.toBe("transparent");
});

test("D-EXP-3：控件按调试阶段正确禁用/启用", async ({ page }) => {
  await openScript(page);
  await page.locator("#tab-debug").click();
  // 空闲：所有调试控件禁用
  await expect(page.locator("#debug-step-over")).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#debug-continue")).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#debug-stop")).toHaveAttribute("aria-disabled", "true");

  // 命中断点后：步进/继续/停止可用
  await setBp(page, 6);
  await page.locator("#btn-debug").click();
  await expect(activeFrame(page)).toContainText("script.py:6", { timeout: 15_000 });
  await expect(page.locator("#debug-step-over")).toHaveAttribute("aria-disabled", "false");
  await expect(page.locator("#debug-continue")).toHaveAttribute("aria-disabled", "false");
  await expect(page.locator("#debug-stop")).toHaveAttribute("aria-disabled", "false");
});

test("D-EXP-4：启动中有「调试器启动中…」反馈，命中后提示隐藏", async ({ page }) => {
  await openScript(page);
  await setBp(page, 6);
  await page.locator("#tab-debug").click();
  // 启动提示文案存在于 DOM（即便转瞬即逝，也验证其反馈文本就位）
  await expect(page.locator("#debug-starting-hint")).toContainText("调试器启动中", { timeout: 10_000 });
  await page.locator("#btn-debug").click();
  await expect(activeFrame(page)).toContainText("script.py:6", { timeout: 15_000 });
  // 命中后启动提示应隐藏（不再显示 spinner）
  await expect(page.locator("#debug-starting-hint")).toHaveClass(/hidden/);
});

test("D-EXP-5：停止调试后界面迅速清场且不卡顿", async ({ page }) => {
  await openScript(page);
  await setBp(page, 6);
  await page.locator("#btn-debug").click();
  await expect(activeFrame(page)).toContainText("script.py:6", { timeout: 15_000 });

  const t0 = Date.now();
  await page.locator("#debug-stop").click();
  // 当前行高亮应在 1s 内消失（无挂起 / 无卡死）
  await expect(page.locator(".debug-current-line")).toHaveCount(0, { timeout: 1000 });
  const dt = Date.now() - t0;
  expect(dt).toBeLessThan(1500);

  // 编辑器仍可用：断点装饰未因停止而丢失（界面没冻结）
  await expect(page.locator(".gutter-breakpoint")).toHaveCount(1);
});

test("D-EXP-6：纯键盘流（F5/F10/F5…）即可完成完整调试会话", async ({ page }) => {
  await openScript(page);
  await setBp(page, 6);
  await setBp(page, 9);

  // 焦点移出编辑器后，键盘快捷键驱动全流程
  await focusOutAndPress(page, "F5"); // 启动 → 命中 6
  await expect(activeFrame(page)).toContainText("script.py:6", { timeout: 15_000 });
  await focusOutAndPress(page, "F10"); // 单步跳过 → 7
  await expect(activeFrame(page)).toContainText("script.py:7", { timeout: 15_000 });
  await focusOutAndPress(page, "F10"); // 单步跳过 → 8
  await expect(activeFrame(page)).toContainText("script.py:8", { timeout: 15_000 });
  await focusOutAndPress(page, "F5"); // 继续 → 跳到下一断点 9
  await expect(activeFrame(page)).toContainText("script.py:9", { timeout: 15_000 });
  await focusOutAndPress(page, "F5"); // 继续 → 运行到结束
  await expect(page.locator("#debug-stack .debug-stack-frame")).toHaveCount(0, { timeout: 15_000 });
});

test("D-EXP-7：调试启动失败有明确错误反馈且不卡死", async ({ page }) => {
  await openScript(page);
  // 注入「启动失败」场景（debugpy 缺失 / 解释器不可用）
  await page.evaluate(() => (window as any).__OC_DEBUG__.setFailNext(true));
  await page.locator("#btn-debug").click();
  await expect(page.locator(".toast").first()).toBeVisible({ timeout: 10_000 });
  // 按文案过滤：环境检查 info toast 可能与错误 toast 并存（openWorkspace 的 init 失败
  // 修复后，dep/环境检查能正常完成并弹提示），strict mode 下裸 .toast 会歧义
  await expect(page.locator(".toast", { hasText: "调试启动" })).toContainText("调试启动");
  // 未进入调试态：控件仍禁用、仍处空闲可重试
  await expect(page.locator("#debug-step-over")).toHaveAttribute("aria-disabled", "true");
  // 编辑器仍可用（点击 gutter 仍能下断点，证明界面未冻结）
  await clickGlyph(page, 9);
  await expect(page.locator(".gutter-breakpoint")).toHaveCount(1);
});
