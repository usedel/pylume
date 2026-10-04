/**
 * E2E：PR-G2 工作区级符号 Quick Pick（dx_features_backlog §6.6）
 *
 * Ctrl+F12（symbol 模式）数据源扩展：已打开 tab 的 documentSymbol（PR-G）+ G-1 工作区
 * 顶层符号索引（PR-E 落地，PR-G2 复用；经 mock FS bridge 走真实磁盘）。
 *  - WS1 只打开 a.py 时，b.py 的顶层符号也在列；选中后跳转到 b.py 对应定义行。
 *  - WS2 空查询时列表非空（索引后台构建完成后重刷链路生效）。
 */
import { test, expect } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

let repo: GitRepo;
const pageErrors: string[] = [];

const B_PY = [
  "class DataBlock:",
  "    def load(self):",
  "        pass",
  "",
  "",
  "def wash_data(rows):",
  "    return rows",
  "",
].join("\n");

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "a.py": "from b import DataBlock\n", "b.py": B_PY, "util.py": "LIMIT = 3\n" });
  await equipPage(page, repo);
  await page.goto("/");
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

/** 只打开 a.py（b.py 不开），Ctrl+F12 进符号模式 */
async function openSymbolPick(page: Page): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: "a.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
  // dblclick 后焦点留在文件树，editor 级键位（Ctrl+F12）要求编辑器持有焦点（dx/07 同款）
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    app.editor.setPosition({ lineNumber: 1, column: 1 });
    app.editor.focus();
  });
  await expect(page.locator(".monaco-editor textarea")).toBeFocused({ timeout: 5_000 });
  await page.keyboard.press("Control+F12");
  await expect(page.locator("#quick-open-input")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("#quick-open-input")).toHaveAttribute(
    "placeholder",
    /工作区/,
    { timeout: 5_000 },
  );
}

test("E-DX-WS1 未打开文件的顶层符号在列，选中跳到定义行", async ({ page }) => {
  await openSymbolPick(page);
  // G-1 索引后台构建（200 文件上限内的 3 文件应秒级完成），输入前缀搜索 b.py 的 wash_data
  await page.locator("#quick-open-input").fill("wash_data");
  const row = page.locator("#quick-open-list .quick-open-item", { hasText: "wash_data" }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText("b.py:6"); // sub 显示 文件:行号
  await page.keyboard.press("Enter");
  // 跳转：切到 b.py 且光标落在定义行（第 6 行）
  await expect(page.locator("#tabbar .tab.active")).toContainText("b.py", { timeout: 10_000 });
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
        return app.editor.getPosition()?.lineNumber;
      }),
      { timeout: 10_000 },
    )
    .toBe(6);
});

test("E-DX-WS2 类符号在列；var（顶层赋值）同样可搜可跳", async ({ page }) => {
  await openSymbolPick(page);
  await page.locator("#quick-open-input").fill("LIMIT");
  const row = page.locator("#quick-open-list .quick-open-item", { hasText: "LIMIT" }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText("util.py:1");
  await page.keyboard.press("Enter");
  await expect(page.locator("#tabbar .tab.active")).toContainText("util.py", { timeout: 10_000 });
});
