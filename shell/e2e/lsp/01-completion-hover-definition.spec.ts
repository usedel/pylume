/**
 * LSP 基础功能 E2E（代码补全 / Hover / 跳转定义 / 诊断提醒）。
 *
 * 由 e2e/mocks/tauri-mock.js 内置的浏览器侧 LSP 协议替身驱动（真实 pyrefly 在浏览器
 * 模式下没有进程），语义已与静态引擎对齐到可断言程度：属性成员补全、跨文件跳转定义、
 * 函数 docstring hover、missing-import 诊断。用例只写「用户旅程」，不直测 mock 内部实现。
 */
import { test, expect } from "@playwright/test";
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
  'name = "pylume"',
  "",
  "total = add_score(2, 3)",
  "print(total)",
  "",
].join("\n");

/** 双击文件树打开文件，并确认编辑器就绪后再切下一个 */
async function openFile(page: import("@playwright/test").Page, name: string): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: name }).first().dblclick();
  await expect(page.locator("#editor .monaco-editor")).toBeVisible({ timeout: 10_000 });
}

test.beforeEach(async ({ page }) => {
  const repo = await makeGitRepo({
    files: { "lib.py": LIB_PY, "main.py": MAIN_PY },
    commitMsg: "baseline",
  });
  await equipPage(page, repo);
  await page.goto("/");
  // 工作区自动恢复 + 首次 git 状态刷新完成
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  // 先打开 lib.py（让 mock 按 didOpen 索引进其符号），再打开 main.py（最终激活 main.py）
  await openFile(page, "lib.py");
  await openFile(page, "main.py");
});

test("代码补全：输入变量名 + . 弹出 LSP 成员补全列表（str 方法）", async ({ page }) => {
  const editor = page.locator("#editor .monaco-editor");
  await editor.click();
  // 光标落到文档末尾，换行后输入 `result = s.`——末尾的 `.` 触发 LSP 补全
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("result = s.");

  // Monaco 补全 widget 弹出，且包含 s（str 类型）的方法成员
  const suggest = page.locator("#editor .suggest-widget");
  await expect(suggest).toBeVisible({ timeout: 10_000 });
  await expect(suggest).toContainText("upper", { timeout: 10_000 });
  await expect(suggest).toContainText("split");
});

test("Hover：悬停函数调用处显示其 docstring", async ({ page }) => {
  // 悬停须落在文本实际位置（dc 里 view-line 中心是行末空白，Monaco 不触发 hover）。
  // 单次 mouse.move 无中间 mousemove 序列、落点可能在字符间隙 → 偶发不触发：
  // 分步移动（产生真实 mousemove 流）+ 整体重试去抖。
  const line = page
    .locator("#editor .monaco-editor .view-line", { hasText: "add_score(2, 3)" })
    .first();
  await expect(async () => {
    const box = await line.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 30, box!.y + box!.height / 2);
    await page.mouse.move(box!.x + 60, box!.y + box!.height / 2, { steps: 4 });
    const hover = page.locator(".monaco-hover:not(.hidden)").first();
    await expect(hover).toContainText("Return the sum of two integers", { timeout: 2_000 });
  }, { timeout: 15_000 }).toPass();
});

test("跳转定义：从调用处跳到 lib.py 的定义行", async ({ page }) => {
  // 把光标放到 add_score 调用行（点击 .view-line 定位），再用项目默认键 Ctrl+B 跳转
  //（goto_definition 默认键位；F12 为 Monaco 固定兜底键，触发同一 handler）
  const line = page
    .locator("#editor .monaco-editor .view-line", { hasText: "add_score(2, 3)" })
    .first();
  await line.click();
  await page.keyboard.press("Control+B");

  // 编辑器切到 lib.py（状态栏显示目标文件路径 + 激活 tab 同步切换）
  await expect(page.locator("#status-file")).toContainText("lib.py", { timeout: 10_000 });
  await expect(page.locator("#tabbar .tab.active")).toContainText("lib.py", { timeout: 5_000 });
});

test("诊断：缺失 import 点亮红波浪线错误提醒", async ({ page }) => {
  // 打开 main.py 时 mock 按 didOpen 索引并推送 missing-import 诊断 → 编辑器渲染红波浪线
  const squiggly = page.locator("#editor .squiggly-error").first();
  await expect(squiggly).toBeVisible({ timeout: 10_000 });
});