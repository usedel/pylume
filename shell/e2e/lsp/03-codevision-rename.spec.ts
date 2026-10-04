/**
 * 引用计数 Code Vision + 就地重命名 E2E（P0，对标 PyCharm 交互）。
 *
 * 由 e2e/mocks/tauri-mock.js 内置 LSP 协议替身驱动（03 起 mock 补齐
 * documentSymbol / references / prepareRename / rename 四个方法，语义为
 * 「全文档词扫描」：引用 = 该词在全部已镜像文档的出现，重命名 = 全部出现替换）。
 * 覆盖旅程：
 *  - Code Vision：声明行上方「N 处引用」计数 + 点击弹引用列表 + 条目跳转选中标识符；
 *  - Alt+F7 引用面板：按引用种类分组 + 点击跳转选中；
 *  - 就地改名：F2 原地输入框 + 当前文件 ghost 预览 + Enter 落盘；
 *  - 跨文件改名：Enter → 确认摘要（影响文件数 + 各文件命中数，D-3）→ 一次性写盘 + toast 汇总
 *    （原「无 diff 预览模态」裁决不变——只加摘要确认，不做逐处 diff）；
 *  - 右键菜单入口（可发现性）；
 *  - Esc 取消 / 光标不在符号上的防误触提示。
 */
import { test, expect } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

const LIB_PY = [
  "def add_score(a, b):",
  '    """Return the sum of two integers."""',
  "    return a + b",
  "",
  "",
  "def label(x):",
  // 注意：mock 的 references 是词扫描，docstring 里不得再出现「label」一词，
  // 否则 label 的引用数会 +1（保持断言的确定性）
  '    """Return a display text."""',
  '    return "score-" + str(x)',
  "",
  "",
  "result = label(3)",
  "",
].join("\n");

const MAIN_PY = [
  "from lib import add_score",
  "",
  "total = add_score(2, 3)",
  "print(total)",
  "",
].join("\n");

/** 双击文件树打开文件，并确认编辑器就绪 */
let repoRef: GitRepo;

async function openFile(page: import("@playwright/test").Page, name: string): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: name }).first().dblclick();
  await expect(page.locator("#editor .monaco-editor")).toBeVisible({ timeout: 10_000 });
}

/** 把光标精确放到某行（Home 后右移 n 次落到目标单词首字符上） */
async function gotoWord(page: import("@playwright/test").Page, lineText: string, rights: number): Promise<void> {
  const line = page.locator("#editor .monaco-editor .view-line", { hasText: lineText }).first();
  await line.click();
  await page.keyboard.press("Home");
  for (let i = 0; i < rights; i++) await page.keyboard.press("ArrowRight");
}

test.beforeEach(async ({ page }) => {
  const repo = await makeGitRepo({
    files: { "lib.py": LIB_PY, "main.py": MAIN_PY },
    commitMsg: "baseline",
  });
  repoRef = repo;
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  // 两个文件都要打开：跨文件改名/references 依赖 didOpen 建立的文档镜像
  await openFile(page, "lib.py");
  await openFile(page, "main.py");
  await openFile(page, "lib.py"); // 最终激活 lib.py（声明所在文件）
});

test("Code Vision：类/函数声明行上方显示「N 处引用」计数", async ({ page }) => {
  // add_score：lib.py 定义 1 处 + main.py 导入/调用 2 处 = 3
  const lensAdd = page.locator("#editor .codelens-decoration", { hasText: "3 处引用" });
  await expect(lensAdd.first()).toBeVisible({ timeout: 15_000 });
  // label：lib.py 定义 + 同文件调用 = 2
  const lensLabel = page.locator("#editor .codelens-decoration", { hasText: "2 处引用" });
  await expect(lensLabel.first()).toBeVisible({ timeout: 15_000 });
});

test("Code Vision：点击计数弹出引用列表，点击条目跳转并选中标识符", async ({ page }) => {
  await page.locator("#editor .codelens-decoration", { hasText: "3 处引用" }).first().click();

  const popup = page.locator(".oc-cv-popup");
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expect(popup).toContainText("add_score · 3 处引用");
  // 三条引用都在：定义（lib.py:1）/ 导入（main.py:1）/ 调用（main.py:3）
  await expect(popup.locator(".oc-cv-row")).toHaveCount(3);

  // 点击调用处条目 → 跳到 main.py 并选中标识符
  await popup.locator(".oc-cv-row", { hasText: "main.py:3" }).click();
  await expect(page.locator("#status-file")).toContainText("main.py", { timeout: 10_000 });
  await expect(page.locator("#editor .selected-text").first()).toBeVisible({ timeout: 10_000 });
});

test("Alt+F7 引用面板：按引用种类分组，点击跳转并选中标识符", async ({ page }) => {
  // 调用行在 main.py，先切过去再落光标（Home + 右移 8 次到 add_score 词首）
  await openFile(page, "main.py");
  await gotoWord(page, "total = add_score(2, 3)", 8);
  await page.keyboard.press("Alt+F7");

  const panel = page.locator("#find-usages-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  // 启发式分组：定义 / 导入 / 调用各 1
  await expect(panel.locator(".fu-chip", { hasText: "定义" })).toContainText("(1)");
  await expect(panel.locator(".fu-chip", { hasText: "导入" })).toContainText("(1)");
  await expect(panel.locator(".fu-chip", { hasText: "调用" })).toContainText("(1)");

  // 点击第一条结果（定义）→ 跳回 lib.py 并选中标识符
  await panel.locator(".search-match").first().click();
  await expect(page.locator("#status-file")).toContainText("lib.py", { timeout: 10_000 });
  await expect(page.locator("#editor .selected-text").first()).toBeVisible({ timeout: 10_000 });
});

test("就地改名（当前文件）：F2 原地输入框 + ghost 预览，Enter 落盘", async ({ page }) => {
  await gotoWord(page, "def label(x):", 5);
  await page.keyboard.press("F2");

  const input = page.locator(".oc-rename-widget .oc-rename-input");
  await expect(input).toBeVisible({ timeout: 10_000 });
  await expect(input).toHaveValue("label");
  // 当前文件 ghost 预览：定义 + 调用共 2 处高亮；提示条不含跨文件
  await expect(page.locator("#editor .oc-rename-ghost")).toHaveCount(2, { timeout: 10_000 });
  await expect(page.locator(".oc-rename-hint")).toContainText("将更新本文件 2 处");

  await input.fill("tag");
  await page.keyboard.press("Enter");

  // 编辑器缓冲与磁盘都更新
  await expect(page.locator("#editor .view-lines")).toContainText("def tag(x):", { timeout: 10_000 });
  await expect(page.locator("#editor .view-lines")).toContainText("result = tag(3)");
});

test("就地改名（跨文件）：Enter → 确认摘要 → 落盘 + toast 汇总（D-3）", async ({ page }) => {
  await gotoWord(page, "def add_score(a, b):", 5);
  await page.keyboard.press("F2");

  const input = page.locator(".oc-rename-widget .oc-rename-input");
  await expect(input).toBeVisible({ timeout: 10_000 });
  // 当前文件只有定义 1 处，提示条指出还有其他文件
  await expect(page.locator(".oc-rename-hint")).toContainText("其他 1 个文件", { timeout: 10_000 });

  await input.fill("sum_scores");
  await page.keyboard.press("Enter");

  // D-3：跨文件确认摘要——影响文件数 + 各文件命中数（按命中数降序）
  const dialog = page.locator("#confirm-modal");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toContainText("跨文件重命名「add_score」→「sum_scores」");
  await expect(dialog).toContainText("将修改 2 个文件共 3 处");
  await expect(dialog).toContainText("main.py × 2 处");
  await expect(dialog).toContainText("lib.py × 1 处");
  await page.locator("#confirm-ok").click();

  // 编辑器缓冲立即更新 + toast 汇总（2 个文件 3 处）
  await expect(page.locator("#editor .view-lines")).toContainText("def sum_scores(a, b):", { timeout: 10_000 });
  await expect(page.locator(".toast", { hasText: "2 个文件 3 处" })).toBeVisible({ timeout: 10_000 });
  // 两个文件都真实落盘（当前文件 + 未在编辑器打开缓冲的 main.py）
  await expect.poll(() => repoRef.read("lib.py"), { timeout: 10_000 }).toContain("def sum_scores(a, b):");
  await expect.poll(() => repoRef.read("main.py"), { timeout: 10_000 }).toContain("from lib import sum_score");
});

test("就地改名（跨文件）：确认摘要取消 → 不落盘（D-3）", async ({ page }) => {
  await gotoWord(page, "def add_score(a, b):", 5);
  await page.keyboard.press("F2");
  const input = page.locator(".oc-rename-widget .oc-rename-input");
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill("sum_scores");
  await page.keyboard.press("Enter");

  const dialog = page.locator("#confirm-modal");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await page.locator("#confirm-cancel").click();

  // 取消：不落盘，widget 收起
  await expect(page.locator(".oc-rename-widget")).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(() => repoRef.read("lib.py"), { timeout: 10_000 }).toContain("def add_score(a, b):");
});

test("就地改名：Esc 取消不落盘", async ({ page }) => {
  await gotoWord(page, "def label(x):", 5);
  await page.keyboard.press("F2");
  const input = page.locator(".oc-rename-widget .oc-rename-input");
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill("renamed_but_cancelled");
  await page.keyboard.press("Escape");

  await expect(page.locator(".oc-rename-widget")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator("#editor .view-lines")).toContainText("def label(x):");
});

test("就地改名：光标不在符号上时 F2 不弹输入框（防误触提示）", async ({ page }) => {
  // Ctrl+Home 后下移 4 行到空行（空 view-line 无宽度不可点，用键盘导航）→
  // prepareRename 无词 → 提示「光标处不是可重命名的符号」
  await page.locator("#editor .monaco-editor").click();
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("F2");

  await expect(page.locator(".toast", { hasText: "不是可重命名的符号" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".oc-rename-widget")).toHaveCount(0);
});

test("可发现性：编辑器右键菜单提供「查找引用 / 重命名…」入口", async ({ page }) => {
  // 光标落到 add_score 上，用 Shift+F10（Monaco 内建「编辑器上下文菜单」键位）唤出
  // 同一个菜单——等价于用户右键，但 headless 下稳定（右键目标解析偶发抖动）。
  await gotoWord(page, "def add_score(a, b):", 5);
  await page.keyboard.press("Shift+F10");

  // Monaco 常驻一个隐藏的空 .context-view 容器，须定位到含 .monaco-menu 的可见实例
  const menu = page.locator(".context-view .monaco-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu.getByRole("menuitem", { name: "查找引用" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "重命名…" })).toBeVisible();

  // 点「查找引用」走与 Alt+F7 同一链路 → 引用面板按种类落结果（add_score：3 处）
  await menu.getByRole("menuitem", { name: "查找引用" }).click();
  await expect(page.locator("#find-usages-panel .fu-chip", { hasText: "全部 (3)" })).toBeVisible({ timeout: 10_000 });
});
