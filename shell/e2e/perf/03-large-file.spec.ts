/**
 * E2E：A-4 红线「大文件打开」（调研报告 §6-A-4 补项）
 *
 *  - P-LARGE-1 2MB Python 文件打开耗时 < 5000 ms，且打开后编辑器可用（行数正确 + 可定位）
 *
 * 说明：输出洪峰的红线回归在 e2e/perf/01-output-guard.spec.ts（环形缓冲 + 背压），
 * 长跑内存增长在 bench/collect-metrics.ps1 -SoakMinutes（两者与本用例共同构成 A-4 三项）。
 */
import { test, expect } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

let repo: GitRepo;
const pageErrors: string[] = [];

/** 生成 ≈2MB 的合法 Python 文本（ defs + 短赋值行交错，≈17 万行） */
function buildLargeContent(): string {
  const parts: string[] = [];
  let size = 0;
  let i = 0;
  while (size < 2 * 1024 * 1024) {
    if (i % 20 === 0) {
      const def = `def helper_${i}(value):\n    return value + ${i}\n`;
      parts.push(def);
      size += def.length;
    } else {
      const line = `x_${i} = ${i}\n`;
      parts.push(line);
      size += line.length;
    }
    i++;
  }
  return parts.join("");
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "large.py": buildLargeContent(), "main.py": "print('hi')\n" });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#tree .tree-item .name", { hasText: "large.py" })).toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  expect(pageErrors, "页面不应有未捕获异常").toEqual([]);
});

test("P-LARGE-1 2MB 文件打开耗时与可用性", async ({ page }) => {
  const expectedLineCount = buildLargeContent().split("\n").length;
  const t0 = Date.now();
  await page.locator('#tree .tree-item[data-path$="large.py"]').first().dblclick();

  // model 行数到位 = 打开完成（toPass 轮询，等的是内容而非 UI 壳）
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
          return app.editor.getModel()?.getLineCount() ?? 0;
        }),
      { timeout: 15_000, intervalMs: 200 },
    )
    .toBe(expectedLineCount);
  const openMs = Date.now() - t0;
  expect(openMs, `2MB 文件打开耗时 ${openMs}ms，红线 5000ms`).toBeLessThan(5000);

  // 打开后可用：跳到末尾 + 编辑器仍可接收动作
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const m = app.editor.getModel()!;
    app.editor.revealLine(m.getLineCount());
    app.editor.setPosition({ lineNumber: m.getLineCount(), column: 1 });
  });
  await expect(page.locator(".monaco-editor")).toBeVisible();
});
