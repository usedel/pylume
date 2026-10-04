/**
 * E2E：PR-C 保存清理（dx_features_backlog §6.3）
 *
 *  - E-DX-SC1 Ctrl+S 落盘内容已清理（行尾空白剥除 + 补最终换行）
 *  - E-DX-SC2 设置关闭两项后，保存原样落盘（autosave/运行前路径的豁免由 runOnSaveActions 门控保证，无单独 e2e）
 *
 * mock 的 FS 命令经 bridge 走真实磁盘（tauri-mock.js FS_CMDS → E2E_BRIDGE），故直接用
 * repo.read() 断言落盘内容。编辑器改动只改 model（autosave 模式在 mock 配置默认 off）。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

const MESSY = "alpha = 1   \nbeta = 2\t\n";
const CLEAN = "alpha = 1\nbeta = 2\n";

let repo: GitRepo;
const pageErrors: string[] = [];

/** 在第 1 行行尾追加一个空格使 tab 进入 dirty（清理后内容与预期 CLEAN 严格相等，故须打在行尾） */
async function makeDirty(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const col = app.editor.getModel().getLineMaxColumn(1);
    app.editor.setPosition({ lineNumber: 1, column: col });
    app.editor.focus();
  });
  await expect(page.locator(".monaco-editor textarea")).toBeFocused({ timeout: 5_000 });
  await page.keyboard.type(" ");
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "messy.py": MESSY, "messy2.py": MESSY });
  await equipPage(page, repo);
  await page.goto("/");
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-DX-SC1 Ctrl+S 清理落盘，autosave 落盘不清理", async ({ page }) => {
  await page.locator("#tree .tree-item .name", { hasText: "messy.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });

  // 前置：文件在磁盘上仍是原始脏内容
  expect(repo.read("messy.py")).toBe(MESSY);

  // 第一步：autosave（delay 默认关闭）不涉及；显式 Ctrl+S → 落盘内容被清理
  await makeDirty(page);
  await page.keyboard.press("Control+s");
  await expect.poll(() => repo.read("messy.py"), { timeout: 10_000 }).toBe(CLEAN);
  // 编辑器 model 同步为清理后的内容（setValue 已生效）
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
          return app.editor.getValue();
        }),
      { timeout: 5_000 },
    )
    .toBe(CLEAN);
});

test("E-DX-SC2 关闭两个开关后保存原样落盘", async ({ page }) => {
  // makeDirty 在第 1 行行尾追加的空格在清理关闭时会被保留，期望值须含它
  const messyAfterType = "alpha = 1    \nbeta = 2\t\n";
  await page.locator("#tree .tree-item .name", { hasText: "messy2.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });

  await page.keyboard.press("Control+Alt+S");
  await expect(page.locator("#settings-modal, .modal:has(#settings-save)").first()).toBeVisible({ timeout: 5_000 });
  await page.locator('.settings-nav-item[data-cat="editor"]').click();
  await page.locator("#settings-trim-trailing").uncheck();
  await page.locator("#settings-final-newline").uncheck();
  await page.locator("#settings-save").click();
  await expect(page.locator("#settings-modal")).toBeHidden({ timeout: 5_000 });

  await makeDirty(page);
  await page.keyboard.press("Control+s");
  await expect.poll(() => repo.read("messy2.py"), { timeout: 10_000 }).toBe(messyAfterType);
});
