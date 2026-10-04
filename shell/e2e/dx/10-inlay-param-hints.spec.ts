/**
 * E2E：PR-N 参数名行内提示（dx_features_backlog §6.8 —— 原条件项，探针转正后落地）
 *
 * 走**真实 pyrefly 桥**（equipPage realPyrefly）：参数名提示是引擎侧能力，
 * mock 的 LSP 替身没有 inlayHint 实现，只有真机桥能证明整条链路：
 *   startEngine 就绪 → didChangeConfiguration 推 callArgumentNames="all"
 *   → Monaco provider 拿到 textDocument/inlayHint → 调用处渲染灰字 `a= / b=`。
 *
 *  - E-DX-IP1 默认开：调用处出现参数名提示（`a=` 与 `b=`）
 *  - E-DX-IP2 设置关掉后提示消失（配置经 didChangeConfiguration 即时生效，无需重启引擎）
 *
 * 前置：本机安装 pyrefly（ci/versions.toml 锁 1.3.1；本机 1.3.0，探针同口径）。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makeGitRepo } from "../helpers";

const LIB_PY = [
  "def add_score(a, b):",
  '    """Return the sum of two integers."""',
  "    return a + b",
  "",
].join("\n");

const MAIN_PY = ["from lib import add_score", "", "total = add_score(2, 3)", "print(total)", ""].join("\n");

// ⚠ 必须有 pyproject.toml：pyrefly 从它发现工作区并启动索引（引用计数那次的同款教训），
// 没有它连变量类型提示都不给（实测 engineResult = []）。
const PYPROJECT = '[project]\nname = "probe"\nversion = "0.1.0"\n';

let stopPyrefly: (() => void) | undefined;
const pageErrors: string[] = [];

async function openFile(page: Page, name: string): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: name }).first().dblclick();
  await expect(page.locator("#editor .monaco-editor")).toBeVisible({ timeout: 10_000 });
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const repo = await makeGitRepo({
    files: { "pyproject.toml": PYPROJECT, "lib.py": LIB_PY, "main.py": MAIN_PY },
    commitMsg: "baseline",
  });
  const equipped = await equipPage(page, repo, { realPyrefly: true });
  stopPyrefly = equipped.stopPyrefly;
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await expect(page.locator("#status-lsp")).toContainText("就绪", { timeout: 30_000 });
  await openFile(page, "main.py");
});

test.afterEach(async () => {
  stopPyrefly?.();
  stopPyrefly = undefined;
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-DX-IP1 真实 pyrefly：调用处出现参数名提示", async ({ page }) => {
  // ⚠ hasText 定位：不能用 "add_score(2, 3)"（提示插入后整行渲染成 "add_score(a= 2, 3)"），
  //   也不能只用 "add_score"（会先命中 import 行）——用 "add_score(" 唯一命中调用行
  const line = page.locator("#editor .monaco-editor .view-line", { hasText: "add_score(" }).first();
  await expect(line).toBeVisible({ timeout: 10_000 });
  // 引擎侧 150ms 防抖 + provider 异步：轮询等待提示渲染
  await expect.poll(async () => (await line.textContent()) ?? "", { timeout: 20_000 }).toContain("a=");
  expect(await line.textContent()).toContain("b=");
});

test("E-DX-IP2 关闭设置后参数名提示消失", async ({ page }) => {
  const line = page.locator("#editor .monaco-editor .view-line", { hasText: "add_score(" }).first();
  await expect.poll(async () => (await line.textContent()) ?? "", { timeout: 20_000 }).toContain("a=");

  await page.keyboard.press("Control+Alt+S");
  await expect(page.locator("#settings-modal, .modal:has(#settings-save)").first()).toBeVisible({ timeout: 5_000 });
  await page.locator('.settings-nav-item[data-cat="editor"]').click();
  await page.locator("#settings-inlay-param-hints").uncheck();
  await page.locator("#settings-save").click();
  await expect(page.locator("#settings-modal")).toBeHidden({ timeout: 5_000 });

  // 引擎侧防抖 150ms；关掉后不再有参数名提示（变量类型提示仍可能由引擎默认给出，不在本断言内）
  await expect
    .poll(async () => ((await line.textContent()) ?? "").includes("a="), { timeout: 20_000 })
    .toBe(false);
});
