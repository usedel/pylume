/**
 * E2E：P3 可发现性与细节批次（对标调研 §6-E / §6-C-5 / §6-E-4）
 *
 *  - P3-1 设置搜索（E-1）：关键词过滤跨分类命中 + 空态「查找快捷键」跳转
 *  - P3-2 搜索 scope + 分组折叠（E-5）：当前文件 scope 可搜、文件组头点击折叠
 *  - P3-3 文件树定位到当前文件（E-3）：工具栏按钮 → 树内重新展开 + 选中
 *  - P3-4 Git 文件历史（E-4）：文件树右键 → 详情视图列出提交（真实 git bridge）
 *  - P3-5 与剪贴板对比（C-5）：域入口打开 diff 模态 + Esc 关闭
 */
import { test, expect } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

const SRC = 'def greet(name):\n    return "hello " + name\n\nprint(greet("world"))\n';

let repo: GitRepo;
const pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makeGitRepo({ files: { "main.py": SRC }, commitMsg: "baseline" });
  await equipPage(page, repo);
  await page.goto("/");
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  expect(pageErrors, "页面不应有未捕获异常").toEqual([]);
});

test("P3-1 设置搜索：跨分类过滤 + 空态跳转快捷键分类", async ({ page }) => {
  await page.locator("#btn-settings").click();
  const search = page.locator("#settings-search");
  await expect(search).toBeVisible();

  // 「字号」命中外观区的字号行；无命中的分类（编辑器区）隐藏
  await search.fill("字号");
  await expect(page.locator("#settings-section-appearance label[for='settings-font']")).toBeVisible();
  await expect(page.locator("#settings-section-editor")).toBeHidden();

  // 英文关键词命中（内置关键词表）：minimap → 编辑器区的「迷你地图」
  await search.fill("minimap");
  await expect(page.locator("#settings-section-editor label[for='settings-minimap']")).toBeVisible();
  await expect(page.locator("#settings-section-appearance")).toBeHidden();

  // 无匹配 → 空态 + 「查找快捷键」跳转
  await search.fill("zzz不存在的设置qqq");
  await expect(page.locator("#settings-search-empty")).toBeVisible();
  await page.locator("#settings-search-goto-kb").click();
  await expect(page.locator("#settings-section-keybindings")).toBeVisible();
  await expect(search).toHaveValue("");
});

test("P3-2 搜索 scope：当前文件可搜 + 文件组折叠", async ({ page }) => {
  await page.locator("#tab-search").click();
  await page.locator("#search-scope").selectOption("file");
  await page.locator("#search-input").fill("greet");
  await page.locator("#search-input").press("Enter");

  const firstFile = page.locator("#search-results .search-file").first();
  await expect(firstFile).toBeVisible({ timeout: 10_000 });
  // scope=当前文件：只搜活动标签（main.py）
  const names = await page.locator("#search-results .search-file-name").allTextContents();
  expect(names.length).toBeGreaterThan(0);
  for (const n of names) expect(n).toContain("main.py");

  // 分组折叠：点文件头 → 匹配行隐藏，再点恢复
  await expect(firstFile.locator(".search-match").first()).toBeVisible();
  await firstFile.locator(".search-file-name").click();
  await expect(firstFile).toHaveClass(/collapsed/);
  await expect(firstFile.locator(".search-match").first()).toBeHidden();
  await firstFile.locator(".search-file-name").click();
  await expect(firstFile.locator(".search-match").first()).toBeVisible();
});

test("P3-3 文件树「定位到当前文件」：折叠后重新展开 + 选中", async ({ page }) => {
  // 单击根目录（目录单击 = 折叠/展开切换）把树收起
  const rootItem = page.locator("#tree > .tree-item").first();
  await rootItem.click();
  await expect(page.locator('#tree .tree-item[data-path$="main.py"]')).toHaveCount(0);

  // 工具栏「定位到当前文件」→ 逐级展开 + 选中活动文件
  await page.locator("#btn-tree-reveal").click();
  const item = page.locator('#tree .tree-item[data-path$="main.py"]').first();
  await expect(item).toBeVisible({ timeout: 10_000 });
  await expect(item).toHaveClass(/active/);
});

test("P3-4 Git 文件历史：右键入口 → 详情视图列出真实提交", async ({ page }) => {
  const item = page.locator('#tree .tree-item[data-path$="main.py"]').first();
  await item.click({ button: "right", force: true });
  const ctx = page.locator("#ctx-menu");
  await expect(ctx).toBeVisible();
  await ctx.locator(".ctx-menu-item", { hasText: "Git 文件历史" }).first().click({ force: true });

  // 详情视图：标题 + 至少一条提交（makeGitRepo 有基线提交），hash 可点击进提交详情
  await expect(page.locator("#git-detail-label")).toHaveText(/文件历史 · main\.py/);
  await expect(page.locator("#git-detail-view .git-file-history-row").first()).toBeVisible();
  await page.locator("#git-detail-view .git-blame-hash").first().click();
  await expect(page.locator("#git-detail-label")).toHaveText(/提交 /);
});

test("P3-5 与剪贴板对比：diff 模态打开与 Esc 关闭", async ({ page }) => {
  // 预置剪贴板内容（mock 的 read_text 读 __E2E_CLIPBOARD__）
  await page.evaluate(() => {
    (window as any).__E2E_CLIPBOARD__ = "CLIPBOARD-SENTINEL-LINE";
  });
  // 打开活动文件与剪贴板的对比（域入口；编辑器右键菜单的 addAction 接线另有人工覆盖）
  await page.evaluate(async () => {
    const mod = (await import(/* @vite-ignore */ "/src/clipboardDiff.ts")) as any;
    await mod.diffEditorWithClipboard();
  });
  const modal = page.locator("#clipboard-diff-modal");
  await expect(modal).toBeVisible();
  await expect(page.locator("#clipboard-diff-title")).toContainText("main.py");
  // original 侧 = 剪贴板哨兵行
  await expect(modal.locator(".monaco-diff-editor .view-lines").first()).toContainText("CLIPBOARD-SENTINEL-LINE", { timeout: 10_000 });
  // Esc 关闭（无多层模态）
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
});
