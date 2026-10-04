/**
 * E2E：PR-K 新建 .py 文件自动插 header 文件头模板（dx_features_backlog §6.6）
 *
 *  - E-DX-NT1 开关默认关：文件树右键「新建 Python 文件」后编辑器为空（不插模板）
 *  - E-DX-NT2 设置开关打开后：新建 Python 文件自动插文件头（断言编辑器 model——
 *    mock 配置 autosave 默认 off，插入只改内存 model，不落盘，磁盘断言不适用）
 *
 * 两个入口（普通「新建文件」输入 .py 后缀 / 专属「新建 Python 文件」）共用 insertHeaderIfEnabled
 * 门控；草稿（Ctrl+Alt+Shift+Insert）不走该路径天然豁免，无单独用例。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

let repo: GitRepo;
const pageErrors: string[] = [];

/** 文件树根节点右键 →「新建 Python 文件」→ 内联输入文件名 → Enter 确认 */
async function newPyFileViaTree(page: Page, name: string): Promise<void> {
  await page.locator("#tree .tree-item").first().click({ button: "right", force: true });
  const ctx = page.locator("#ctx-menu");
  await expect(ctx).toBeVisible({ timeout: 5_000 });
  await ctx.locator(".ctx-menu-item", { hasText: "新建 Python 文件" }).first().click({ force: true });
  const input = page.locator("#tree .inline-input");
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill(name);
  await input.press("Enter"); // blur=取消，提交必须显式 Enter（fileTree inlineInput 语义）
}

/** 读某路径 tab 的编辑器 model 内容（内存值，非磁盘） */
async function modelValue(page: Page, suffix: string): Promise<string> {
  return page.evaluate(async (suffix) => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const tab = app.tabs.find((t: any) => t.path.endsWith(suffix));
    return tab ? tab.model.getValue() : null;
  }, suffix);
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "a.py": "x = 1\n" });
  await equipPage(page, repo);
  await page.goto("/");
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-DX-NT1 默认关：新建 Python 文件为空（不插文件头模板）", async ({ page }) => {
  await newPyFileViaTree(page, "alpha.py");
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => modelValue(page, "alpha.py"), { timeout: 10_000 }).toBe("");
  expect(repo.read("alpha.py")).toBe("");
});

test("E-DX-NT2 开关开：新建 Python 文件自动插文件头模板", async ({ page }) => {
  // 设置面板打开 new_file_template（编辑器分区，接线同 PR-B/PR-C 开关）；
  // 用标题栏「设置」按钮而非 Ctrl+Alt+S——boot 早期键位分发尚未就绪（实测）。
  // 先等树渲染完成（boot 就绪标志），否则按钮接线未完成时点击被吞（合跑偶发）。
  await expect(page.locator("#tree .tree-item", { hasText: "a.py" })).toBeVisible({ timeout: 20_000 });
  await page.locator("button[title='设置'], #btn-settings").first().click();
  await expect(page.locator("#settings-modal, .modal:has(#settings-save)").first()).toBeVisible({ timeout: 5_000 });
  await page.locator('.settings-nav-item[data-cat="editor"]').click();
  await page.locator("#settings-new-file-template").check();
  await page.locator("#settings-save").click();
  await expect(page.locator("#settings-modal")).toBeHidden({ timeout: 5_000 });

  await newPyFileViaTree(page, "beta.py");
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
  // header 模板（builtin.header）：编码声明行 + 光标停 $END$；这里只断言模板体落进 model
  await expect.poll(() => modelValue(page, "beta.py"), { timeout: 10_000 })
    .toContain("# -*- coding: utf-8 -*-");
});
