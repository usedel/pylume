/**
 * E2E：PR-O Extract 重构（refactor.extract code action，dx_features_backlog 第三梯队探针转正）
 *
 * 走**真实 pyrefly 桥**（equipPage realPyrefly）：探针（bench/extract-refactor-probe/）已证明
 * pyrefly 原生返回 refactor.extract 且直接带 WorkspaceEdit（changes 形态），shell 侧零自研；
 * 本组用例验证产品链路整通：选区 → Ctrl+. 灯泡菜单 → 应用 edit → 产出代码正确。
 *
 *  - E-DX-ER1 Extract into variable 端到端：菜单出现 → 应用 → 插入赋值行 + 调用点替换
 *  - E-DX-ER2 抑制清单生效：extract helper（引擎产出漏 return 的坏代码，探针实测）不进菜单；
 *    Introduce parameter（产出正确）保留
 *
 * 前置：本机安装 pyrefly（ci/versions.toml 锁 1.3.1；1.2.0 起即支持 refactor.extract，
 * 探针 pyrefly_path 组实测）。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makeGitRepo } from "../helpers";

// 表达式 `PRICE * QUANTITY`（16 字符）位于第 6 行 0 基字符 12..28（4 空格 + "total = " 之后）
const MAIN_PY = [
  "PRICE = 10",
  "QUANTITY = 3",
  "",
  "",
  "def calc() -> int:",
  "    total = PRICE * QUANTITY",
  "    return total + PRICE",
  "",
].join("\n");

// ⚠ 必须有 pyproject.toml：pyrefly 从它发现工作区并启动索引（PR-N 教训同源）
const PYPROJECT = '[project]\nname = "probe"\nversion = "0.1.0"\n';

let stopPyrefly: (() => void) | undefined;
const pageErrors: string[] = [];

/** 编辑器选区（Monaco 1 基列号）+ 聚焦——比鼠标拖拽稳定（monospace 估宽会漂） */
async function selectRange(page: Page, line: number, colStart: number, colEnd: number): Promise<void> {
  await page.evaluate(async ([l, c1, c2]) => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const ed = app.editor;
    ed.focus();
    ed.setSelection({ startLineNumber: l, startColumn: c1, endLineNumber: l, endColumn: c2 });
  }, [line, colStart, colEnd] as const);
}

async function modelValue(page: Page, suffix: string): Promise<string | null> {
  return page.evaluate(async (suffix) => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const tab = app.tabs.find((t: any) => t.path.endsWith(suffix));
    return tab ? tab.model.getValue() : null;
  }, suffix);
}

async function openCodeActionMenu(page: Page): Promise<void> {
  await selectRange(page, 6, 13, 29); // 第 6 行 `PRICE * QUANTITY`：0 基 12..28 → 1 基 13..29
  // lazy 索引就绪窗口（探针口径：didOpen 后 ~3s 内 codeAction 可用）；引擎已过「就绪」门槛
  await page.waitForTimeout(2_000);
  await page.keyboard.press("Control+.");
  // Monaco 0.52 的 code action 菜单走 ActionWidget（platform/actionWidget）：容器 .action-widget
  const widget = page.locator(".action-widget");
  await expect(widget).toBeVisible({ timeout: 10_000 });
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const repo = await makeGitRepo({
    files: { "pyproject.toml": PYPROJECT, "main.py": MAIN_PY },
    commitMsg: "baseline",
  });
  const equipped = await equipPage(page, repo, { realPyrefly: true });
  stopPyrefly = equipped.stopPyrefly;
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await expect(page.locator("#status-lsp")).toContainText("就绪", { timeout: 30_000 });
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().dblclick();
  await expect(page.locator("#editor .monaco-editor")).toBeVisible({ timeout: 10_000 });
});

test.afterEach(async () => {
  stopPyrefly?.();
  stopPyrefly = undefined;
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-DX-ER1 Extract into variable 端到端：应用后插入赋值行 + 调用点替换", async ({ page }) => {
  await openCodeActionMenu(page);
  const item = page.locator(".action-widget .monaco-list-row", { hasText: "Extract into variable" });
  await expect(item).toBeVisible({ timeout: 10_000 });
  // 行点击用坐标：locator.click 的 hover 前置检查在列表重渲染时会无限重试（row 节点重建）
  const box = await item.boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);

  // 应用后断言 model（autosave off 不落盘，PR-K 同口径）：赋值行插入 + 表达式替换
  await expect.poll(() => modelValue(page, "main.py"), { timeout: 10_000 })
    .toContain("extracted_value = PRICE * QUANTITY");
  const value = await modelValue(page, "main.py");
  expect(value).toContain("total = extracted_value");
  expect(value).not.toContain("total = PRICE * QUANTITY");
});

test("E-DX-ER2 抑制清单：extract helper 不进菜单，Introduce parameter 保留", async ({ page }) => {
  await openCodeActionMenu(page);
  const rows = page.locator(".action-widget .monaco-list-row");
  await expect(rows.first()).toBeVisible({ timeout: 10_000 });

  // helper 变体漏 return（探针实测 1.2.0/1.3.1 同样），过滤直至引擎修复
  await expect(page.locator(".action-widget .monaco-list-row", { hasText: "Extract into helper" }))
    .toHaveCount(0);
  // Introduce parameter 产出正确（探针逐例核对），保留
  await expect(rows.filter({ hasText: "Introduce parameter" })).toHaveCount(1);
});
