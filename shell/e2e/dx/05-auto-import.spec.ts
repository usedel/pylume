/**
 * E2E：PR-E 补全内联 auto-import（dx_features_backlog §6.5，自研 G-1 索引数据源）
 *
 *  - E-DX-AI1 输入未导入符号前缀 → 补全出现工作区候选（detail 显示 import 语句）
 *    → 选中后文件头自动插入 `from lib import DataFrame`，编辑点插入符号名
 *
 * 数据源走 e2e fs bridge（list_workspace_files / read_file 白名单内，真实磁盘）。
 * 首次触发后台建索引（本设计为不阻塞按键），故输入后轮询 suggest 出现而非同步断言。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

const LIB = "class DataFrame:\n    def head(self, n: int) -> list:\n        return []\n";
const MAIN = "def f():\n    return \n";

let repo: GitRepo;
const pageErrors: string[] = [];

function lines(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const m = app.editor.getModel();
    const n = m.getLineCount();
    const out: string[] = [];
    for (let i = 1; i <= n; i++) out.push(m.getLineContent(i));
    return out;
  });
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "lib.py": LIB, "main.py": MAIN });
  await equipPage(page, repo);
  await page.goto("/");
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
  // 光标放回 "    return " 行尾
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const col = app.editor.getModel().getLineMaxColumn(2);
    app.editor.setPosition({ lineNumber: 2, column: col });
    app.editor.focus();
  });
  await expect(page.locator(".monaco-editor textarea")).toBeFocused({ timeout: 5_000 });
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-DX-AI1 未导入符号补全 → 选中后头部自动插 import", async ({ page }) => {
  // 输入前缀（索引后台构建，任一次键入触发到已就绪索引即出候选）
  await page.keyboard.type("DataFra");
  const row = page.locator(".monaco-editor .suggest-widget .monaco-list-row", { hasText: "DataFrame" });
  if (!(await row.isVisible().catch(() => false))) {
    await page.keyboard.press("Control+Space"); // 手动再触发一次
  }
  await expect(row.first()).toBeVisible({ timeout: 10_000 });
  await expect(row.first()).toContainText("from lib import DataFrame"); // detail 展示插入预览

  await page.keyboard.press("Enter"); // 接受补全

  await expect
    .poll(async () => lines(page), { timeout: 10_000 })
    .toEqual(["from lib import DataFrame", "def f():", "    return DataFrame", ""]);
});
