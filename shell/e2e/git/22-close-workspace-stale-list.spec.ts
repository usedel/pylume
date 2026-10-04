/**
 * 回归：关闭工作区后的 UI 残留清理（用户报告 2026-09-30 + 同轮审计）。
 *
 * 用户报告原案：git 面板显示更改记录时执行「关闭工作区」，面板不刷新，
 * 旧更改列表残留。根因：resetGitState 只清内存不重渲染，而 renderGitPanel
 * 的既有触发点（onShow / 刷新按钮 / fs-changed / git 写操作）在「工作区已关、
 * 用户停在 git 面板不动」时全都不发生。
 *
 * 同轮审计一并覆盖的回归点：
 *  - git 子 tab 互斥复位（停在历史/贮藏页关工作区，重开工作区后 changes 仍 hidden 的隐性破坏）
 *  - 提交框草稿清理（git-commit-msg 残留旧信息）
 *  - 分支条复位（git-branch-current 显示 "—"）
 *  - 调试控制台清空（clearDebugConsole 此前零调用，onShow 不覆盖）
 *  - 搜索文件掩码复位（search-mask 残留会让新工作区首次搜索被旧掩码静默过滤）
 *  - 底部面板辅助元素显隐（终端 tab 激活时关工作区 → 输出 chips 不出现/终端下拉残留）
 *  - 问题面板同步清空（此前靠 marker 事件 500ms 防抖间接兜底）
 *  - 工作区级弹层收口（quickOpen 等；本文件验 debug 控制台与底部面板，弹层走断言可见性）
 */
import { test, expect } from "@playwright/test";
import { equipPage, makeGitRepo } from "../helpers";
import { writeFileSync } from "node:fs";

test.describe("关闭工作区后 git 面板残留旧更改列表", () => {
  test("git 面板可见时关闭工作区 → #git-changes 清空且显示无工作区空态", async ({ page }) => {
    const repo = await makeGitRepo({
      files: { "app.py": "print('base')\n" },
      commitMsg: "base",
    });
    // 制造工作区更改（1 个修改 + 1 个未跟踪）
    writeFileSync(`${repo.root}\\app.py`, "print('changed')\n");
    writeFileSync(`${repo.root}\\new_file.py`, "x = 1\n");

    await equipPage(page, repo);
    await page.goto("/");

    // 等 git 状态就绪：状态栏分支名出现（临时仓库默认分支 main/master，不硬编码）
    await expect
      .poll(async () => (await page.locator("#status-git").textContent())?.trim() ?? "", { timeout: 15_000 })
      .not.toBe("");

    // 切到 git 侧栏视图（左侧活动栏 tab）
    await page.locator("#tab-git").click();
    await expect(page.locator("#view-git")).toBeVisible();

    // 等待变更列表渲染出条目
    await expect(page.locator("#git-changes .scm-item").first()).toBeVisible({ timeout: 15_000 });
    const before = await page.locator("#git-changes .scm-item").count();
    expect(before).toBeGreaterThan(0);

    // 在提交框写入草稿（验证关闭时被清理）
    await page.locator("#git-commit-msg").fill("未提交的草稿信息");

    // 切到贮藏子 tab（验证关闭时子 tab 互斥复位）
    await page.locator("#git-subtab-stash").click();
    await expect(page.locator("#git-stash-panel")).toBeVisible();

    // 菜单「文件 → 关闭工作区」
    await page.locator('.menubar-item[data-menu="file"]').click();
    await page.locator("#menu-dropdown").getByText("关闭工作区").click();

    // 等工作区真正关掉
    await expect(page.locator("#tree-header-text")).toHaveText("文件");
    await expect(page.locator("#status-git")).toHaveText("");

    // 核心断言：#git-changes 不残留 .scm-item，且呈现无工作区空态
    await expect(page.locator("#git-changes .scm-item")).toHaveCount(0);
    // closeWorkspace 在 root 置 null 后补了终态渲染，文案是「尚未打开工作区」
    //（teardown 中途的「不是 Git 仓库」只是过渡态）
    await expect(page.locator("#git-changes")).toContainText("尚未打开工作区");
    // 子 tab 复位：changes 区可见、stash 区隐藏（重开工作区不会留旧互斥态）
    await expect(page.locator("#git-changes")).toBeVisible();
    await expect(page.locator("#git-stash-panel")).toBeHidden();
    // 提交框草稿清理
    await expect(page.locator("#git-commit-msg")).toHaveValue("");
    // 分支条复位为占位符
    await expect(page.locator("#git-branch-current")).toHaveText(/—/);
  });

  test("终端 tab 激活时关闭工作区 → 底部面板复位到输出 tab 且辅助元素显隐正确", async ({ page }) => {
    const repo = await makeGitRepo({
      files: { "app.py": "print('base')\n" },
      commitMsg: "base",
    });
    await equipPage(page, repo);
    await page.goto("/");
    await expect
      .poll(async () => (await page.locator("#status-git").textContent())?.trim() ?? "", { timeout: 15_000 })
      .not.toBe("");

    // 打开终端 tab（触发 PTY 会话）再关闭工作区
    await page.locator("#tab-terminal").click();
    await expect(page.locator("#terminal-panel")).toBeVisible({ timeout: 10_000 });

    await page.locator('.menubar-item[data-menu="file"]').click();
    await page.locator("#menu-dropdown").getByText("关闭工作区").click();
    await expect(page.locator("#tree-header-text")).toHaveText("文件");

    // 底部面板复位到输出 tab：输出区可见、终端区隐藏
    await expect(page.locator("#output")).toBeVisible();
    await expect(page.locator("#terminal-panel")).toBeHidden();
    // 辅助元素显隐与 setBottomTab("output") 同口径：
    // 输出过滤 chips 出现、级别 chips 按设置、终端命令下拉隐藏
    await expect(page.locator("#output-channels")).toBeVisible();
    await expect(page.locator("#terminal-cmd")).toBeHidden();
  });

  test("调试侧栏与搜索视图在关闭工作区后不残留旧内容", async ({ page }) => {
    const repo = await makeGitRepo({
      files: { "app.py": "print('base')\n" },
      commitMsg: "base",
    });
    await equipPage(page, repo);
    await page.goto("/");
    await expect
      .poll(async () => (await page.locator("#status-git").textContent())?.trim() ?? "", { timeout: 15_000 })
      .not.toBe("");

    // 搜索视图：填入掩码（验证复位）
    await page.locator("#tab-search").click();
    await page.locator("#search-mask").fill("*.py");
    // change 事件才触发内存同步——blur 模拟 change
    await page.locator("#search-mask").blur();

    // 调试侧栏：控制台区存在（initDebugConsole 已挂载）
    await page.locator("#tab-debug").click();
    await expect(page.locator("#debug-console-log")).toBeVisible();

    await page.locator('.menubar-item[data-menu="file"]').click();
    await page.locator("#menu-dropdown").getByText("关闭工作区").click();
    await expect(page.locator("#tree-header-text")).toHaveText("文件");

    // 搜索掩码复位
    await page.locator("#tab-search").click();
    await expect(page.locator("#search-mask")).toHaveValue("");
    // 调试控制台清空（clearDebugConsole）——无残留行
    await page.locator("#tab-debug").click();
    await expect(await page.locator("#debug-console-log").textContent()).toBe("");
  });

  test("切换工作区（A→B）时停留在 git 视图 → 面板刷新为新仓库数据", async ({ page }) => {
    const repoA = await makeGitRepo({ files: { "a.py": "print('a')\n" }, commitMsg: "base-a" });
    writeFileSync(`${repoA.root}\\a.py`, "print('a-changed')\n");

    await equipPage(page, repoA);
    await page.goto("/");
    await expect
      .poll(async () => (await page.locator("#status-git").textContent())?.trim() ?? "", { timeout: 15_000 })
      .not.toBe("");

    // 停在 git 视图，确认 A 的更改条目已渲染
    await page.locator("#tab-git").click();
    await expect(page.locator("#git-changes .scm-item").first()).toBeVisible({ timeout: 15_000 });
    expect(await page.locator("#git-changes .scm-item").count()).toBeGreaterThan(0);

    // 动态把 recentWorkspaces 换成 B（equipPage 暴露的 __E2E_BRIDGE__ 通道），
    // 经菜单「最近的工作区」打开 B —— 走 openWorkspace 真实切换链路
    const repoB = await makeGitRepo({ files: { "b.py": "print('b')\n" }, commitMsg: "base-b" });
    await page.evaluate(async (rootB) => {
      const b = (window as { __E2E_BRIDGE__?: (ch: string, cmd: unknown, args: unknown) => Promise<unknown> }).__E2E_BRIDGE__;
      await b?.("setRecentWorkspaces", [rootB], null);
    }, repoB.root);

    await page.locator('.menubar-item[data-menu="file"]').click();
    // 子菜单父项：点击展开（hover 有 200ms 延时 + mouseleave 关闭竞态，click 是同步切换更稳）
    await page.locator("#menu-dropdown .ctx-menu-item.with-submenu", { hasText: "最近的工作区" }).click();
    // 菜单项（menuBar.ts openSubmenu 渲染）：.ctx-menu-item > .sub-label（basename）+
    // .sub-detail（全路径）。裸 getByText 会命中两个 span（strict 歧义），按 .sub-label 定位。
    await page.locator("#menu-submenu .ctx-menu-item .sub-label", { hasText: repoB.root.split(/[\\/]/).pop() ?? "" })
      .click();

    // B 打开完成：状态栏出现 B 的分支
    await expect
      .poll(async () => (await page.locator("#status-git").textContent())?.trim() ?? "", { timeout: 20_000 })
      .toContain("main");
    await page.waitForTimeout(1_500); // 等 openWorkspace 尾部刷新链落地

    // git 视图全程未切走：面板应为 B 的数据（b.py 无更改 → 空态「无更改」），不残留 A 的条目
    await expect(page.locator("#git-changes .scm-item")).toHaveCount(0);
    await expect(page.locator("#git-changes")).toContainText("无更改");
  });
});
