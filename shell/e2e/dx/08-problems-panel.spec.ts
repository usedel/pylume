/**
 * E2E：问题面板 + 状态栏问题芯片（2026-09-29 交付，对标 PyCharm Problems View）
 *
 *  - E-DX-PB1 有诊断时：状态栏芯片显示计数（点击打开问题面板）；tab 徽标带错误数
 *  - E-DX-PB2 面板分组渲染：按文件分组 + 严重度徽标 + 行:列 + 消息首行
 *  - E-DX-PB3 点击条目跳转：打开对应文件并定位到错误行（reveal + 光标）
 *  - E-DX-PB4 过滤 chips：错误过滤后只剩 error 条目
 *  - E-DX-PB5 Alt+0 打开问题面板（window 级键）
 *  - E-DX-PB6 修复错误后面板/芯片联动清空（marker 变化驱动防抖刷新）
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

const SOURCE = "x = 1\ny = 2\nz = 3\n";

let repo: GitRepo;
const pageErrors: string[] = [];

/** 注入 marker（owner "e2e-pb"）后聚焦编辑器 */
async function injectMarkers(page: Page, markers: Array<{ line: number; col: number; severity: number; message: string; source?: string }>): Promise<void> {
  await page.evaluate(async (ms) => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    app.monaco.editor.setModelMarkers(app.editor.getModel(), "e2e-pb", ms.map((m: any) => ({
      startLineNumber: m.line,
      startColumn: m.col,
      endLineNumber: m.line,
      endColumn: m.col + 1,
      message: m.message,
      severity: m.severity,
      ...(m.source !== undefined ? { source: m.source } : {}),
    })));
    app.editor.focus();
  }, markers);
}

async function openEditor(page: Page, file: string): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: file }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "a.py": SOURCE, "b.py": SOURCE });
  await equipPage(page, repo);
  await page.goto("/");
  await openEditor(page, "a.py");
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-DX-PB1 芯片计数 + 点击打开面板 + tab 徽标", async ({ page }) => {
  await injectMarkers(page, [
    { line: 1, col: 1, severity: 8, message: "Parse error: Expected an identifier", source: "pyrefly" },
    { line: 2, col: 3, severity: 4, message: "E501 line too long", source: "E501" },
  ]);
  // 防抖 500ms 后芯片亮起
  const chip = page.locator("#status-problems");
  await expect(chip).toBeVisible({ timeout: 5_000 });
  await expect(chip).toHaveText(/✕ 1/);
  await expect(chip).toHaveText(/⚠ 1/);
  // tab 徽标（全局 1 错）
  await expect(page.locator("#tab-problems")).toHaveText(/问题 \(1\)/);
  // 芯片点击 → 问题面板打开
  await chip.click();
  await expect(page.locator("#problems-panel")).toBeVisible();
  await expect(page.locator("#problems-panel .pb-item")).toHaveCount(2);
});

test("E-DX-PB2 面板分组渲染（文件头/徽标/行:列/消息）", async ({ page }) => {
  await injectMarkers(page, [
    { line: 1, col: 1, severity: 8, message: "Parse error: Expected an identifier", source: "pyrefly" },
    { line: 3, col: 2, severity: 8, message: "undefined name `foo`", source: "pyrefly" },
    { line: 2, col: 3, severity: 4, message: "E501 line too long", source: "E501" },
  ]);
  await page.locator("#tab-problems").click();
  await expect(page.locator("#problems-panel")).toBeVisible();
  // 文件头带错误/警告计数
  await expect(page.locator("#problems-panel .search-file-name").first()).toHaveText(/a\.py/);
  await expect(page.locator("#problems-panel .search-file-name").first()).toHaveText(/✕2/);
  await expect(page.locator("#problems-panel .search-file-name").first()).toHaveText(/⚠1/);
  // 首条：错误徽标 + 行:列 + 消息首行
  const first = page.locator("#problems-panel .pb-item").first();
  await expect(first.locator(".pb-sev-error")).toHaveText("错误");
  await expect(first.locator(".pb-line")).toHaveText("1:1");
  await expect(first.locator(".pb-msg")).toHaveText("Parse error: Expected an identifier");
});

test("E-DX-PB3 点击条目跳转定位", async ({ page }) => {
  await injectMarkers(page, [
    { line: 3, col: 2, severity: 8, message: "undefined name `foo`", source: "pyrefly" },
  ]);
  await page.locator("#tab-problems").click();
  await expect(page.locator("#problems-panel .pb-item")).toHaveCount(1);
  // 光标先在 L1
  await page.locator("#problems-panel .pb-item").first().click();
  // 跳转后光标落 L3C2 + 视口滚到该行（revealLineInCenter）
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
        const p = app.editor.getPosition();
        return `${p.lineNumber}:${p.column}`;
      }),
    )
    .toBe("3:2");
});

test("E-DX-PB4 过滤 chips：只看错误", async ({ page }) => {
  await injectMarkers(page, [
    { line: 1, col: 1, severity: 8, message: "err", source: "pyrefly" },
    { line: 2, col: 1, severity: 4, message: "warn", source: "E501" },
  ]);
  await page.locator("#tab-problems").click();
  await expect(page.locator("#problems-panel .pb-item")).toHaveCount(2);
  await page.locator("#problems-panel .fu-chip", { hasText: "错误" }).click();
  await expect(page.locator("#problems-panel .pb-item")).toHaveCount(1);
  await expect(page.locator("#problems-panel .pb-item .pb-sev-error")).toHaveCount(1);
});

test("E-DX-PB5 Alt+0 打开问题面板", async ({ page }) => {
  await injectMarkers(page, [
    { line: 1, col: 1, severity: 8, message: "err", source: "pyrefly" },
  ]);
  await page.keyboard.press("Alt+0");
  await expect(page.locator("#problems-panel")).toBeVisible();
  await expect(page.locator("#problems-panel .pb-item")).toHaveCount(1);
});

test("E-DX-PB8 全部视图错误优先排序（severity 降序 → 行升序）", async ({ page }) => {
  // 刻意以「warning 行号靠前 + error 行号靠后」的插入序注入——排序后 error 仍须排最前
  await injectMarkers(page, [
    { line: 2, col: 1, severity: 4, message: "warn L2", source: "E501" },
    { line: 4, col: 1, severity: 4, message: "warn L4", source: "E501" },
    { line: 6, col: 1, severity: 4, message: "warn L6", source: "E501" },
    { line: 8, col: 1, severity: 8, message: "err L8", source: "pyrefly" },
    { line: 9, col: 1, severity: 8, message: "err L9", source: "pyrefly" },
  ]);
  await page.locator("#tab-problems").click();
  const items = page.locator("#problems-panel .pb-item");
  await expect(items).toHaveCount(5);
  // 前 2 条是 error（行升序），后 3 条是 warning（行升序）
  await expect(items.nth(0).locator(".pb-sev")).toHaveText("错误");
  await expect(items.nth(0).locator(".pb-msg")).toHaveText("err L8");
  await expect(items.nth(1).locator(".pb-sev")).toHaveText("错误");
  await expect(items.nth(1).locator(".pb-msg")).toHaveText("err L9");
  await expect(items.nth(2).locator(".pb-sev")).toHaveText("警告");
  await expect(items.nth(2).locator(".pb-msg")).toHaveText("warn L2");
  await expect(items.nth(4).locator(".pb-msg")).toHaveText("warn L6");
});

test("E-DX-PB6 清除 marker 后联动清空", async ({ page }) => {
  await injectMarkers(page, [
    { line: 1, col: 1, severity: 8, message: "err", source: "pyrefly" },
  ]);
  const chip = page.locator("#status-problems");
  await expect(chip).toBeVisible({ timeout: 5_000 });
  // 清空 marker（模拟修复后引擎重推空诊断）
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    app.monaco.editor.setModelMarkers(app.editor.getModel(), "e2e-pb", []);
  });
  await expect(chip).toBeHidden({ timeout: 5_000 });
  await expect(page.locator("#tab-problems")).toHaveText("问题");
  // 面板（若打开）显示空态
  await page.keyboard.press("Alt+0");
  await expect(page.locator("#problems-panel .pb-empty")).toBeVisible();
});

test("E-DX-PB7 点击最后一条后滚动位置不跳顶（指纹短路 + scrollTop 转移）", async ({ page }) => {
  // 复刻实案：点击条目 → openFile → activateTab → lintActiveFile 重设 ruff marker
  // （值未变也触发 onDidChangeMarkers）→ 500ms 防抖 renderProblems 全量重建 → 滚回顶部。
  // 修复：指纹不变短路重建；内容变化也转移 scrollTop。
  // 注：行号必须真实存在于文件内（openFile 的 setPosition 会 clamp，制造 70 行源文件）。
  const longSource = Array.from({ length: 70 }, (_, i) => `v${i} = ${i}`).join("\n") + "\n";
  repo.write("long.py", longSource);
  // 触发文件树刷新（fs-changed 链）
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    await app.monaco; // noop：保持模块已加载
  });
  await page.reload();
  await openEditor(page, "long.py");

  const many: Array<{ line: number; col: number; severity: number; message: string; source?: string }> = [];
  for (let i = 1; i <= 60; i++) {
    many.push({ line: i, col: 1, severity: 8, message: `err ${i}`, source: "pyrefly" });
  }
  await injectMarkers(page, many);
  await page.locator("#tab-problems").click();
  const results = page.locator("#problems-panel .find-usages-results");
  await expect(page.locator("#problems-panel .pb-item")).toHaveCount(60);

  // 滚到底部（真实用户行为：拖滚动条到最下）
  await page.evaluate(() => {
    const scroller = document.querySelector("#problems-panel .find-usages-results") as HTMLElement | null;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });
  const scrollTopBefore = await results.evaluate((el) => el.scrollTop);
  expect(scrollTopBefore).toBeGreaterThan(0);

  // 点击最后一条（触发 openFile → activateTab → lintActiveFile → marker 重设 → 防抖刷新）
  await page.locator("#problems-panel .pb-item").last().click();
  // 跳转生效（光标到 60 行）
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
        return app.editor.getPosition().lineNumber;
      }),
    )
    .toBe(60);
  // 等 500ms 防抖 + 渲染余量：滚动位置必须保持（不回顶）
  await page.waitForTimeout(1_200);
  const scrollTopAfter = await results.evaluate((el) => el.scrollTop);
  expect(scrollTopAfter).toBe(scrollTopBefore);

  // 再验证内容变化场景的滚动保持：追加一条新错误（指纹变化 → 重建 + scrollTop 转移）
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const model = app.editor.getModel();
    const markers = app.monaco.editor.getModelMarkers({ resource: model.uri });
    app.monaco.editor.setModelMarkers(model, "e2e-pb", [
      ...markers,
      { startLineNumber: 61, startColumn: 1, endLineNumber: 61, endColumn: 2, message: "new err", severity: 8, source: "pyrefly" },
    ]);
  });
  await page.waitForTimeout(1_200);
  await expect(page.locator("#problems-panel .pb-item")).toHaveCount(61);
  const scrollTopAfterAppend = await results.evaluate((el) => el.scrollTop);
  expect(scrollTopAfterAppend).toBe(scrollTopBefore); // 追加条目不跳顶
});
