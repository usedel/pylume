/**
 * E2E：PR-G 文件内符号 Quick Pick（dx_features_backlog §6.6/§6.8 第二梯队 D2）
 *
 *  - E-DX-SQ1 Ctrl+F12 打开符号模式 → 模糊搜当前文件符号 → Enter 跳到定义行
 *  - E-DX-SQ2 其他已打开 tab 的符号同样在列（sub 显示其 文件:行），选中后切到该文件
 *
 * 符号数据源 = LSP documentSymbol，经 tauri-mock 的协议替身提供（def/class + 方法），
 * 与大纲 / 面包屑 / Code Vision 同一口径。Ctrl+F12 是 editor 级规则（带
 * when: editorTextFocus），按键前必须先把焦点交给编辑器（PR-A 教训）。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

const A_PY = [
  "def calculate_total(price, quantity):",
  "    return price * quantity",
  "",
  "",
  "def another_alpha(value):",
  "    return value * 2",
  "",
].join("\n");

const B_PY = [
  "def beta_helper(text):",
  "    return text.upper()",
  "",
].join("\n");

let repo: GitRepo;
const pageErrors: string[] = [];

/** 打开文件并把焦点交给编辑器（editor 级键位规则的前提） */
async function openAndFocus(page: Page, name: string): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: name }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    app.editor.setPosition({ lineNumber: 1, column: 1 });
    app.editor.focus();
  });
  await expect(page.locator(".monaco-editor textarea")).toBeFocused({ timeout: 5_000 });
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "a.py": A_PY, "b.py": B_PY });
  await equipPage(page, repo);
  await page.goto("/");
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-DX-SQ1 Ctrl+F12 搜符号并跳转到定义行", async ({ page }) => {
  await openAndFocus(page, "a.py");
  await page.keyboard.press("Control+F12");
  const input = page.locator("#quick-open-input");
  await expect(input).toBeVisible({ timeout: 5_000 });
  // 占位符 = 符号模式（证明走的不是混搜/文件模式）
  // PR-G2 扩展工作区级符号后占位符文案更新
  await expect(input).toHaveAttribute("placeholder", "搜索符号（已打开文件 + 工作区，Enter 跳转）");

  await input.fill("calctot"); // 模糊（子序列）命中 calculate_total
  const row = page.locator("#quick-open-list .quick-open-item").first();
  await expect(row.locator(".quick-open-name")).toHaveText("calculate_total", { timeout: 5_000 });
  await expect(row.locator(".quick-open-sub")).toContainText("a.py:1");

  await page.keyboard.press("Enter");
  await expect(page.locator("#quick-open-modal")).toBeHidden({ timeout: 5_000 });
  // 光标落在定义行（第 1 行）
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
          return app.editor.getPosition()?.lineNumber ?? -1;
        }),
      { timeout: 5_000 },
    )
    .toBe(1);
});

test("E-DX-SQ2 其他已打开标签的符号也在列，选中后切到该文件", async ({ page }) => {
  await openAndFocus(page, "a.py");
  await openAndFocus(page, "b.py");
  // 当前在 b.py，搜只存在于 a.py 的符号
  await page.keyboard.press("Control+F12");
  const input = page.locator("#quick-open-input");
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill("alph");
  const row = page.locator("#quick-open-list .quick-open-item").first();
  await expect(row.locator(".quick-open-name")).toHaveText("another_alpha", { timeout: 5_000 });
  await expect(row.locator(".quick-open-sub")).toContainText("a.py:5");

  await page.keyboard.press("Enter");
  await expect(page.locator("#quick-open-modal")).toBeHidden({ timeout: 5_000 });
  await expect(page.locator("#tabbar .tab.active")).toContainText("a.py", { timeout: 5_000 });
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
          return app.editor.getPosition()?.lineNumber ?? -1;
        }),
      { timeout: 5_000 },
    )
    .toBe(5);
});
