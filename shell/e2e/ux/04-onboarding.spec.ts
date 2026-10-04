/**
 * E2E：新手引导 + uv 速查卡（2026-09-30，docs/onboarding_dev_plan.md PR-S1/S2/S4）
 *
 *  - OG-1 帮助菜单「新手指南」→ md 落盘打开且预览含「uv 速查卡」标题
 *  - OG-2 欢迎页三步卡可见 + 指南链接可点
 *  - OG-3 有工作区时帮助菜单「欢迎页」→ overlay 完整版显示 → 点关闭恢复编辑器
 *  - OG-4 命令面板「新手指南」可达（打开指南）
 *  - OG-6 巡礼条目「试一下」（选 open_devtools）→ devtools 面板打开 + 条目变勾选 + 计数 1/6
 *  - OG-7 巡礼全部完成 → 折叠为一行 · 清 localStorage 后恢复
 *  - OG-8 问题面板空态改用 emptyState（断言含「ruff」教学文案）
 *  - OG-9 书签空态键位跟随（改键后文案变）
 *
 * mock 面：get_data_doc_path 双侧已映射（helpers plugins 通道），write_file 走 FS bridge 真实磁盘；
 * 落盘路径 = repo.root/docs/onboarding_guide.md（pluginsDir 未提供时）。
 * 注意：帮助菜单子菜单无 hover 竞态问题（help 一级即含「新手指南」，直接 click 菜单项）。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makeGitRepo, makePlainDir, type GitRepo } from "../helpers";

/** 启动到欢迎页（startEmpty：最近工作区为空 → 停在欢迎页）。
 *  #ew-new-project 可见只说明页面渲染，wireMenuBar / 键位接线 / 命令注册表在其后的 init 步骤——
 *  再等 invoke 流水出现 list_plugin_dirs（init 中段信号，plugins spec 同款等待）。 */
async function bootEmpty(page: Page, repo: GitRepo): Promise<void> {
  await equipPage(page, repo, { startEmpty: true });
  await page.goto("/");
  await expect(page.locator("#ew-new-project")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const log = (window as unknown as { __TAURI_MOCK_INVOKE_LOG__?: string[] }).__TAURI_MOCK_INVOKE_LOG__ ?? [];
          return log.some((x) => x.startsWith("list_plugin_dirs")) ? 1 : 0;
        }),
      { timeout: 20_000 },
    )
    .toBe(1);
}

/** 有工作区启动（默认路径：自动恢复最近工作区；等 Git 状态就绪 = init 后段完成） */
async function bootWorkspace(page: Page, repo: GitRepo): Promise<void> {
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
}

/** 点帮助菜单的指定项（menuBar 渲染的 #menu-dropdown，项 class .ctx-menu-item） */
async function clickHelpMenu(page: Page, itemText: string): Promise<void> {
  await page.locator('.menubar-item[data-menu="help"]').click();
  const item = page.locator('#menu-dropdown .ctx-menu-item', { hasText: itemText }).first();
  await expect(item).toBeVisible({ timeout: 5_000 });
  await item.click();
}

/** 经 state.ts 在页内执行源码（withApp 范式；参数须可序列化） */
function withApp(page: Page, src: string): Promise<unknown> {
  return page.evaluate(async (code) => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    return new Function("app", code)(app);
  }, src);
}

test.describe("OG-1/2：指南入口 + 欢迎页三步卡", () => {
  test("OG-1 帮助菜单「新手指南」→ md 打开且预览含「uv 速查卡」", async ({ page }) => {
    const repo = await makePlainDir({ "a.py": "x = 1\n" });
    await bootEmpty(page, repo);

    await clickHelpMenu(page, "新手指南");
    // 落盘 + 打开：.md tab 打开（预览开关默认关，先验证 tab 与内容到达）
    await expect(page.locator("#tabbar .tab.active .name", { hasText: "onboarding_guide.md" })).toBeVisible({ timeout: 15_000 });
    // 打开预览（方案A 开关按钮），断言渲染出 uv 速查卡标题
    await page.locator("#btn-md-preview").click();
    await expect(page.locator("#md-preview")).toBeVisible();
    await expect(page.locator("#md-preview")).toContainText("uv 速查卡", { timeout: 10_000 });
    // 磁盘落盘（write_file 走真实 FS bridge）
    expect(repo.read("docs/onboarding_guide.md")).toContain("uv 速查卡");
  });

  test("OG-2 欢迎页三步卡可见 + 指南链接可点", async ({ page }) => {
    const repo = await makePlainDir({ "a.py": "x = 1\n" });
    await bootEmpty(page, repo);

    // 三步卡：三张卡 + 键位标签（运行脚本 Ctrl+F10 / 启动调试 F5 出厂值）
    const steps = page.locator("#ew-quickstart-steps .ew-qs-step");
    await expect(steps).toHaveCount(3);
    await expect(page.locator("#ew-quickstart-steps .ew-qs-step", { hasText: "运行脚本" }).locator("kbd")).toHaveText("Ctrl+F10");
    await expect(page.locator("#ew-quickstart-steps .ew-qs-step", { hasText: "启动调试" }).locator("kbd")).toHaveText("F5");
    // 巡礼区：6 条 + 计数 0/6
    await expect(page.locator("#ew-tour-body .ew-tour-item")).toHaveCount(6);
    await expect(page.locator("#ew-tour-count")).toHaveText("0/6 已体验");
    // 指南链接可点 → 打开指南 tab
    await page.locator("#ew-guide-link").click();
    await expect(page.locator("#tabbar .tab.active .name", { hasText: "onboarding_guide.md" })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("OG-3：force-show 欢迎页（有工作区）", () => {
  test("帮助菜单「欢迎页」→ overlay 完整版 → 点关闭恢复编辑器", async ({ page }) => {
    const repo = await makeGitRepo({ files: { "a.py": "print('a')\n" }, commitMsg: "baseline" });
    await bootWorkspace(page, repo);
    // 打开一个文件（activeTab 存在 → overlay 隐藏）
    await page.locator("#tree .tree-item .name", { hasText: "a.py" }).first().dblclick();
    await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#editor-overlay")).toBeHidden();

    // force-show：完整版 overlay（actions + quickstart + tour 全显 + force-close 可见）
    await clickHelpMenu(page, "欢迎页");
    await expect(page.locator("#editor-overlay")).toBeVisible();
    await expect(page.locator("#ew-actions")).toBeVisible();
    await expect(page.locator("#ew-quickstart")).toBeVisible();
    await expect(page.locator("#ew-tour-section")).toBeVisible();
    await expect(page.locator("#ew-force-close")).toBeVisible();

    // 关闭 → 恢复编辑器（force 解除，activeTab 仍在）
    await page.locator("#ew-force-close").click();
    await expect(page.locator("#editor-overlay")).toBeHidden();
    await expect(page.locator(".monaco-editor")).toBeVisible();

    // 再点帮助菜单「欢迎页」（toggle 语义：置位后再点 = 解除）
    await clickHelpMenu(page, "欢迎页");
    await expect(page.locator("#editor-overlay")).toBeVisible();
    await clickHelpMenu(page, "欢迎页");
    await expect(page.locator("#editor-overlay")).toBeHidden();
  });

  test("OG-3b force 欢迎页下打开文件 → 覆盖层自动解除（文件不被挡住）", async ({ page }) => {
    const repo = await makeGitRepo({
      files: { "a.py": "print('a')\n", "b.py": "print('b')\n" },
      commitMsg: "baseline",
    });
    await bootWorkspace(page, repo);
    await page.locator("#tree .tree-item .name", { hasText: "a.py" }).first().dblclick();
    await expect(page.locator("#editor-overlay")).toBeHidden();

    // force-show 完整版欢迎页：整层盖在编辑器上（回归前提）
    await clickHelpMenu(page, "欢迎页");
    await expect(page.locator("#editor-overlay")).toBeVisible();

    // 文件树打开另一个文件：激活内容即解除 force，新文件必须可见（曾整层被挡住）
    await page.locator("#tree .tree-item .name", { hasText: "b.py" }).first().dblclick();
    await expect(page.locator("#editor-overlay")).toBeHidden();
    await expect(page.locator("#tabbar .tab.active .name", { hasText: "b.py" })).toBeVisible();
    await expect(page.locator(".monaco-editor")).toBeVisible();
  });
});

test.describe("OG-4：命令面板「新手指南」", () => {
  test("Search Everywhere 命令模式搜「新手指南」→ 打开指南", async ({ page }) => {
    const repo = await makePlainDir({ "a.py": "x = 1\n" });
    await bootEmpty(page, repo);

    // 命令面板直达（Ctrl+Shift+P）——浏览器键位由 browserKeys 护栏放行应用处理
    await page.keyboard.press("Control+Shift+P");
    await expect(page.locator("#quick-open-input")).toBeVisible({ timeout: 5_000 });
    await page.locator("#quick-open-input").fill("新手指南");
    const item = page.locator(".quick-open-item", { hasText: "新手指南" }).first();
    await expect(item).toBeVisible({ timeout: 5_000 });
    await item.click();
    await expect(page.locator("#tabbar .tab.active .name", { hasText: "onboarding_guide.md" })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("OG-6/7：功能巡礼", () => {
  test.beforeEach(async ({ page }) => {
    // 清巡礼完成态（localStorage 持久化，跨用例不污染）
    await page.addInitScript(() => {
      try {
        for (const k of Object.keys(localStorage)) if (k.startsWith("pylume.tour.")) localStorage.removeItem(k);
      } catch { /* 忽略 */ }
    });
  });

  test("OG-6 巡礼「试一下」（open_devtools）→ 面板打开 + 勾选 + 计数 1/6", async ({ page }) => {
    const repo = await makePlainDir({ "a.py": "x = 1\n" });
    await bootEmpty(page, repo);

    // 点击 open_devtools 条目的「试一下」→ devtools 面板（picker）打开
    const row = page.locator("#ew-tour-body .ew-tour-item", { hasText: "工具箱" });
    await row.locator(".btn", { hasText: "试一下" }).click();
    await expect(page.locator("#devtools-picker")).toBeVisible({ timeout: 5_000 });
    // 条目变勾选（done 类）+ 计数 1/6
    await expect(row).toHaveClass(/done/);
    await expect(page.locator("#ew-tour-count")).toHaveText("1/6 已体验");
    // localStorage 已持久化
    const stored = await page.evaluate(() => localStorage.getItem("pylume.tour.open_devtools"));
    expect(stored).toBe("1");
  });

  test("OG-7 全部完成 → 折叠为一行 · 重置后恢复", async ({ page }) => {
    const repo = await makePlainDir({ "a.py": "x = 1\n" });
    await bootEmpty(page, repo);

    // 直接经页内 API 标记全部完成 + 重渲（6 条逐一「试一下」会真的开 6 个面板，不适合 e2e）
    await page.evaluate(async () => {
      const wg = (await import(/* @vite-ignore */ "/src/welcomeGuide.ts")) as any;
      for (const t of wg.TOUR_ITEMS) localStorage.setItem(`pylume.tour.${t.quickOpenId}`, "1");
      wg.renderTour();
    });
    await expect(page.locator("#ew-tour-count")).toHaveText("6/6 已体验");
    // 全部完成条目淡化 + 勾选
    await expect(page.locator("#ew-tour-body .ew-tour-item.done")).toHaveCount(6);

    // 「全部完成，收起」→ 折叠为一行（collapsed 类 + body/foot 被 CSS 隐藏，DOM 不重建）
    await page.locator("#ew-tour-foot .ew-tour-fold", { hasText: "全部完成，收起" }).click();
    await expect(page.locator("#ew-tour-section")).toHaveClass(/collapsed/);
    await expect(page.locator("#ew-tour-body")).toBeHidden();
    await expect(page.locator("#ew-tour-foot")).toBeHidden();

    // 「重新体验」重置入口：折叠态标题行点击展开 → foot 出现「重新体验」→ 点击后全部恢复未完成
    await page.locator("#ew-tour-header").click();
    await expect(page.locator("#ew-tour-section")).not.toHaveClass(/collapsed/);
    await expect(page.locator("#ew-tour-body .ew-tour-item").first()).toBeVisible();
    await page.locator("#ew-tour-foot .ew-tour-fold", { hasText: "重新体验" }).click();
    await expect(page.locator("#ew-tour-count")).toHaveText("0/6 已体验");
    await expect(page.locator("#ew-tour-body .ew-tour-item.done")).toHaveCount(0);

    // 不感兴趣收起：点击后折叠，计数保持
    await page.locator("#ew-tour-foot .ew-tour-fold", { hasText: "不感兴趣，收起" }).click();
    await expect(page.locator("#ew-tour-section")).toHaveClass(/collapsed/);
    await expect(page.locator("#ew-tour-count")).toHaveText("0/6 已体验");
  });
});

test.describe("OG-8/9：空状态（S4）", () => {
  test("OG-8 问题面板空态含「ruff」教学文案", async ({ page }) => {
    const repo = await makePlainDir({ "a.py": "x = 1\n" });
    await equipPage(page, repo);
    await page.goto("/");
    await page.locator("#tree .tree-item .name", { hasText: "a.py" }).first().dblclick();
    await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });

    // 打开问题面板（无 marker → 空态）
    await page.locator("#tab-problems").click();
    await expect(page.locator("#problems-panel")).toBeVisible();
    await expect(page.locator("#problems-panel .empty-state")).toContainText("没有发现问题");
    await expect(page.locator("#problems-panel .empty-state")).toContainText("ruff");
  });

  test("OG-9 书签空态键位跟随（改键后文案变）", async ({ page }) => {
    const repo = await makePlainDir({ "a.py": "x = 1\n" });
    await equipPage(page, repo);
    await page.goto("/");
    // 等 init 完成（书签 modal 由 initBookmarks 建立；书签弹窗是 wireBookmarks 动态创建的 host）
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const log = (window as unknown as { __TAURI_MOCK_INVOKE_LOG__?: string[] }).__TAURI_MOCK_INVOKE_LOG__ ?? [];
            return log.some((x) => x.startsWith("list_plugin_dirs")) ? 1 : 0;
          }),
        { timeout: 20_000 },
      )
      .toBe(1);

    // 改 bookmark_toggle 键位 → 渲染书签列表空态 → 文案带新键
    await withApp(page, "app.settings.keybindings.bookmark_toggle = 'Ctrl+Alt+B';");
    await page.evaluate(async () => {
      const b = (await import(/* @vite-ignore */ "/src/bookmarks.ts")) as any;
      await b.openBookmarks();
    });
    const empty = page.locator(".empty-state", { hasText: "暂无书签" }).last();
    await expect(empty).toBeVisible({ timeout: 5_000 });
    await expect(empty).toContainText("Ctrl+Alt+B");
    await expect(empty).not.toContainText("Ctrl+F11");
  });
});
