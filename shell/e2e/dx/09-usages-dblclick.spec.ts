/**
 * E2E：PR-I Ctrl+Shift+双击 = 查找引用（dx_features_backlog §6.6/§6.8 第二梯队 D4 AM）
 *
 *  - E-DX-FU1 按住 Ctrl+Shift 双击符号 → 底部「引用」面板按种类出结果（add_score：3 处）
 *  - E-DX-FU2 **普通双击不受影响**：仍是选词，不打开引用面板（保护默认习惯）
 *
 * 引用数据由 tauri-mock 的 `textDocument/references` 替身提供（全文档词扫描），
 * 故两个文件都要 didOpen（与 lsp/03 同一前置）。
 *
 * ⚠ 手势落点三条实测（探针确认，别再踩）：
 *   1. Monaco 两次点击之间重绘行 DOM，**浏览器不合成 dblclick 事件**
 *      （实测 mousedown/mouseup 各 2、dblclick 0）→ 实现侧不能用 DOM dblclick；
 *   2. 测试侧因此改为「按住修饰键 + 同一点连点两次」（keyboard.down 的修饰键在
 *      mousedown 里确实存在，实测 mods=2）；
 *   3. `locator("span", {hasText}).dblclick()` 会点到整行/相邻 token（曾落到 `import`），
 *      必须用 Range 圈出子串取矩形中心。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

const LIB_PY = [
  "def add_score(a, b):",
  '    """Return the sum of two integers."""',
  "    return a + b",
  "",
  "",
  "def label(x):",
  '    """Return a display text."""',
  '    return "score-" + str(x)',
  "",
  "",
  "result = label(3)",
  "",
].join("\n");

const MAIN_PY = ["from lib import add_score", "", "total = add_score(2, 3)", "print(total)", ""].join("\n");

let repo: GitRepo;
const pageErrors: string[] = [];

async function openFile(page: Page, name: string): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: name }).first().dblclick();
  await expect(page.locator("#editor .monaco-editor")).toBeVisible({ timeout: 10_000 });
}

/** 用 Range 精确圈出目标词的矩形中心（Monaco token 与 span 非一一对应） */
async function wordCenter(page: Page, word: string): Promise<{ x: number; y: number }> {
  const box = await page.evaluate((w) => {
    const host = document.querySelector("#editor .monaco-editor .view-lines");
    if (!host) return null;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const txt = n.textContent ?? "";
      const idx = txt.indexOf(w);
      if (idx < 0) continue;
      const range = document.createRange();
      range.setStart(n, idx);
      range.setEnd(n, idx + w.length);
      const r = range.getBoundingClientRect();
      if (r.width <= 0) continue;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  }, word);
  if (!box) throw new Error(`未找到词 ${word} 的渲染矩形`);
  return box;
}

/** 带修饰键的「双击」= 同一点连点两次（d-1/d-2）——实现侧就是按两次 mousedown 判定的 */
async function dblclickWordWithMods(
  page: Page,
  word: string,
  mods: ("Control" | "Shift")[],
): Promise<void> {
  const { x, y } = await wordCenter(page, word);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.click(x, y);
  await page.mouse.click(x, y);
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
}

/** 普通双击手势（无修饰键）：Monaco 自身会选词——用来验证默认行为没被占用 */
async function plainDblclickWord(page: Page, word: string): Promise<void> {
  const abs = await wordCenter(page, word);
  const host = page.locator("#editor .monaco-editor .view-lines").first();
  const box = await host.boundingBox();
  if (!box) throw new Error("取不到 .view-lines 的矩形");
  await host.dblclick({ position: { x: abs.x - box.x, y: abs.y - box.y } });
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makeGitRepo({ files: { "lib.py": LIB_PY, "main.py": MAIN_PY }, commitMsg: "baseline" });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  // 引用两面都需要文档镜像（didOpen），两个文件都要打开
  await openFile(page, "lib.py");
  await openFile(page, "main.py");
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-DX-FU1 Ctrl+Shift+双击符号 → 引用面板按种类出结果", async ({ page }) => {
  await dblclickWordWithMods(page, "add_score", ["Control", "Shift"]);

  const panel = page.locator("#find-usages-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  // 定义（lib.py:1）/ 导入（main.py:1）/ 调用（main.py:3）
  await expect(panel.locator(".fu-chip", { hasText: "全部" })).toContainText("(3)", { timeout: 10_000 });
  await expect(panel.locator(".fu-chip", { hasText: "定义" })).toContainText("(1)");
  await expect(panel.locator(".fu-chip", { hasText: "调用" })).toContainText("(1)");
});

test("E-DX-FU2 普通双击仍是选词，不打开引用面板", async ({ page }) => {
  await plainDblclickWord(page, "add_score");
  // 默认双击选词行为保持不变（标识符被选中）
  await expect(page.locator("#editor .selected-text").first()).toBeVisible({ timeout: 10_000 });
  // 引用面板不应被拉起（给足时间窗再断言）
  await page.waitForTimeout(2_000);
  await expect(page.locator("#find-usages-panel .fu-chip")).toHaveCount(0);
});
