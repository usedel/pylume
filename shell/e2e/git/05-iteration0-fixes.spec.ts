/**
 * E2E-05：迭代 0 修复回归（A1 / A2）
 *
 * A1：空暂存 + Ctrl+Enter → 内联提示「没有已暂存的更改」，不发出 git commit
 * A2：空消息 + 「提交全部」→ 内联提示，不暂存任何文件（暂存区保持空）
 */
import { test, expect } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

let repo: GitRepo;

test.beforeEach(async ({ page }) => {
  repo = await makeGitRepo({
    files: { "main.py": "print('hello')\n" },
    commitMsg: "baseline",
  });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  repo.write("main.py", "print('changed')\n");
  await page.locator("#tab-git").click();
});

test("A1：空暂存 Ctrl+Enter → 内联提示，不触发 git commit", async ({ page }) => {
  const errEl = page.locator("#git-commit-error");
  const commitBtn = page.locator("#git-commit-btn");

  // 有变更未暂存：按钮禁用
  await expect(commitBtn).toBeDisabled({ timeout: 10_000 });

  // 有消息但无暂存 → Ctrl+Enter 走内联提示（A1 修复前会发空提交、toast 报错）
  await page.locator("#git-commit-msg").fill("should not commit");
  await page.locator("#git-commit-msg").press("Control+Enter");

  await expect(errEl).toBeVisible({ timeout: 5_000 });
  await expect(errEl).toContainText("没有已暂存的更改");
  // 无错误 toast（区别于修复前的 git 报错 toastFail）
  await expect(page.locator(".toast--error")).toHaveCount(0);
  // 仓库仍只有 baseline 一个提交
  const count = (await repo.git(["rev-list", "--count", "HEAD"])).trim();
  expect(count).toBe("1");
});

test("A2：空消息「提交全部」→ 内联提示，不暂存任何文件", async ({ page }) => {
  const errEl = page.locator("#git-commit-error");

  // 变更条目出现（未暂存）
  const item = page.locator("#git-changes .scm-item", { hasText: "main.py" });
  await expect(item).toHaveCount(1, { timeout: 10_000 });

  // 消息为空 → 提交下拉「提交全部」→ 内联提示（A2 修复前会先把全部文件 stage）
  await page.locator("#git-commit-more").click();
  await page.locator(".ctx-menu-item", { hasText: "提交全部" }).click();
  await expect(errEl).toBeVisible({ timeout: 5_000 });
  await expect(errEl).toContainText("提交信息不能为空");

  // 关键断言：暂存区保持空（A2 修复前 main.py 已被 stage）
  const staged = await repo.git(["diff", "--cached", "--name-only"]);
  expect(staged.trim()).toBe("");
  // 仓库仍只有 baseline 提交
  const count = (await repo.git(["rev-list", "--count", "HEAD"])).trim();
  expect(count).toBe("1");
});
