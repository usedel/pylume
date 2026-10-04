/**
 * 真实 pyrefly 适配 E2E。
 *
 * 与 01-* 的 mock 语义引擎不同，本组用例经 e2e/helpers.ts 的 realPyreflyBridgeFor 在 Node 侧
 * spawn 真实 `pyrefly lsp` 进程，用 Content-Length 帧把前端 `lsp_send_*` 命令转发给真实引擎
 * （复刻 Rust lsp.rs 的协议），验证前端 LSP 桥对 pyrefly 的适配：initialize 握手 /
 * 跨文件跳转 / 补全类型推断 / docstring hover / missing-import 诊断。
 *
 * 前置：本机需安装 pyrefly（版本锁定见 ci/versions.toml — pyrefly = "1.3.1"，`pyrefly lsp`）。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makeGitRepo } from "../helpers";

const LIB_PY = [
  "def add_score(a, b):",
  '    """Return the sum of two integers."""',
  "    return a + b",
  "",
].join("\n");

const MAIN_PY = [
  "import nonexistent_module_xyz",
  "from lib import add_score",
  "",
  's = "hello"',
  "",
  "add_score(2, 3)",
  "",
].join("\n");

let stopPyrefly: (() => void) | undefined;

async function openFile(page: Page, name: string): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: name }).first().dblclick();
  await expect(page.locator("#editor .monaco-editor")).toBeVisible({ timeout: 10_000 });
}

test.beforeEach(async ({ page }) => {
  const repo = await makeGitRepo({
    files: { "lib.py": LIB_PY, "main.py": MAIN_PY },
    commitMsg: "baseline",
  });
  const equipped = await equipPage(page, repo, { realPyrefly: true });
  stopPyrefly = equipped.stopPyrefly;
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  // 真实引擎 initialize 往返完成后状态栏显示「就绪」——这也是 pyrefly 适配通过的第一道关卡
  await expect(page.locator("#status-lsp")).toContainText("就绪", { timeout: 30_000 });
  await openFile(page, "main.py");
});

test.afterEach(async () => {
  stopPyrefly?.();
  stopPyrefly = undefined;
});

test("代码补全：真实 pyrefly 对 `s.` 类型推断出 str 方法", async ({ page }) => {
  const editor = page.locator("#editor .monaco-editor");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("result = s.");

  const suggest = page.locator("#editor .suggest-widget");
  await expect(suggest).toBeVisible({ timeout: 15_000 });
  // casefold 是 str 特有方法（字母序靠前，虚拟列表初始可见区，稳定命中）——证明类型推断为 str
  await expect(suggest).toContainText("casefold", { timeout: 15_000 });
});

test("跳转定义：真实 pyrefly 从调用处跳到 lib.py 定义行", async ({ page }) => {
  // 精确定位：add_score 是独立行、位于行首；点行内 x+30（≈ char 4）落在 add_score token 上，
  // 真实 pyrefly 需要 position 命中 token 才返回定义（行末空白会返回 null）。
  const line = page
    .locator("#editor .monaco-editor .view-line", { hasText: "add_score(2, 3)" })
    .first();
  // 必须等该行渲染就绪再取 boundingBox：Monaco 是异步渲染，全量跑（资源紧张）时
  // 过早取会拿到 null → 用例偶发失败。PR-B sticky 计算加入渲染管线后该竞态趋于稳定，
  // 故升级为 poll 轮询（toPass），to be visible 不足以保证 boundingBox 非空（实测踩坑）。
  await expect(line).toBeVisible({ timeout: 10_000 });
  let box: { x: number; y: number; width: number; height: number } | null = null;
  await expect
    .poll(async () => (box = await line.boundingBox()), { timeout: 10_000 })
    .not.toBeNull();
  await page.mouse.click(box!.x + 30, box!.y + box!.height / 2);
  await page.keyboard.press("Control+B");

  await expect(page.locator("#status-file")).toContainText("lib.py", { timeout: 15_000 });
  await expect(page.locator("#tabbar .tab.active")).toContainText("lib.py", { timeout: 5_000 });
});

test("Hover：真实 pyrefly 显示函数 docstring", async ({ page }) => {
  // 聚焦编辑器并等 view-line 渲染就绪（避免 boundingBox 在 Monaco 异步渲染完成前取到 null）
  const editor = page.locator("#editor .monaco-editor");
  await editor.click();
  const line = page
    .locator("#editor .monaco-editor .view-line", { hasText: "add_score(2, 3)" })
    .first();
  await expect(line).toBeVisible({ timeout: 10_000 });
  let box: { x: number; y: number; width: number; height: number } | null = null;
  await expect
    .poll(async () => (box = await line.boundingBox()), { timeout: 10_000 })
    .not.toBeNull();
  await page.mouse.move(box!.x + 30, box!.y + box!.height / 2);

  const hover = page.locator(".monaco-hover:not(.hidden)").first();
  await expect(hover).toContainText("Return the sum of two integers", { timeout: 15_000 });
});

test("诊断：真实 pyrefly 对缺失 import 点亮红波浪线", async ({ page }) => {
  const squiggly = page.locator("#editor .squiggly-error").first();
  await expect(squiggly).toBeVisible({ timeout: 20_000 });
});