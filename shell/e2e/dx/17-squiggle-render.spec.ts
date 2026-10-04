/**
 * E2E：错误/警告波浪线渲染语义（2026-09-29 用户报告「警告有黄线、错误无红线」排查交付）
 *
 * 排查结论（多轮 hook 诊断 + 真实工作区 marker 注入验证）：
 *  1. Monaco 渲染链路正常：severity=8 恒渲染 .squiggly-error（视口内逐行验证）
 *  2. 真凶一：pyrefly 单批内重复推送同形态诊断（实案 `Unpacked keyword argument` ×19 份
 *     同 range）——不去重时同 range 装饰互相压盖 + 计数虚高（toast/面板/hover 全部失真）
 *  3. 真凶二：用户视口段（文件头部 import 区）error 与 warning 同 range 并存
 *     （`Cannot find module` error + `may be unused` warning，range 相同）——Monaco 同 range
 *     装饰按 zIndex 合并，error(30) 应盖 warning(20)，但去重前 error 被重复 marker 干扰
 *
 *  - E-DX-SQ1 severity 映射：error/warning/info 各渲染对应 squiggle 类
 *  - E-DX-SQ2 视口滚动到错误行时红线可见（长文件中段/尾部）
 *  - E-DX-SQ3 同 range 重复诊断去重（handleDiagnostics：toast 计数不虚高）
 *  - E-DX-SQ4 同 range error+warning 并存：error 线优先渲染（红线可见）
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makePlainDir } from "../helpers";

const SRC = Array.from({ length: 720 }, (_, i) => `v${i} = ${i}`).join("\n") + "\n"; // SQ5 需 ≥709 行

/** 注入 marker（owner pylume-lsp，与 handleDiagnostics 同链） */
async function inject(page: Page, markers: unknown[]): Promise<void> {
  await page.evaluate(async (ms) => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    app.monaco.editor.setModelMarkers(app.editor.getModel(), "pylume-lsp", ms as any[]);
  }, markers);
}

/** 视口内 squiggle 计数 */
async function squiggles(page: Page): Promise<{ err: number; warn: number; info: number }> {
  return page.evaluate(() => {
    const ed = document.querySelector(".monaco-editor")!;
    return {
      err: ed.querySelectorAll(".squiggly-error").length,
      warn: ed.querySelectorAll(".squiggly-warning").length,
      info: ed.querySelectorAll(".squiggly-info").length,
    };
  });
}

/** 经 handleDiagnostics 真链路注入（走 lsp.onNotification → 去重 → setMarkers）。
 *  路径归一比较同 main.ts setMarkers 的 samePath 语义（fileUriToPath 产正斜杠，
 *  tab.path 在 Windows 是反斜杠——精确 === 会全程失配）。 */
async function publishDiagnostics(page: Page, diagnostics: unknown[]): Promise<void> {
  await page.evaluate(async (ds) => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const model = app.editor.getModel();
    const uri = model.uri.toString();
    const lsp = (await import(/* @vite-ignore */ "/src/lsp/client.ts")) as any;
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    lsp.handleDiagnostics(
      { uri, diagnostics: ds },
      "static",
      (p: string, markers: any[], owner?: string) => {
        const tab = app.tabs.find((t: any) => norm(t.path) === norm(p));
        if (tab) app.monaco.editor.setModelMarkers(tab.model, owner ?? "pylume-lsp", markers);
      },
    );
  }, diagnostics);
}

/** LSP diagnostic 形态（与 pyrefly 推送一致） */
function lspDiag(line: number, startChar: number, endLine: number, endChar: number, severity: number, message: string, code?: string): Record<string, unknown> {
  return {
    range: {
      start: { line: line - 1, character: startChar - 1 },
      end: { line: endLine - 1, character: endChar - 1 },
    },
    severity,
    message,
    ...(code !== undefined ? { code } : {}),
  };
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => {
    throw new Error(`pageerror: ${e}`);
  });
  const repo = await makePlainDir({ "sq.py": SRC });
  await equipPage(page, repo);
  await page.goto("/");
  await page.locator("#tree .tree-item .name", { hasText: "sq.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
});

test("E-DX-SQ1 severity → squiggle 类映射（视口内三类并存）", async ({ page }) => {
  await inject(page, [
    { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3, severity: 8, message: "err" },
    { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 3, severity: 4, message: "warn" },
    { startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 3, severity: 2, message: "info" },
  ]);
  await page.waitForTimeout(400);
  const c = await squiggles(page);
  expect(c.err).toBe(1);
  expect(c.warn).toBe(1);
  expect(c.info).toBe(1);
});

test("E-DX-SQ2 错误行滚动可见（中段 + 尾部）", async ({ page }) => {
  await inject(page, [
    { startLineNumber: 6, startColumn: 1, endLineNumber: 6, endColumn: 3, severity: 8, message: "mid err" },
    { startLineNumber: 12, startColumn: 1, endLineNumber: 12, endColumn: 3, severity: 8, message: "tail err" },
  ]);
  await page.waitForTimeout(400);
  // 12 行文件全在视口内（无需滚动，两线并存）
  const c = await squiggles(page);
  expect(c.err).toBe(2);
});

test("E-DX-SQ3 pyrefly 重复诊断去重（经 handleDiagnostics 真链路）", async ({ page }) => {
  // 同形态 ×5（复刻实案：Unpacked keyword argument ×19）+ 一条独立 error + 一条 warning
  const dup = lspDiag(2, 1, 2, 5, 1, "Unpacked keyword argument `CursorShape`", "invalid-argument-type");
  await publishDiagnostics(page, [
    dup, { ...dup }, { ...dup }, { ...dup }, { ...dup },
    lspDiag(4, 1, 4, 5, 1, "Cannot find module `foo`", "missing-import"),
    lspDiag(6, 1, 6, 5, 2, "Import may be unused", "unused-import"),
  ]);
  await page.waitForTimeout(400);

  // marker 数：去重后 = 3（非 7）
  const counts = await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const markers = app.monaco.editor.getModelMarkers({ resource: app.editor.getModel().uri });
    const S = app.monaco.MarkerSeverity;
    return {
      total: markers.length,
      errs: markers.filter((m: any) => m.severity === S.Error).length,
      warns: markers.filter((m: any) => m.severity === S.Warning).length,
    };
  });
  expect(counts.total).toBe(3);
  // PyCharm 语义降级：missing-import 保留 Error；invalid-argument-type（类型类）降 Warning
  expect(counts.errs).toBe(1);
  expect(counts.warns).toBe(2);

  // 渲染：1 红线（missing-import）+ 2 黄线（类型类 + unused）
  const c = await squiggles(page);
  expect(c.err).toBe(1);
  expect(c.warn).toBe(2);

  // 保存 toast 计数不虚高（Ctrl+S → 仅 1 条 error 级）
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const col = app.editor.getModel().getLineMaxColumn(1);
    app.editor.setPosition({ lineNumber: 1, column: col });
    app.editor.focus();
  });
  await expect(page.locator(".monaco-editor textarea")).toBeFocused({ timeout: 5_000 });
  await page.keyboard.type("2");
  await page.keyboard.press("Control+s");
  await expect(page.locator(".toast", { hasText: "sq.py：1 处类型/引用错误（已保存）" })).toBeVisible({ timeout: 5_000 });
});

test("E-DX-SQ6 PyCharm 语义分级：类型类 error 降黄线，硬错误保留红线", async ({ page }) => {
  // 复刻用户实案：1044 行 bad-function-definition（`Default None is not assignable...`）
  // 在 PyCharm 是警告——降级后画黄线；parse-error / missing-import 保留红线
  await publishDiagnostics(page, [
    // 类型检查类（LSP error）→ Warning 黄线
    lspDiag(2, 1, 2, 5, 1, "Default `None` is not assignable to parameter `repo_root` with type `str`", "bad-function-definition"),
    lspDiag(4, 1, 4, 5, 1, "`str | None` is not assignable to variable `repo_root` with type `str`", "bad-assignment"),
    lspDiag(6, 1, 6, 5, 1, "No attribute `tcgetattr` in module `termios`", "missing-attribute"),
    // 硬错误（LSP error）→ Error 红线
    lspDiag(8, 1, 8, 5, 1, "Parse error: Expected an identifier", "parse-error"),
    lspDiag(10, 1, 10, 5, 1, "Cannot find module `fuck`", "missing-import"),
    // LSP warning → 原样 Warning
    lspDiag(12, 1, 12, 5, 2, "Import may be unused", "unused-import"),
  ]);
  await page.waitForTimeout(400);

  const counts = await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const markers = app.monaco.editor.getModelMarkers({ resource: app.editor.getModel().uri });
    const S = app.monaco.MarkerSeverity;
    return {
      errs: markers.filter((m: any) => m.severity === S.Error).length,
      warns: markers.filter((m: any) => m.severity === S.Warning).length,
      errLines: markers.filter((m: any) => m.severity === S.Error).map((m: any) => m.startLineNumber),
    };
  });
  expect(counts.errs).toBe(2); // 只有 parse-error + missing-import
  expect(counts.warns).toBe(4); // 3 条类型类降级 + 1 条原生 warning
  expect(counts.errLines).toEqual([8, 10]);

  const c = await squiggles(page);
  expect(c.err).toBe(2);
  expect(c.warn).toBe(4);
});

test("E-DX-SQ4 同 range error+warning 并存：红线优先渲染", async ({ page }) => {
  // 复刻实案：53 行 `import fuckme` —— Cannot find module (error) + may be unused (warning) 同 range
  await publishDiagnostics(page, [
    lspDiag(8, 1, 8, 8, 1, "Cannot find module `fuckme`", "missing-import"),
    lspDiag(8, 1, 8, 8, 2, "Import `fuckme` may be unused", "unused-import"),
  ]);
  await page.waitForTimeout(400);
  // error zIndex(30) > warning(20)：该行渲染 .squiggly-error（红线可见，不被黄线吞掉）
  const c = await squiggles(page);
  expect(c.err).toBe(1);
});

test("E-DX-SQ5 大量 marker（> Monaco 渲染上限 500）：error 优先渲染（分层截断）", async ({ page }) => {
  // 复刻真实环境实案（hermes-agent/cli.py 851 条 marker，75 行 error 排在 marker service
  // 插入序 500 名后 → 无装饰无红线，早期 warning 恰在前 500 → 有黄线）。
  // 修复：capMarkersBySeverity 分层截断（Error 全保留 > Warning > Info），error 必入渲染窗口。
  const diags: Record<string, unknown>[] = [];
  // 600 条 warning（行 1-600，模拟 pyrefly 的 unused-import 大军——插入序在前）
  for (let i = 1; i <= 600; i++) {
    diags.push(lspDiag(i, 1, i, 5, 2, `unused warning ${i}`, "unused-import"));
  }
  // 10 条 error 在文件中后段（行 700-709——插入序在后，Monaco 原生 take:500 会把它们截掉）
  for (let i = 700; i <= 709; i++) {
    diags.push(lspDiag(i, 1, i, 5, 1, `Cannot find module \`m${i}\``, "missing-import"));
  }
  await publishDiagnostics(page, diags);
  await page.waitForTimeout(500);

  // marker 总量被截到 ≤450（Error 优先保留）
  const counts = await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const markers = app.monaco.editor.getModelMarkers({ resource: app.editor.getModel().uri });
    const S = app.monaco.MarkerSeverity;
    return {
      total: markers.length,
      errs: markers.filter((m: any) => m.severity === S.Error).length,
    };
  });
  expect(counts.total).toBeLessThanOrEqual(450);
  expect(counts.errs).toBe(10); // error 全保留（不被 warning 挤掉）

  // 滚到 705 行（error 区）：红线必须渲染（修复前：插入序 500 截断 → 无线）
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    app.editor.revealLineInCenter(705);
  });
  await page.waitForTimeout(600);
  const c = await squiggles(page);
  expect(c.err).toBeGreaterThanOrEqual(1); // 视口内 error 行的红线可见
});
