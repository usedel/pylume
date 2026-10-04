/**
 * E2E：诊断导航 + 保存 toast 错误分类（2026-09-29 保存错误排查交付）
 *
 *  - E-DX-MN1 F8 逐个跳转：多个 error marker → F8 依序定位（行/列正确），Shift+F8 反向
 *  - E-DX-MN2 循环回绕：最后一个再 F8 → 回到第一个，toast 标注「已回绕」
 *  - E-DX-MN3 无诊断时 F8 → 提示 toast，不跳转
 *  - E-DX-MN4 保存 toast 文案分类：pyrefly 形态（parse-error + 语义 code）→ 「N 处语法错误，M 处类型/引用错误」
 *  - E-DX-MN5 保存 toast「定位」动作 → 点击直达第一个错误行
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

const SOURCE = "x = 1\ny = 2\nz = 3\n";

let repo: GitRepo;
const pageErrors: string[] = [];

/** 给模型注入 marker（owner "e2e-nav"，与 06-save-error-toast 同口径——saveTab 不按 owner 过滤）。
 *  注入后聚焦编辑器（editor 级键位需焦点在 Monaco 内）。 */
async function injectMarkers(page: Page, markers: Array<{ line: number; col: number; severity: number; message: string; source?: string; code?: string }>): Promise<void> {
  await page.evaluate(async (ms) => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    app.monaco.editor.setModelMarkers(app.editor.getModel(), "e2e-nav", ms.map((m: any) => ({
      startLineNumber: m.line,
      startColumn: m.col,
      endLineNumber: m.line,
      endColumn: m.col + 1,
      message: m.message,
      severity: m.severity,
      ...(m.source !== undefined ? { source: m.source } : {}),
      ...(m.code !== undefined ? { code: m.code } : {}),
    })));
    app.editor.focus();
  }, markers);
  await expect(page.locator(".monaco-editor textarea")).toBeFocused({ timeout: 5_000 });
}

/** 当前光标位置 */
async function cursorPos(page: Page): Promise<{ line: number; column: number }> {
  return page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const p = app.editor.getPosition();
    return { line: p.lineNumber, column: p.column };
  });
}

async function openEditor(page: Page, file: string): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: file }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "nav.py": SOURCE, "clean.py": SOURCE });
  await equipPage(page, repo);
  await page.goto("/");
  await openEditor(page, "nav.py");
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-DX-MN1 F8 依序跳转，Shift+F8 反向", async ({ page }) => {
  await injectMarkers(page, [
    { line: 1, col: 1, severity: 8, message: "err at L1", source: "pyrefly", code: "parse-error" },
    { line: 2, col: 3, severity: 8, message: "err at L2", source: "pyrefly", code: "unknown-name" },
    { line: 3, col: 2, severity: 4, message: "warn at L3", source: "ruff", code: "E501" },
  ]);
  // 光标在 L1 → F8 命中 L2（L1 之后的第一个）
  await page.keyboard.press("F8");
  await expect.poll(() => cursorPos(page)).toEqual({ line: 2, column: 3 });
  // 再 F8 → L3（warning 也在导航序列）
  await page.keyboard.press("F8");
  await expect.poll(() => cursorPos(page)).toEqual({ line: 3, column: 2 });
  // Shift+F8 反向 → 回 L2
  await page.keyboard.press("Shift+F8");
  await expect.poll(() => cursorPos(page)).toEqual({ line: 2, column: 3 });
});

test("E-DX-MN2 循环回绕：末尾再 F8 回到第一个", async ({ page }) => {
  await injectMarkers(page, [
    { line: 1, col: 1, severity: 8, message: "err at L1", source: "pyrefly", code: "parse-error" },
    { line: 3, col: 1, severity: 8, message: "err at L3", source: "pyrefly", code: "parse-error" },
  ]);
  // 光标 L1 → F8 到 L3（末项）
  await page.keyboard.press("F8");
  await expect.poll(() => cursorPos(page)).toEqual({ line: 3, column: 1 });
  // 再 F8 → 回绕到 L1，toast 标注
  await page.keyboard.press("F8");
  await expect.poll(() => cursorPos(page)).toEqual({ line: 1, column: 1 });
  await expect(page.locator(".toast", { hasText: "已回绕" })).toBeVisible({ timeout: 5_000 });
});

test("E-DX-MN3 无诊断时 F8 给提示", async ({ page }) => {
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    app.editor.focus();
  });
  await expect(page.locator(".monaco-editor textarea")).toBeFocused({ timeout: 5_000 });
  await page.keyboard.press("F8");
  await expect(page.locator(".toast", { hasText: "没有可跳转的诊断" })).toBeVisible({ timeout: 5_000 });
});

test("E-DX-MN4+E-DX-MN5 保存 toast 分类文案 + 定位动作", async ({ page }) => {
  // 模拟 168 实案形态：2 语法（parse-error）+ 3 类型（语义 code）
  await injectMarkers(page, [
    { line: 1, col: 1, severity: 8, message: "Parse error", source: "pyrefly", code: "parse-error" },
    { line: 2, col: 1, severity: 8, message: "Parse error", source: "pyrefly", code: "parse-error" },
    { line: 3, col: 1, severity: 8, message: "type err 1", source: "pyrefly", code: "invalid-argument-type" },
    { line: 3, col: 2, severity: 8, message: "type err 2", source: "pyrefly", code: "unknown-name" },
    { line: 3, col: 3, severity: 8, message: "type err 3", source: "pyrefly", code: "invalid-assignment" },
  ]);
  // 滚到文件底部再保存（复刻用户场景：视口远离错误行）
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    app.editor.setPosition({ lineNumber: 3, column: 10 });
  });
  // dirty 化：改一个字符
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const col = app.editor.getModel().getLineMaxColumn(1);
    app.editor.setPosition({ lineNumber: 1, column: col });
    app.editor.focus();
  });
  await expect(page.locator(".monaco-editor textarea")).toBeFocused({ timeout: 5_000 });
  await page.keyboard.type("2");
  await page.keyboard.press("Control+s");
  // 分类文案：语法 2 + 类型 3
  await expect(page.locator(".toast", { hasText: "nav.py：2 处语法错误，3 处类型/引用错误（已保存）" })).toBeVisible({ timeout: 5_000 });
  // 落盘不阻断
  await expect.poll(() => repo.read("nav.py"), { timeout: 10_000 }).toBe("x = 12\ny = 2\nz = 3\n");
  // 「定位」动作 → 跳到第一个错误（L1 col1）
  await page.locator(".toast .toast-action", { hasText: "定位" }).first().click();
  await expect.poll(() => cursorPos(page)).toEqual({ line: 1, column: 1 });
});

test("E-DX-MN4b 纯类型错误不再误称语法错误", async ({ page }) => {
  await injectMarkers(page, [
    { line: 2, col: 1, severity: 8, message: "type err", source: "pyrefly", code: "invalid-argument-type" },
  ]);
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const col = app.editor.getModel().getLineMaxColumn(1);
    app.editor.setPosition({ lineNumber: 1, column: col });
    app.editor.focus();
  });
  await expect(page.locator(".monaco-editor textarea")).toBeFocused({ timeout: 5_000 });
  await page.keyboard.type("2");
  await page.keyboard.press("Control+s");
  await expect(page.locator(".toast", { hasText: "nav.py：1 处类型/引用错误（已保存）" })).toBeVisible({ timeout: 5_000 });
});
