/**
 * E2E：PR-D 最近编辑位置（dx_features_backlog §6.4）
 *
 *  - E-DX-EL1 编辑两个文件后 Ctrl+Shift+Backspace 跨文件回跳上一个编辑位置
 *  - E-DX-EL2 连续按循环回溯（栈底 → 回栈顶）
 *
 * 语义对齐 EditPointStack 单测：当前位置所在编辑区域（同文件行距 ≤3）被跳过；
 * 任何新编辑重置导航游标（本 spec 跳转间无内容变更，游标保持）。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

const SRC = "alpha = 1\nbeta = alpha + 2\nprint(beta)\n";
const SECOND = "one = 1\ntwo = 2\nthree = 3\n";

let repo: GitRepo;
const pageErrors: string[] = [];

// 本文件用例含两次页面加载/文件打开 + 跨文件跳转，合跑（dev server 已热）时可能超过
// 全局 30s 预算——超时的表现是 poll 被打断报「Canceled: Canceled」（实测踩坑），故放宽到 60s
test.setTimeout(60_000);

/** 当前活动 tab 文件名 + 光标行 */
function location(page: Page): Promise<{ file: string; line: number }> {
  return page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    return {
      file: app.activeTab.path.replace(/\\/g, "/").split("/").pop() as string,
      line: app.editor.getPosition()?.lineNumber ?? 0,
    };
  });
}

async function editAt(page: Page, line: number, text: string): Promise<void> {
  await page.evaluate(
    async ([l]) => {
      const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
      app.editor.setPosition({ lineNumber: l as number, column: 1 });
      app.editor.focus();
    },
    [line] as const,
  );
  await expect(page.locator(".monaco-editor textarea")).toBeFocused({ timeout: 5_000 });
  await page.keyboard.type(text);
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => {
    pageErrors.push(String(e));
    console.log(`[pageerror] ${e.message}\n${(e.stack ?? "").split("\n").slice(0, 10).join("\n")}`);
  });
  repo = await makePlainDir({ "main.py": SRC, "second.py": SECOND });
  await equipPage(page, repo);
  await page.goto("/");
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-DX-EL1 跨文件回跳上一个编辑位置", async ({ page }) => {
  await editAt(page, 1, "x"); // 编辑点 main.py:1
  await page.locator("#tree .tree-item .name", { hasText: "second.py" }).first().dblclick();
  await expect
    .poll(async () => (await location(page)).file, { timeout: 10_000 })
    .toBe("second.py");
  await editAt(page, 3, "y"); // 编辑点 second.py:3

  await page.keyboard.press("Control+Shift+Backspace");
  await expect
    .poll(async () => location(page), { timeout: 10_000 })
    .toEqual({ file: "main.py", line: 1 });
});

test("E-DX-EL2 连续按循环回溯：栈底后回栈顶", async ({ page }) => {
  await editAt(page, 1, "x"); // 栈: [main:1]
  await page.locator("#tree .tree-item .name", { hasText: "second.py" }).first().dblclick();
  await expect
    .poll(async () => (await location(page)).file, { timeout: 10_000 })
    .toBe("second.py");
  await editAt(page, 3, "y"); // 栈: [main:1, second:3]

  await page.keyboard.press("Control+Shift+Backspace"); // second:3 是当前位置 → 跳 main:1
  await expect
    .poll(async () => location(page), { timeout: 10_000 })
    .toEqual({ file: "main.py", line: 1 });

  await page.keyboard.press("Control+Shift+Backspace"); // 回溯到栈底后循环回栈顶 second:3
  await expect
    .poll(async () => location(page), { timeout: 10_000 })
    .toEqual({ file: "second.py", line: 3 });
});
