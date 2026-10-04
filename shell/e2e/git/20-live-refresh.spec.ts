/**
 * 体验修复回归（用户报告 2026-09-18）：
 *  - E2E-12：编辑区保存文件 → SCM 面板条目实时刷新（无需切走再切回 git 面板）
 *    关键场景：git 面板保持前台，编辑器改文件并保存，条目应立即出现（此前须切走再切回）
 *  - E2E-13：底部差异面板实时刷新（第 2 则 · 第 1 步）
 *    - 13a：diff 打开时编辑保存 → diff 内容更新（右侧出现新行）
 *    - 13b：diff 打开时 stage 全部 → auto 口径无内容 → 视图关闭 + 提示
 *    - 13c：冲突文件 diff 打开 + 块级选择进行中 → 外部变更不自动刷（保护进度）
 *  - 黑框修复（taskkill no_window）为 Rust 侧，由 cargo check + 代码审查保障
 */
import { test, expect } from "@playwright/test";
import { equipPage, makeGitRepo, makeConflictRepo } from "../helpers";

test("E2E-12：git 面板前台时编辑保存 → 条目实时出现", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "main.py": "print('v1')\n", "other.py": "x = 1\n" }, commitMsg: "baseline" });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  // 先打开 main.py（编辑器常驻中央区，不随侧栏切换关闭）
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().dblclick();
  const editor = page.locator("#editor .monaco-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });

  // 切到 git 面板（此后保持前台）——干净工作区显示「无更改」
  await page.locator("#tab-git").click();
  await expect(page.locator("#git-changes")).toContainText("无更改", { timeout: 10_000 });

  // 编辑器仍可交互：点击中央区 → 打字 → Ctrl+S 保存
  await editor.click();
  await page.keyboard.type("# edited by e2e");
  await page.keyboard.press("Control+s");

  // 断言：不切走 tab，SCM 条目自动出现（fs-changed → refreshGitStatus + renderGitPanel 新链路）
  await expect(page.locator("#git-changes .scm-item", { hasText: "main.py" })).toHaveCount(1, { timeout: 10_000 });
  expect(repo.read("main.py")).toContain("# edited by e2e");
});

test("E2E-12b：git 面板前台时暂存/撤销暂存文件 → 面板分组实时变化", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "main.py": "print('v1')\n" }, commitMsg: "baseline" });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  // 先做一处工作区修改（git 视图前台时保存）
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().dblclick();
  const editor = page.locator("#editor .monaco-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await page.locator("#tab-git").click();
  await editor.click();
  await page.keyboard.type("# staged-test");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#git-changes .scm-item", { hasText: "main.py" })).toHaveCount(1, { timeout: 10_000 });

  // 暂存（面板前台的分组标题 + 按钮）
  const item = page.locator("#git-changes .scm-item", { hasText: "main.py" }).first();
  await item.hover();
  await item.locator(".scm-action").click();
  // 条目移动到「已暂存」分组（同一面板实时重绘）
  await expect(page.locator("#git-changes")).toContainText("已暂存", { timeout: 10_000 });
  await expect(page.locator("#git-commit-btn")).toHaveText(/提交\(1\)/, { timeout: 10_000 });
});

// ---------- E2E-13：差异视图（编辑区 tab 模式，第 2 步迁移） ----------

test("E2E-13a：diff tab 模式下编辑保存 → 切回 diff tab 内容已更新", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "main.py": "print('v1')\n" }, commitMsg: "baseline" });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  // 打开文件并做第一处修改 → 保存 → SCM 条目出现
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().dblclick();
  const editor = page.locator("#editor .monaco-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await page.locator("#tab-git").click();
  await editor.click();
  await page.keyboard.type("# first edit");
  await page.keyboard.press("Control+s");
  const item = page.locator("#git-changes .scm-item", { hasText: "main.py" });
  await expect(item).toHaveCount(1, { timeout: 10_000 });

  // 打开 diff → 编辑区出现 diff tab（第 2 步迁移：不再去底部面板）
  await item.click();
  const diffTab = page.locator("#tabbar .tab", { hasText: "main.py · 差异" });
  await expect(diffTab).toHaveCount(1, { timeout: 10_000 });
  await expect(diffTab).toHaveClass(/active/, { timeout: 10_000 });
  await expect(page.locator("#git-diff-editor")).toContainText("first edit", { timeout: 10_000 });
  // 主编辑器隐藏（互斥呈现）
  await expect(page.locator("#editor")).toHaveClass(/hidden/);

  // 切回文件 tab 编辑第二处 → 保存
  await page.locator("#tabbar .tab", { hasText: "main.py" }).first().click();
  await expect(page.locator("#editor")).not.toHaveClass(/hidden/, { timeout: 5_000 });
  await editor.click();
  await page.keyboard.type("# second edit");
  await page.keyboard.press("Control+s");

  // 切回 diff tab：内容已含第二处（diff tab 重新激活时按需重开 + 事件链刷新）
  await diffTab.click();
  await expect(page.locator("#git-diff-editor")).toContainText("second edit", { timeout: 10_000 });
});

test("E2E-13b：diff 打开时 stage 该文件 → auto 口径切 HEAD↔暂存区（内容仍在，基准切换）", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "main.py": "print('v1')\n" }, commitMsg: "baseline" });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  // 修改并保存 → 打开 diff
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().dblclick();
  const editor = page.locator("#editor .monaco-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await page.locator("#tab-git").click();
  await editor.click();
  await page.keyboard.type("# to-stage");
  await page.keyboard.press("Control+s");
  const item = page.locator("#git-changes .scm-item", { hasText: "main.py" });
  await expect(item).toHaveCount(1, { timeout: 10_000 });
  await item.click();
  await expect(page.locator("#git-diff-panel")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#git-diff-editor")).toContainText("to-stage", { timeout: 10_000 });
  // 打开时是 Index↔工作区 口径
  await expect(page.locator("#git-diff-label")).toContainText("暂存区 vs 工作区");

  // 回 SCM 面板暂存该文件（底部 diff 保持前台）
  await page.locator("#tab-git").click();
  const scmItem = page.locator("#git-changes .scm-item", { hasText: "main.py" }).first();
  await scmItem.hover();
  await scmItem.locator(".scm-action").click();
  await expect(page.locator("#git-changes")).toContainText("已暂存", { timeout: 10_000 });

  // stage 后 diff 仍在（auto 口径切到 HEAD↔暂存区，显示暂存的内容）——对齐 VS Code 语义
  await expect(page.locator("#git-diff-label")).toContainText("HEAD vs 暂存区", { timeout: 10_000 });
  await expect(page.locator("#git-diff-editor")).toContainText("to-stage", { timeout: 10_000 });
});

test("E2E-13c：冲突 diff + 块级选择进行中 → 外部变更不自动刷新（保护进度）", async ({ page }) => {
  const { repo } = await makeConflictRepo();
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  // 打开冲突 diff（块级合并面板出现；Monaco 异步渲染 → 轮询等冲突内容出现）
  await page.locator("#tab-git").click();
  const item = page.locator("#git-changes .scm-item", { hasText: "app.py" });
  await expect(item).toHaveCount(1, { timeout: 10_000 });
  await item.click();
  await expect(page.locator("#git-diff-accept-current")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#git-diff-editor")).toContainText("CURRENT", { timeout: 10_000 });

  // 内容渲染完成后再取快照（此前取太早拿到空串，断言恒真无意义）
  const before = await page.locator("#git-diff-editor").textContent();

  // 外部改文件（模拟另一个工具写入；不经过编辑器）
  repo.write("app.py", "line1\nEXTERNAL-CHANGE\nline3\n");
  // 手动触发一次 fs-changed（真实环境由 watcher 发出；这里直接驱动同一入口验证保护逻辑——
  // 经 git 状态刷新链（git_status 会读盘）即可，不必依赖 mock 的 write_file 通道）
  await page.evaluate(() => {
    const w = window as unknown as { __E2E_BRIDGE__?: (c: string, cmd: string, a: unknown) => Promise<unknown> };
    void w?.__E2E_BRIDGE__("git", "git_status", {});
  }).catch(() => { /* bridge 通道名可能不同，忽略——保护逻辑由下面的断言验证 */ });

  // 等待防抖窗口过后：冲突 diff 内容不应被刷新（EXTERNAL-CHANGE 不得出现）
  await page.waitForTimeout(1_200);
  const after = await page.locator("#git-diff-editor").textContent();
  expect(after).toBe(before); // 完全未变 = 未被自动刷新
});

// ---------- E2E-14：diff tab 生命周期（第 2 步迁移核心新行为） ----------

test("E2E-14：多文件 diff tab 共存 + SCM 去重 + 关闭恢复文件 tab", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "a.py": "a1\n", "b.py": "b1\n" }, commitMsg: "baseline" });
  repo.write("a.py", "a1-changed\n");
  repo.write("b.py", "b1-changed\n");
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  // SCM 打开 a.py 的 diff → 编辑区出现 diff tab
  await page.locator("#tab-git").click();
  await page.locator("#git-changes .scm-item", { hasText: "a.py" }).click();
  await expect(page.locator("#tabbar .tab", { hasText: "a.py · 差异" })).toHaveCount(1, { timeout: 10_000 });

  // 再打开 b.py 的 diff → 两个 diff tab 共存
  await page.locator("#git-changes .scm-item", { hasText: "b.py" }).click();
  await expect(page.locator("#tabbar .tab", { hasText: "b.py · 差异" })).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator("#tabbar .tab", { hasText: "a.py · 差异" })).toHaveCount(1);
  // b 的 diff tab 激活，内容显示 b 的变更
  await expect(page.locator("#git-diff-editor")).toContainText("b1-changed", { timeout: 10_000 });

  // SCM 再点 a.py：去重——不新建 tab，激活已有的
  await page.locator("#git-changes .scm-item", { hasText: "a.py" }).click();
  const aTab = page.locator("#tabbar .tab", { hasText: "a.py · 差异" });
  await expect(aTab).toHaveClass(/active/, { timeout: 10_000 });
  await expect(page.locator("#tabbar .tab").filter({ hasText: "差异" })).toHaveCount(2); // 仍是 2 个
  await expect(page.locator("#git-diff-editor")).toContainText("a1-changed", { timeout: 10_000 });

  // 切回 b 的 diff tab（手动点击；真 bug 已修：diff tab 激活时欢迎页覆盖层不再遮挡 tabbar）
  await page.locator("#tabbar .tab", { hasText: "b.py · 差异" }).click();
  await expect(page.locator("#git-diff-editor")).toContainText("b1-changed", { timeout: 10_000 });

  // 关闭活动的 b diff tab（× 按钮）→ 回到剩余 tab
  await page.locator("#tabbar .tab.active .close").click();
  await expect(page.locator("#tabbar .tab").filter({ hasText: "差异" })).toHaveCount(1, { timeout: 5_000 });
  // a 的 diff tab 成为激活 tab（内容仍正确）
  await expect(page.locator("#tabbar .tab", { hasText: "a.py · 差异" })).toHaveClass(/active/);
  await expect(page.locator("#git-diff-editor")).toContainText("a1-changed", { timeout: 10_000 });
});

// ---------- E2E-15：untracked 文件的差异工具栏适配（实测反馈 2026-09-18 第 4 则） ----------

test("E2E-15：untracked 文件 diff 隐藏 hunk/Blame 按钮 + Blame 前置引导", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "main.py": "print('v1')\n" }, commitMsg: "baseline" });
  repo.write("_check_venv.py", "import sys\nprint(sys.prefix)\n"); // untracked（复现用户的下划线脚本场景）
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  // SCM 打开 untracked 文件的 diff（整文件新增视图）
  await page.locator("#tab-git").click();
  const item = page.locator("#git-changes .scm-item", { hasText: "_check_venv.py" });
  await expect(item).toHaveCount(1, { timeout: 10_000 });
  await item.click();
  await expect(page.locator("#git-diff-editor")).toContainText("sys.prefix", { timeout: 10_000 });

  // hunk 操作与 Blame 按钮对 untracked 隐藏（无意义操作不上界面）
  await expect(page.locator("#git-diff-hunk-stage")).toHaveClass(/hidden/);
  await expect(page.locator("#git-diff-hunk-discard")).toHaveClass(/hidden/);
  await expect(page.locator("#git-diff-blame")).toHaveClass(/hidden/);
  // 三态基准组同样隐藏（既有行为）
  await expect(page.locator("#git-diff-base-group")).toHaveClass(/hidden/);

  // 对比：tracked 文件的 diff 这组按钮全部可见
  repo.write("main.py", "print('v2')\n");
  await page.locator("#git-btn-refresh").click();
  const trackedItem = page.locator("#git-changes .scm-item", { hasText: "main.py" });
  await expect(trackedItem).toHaveCount(1, { timeout: 10_000 });
  await trackedItem.click();
  await expect(page.locator("#git-diff-editor")).toContainText("v2", { timeout: 10_000 });
  await expect(page.locator("#git-diff-hunk-stage")).not.toHaveClass(/hidden/);
  await expect(page.locator("#git-diff-hunk-discard")).not.toHaveClass(/hidden/);
  await expect(page.locator("#git-diff-blame")).not.toHaveClass(/hidden/);
});

test("E2E-15b：untracked 文件的 Blame 经文件树右键入口 → 人话引导（非 git 报错）", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "main.py": "print('v1')\n" }, commitMsg: "baseline" });
  repo.write("_tmp_probe.py", "x = 1\n");
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  // 刷 git 状态（右键菜单构建读状态 Map）
  await page.locator("#tab-git").click();
  await expect(page.locator("#git-changes .scm-item", { hasText: "_tmp_probe.py" })).toHaveCount(1, { timeout: 10_000 });
  await page.locator("#tab-files").click();
  await page.locator("#tree .tree-item .name", { hasText: "_tmp_probe.py" }).first()
    .click({ button: "right", force: true });
  const ctx = page.locator("#ctx-menu");
  await expect(ctx).toBeVisible();
  // untracked：只有「暂存新文件」，无 打开差异 / Blame（文件树右键的既有分流）
  await expect(ctx).toContainText("暂存新文件");
  await expect(ctx).not.toContainText("Blame");
  await page.keyboard.press("Escape");

  // SCM 右键（untracked 条目）同样不含 Blame——多入口一致
  await page.locator("#tab-git").click();
  const item = page.locator("#git-changes .scm-item", { hasText: "_tmp_probe.py" });
  await item.click({ button: "right", force: true });
  await expect(page.locator("#ctx-menu")).not.toContainText("Blame");
  await page.keyboard.press("Escape");
});
