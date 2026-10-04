/**
 * E2E-15/16（迭代 4 · 远程与深度）：
 *  - E2E-16：远程仓库管理面板（打开 / 添加 remote / 列表显示 / 删除）
 *  - E2E-15b：「推送到此」按钮触发带 remote 的 push（mock 配置级模拟）→ 上游绑定生效（状态栏不再提示无上游）
 */
import { test, expect } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

let repo: GitRepo;

test.beforeEach(async ({ page }) => {
  repo = await makeGitRepo({
    files: { "main.py": "print('v1')\n" },
    commitMsg: "baseline",
  });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
});

test("E2E-16：远程管理面板 添加/列表/删除", async ({ page }) => {
  await page.locator("#tab-git").click();
  // 打开远程管理
  await page.locator("#git-btn-more").click();
  await page.locator(".ctx-menu-item", { hasText: "远程仓库" }).click();
  const modal = page.locator("#git-remote-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });

  // 初始空态
  await expect(modal.locator(".git-remote-list")).toContainText("无远程仓库", { timeout: 5_000 });

  // 添加 remote
  await modal.locator("input").nth(0).fill("origin");
  await modal.locator("input").nth(1).fill("https://github.com/e2e/demo.git");
  await modal.locator("button", { hasText: "添加" }).click();
  await expect(modal.locator(".git-remote-item", { hasText: "origin" })).toHaveCount(1, { timeout: 5_000 });
  await expect(modal.locator(".git-remote-item", { hasText: "github.com/e2e/demo" })).toHaveCount(1);

  // 真仓库 remote 已配置
  const remotes = await repo.git(["remote", "-v"]);
  expect(remotes).toContain("github.com/e2e/demo.git");

  // 删除（行内按钮 → openConfirm 的 #confirm-ok）
  await modal.locator(".git-remote-item button", { hasText: "删除" }).click();
  await page.locator("#confirm-ok").click();
  await expect(modal.locator(".git-remote-list")).toContainText("无远程仓库", { timeout: 5_000 });
  const after = await repo.git(["remote"]);
  expect(after.trim()).toBe("");
  // 关闭（force：trapFocus/动画下 stable 检查偶发卡顿；关闭非功能断言对象）
  await modal.locator("button", { hasText: "关闭" }).click({ force: true });
});

test("E2E-15b：「推送到此」建立上游绑定（mock 配置级 push）", async ({ page }) => {
  // 预置 origin remote（真配置）
  await repo.git(["remote", "add", "origin", "https://github.com/e2e/demo.git"]);
  await page.locator("#tab-git").click();

  // 远程管理面板 → 「推送到此」
  await page.locator("#git-btn-more").click();
  await page.locator(".ctx-menu-item", { hasText: "远程仓库" }).click();
  const modal = page.locator("#git-remote-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });
  await modal.locator(".git-remote-item button", { hasText: "推送到此" }).click();

  // busy 条出现又消失（操作完成）
  await expect(page.locator("#git-remote-busy")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("#git-remote-busy")).toHaveCount(0, { timeout: 15_000 });

  // 真仓库：上游三件套已绑定（mock push 写 refs/remotes/origin/main + config）
  const upstream = await repo.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  // 不同 git 版本可能返回全名或短名（refs/remotes/origin/main / origin/main），语义等价
  expect(upstream.trim()).toMatch(/^(refs\/remotes\/)?origin\/main$/);
  // 状态栏刷新后同步计数为 0（本地与远程跟踪 ref 一致）——无 ↑↓ 显示即成功
  await page.locator("#tab-git").click(); // 再触发一次状态刷新
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 10_000 });
  await expect(page.locator("#status-git")).not.toContainText("↑");
});
