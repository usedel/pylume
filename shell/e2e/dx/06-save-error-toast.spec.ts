/**
 * E2E：PR-F 保存时语法错误提示（dx_features_backlog §6.6/§6.8 第二梯队 D1）
 *
 *  - E-DX-SE1 显式 Ctrl+S：存在 error 级 marker → toast「N 处语法错误（已保存）」且**照常落盘**
 *    （只提示不阻止保存）；marker 经 state.ts 注入（mock 层无真实引擎，e2e 的被测边界 =
 *    saveTab 的 marker 查询 + toast 行为，owner 名无关紧要——实现按全量查询不按 owner 过滤）
 *  - E-DX-SE2 仅 warning 级 marker → 保存不弹语法错误 toast
 *
 *  runActions 门控（autosave/运行前落盘不提示）由 saveTab 的显式分支结构保证，
 *  与 PR-C 保存清理同口径，无单独 e2e。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

const SOURCE = "x = 1\n";

let repo: GitRepo;
const pageErrors: string[] = [];

/** 在第 1 行行尾追加一个字符使 tab 进入 dirty（落盘值 = "x = 12"） */
async function makeDirty(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const col = app.editor.getModel().getLineMaxColumn(1);
    app.editor.setPosition({ lineNumber: 1, column: col });
    app.editor.focus();
  });
  await expect(page.locator(".monaco-editor textarea")).toBeFocused({ timeout: 5_000 });
  await page.keyboard.type("2");
}

/** 给当前模型注入指定严重度的 marker（severity 8=Error / 4=Warning，与 MarkerSeverity 枚举一致） */
async function injectMarker(page: Page, severity: number): Promise<void> {
  await page.evaluate(async (sev) => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    app.monaco.editor.setModelMarkers(app.editor.getModel(), "e2e-syntax", [
      {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 2,
        message: "E2E 模拟语法错误",
        severity: sev,
      },
    ]);
  }, severity);
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "bad.py": SOURCE });
  await equipPage(page, repo);
  await page.goto("/");
  await page.locator("#tree .tree-item .name", { hasText: "bad.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-DX-SE1 保存遇 error marker：toast 提示且照常落盘", async ({ page }) => {
  await makeDirty(page);
  await injectMarker(page, 8); // MarkerSeverity.Error
  await page.keyboard.press("Control+s");
  // toast 出现（error 级文案，含文件名与数量）
  await expect(page.locator(".toast", { hasText: "bad.py：1 处语法错误（已保存）" })).toBeVisible({ timeout: 5_000 });
  // **不阻止保存**：落盘内容为编辑后的值
  await expect.poll(() => repo.read("bad.py"), { timeout: 10_000 }).toBe("x = 12\n");
});

test("E-DX-SE2 仅 warning marker：保存不弹语法错误 toast", async ({ page }) => {
  await makeDirty(page);
  await injectMarker(page, 4); // MarkerSeverity.Warning
  await page.keyboard.press("Control+s");
  await expect.poll(() => repo.read("bad.py"), { timeout: 10_000 }).toBe("x = 12\n");
  // 落盘已完成仍无 error toast（给足时间窗再断言不存在）
  await page.waitForTimeout(1_500);
  await expect(page.locator(".toast", { hasText: "语法错误（已保存）" })).toHaveCount(0);
});
