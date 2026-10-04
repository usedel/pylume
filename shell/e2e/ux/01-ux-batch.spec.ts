/**
 * E2E：体验性小问题修复验收（2026-09-25 四批）
 *
 *  - UX-1 切标签记忆光标 + 滚动位置（viewState）
 *  - UX-2 切标签后编辑器自动聚焦
 *  - UX-3 Ctrl+Tab / Ctrl+Shift+Tab 循环切换标签
 *  - UX-4 标签溢出时激活标签滚入可视区 + 中键关闭
 *  - UX-5 git 丢弃块重载后 undo 栈保留（pushEditOperations 替代 setValue）
 *  - UX-6 文件树展开状态跨会话持久化 + 刷新后滚动位置恢复
 *  - UX-7 切标签时文件树自动跟随（可关开关）
 *  - UX-8 面板显隐持久化（底部面板 / 侧栏视图 / 大纲折叠）
 *  - UX-9 快速打开最近查询历史（↑ 回溯）
 *
 * 复用 session/git spec 的范式：真实临时 git 仓库 + tauri-mock 桥 + reload 模拟重启。
 * 大文件守卫（read_file 10MB 上限）在 Rust 层，由 fs_cmds 单测覆盖，浏览器 mock 无法触达。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

/** 经 state.ts 读取/操作运行时（与真实运行时同一模块实例）。
 *  注意：page.evaluate 参数须可序列化，函数传不过去——这里传源码串，页内 new Function 执行。 */
function withApp(page: Page, src: string): Promise<unknown> {
  return page.evaluate(async (code) => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    return new Function("app", code)(app);
  }, src);
}

async function activeTabName(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector("#tabbar .tab.active .name")?.textContent ?? null);
}

async function boot(page: Page, repo: GitRepo): Promise<void> {
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
}

async function openFileByTree(page: Page, name: string): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: name }).first().dblclick();
  await expect(page.locator("#tabbar .tab", { hasText: name }).first()).toBeVisible({ timeout: 10_000 });
}

// ---------- UX-1/2/3：标签页与编辑器 ----------

test("UX-1 切标签记忆光标与滚动位置", async ({ page }) => {
  const lines = Array.from({ length: 200 }, (_, i) => `l${i + 1} = ${i + 1}`);
  const repo = await makeGitRepo({ files: { "long.py": lines.join("\n") + "\n", "b.py": "print('b')\n" }, commitMsg: "baseline" });
  await boot(page, repo);

  await openFileByTree(page, "long.py");
  await openFileByTree(page, "b.py");
  // 回到 long.py：光标 120 行 + 滚动到中部
  await page.locator("#tabbar .tab", { hasText: "long.py" }).first().click();
  await withApp(page, "app.editor.setPosition({lineNumber:120,column:5}); app.editor.setScrollTop(1500);");

  // 切走再切回
  await page.locator("#tabbar .tab", { hasText: "b.py" }).first().click();
  await page.locator("#tabbar .tab", { hasText: "long.py" }).first().click();

  await expect.poll(() =>
    withApp(page, "return ({line: app.editor.getPosition()?.lineNumber ?? 0, scrollTop: app.editor.getScrollTop()})"),
  ).toEqual(expect.objectContaining({ line: 120, scrollTop: expect.any(Number) }));
  const st = (await withApp(page, "return ({line: app.editor.getPosition()?.lineNumber, scrollTop: app.editor.getScrollTop()})")) as {
    line: number;
    scrollTop: number;
  };
  expect(st.line).toBe(120);
  expect(st.scrollTop).toBeGreaterThan(1000); // 滚动位置也被保留（旧实现恒回顶部）
});

test("UX-2 鼠标切标签后编辑器自动聚焦", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "a.py": "one = 1\n", "b.py": "two = 2\n" }, commitMsg: "baseline" });
  await boot(page, repo);
  await openFileByTree(page, "a.py");
  await openFileByTree(page, "b.py");
  // 点击 a.py 标签（鼠标路径）→ 焦点应落回编辑器（旧实现留在 tab 元素上）
  await page.locator("#tabbar .tab", { hasText: "a.py" }).first().click();
  await expect(page.locator("#editor .monaco-editor textarea")).toBeFocused({ timeout: 5_000 });
  // 焦点在编辑器里可直接打字（体验断点的直接复现路径）
  await page.keyboard.type("# typed");
  await expect(page.locator("#editor .monaco-editor")).toContainText("# typed", { timeout: 5_000 });
});

test("UX-3 Ctrl+Tab / Ctrl+Shift+Tab 循环切换标签", async ({ page }) => {
  const repo = await makeGitRepo({
    files: { "a.py": "1\n", "b.py": "2\n", "c.py": "3\n" },
    commitMsg: "baseline",
  });
  await boot(page, repo);
  await openFileByTree(page, "a.py");
  await openFileByTree(page, "b.py");
  await openFileByTree(page, "c.py"); // 激活 c（打开顺序 a,b,c）
  await expect(page.locator("#tabbar .tab.active"), "初始激活 c").toHaveText(/c\.py/);

  await page.keyboard.press("Control+Shift+Tab"); // c → b
  await expect.poll(() => activeTabName(page)).toBe("b.py");
  await page.keyboard.press("Control+Tab"); // b → c
  await expect.poll(() => activeTabName(page)).toBe("c.py");
  await page.keyboard.press("Control+Tab"); // c 环绕 → a
  await expect.poll(() => activeTabName(page)).toBe("a.py");
  await page.keyboard.press("Control+Shift+Tab"); // a 环绕回 → c
  await expect.poll(() => activeTabName(page)).toBe("c.py");
});

// ---------- UX-4：溢出滚入可视区 + 中键关闭 ----------

test("UX-4 激活标签滚入可视区；中键关闭标签", async ({ page }) => {
  test.setTimeout(60_000);
  page.setViewportSize({ width: 720, height: 600 }); // 压窄窗口制造标签栏溢出
  const files: Record<string, string> = {};
  for (let i = 1; i <= 8; i++) files[`t${i}.py`] = `x${i} = ${i}\n`;
  const repo = await makeGitRepo({ files, commitMsg: "baseline" });
  await boot(page, repo);
  for (let i = 1; i <= 8; i++) await openFileByTree(page, `t${i}.py`);

  // 打满 8 个标签后，激活的 t8 必须在标签栏可视区内（旧实现可能滚出屏外）
  await expect.poll(() =>
    page.evaluate(() => {
      const bar = document.getElementById("tabbar")!;
      const active = bar.querySelector<HTMLElement>(".tab.active");
      if (!active) return { barRight: 0, activeRight: 9999, overflow: false };
      const barRect = bar.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      return {
        barRight: barRect.right,
        activeRight: activeRect.right,
        overflow: bar.scrollWidth > bar.clientWidth,
        scrolled: bar.scrollLeft > 0,
      };
    }),
  ).toEqual(expect.objectContaining({ overflow: true, scrolled: true }));

  // 中键关闭第一个标签（position 定在名称区避开关闭按钮；未脏无确认弹窗）
  const before = await page.locator("#tabbar .tab").count();
  await page.locator("#tabbar .tab").first().click({ button: "middle", position: { x: 12, y: 10 } });
  await expect(page.locator("#tabbar .tab")).toHaveCount(before - 1);
  await expect(page.locator("#tabbar .tab", { hasText: "t1.py" })).toHaveCount(0);
});

// ---------- UX-5：git 改写工作区后 undo 栈保留 ----------

test("UX-5 git 丢弃块重载编辑器后 Ctrl+Z 可撤销重载", async ({ page }) => {
  const repo = await makeGitRepo({
    files: { "main.py": "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\nl15\n" },
    commitMsg: "baseline",
  });
  // 磁盘上两处改动（相隔 >6 行，两个独立 hunk）
  repo.write("main.py", "l1\nCHANGE-A\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\nCHANGE-B\n");
  await boot(page, repo);
  await openFileByTree(page, "main.py");

  // 打开 git 视图 → diff → 丢弃 CHANGE-B 块（复刻 E2E-16 流程；该路径走 reloadFileFromDisk）
  await page.locator("#tab-git").click();
  const item = page.locator("#git-changes .scm-item", { hasText: "main.py" });
  await expect(item).toHaveCount(1, { timeout: 10_000 });
  await item.click();
  await expect(page.locator("#git-diff-editor")).toContainText("CHANGE-B", { timeout: 10_000 });
  await page.locator("#git-diff-editor .view-line", { hasText: "CHANGE-B" }).last().click();
  await page.locator("#git-diff-hunk-discard").click();
  await page.locator("#confirm-ok").click();
  await expect(page.locator(".toast--success").first()).toBeVisible({ timeout: 10_000 });

  // 切回文件 tab：内容已同步（CHANGE-B 消失）
  await page.locator('#tabbar .tab[title*="main.py"]:not([title^="diff:"])').first().click();
  await expect(page.locator("#editor .monaco-editor")).toContainText("CHANGE-A", { timeout: 5_000 });
  await expect(page.locator("#editor .monaco-editor")).not.toContainText("CHANGE-B");

  // 核心断言：重载用 pushEditOperations（保 undo 栈）→ Ctrl+Z 撤销「重载」回到重载前内容
  // （旧实现 setValue 清空 undo 栈，Ctrl+Z 无效果）
  await page.locator("#editor .monaco-editor").click();
  await page.keyboard.press("Control+z");
  await expect(page.locator("#editor .monaco-editor")).toContainText("CHANGE-B", { timeout: 5_000 });
});

// ---------- UX-6/7：文件树 ----------

test("UX-6 文件树展开状态跨会话持久化；刷新后滚动位置恢复", async ({ page }) => {
  test.setTimeout(60_000);
  const files: Record<string, string> = {};
  for (let i = 0; i < 60; i++) files[`f${i}.py`] = `x = ${i}\n`; // 制造树滚动余量
  const repo = await makeGitRepo({ files, commitMsg: "baseline" });
  repo.write("pkg/sub/deep.py", "deep = 1\n");
  await boot(page, repo);

  // 展开 pkg → sub（单击目录 = 展开）
  await page.locator("#tree .tree-item.dir .name", { hasText: "pkg" }).first().click();
  await page.locator("#tree .tree-item.dir .name", { hasText: "sub" }).first().click();
  await expect(page.locator("#tree .tree-item", { hasText: "deep.py" })).toBeVisible({ timeout: 10_000 });

  // 滚动到中部后点刷新（重建 DOM），滚动位置应被恢复
  await page.evaluate(() => { (document.getElementById("tree") as HTMLElement).scrollTop = 700; });
  await page.locator("#btn-tree-refresh").click();
  await expect.poll(() =>
    page.evaluate(() => (document.getElementById("tree") as HTMLElement).scrollTop),
    { timeout: 10_000 },
  ).toBeGreaterThan(500);

  // 重启（reload）：pkg/sub 仍自动展开，deep.py 无需手动展开即可见
  await page.reload();
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await expect(page.locator("#tree .tree-item", { hasText: "deep.py" })).toBeVisible({ timeout: 15_000 });
});

test("UX-7 切标签时文件树自动跟随（可关开关）", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "a.py": "1\n", "b.py": "2\n", "c.py": "3\n" }, commitMsg: "baseline" });
  await boot(page, repo);

  // 默认开启：按钮 aria-pressed=true
  await expect(page.locator("#btn-tree-follow")).toHaveAttribute("aria-pressed", "true");

  // 依次打开三个文件（树里选中的自然是最後的 c.py），点 a.py 标签 → 树选中应跟随到 a.py
  await openFileByTree(page, "a.py");
  await openFileByTree(page, "b.py");
  await openFileByTree(page, "c.py");
  await page.locator("#tabbar .tab", { hasText: "a.py" }).first().click();
  await expect(page.locator('#tree .tree-item[aria-selected="true"]')).toHaveText(/a\.py/);

  // 关闭跟随 → 切 b.py 标签，树选中不再跟随（仍停在 a.py）
  await page.locator("#btn-tree-follow").click();
  await expect(page.locator("#btn-tree-follow")).toHaveAttribute("aria-pressed", "false");
  await page.locator("#tabbar .tab", { hasText: "b.py" }).first().click();
  await expect(page.locator('#tree .tree-item[aria-selected="true"]')).toHaveText(/a\.py/);

  // 开关偏好持久化：重启后仍是关闭态
  await page.reload();
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await expect(page.locator("#btn-tree-follow")).toHaveAttribute("aria-pressed", "false");
});

// ---------- UX-8：面板显隐持久化 ----------

test("UX-8 底部面板 / 侧栏视图 / 大纲折叠态跨会话持久化", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "a.py": "1\n" }, commitMsg: "baseline" });
  await boot(page, repo);

  // 大纲在 files 视图内（TD-001）：先在 files 视图折叠大纲，再切 git 视图
  await page.locator("#outline-header").click();
  await expect(page.locator("#outline-section")).toHaveClass(/collapsed/);
  await page.locator("#tab-git").click();
  await expect(page.locator("#view-git")).toBeVisible();
  // 折叠底部面板
  await page.locator("#btn-toggle-output").click();
  await expect(page.locator("#bottom")).toHaveClass(/collapsed/);

  // 重启：三项全部恢复
  await page.reload();
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await expect(page.locator("#bottom"), "底部面板保持折叠").toHaveClass(/collapsed/);
  await expect(page.locator("#view-git"), "侧栏保持 git 视图").toBeVisible();
  await expect(page.locator("#tab-git")).toHaveClass(/active/);
  await expect(page.locator("#outline-section"), "大纲保持折叠").toHaveClass(/collapsed/);
  // localStorage 落键
  const ls = await page.evaluate(() => ({
    bottom: localStorage.getItem("pylume.bottom_collapsed"),
    view: localStorage.getItem("pylume.sidebar_view"),
    outline: localStorage.getItem("pylume.outline_collapsed"),
  }));
  expect(ls).toEqual({ bottom: "1", view: "git", outline: "1" });
});

// ---------- UX-10：git 分组头「丢弃全部更改」一键批量 ----------

test("UX-10 更改分组头一键丢弃全部更改（含未跟踪文件）", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "a.py": "one\n", "b.py": "two\n" }, commitMsg: "baseline" });
  repo.write("a.py", "one-changed\n");
  repo.write("b.py", "two-changed\n");
  repo.write("c_new.py", "new = 1\n"); // 未跟踪文件：丢弃 = 删除
  await boot(page, repo);
  await openFileByTree(page, "a.py"); // 打开的编辑器应在丢弃后同步重载

  // 切到 git 视图（面板随视图渲染），更改分组头出现「丢弃全部更改」（↩）按钮
  // （按钮为 hover 显现范式，对标 VS Code SCM——先悬停分组头使其可见）
  await page.locator("#tab-git").click();
  const sectionTitle = page.locator(".git-section-title", { hasText: "更改" });
  await expect(sectionTitle).toBeVisible({ timeout: 10_000 });
  await sectionTitle.hover();
  const discardBtn = page.locator('.git-section-title .scm-section-action[data-tip="丢弃全部更改…"]');
  await expect(discardBtn).toBeVisible({ timeout: 10_000 });
  await discardBtn.click();
  await page.locator("#confirm-ok").click();

  await expect(page.locator(".toast--success").first()).toBeVisible({ timeout: 10_000 });
  // 已跟踪文件回退、未跟踪文件删除，工作区干净
  await expect.poll(async () => (await repo.git(["status", "--porcelain"])).trim(), { timeout: 10_000 }).toBe("");
  expect(repo.read("a.py")).toBe("one\n");
  expect(repo.read("b.py")).toBe("two\n");
  // 已打开的 a.py 编辑器同步重载
  await expect(page.locator("#editor .monaco-editor")).toContainText("one", { timeout: 5_000 });
  await expect(page.locator("#editor .monaco-editor")).not.toContainText("one-changed");
});

// ---------- UX-9：快速打开最近查询历史 ----------

test("UX-9 快速打开记录最近查询，输入为空时 ↑ 回溯", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "alpha.py": "1\n" }, commitMsg: "baseline" });
  await boot(page, repo);

  // 打开快速打开（文件模式），输入查询并回车生效
  await page.evaluate(async () => {
    const qo = (await import(/* @vite-ignore */ "/src/quickOpen.ts")) as any;
    await qo.openQuickOpen("files");
  });
  const input = page.locator("#quick-open-input");
  await expect(input).toBeFocused();
  await input.fill("alpha");
  await expect(page.locator(".quick-open-item", { hasText: "alpha.py" })).toBeVisible({ timeout: 10_000 });
  await input.press("Enter");
  await expect(page.locator("#tabbar .tab", { hasText: "alpha.py" })).toBeVisible({ timeout: 10_000 });

  // 再次打开（输入为空）→ ↑ 应回溯出上次查询
  await page.evaluate(async () => {
    const qo = (await import(/* @vite-ignore */ "/src/quickOpen.ts")) as any;
    await qo.openQuickOpen("files");
  });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("alpha");
});
