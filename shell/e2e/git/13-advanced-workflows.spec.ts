/**
 * E2E-13/14（迭代 3 · 高级工作流）：
 *  - E2E-08：状态栏同步计数（↑n）+ 分支列表远程分组
 *  - E2E-13：历史条目右键 cherry-pick（跨分支应用提交）
 *  - E2E-14：stash 带 message 贮藏 + 列表可见 message + diff 查看按钮存在
 *  - 标签：历史右键新建标签 → 分支列表出现标签区
 */
import { test, expect } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

let repo: GitRepo;

test.beforeEach(async ({ page }) => {
  repo = await makeGitRepo({
    files: { "main.py": "print('v1')\n" },
    commitMsg: "c1",
  });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
});

test("E2E-08：上游同步计数 ↑1 显示在状态栏", async ({ page }) => {
  // 环境注记：本机 git 无法 clone/push 本地路径（EDR 拦截 git-upload-pack 子进程，
  // 实测 Node 单进程绝对路径 clone 亦失败）。改用 refs 直写法构造上游关系：
  // update-ref refs/remotes/origin/main + config branch.main.remote/merge —— 零网络依赖，
  // ahead/behind 语义与真实 push 完全一致（rev-list 对比的是 ref 而非传输）。
  await repo.git(["commit", "--allow-empty", "--quiet", "-m", "c2"]);
  const head = (await repo.git(["rev-parse", "HEAD"])).trim();
  await repo.git(["update-ref", "refs/remotes/origin/main", head]);
  // @{upstream} 解析依赖三件套：remote.origin.fetch refspec + branch.<name>.remote/merge
  await repo.git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  await repo.git(["config", "branch.main.remote", "origin"]);
  await repo.git(["config", "branch.main.merge", "refs/heads/main"]);
  // 本地领先 1 个提交（origin/main 停在 c2）
  await repo.git(["commit", "--allow-empty", "--quiet", "-m", "local-only"]);

  // 刷新状态（切侧栏触发 refreshGitStatus → updateGitStatusBar → updateSyncCount）
  await page.locator("#tab-git").click();
  await expect(page.locator("#status-git")).toContainText("↑1", { timeout: 15_000 });
});

test("E2E-13：历史右键 cherry-pick 到另一分支", async ({ page }) => {
  // feature 分支上提交变更（main 不含）；回 main 后从历史 cherry-pick 它
  await repo.git(["checkout", "--quiet", "-b", "feature"]);
  repo.write("main.py", "print('v1')\nprint('feature-added')\n");
  await repo.git(["add", "-A"]);
  await repo.git(["commit", "--quiet", "-m", "feature-change"]);
  await repo.git(["checkout", "--quiet", "main"]);
  // main 工作区回到 v1

  // 打开历史（--all 含 feature 分支提交）→ 右键 feature-change → cherry-pick
  await page.locator("#tab-git").click();
  await page.locator("#git-btn-more").click();
  await page.locator(".ctx-menu-item", { hasText: "提交历史" }).click();
  const item = page.locator("#git-history .git-commit-item", { hasText: "feature-change" });
  await expect(item).toHaveCount(1, { timeout: 10_000 });
  await item.click({ button: "right" });
  await page.locator(".ctx-menu-item", { hasText: "Cherry-pick" }).click();
  await expect(page.locator(".toast--success").first()).toBeVisible({ timeout: 15_000 });

  // 真仓库：main 上出现该内容（新哈希副本）
  const mainContent = await repo.git(["show", "main:main.py"]);
  expect(mainContent).toContain("feature-added");
  const log = await repo.git(["log", "--pretty=format:%s", "main"]);
  expect(log.split("\n")[0]).toBe("feature-change");
});

test("E2E-14：stash 带 message + 列表显示 + diff 按钮", async ({ page }) => {
  repo.write("main.py", "print('v1-wip')\n");
  await page.locator("#tab-git").click();
  // 贮藏（走「更多操作」→ 贮藏更改）：choice（#confirm-modal，中性按钮）→ prompt（#prompt-modal）
  await page.locator("#git-btn-more").click();
  await page.locator(".ctx-menu-item", { hasText: "贮藏更改" }).click();
  // openChoice：中性按钮「仅已跟踪」（动态插在 #confirm-ok 前）
  await page.locator("#confirm-modal .modal-actions button", { hasText: "仅已跟踪" }).click();
  // openPrompt：独立 #prompt-modal
  const promptInput = page.locator("#prompt-input");
  await expect(promptInput).toBeVisible({ timeout: 5_000 });
  await promptInput.fill("wip: 登录页重构");
  await page.locator("#prompt-ok").click();
  await expect(page.locator(".toast--success").first()).toBeVisible({ timeout: 10_000 });

  // 真仓库：stash message 命中
  const stashList = await repo.git(["stash", "list"]);
  expect(stashList).toContain("wip: 登录页重构");

  // 贮藏列表：显示 message + 有 diff 按钮
  await page.locator("#git-btn-more").click();
  await page.locator(".ctx-menu-item", { hasText: "贮藏列表" }).click();
  const stashPanel = page.locator("#git-stash-panel");
  await expect(stashPanel).toBeVisible();
  await expect(stashPanel.locator(".stash-item", { hasText: "wip: 登录页重构" })).toHaveCount(1);
  await expect(stashPanel.locator(".stash-item button[data-tip='查看该贮藏的 diff']")).toHaveCount(1);
});

test("标签：历史右键新建 → 分支列表标签区出现", async ({ page }) => {
  await page.locator("#tab-git").click();
  await page.locator("#git-btn-more").click();
  await page.locator(".ctx-menu-item", { hasText: "提交历史" }).click();
  const first = page.locator("#git-history .git-commit-item").first();
  await expect(first).toBeVisible({ timeout: 10_000 });
  await first.click({ button: "right" });
  await page.locator(".ctx-menu-item", { hasText: "新建标签" }).click();
  const input = page.locator("#prompt-input");
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill("v1.0.0");
  await page.locator("#prompt-ok").click();
  await expect(page.locator(".toast--success").first()).toBeVisible({ timeout: 10_000 });

  // 真仓库标签存在
  const tags = await repo.git(["tag"]);
  expect(tags.trim()).toBe("v1.0.0");

  // 分支列表出现标签区（点状态栏分支名打开）
  await page.locator("#status-git").click();
  const branchList = page.locator("#git-branch-list");
  await expect(branchList).toBeVisible({ timeout: 5_000 });
  await expect(branchList.locator(".git-branch-group-title", { hasText: "标签" })).toBeVisible({ timeout: 10_000 });
  await expect(branchList.locator(".git-branch-item", { hasText: "v1.0.0" })).toHaveCount(1);
});
