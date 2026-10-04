/**
 * E2E：PR-L ruff 规则中文速释（dx_features_backlog §6.6）
 *
 * 诊断 hover 原生渲染 marker.message 多行文本，故被测边界 = ruffLint 的 marker 构造链路：
 * 预置 ruff_lint 诊断（window.__E2E_RUFF_LINT__）→ lintActiveFile → 断言 marker 消息：
 * 命中速释表的规则码追加〔速释〕段；未命中的规则码保持原形态；严重度映射不受影响。
 */
import { test, expect } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

let repo: GitRepo;
const pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "a.py": "print(undefined_name)\n" });
  await equipPage(page, repo);
  await page.goto("/");
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

/** 打开文件并经动态 import 触发一次 ruff lint（注入预置诊断） */
async function lintWithPreset(page: Page, diags: unknown[]): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: "a.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
  await page.evaluate((diags) => {
    (window as any).__E2E_RUFF_LINT__ = diags;
    return import(/* @vite-ignore */ "/src/ruffLint.ts").then((m) => m.lintActiveFile());
  }, diags);
}

test("E-DX-RH1 命中速释表的规则码：marker 消息追加〔速释〕段", async ({ page }) => {
  await lintWithPreset(page, [
    { line: 1, column: 7, end_line: 1, end_column: 21, code: "F821", message: "Undefined name `undefined_name`" },
  ]);
  const messages = await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    return app.monaco.editor
      .getModelMarkers({ owner: "pylume-ruff" })
      .map((m: any) => m.message);
  });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("F821 Undefined name `undefined_name`");
  expect(messages[0]).toContain("\n\n〔速释〕");
  expect(messages[0]).toContain("未定义的名称");
});

test("E-DX-RH2 未命中规则码保持原形态；严重度映射不受速释影响", async ({ page }) => {
  await lintWithPreset(page, [
    // Z001 不在速释表内；E501 走 severityFor 映射（ruff_severity_e 默认 warning）
    { line: 1, column: 1, end_line: 1, end_column: 2, code: "Z001", message: "未知规则诊断" },
    { line: 2, column: 1, end_line: 2, end_column: 2, code: "E501", message: "Line too long" },
  ]);
  const markers = await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    return app.monaco.editor
      .getModelMarkers({ owner: "pylume-ruff" })
      .map((m: any) => ({ message: m.message, severity: m.severity }));
  });
  expect(markers).toHaveLength(2);
  const z = markers.find((m: any) => m.message.startsWith("Z001"));
  const e = markers.find((m: any) => m.message.startsWith("E501"));
  expect(z.message).toBe("Z001 未知规则诊断"); // 无〔速释〕追加
  expect(e.message).toContain("〔速释〕");
  expect(e.severity, "ruff_severity_e 默认 warning").toBe(4); // MarkerSeverity.Warning
});
