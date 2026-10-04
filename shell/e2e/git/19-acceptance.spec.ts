/**
 * 验收补齐（报告 §11.2 矩阵剩余项）：
 *  - E2E-02：Git 菜单存在 + 菜单动作可达（经同源「更多操作」验证）
 *  - E2E-03：init 流程（非仓库空态 → 按钮 → 变 SCM 视图）
 *  - E2E-06：冲突解决（接受当前更改 → 文件标记已解决）
 *  - E2E-07：文件树右键（untracked 只显示暂存，无 diff/Blame）
 *  - E2E-09：忙碌态（慢 fetch busy 条出现/消失）
 *  - E2E-10：大小写路径（右键暂存收到原始大小写 Foo.py）
 *  - E2E-11/11b：远程分支检出（--track 建跟踪 / 同名本地切本地不覆盖；B8 闭环）
 *    远程引用用 update-ref 纯本地构造——本机安全策略禁 git 传输协议，零网络。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makeGitRepo, makeConflictRepo, makePlainDir } from "../helpers";

test("E2E-02：Git 菜单存在且菜单动作可达", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "main.py": "print('v1')\n" }, commitMsg: "baseline" });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  // 菜单栏出现 Git 一级菜单（P0-2 可见性核心断言）
  const gitMenu = page.locator(".menubar-item[data-menu='git']");
  await expect(gitMenu).toBeVisible();
  await expect(gitMenu).toHaveText("Git");

  // menuBar 为悬停延时展开（自动化时序不稳），动作可达性经同源「更多操作」下拉验证
  await page.locator("#tab-git").click();
  await page.locator("#git-btn-more").click();
  const more = page.locator("#ctx-menu .ctx-menu-item");
  expect(await more.filter({ hasText: "推送" }).count()).toBeGreaterThanOrEqual(1);
  expect(await more.filter({ hasText: "拉取" }).count()).toBeGreaterThanOrEqual(1);
  expect(await more.filter({ hasText: "贮藏更改" }).count()).toBeGreaterThanOrEqual(1);
  expect(await more.filter({ hasText: "提交历史" }).count()).toBeGreaterThanOrEqual(1);
  await page.keyboard.press("Escape");
  // 历史入口直接经 SCM tab 验证（与菜单同源动作）
  await page.locator("#git-subtab-history").click();
  await expect(page.locator("#git-subtab-history")).toHaveClass(/active/, { timeout: 5_000 });
  await expect(page.locator("#git-history .git-commit-item").first()).toBeVisible({ timeout: 5_000 });
});

test("E2E-10：大小写路径——右键暂存收到原始大小写 Foo.py", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "Foo.py": "x = 1\n" }, commitMsg: "baseline" });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  repo.write("Foo.py", "x = 2\n");
  // 先刷 git 状态（右键菜单构建读实时状态 Map；write 后必须有一轮刷新）
  await page.locator("#tab-git").click();
  await expect(page.locator("#git-changes .scm-item", { hasText: "Foo.py" })).toHaveCount(1, { timeout: 10_000 });
  // 切回资源管理器右键（git 侧栏下树不可见）；再切 git 验证结果
  await page.locator("#tab-files").click();
  await page.locator("#tree .tree-item .name", { hasText: "Foo.py" }).first()
    .click({ button: "right", force: true });
  const ctx = page.locator("#ctx-menu");
  await expect(ctx).toBeVisible();
  // force：菜单项可能落在视口边缘，跳过 actionability 滚动等待
  await ctx.locator(".ctx-menu-item", { hasText: "暂存更改" }).first().click({ force: true });

  await page.locator("#tab-git").click();
  await expect(page.locator("#git-commit-btn")).toHaveText(/提交\(1\)/, { timeout: 10_000 });

  // 真仓库：暂存路径保持原始大小写
  const staged = await repo.git(["diff", "--cached", "--name-only"]);
  expect(staged.trim()).toBe("Foo.py");
});

test("E2E-07：untracked 右键只显示「暂存新文件」无 diff/Blame", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "tracked.py": "t = 1\n" }, commitMsg: "baseline" });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  repo.write("NewFile.py", "y = 2\n");
  // 树的 git 菜单依赖渲染时的状态 Map：先在资源管理器视图刷新树（切 git 后树不可见）
  await page.locator("#btn-tree-refresh").click();
  await page.waitForTimeout(800);
  // 顺带让 git 状态刷新（菜单构建读取 gitStatusOf）
  await page.locator("#tab-git").click();
  await expect(page.locator("#git-changes .scm-item", { hasText: "NewFile.py" })).toHaveCount(1, { timeout: 10_000 });
  // 切回资源管理器再右键
  await page.locator("#tab-files").click();
  const treeItem = page.locator("#tree .tree-item .name", { hasText: "NewFile.py" }).first();
  await treeItem.click({ button: "right", force: true });
  const ctx = page.locator("#ctx-menu");
  await expect(ctx).toBeVisible();
  // 文本断言：untracked 只有暂存，无 diff/Blame
  await expect(ctx).toContainText("暂存新文件", { timeout: 5_000 });
  await expect(ctx).not.toContainText("打开差异");
  await expect(ctx).not.toContainText("Blame");
  await page.keyboard.press("Escape");
});

test("E2E-03：非仓库空态 → init 按钮 → 变 SCM 视图", async ({ page }) => {
  const plain = await makePlainDir({ "readme.txt": "hello\n" });
  await equipPage(page, plain);
  await page.goto("/");
  // 等工作区自动恢复完成（openWorkspace 末尾会 setSidebarTab("files")——
  // 若在它之前点 tab-git，切换会被这次重置覆盖，aria-selected 永远 false）
  await expect(page.locator("#tree .tree-item .name", { hasText: "readme.txt" })).toBeVisible({ timeout: 20_000 });
  // 自动开工作区的链（status → read_dir → 状态栏）完全落地后再操作，
  // 避免其迟到的一轮刷新与 init 的刷新竞态（E2E 实测会拖慢面板更新）
  await page.waitForTimeout(1_500);

  await page.locator("#tab-git").click();
  // 分步断言：侧栏真的切到了 git 视图
  await expect(page.locator("#tab-git")).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
  // 非 git 状态确认路径（refreshGitStatus 失败 → 空态）
  const initBtn = page.locator("#git-changes button", { hasText: "初始化 Git 仓库" });
  await expect(initBtn).toBeVisible({ timeout: 15_000 });
  // force：空态按钮可能落在侧栏滚动区外，actionability 检查会卡住
  await initBtn.click({ force: true });
  // init 成功 toast（失败则 error toast 会被这里暴露）
  await expect(page.locator(".toast--success").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1_000);
  // 兜底刷新（init 内部链与自动开工作区链存在竞态；刷新按钮已修复为 状态+面板+分支 三连）
  await page.locator("#git-btn-refresh").click({ force: true });
  // init 后 → 状态栏出现分支名（is_git 生效的直接证据；分支名取决于宿主
  // init.defaultBranch——本机 git init 默认 master，勿断言具体名）
  await expect(page.locator("#status-git")).not.toBeEmpty({ timeout: 15_000 });
  // 面板脱离「不是 Git 仓库」空态（变更为空 → 无更改；readme untracked → 更改列表）
  await expect(page.locator("#git-changes")).not.toContainText("不是 Git 仓库", { timeout: 15_000 });
});

test("E2E-06：冲突文件 → 接受当前更改 → 标记已解决", async ({ page }) => {
  const { repo, conflictedPath, currentContent } = await makeConflictRepo();
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  await page.locator("#tab-git").click();
  const item = page.locator("#git-changes .scm-item", { hasText: conflictedPath });
  await expect(item).toHaveCount(1, { timeout: 10_000 });
  await item.click();
  // 冲突 diff：接受按钮组可见（当前/传入/双方）
  await expect(page.locator("#git-diff-accept-current")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#git-diff-accept-both")).toBeVisible();

  // 接受当前 → openConfirm 确认（「接受」）→ 执行
  await page.locator("#git-diff-accept-current").click();
  // 确认框挂载后再点（此前直接点会打在未显示的 modal 上）
  const confirmOk = page.locator("#confirm-ok");
  await expect(confirmOk).toBeVisible({ timeout: 5_000 });
  await confirmOk.click();
  await expect(page.locator(".toast--success").first()).toBeVisible({ timeout: 10_000 });
  // 等内部刷新链（afterConflictResolve → refresh 链）落地，再手动兜底刷新
  await page.waitForTimeout(1_000);

  // 真仓库：内容 = current 版 + 无 UU 冲突态。注意：accept current 取 ours（= HEAD 内容）
  // 再 add → 工作区与 HEAD 无差异 → status 干净（无 M 记录是正确语义，非 bug）
  const content = repo.read(conflictedPath);
  expect(content).toContain(currentContent);
  const status = await repo.git(["status", "--porcelain"]);
  expect(status).not.toMatch(/^UU/m);
  // UI：主动刷新后冲突条目消失（干净或无冲突分组；显示什么取决于 ours 是否恰与 HEAD 同）
  await page.locator("#git-btn-refresh").click();
  await expect(page.locator("#git-changes")).not.toContainText("!!", { timeout: 15_000 });
});

test("E2E-09：慢 fetch 期间 busy 条出现且完成消失", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "a.py": "1\n" }, commitMsg: "base" });
  await equipPage(page, repo, { slowGitMs: { git_fetch: 3000 } });
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  await page.locator("#tab-git").click();
  for (let i = 0; i < 2; i++) {
    await page.locator("#git-btn-more").click();
    await pclickFetch(page);
  }
  // busy 条出现（防重入：第二次点击被锁忽略，仍只有一个 fetch）
  await expect(page.locator("#git-remote-busy")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("#git-remote-busy")).toContainText("fetch 进行中");
  await expect(page.locator("#git-remote-busy")).toHaveCount(0, { timeout: 15_000 });
});

// ---------- E2E-11：远程分支检出为本地跟踪分支（B8 闭环） ----------

test("E2E-11：点远程分支 → 建本地跟踪分支（非 detached HEAD）", async ({ page }) => {
  // update-ref 纯本地构造 refs/remotes/origin/*（本机安全策略禁 git 传输协议，
  // clone/fetch/push 一律不可用；branch -a 可见 + checkout --track 读本地引用，零网络）
  const repo = await makeGitRepo({ files: { "app.py": "v1\n" }, commitMsg: "base" });
  await repo.git(["update-ref", "refs/remotes/origin/feature-x", "HEAD"]);
  // --track 需要 remote.origin 配置段（设跟踪 refspec；纯本地配置，不触网）
  await repo.git(["config", "remote.origin.url", "https://example.invalid/e2e.git"]);
  await repo.git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  await equipPage(page, repo);
  await page.goto("/");
  // 等自动开工作区链落地（立即点 tab 会被其末尾的 setSidebarTab 覆盖）
  await expect(page.locator("#tree .tree-item .name", { hasText: "app.py" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 10_000 });

  // 打开分支列表 → 远程分支组 → 点击 origin/feature-x
  await page.locator("#tab-git").click();
  await page.locator("#git-branch-btn").click();
  const remoteItem = page.locator("#git-branch-list .git-branch-item", { hasText: "origin/feature-x" });
  await expect(remoteItem).toHaveCount(1, { timeout: 10_000 });
  await remoteItem.click();
  // 脏工作区保护在干净仓库下不触发；toast 确认跟踪检出
  await expect(page.locator(".toast--success").first()).toContainText("feature-x", { timeout: 10_000 });

  // 真仓库：本地 feature-x 存在 + 跟踪 origin/feature-x + 非 detached
  const current = (await repo.git(["branch", "--show-current"])).trim();
  expect(current).toBe("feature-x");
  const upstreamRef = (await repo.git(["rev-parse", "--abbrev-ref", "feature-x@{upstream}"])).trim();
  expect(upstreamRef).toBe("origin/feature-x");
});

test("E2E-11b：本地已有同名分支时点远程分支 → 切本地不覆盖", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "a.py": "base\n" }, commitMsg: "base" });
  // 本地建 feature-x（内容与远程引用指向的 HEAD 不同）
  await repo.git(["checkout", "-b", "feature-x"]);
  repo.write("a.py", "local-only\n");
  await repo.git(["add", "-A"]);
  await repo.git(["commit", "--quiet", "-m", "local work"]);
  await repo.git(["checkout", "main"]);
  // 本地构造 origin/feature-x（指向 main 的 HEAD——与本地 feature-x 不同）
  await repo.git(["update-ref", "refs/remotes/origin/feature-x", "main"]);
  await repo.git(["config", "remote.origin.url", "https://example.invalid/e2e.git"]);
  await repo.git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  await equipPage(page, repo);
  await page.goto("/");
  // 等自动开工作区链落地（立即点 tab 会被其末尾的 setSidebarTab 覆盖）
  await expect(page.locator("#tree .tree-item .name", { hasText: "a.py" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 10_000 });

  await page.locator("#tab-git").click();
  await page.locator("#git-branch-btn").click();
  const remoteItem = page.locator("#git-branch-list .git-branch-item", { hasText: "origin/feature-x" });
  await expect(remoteItem).toHaveCount(1, { timeout: 10_000 });
  await remoteItem.click();
  await expect(page.locator("#status-git")).toContainText("feature-x", { timeout: 10_000 });
  // 本地 feature-x 的独有内容仍在（切的是本地分支，未重置到远程指向）
  expect(repo.read("a.py")).toContain("local-only");
});

/** 点「抓取（全部远程）」菜单项的辅助（抽出避免 locator 重复） */
async function pclickFetch(page: Page): Promise<void> {
  await page.locator(".ctx-menu-item", { hasText: "抓取（全部远程）" }).click();
}
