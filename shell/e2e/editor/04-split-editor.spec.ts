/**
 * E2E：编辑器分屏（P4 · C-4，对标 PyCharm Split Right）
 *
 *  - P-SPLIT-1 Ctrl+\ 开分屏：共享 model（主编辑器编辑实时同显）+ 独立光标
 *  - P-SPLIT-2 钉住语义：切换 tab 后分屏保持原文件；关闭被钉住的 tab → 分屏自动收起
 *  - P-SPLIT-3 关闭按钮收起；收起后可再次打开（实例复用）
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

const SRC = 'def greet(name):\n    return "hello " + name\n';
const SRC2 = "x = 1\n";

let repo: GitRepo;
const pageErrors: string[] = [];

/** 主编辑器 model 行数（按活动 tab） */
function mainLine1(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    return app.editor.getModel()?.getLineContent(1) ?? "";
  });
}

async function openMainAndSplit(page: Page): Promise<void> {
  await page.locator('#tree .tree-item[data-path$="main.py"]').first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    app.editor.focus();
  });
  // 键位 Ctrl+\（editor 级键 → Monaco addKeybindingRules → splitEditor.toggleSplit）
  await page.keyboard.press("Control+\\");
  await expect(page.locator("#split-editor-panel")).toBeVisible({ timeout: 10_000 });
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "main.py": SRC, "b.py": SRC2 });
  await equipPage(page, repo);
  await page.goto("/");
});

test.afterEach(async () => {
  expect(pageErrors, "页面不应有未捕获异常").toEqual([]);
});

test("P-SPLIT-1 开分屏：共享 model 同显编辑 + 标签头显示文件名", async ({ page }) => {
  await openMainAndSplit(page);
  await expect(page.locator("#split-editor-label")).toHaveText("main.py");
  // 分屏宿主里确有第二个 Monaco 实例（editor + split-host 各一）
  await expect(page.locator("#split-editor-host .monaco-editor")).toHaveCount(1);
  // 共享 model：主编辑器插入标记 → 分屏视图同显（不用等待任何同步链路——同一 model）
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const m = app.editor.getModel()!;
    app.editor.executeEdits("test", [{ range: new app.monaco.Range(1, 1, 1, 1), text: "SPLIT-MARK " }]);
  });
  await expect(page.locator("#split-editor-host .view-lines")).toContainText("SPLIT-MARK");
  expect(await mainLine1(page)).toContain("SPLIT-MARK");
});

test("P-SPLIT-2 钉住：切 tab 分屏不动；关掉被钉住的 tab 分屏自动收起", async ({ page }) => {
  await openMainAndSplit(page);
  // 切到 b.py：主编辑器换 model，分屏仍显示 main.py（label 不变 + 内容仍是 SRC）
  await page.locator('#tree .tree-item[data-path$="b.py"]').first().dblclick();
  await expect(page.locator("#split-editor-panel")).toBeVisible();
  await expect(page.locator("#split-editor-label")).toHaveText("main.py");
  await expect(page.locator("#split-editor-host .view-lines")).toContainText("greet");
  // 关闭被钉住的 main.py tab（不脏，直接关）→ model dispose → 分屏自动收起
  await page.locator('.tab[data-path$="main.py"] .close').click();
  await expect(page.locator("#split-editor-panel")).toBeHidden({ timeout: 10_000 });
});

test("P-SPLIT-3 关闭按钮收起；再次 Ctrl+\ 可复用实例重新打开", async ({ page }) => {
  await openMainAndSplit(page);
  await page.locator("#split-editor-close").click();
  await expect(page.locator("#split-editor-panel")).toBeHidden();
  // 再按 Ctrl+\ → 重新打开（实例复用：面板再次可见且内容正确）
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    app.editor.focus();
  });
  await page.keyboard.press("Control+\\");
  await expect(page.locator("#split-editor-panel")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#split-editor-host .view-lines")).toContainText("greet");
});
