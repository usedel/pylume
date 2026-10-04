/**
 * E2E：PR-M 粘贴 JSON → Python dict 字面量（dx_features_backlog §6.6）
 *
 * 被测链路 = installPasteJson 的 onDidPaste 拦截：真实浏览器剪贴板 + Ctrl+V
 * （走 Monaco 原生 paste 管线，onDidPaste 才会触发）。断言编辑器 model：
 *  - PJ1 .py 内粘贴完整 JSON → 就地改写为 Python 字面量（true→True / null→None）
 *  - PJ2 开关关（app.settings 显式置 false）→ 原样粘贴
 */
import { test, expect } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

let repo: GitRepo;
const pageErrors: string[] = [];

const JSON_TEXT = '{"name": "pylume", "ok": true, "vals": [1, null]}';

/** 打开 a.py 并把光标放行尾、焦点交给编辑器 */
async function openPyAndFocus(page: Page): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: "a.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    app.editor.setPosition({ lineNumber: 1, column: app.editor.getModel().getLineMaxColumn(1) });
    app.editor.focus();
  });
  await expect(page.locator(".monaco-editor textarea")).toBeFocused({ timeout: 5_000 });
}

/** 读 a.py 的编辑器 model 内容 */
async function modelValue(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    return app.tabs.find((t: any) => t.path.endsWith("a.py"))?.model.getValue() ?? null;
  });
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "a.py": "data = " });
  await equipPage(page, repo);
  await page.goto("/");
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-DX-PJ1 .py 内粘贴完整 JSON：就地转 Python 字面量", async ({ page }) => {
  await openPyAndFocus(page);
  await page.evaluate((t) => navigator.clipboard.writeText(t), JSON_TEXT);
  await page.keyboard.press("Control+v");
  await expect.poll(() => modelValue(page), { timeout: 10_000 }).toContain('"ok": True');
  const value = await modelValue(page);
  expect(value).toContain('"vals": [');
  expect(value).toContain("None");
  expect(value).not.toContain("true");
  expect(value).not.toContain("null");
});

test("E-DX-PJ2 开关关：粘贴原样保留 JSON", async ({ page }) => {
  // 经 mock 预置通道在 init 前关开关（运行时改 app.settings 会被 boot 后的设置装载覆盖，实测竞态）
  await page.addInitScript(() => {
    (window as any).__E2E_SETTINGS_PRESET__ = { paste_json_to_python: false };
  });
  await page.reload();
  await openPyAndFocus(page);
  await page.evaluate((t) => navigator.clipboard.writeText(t), JSON_TEXT);
  await page.keyboard.press("Control+v");
  await expect.poll(() => modelValue(page), { timeout: 10_000 }).toContain(JSON_TEXT);
});
