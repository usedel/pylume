/**
 * E2E-04：暂存 / 提交主链路（迭代 1 · B1 计数 + 基础链路）
 *
 * 旅程：修改文件 → SCM 面板出现变更 → 点 + 暂存 → 提交按钮显示「提交(1)」
 * → 填消息提交（Ctrl+Enter）→ toast 成功 → 真仓库出现第二个提交 → 面板回到干净态。
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
  // 修改文件产生未暂存变更
  repo.write("main.py", "print('hello world')\n");
  // 切到 Git 侧栏（onShow 触发 refreshGitStatus）
  await page.locator("#tab-git").click();
});

test("暂存 → 提交按钮计数 → Ctrl+Enter 提交成功 → 仓库新增提交", async ({ page }) => {
  const changes = page.locator("#git-changes");
  await expect(changes).toBeVisible({ timeout: 10_000 });

  // 1) 未暂存条目出现
  const item = changes.locator(".scm-item", { hasText: "main.py" });
  await expect(item).toHaveCount(1, { timeout: 10_000 });

  // 2) 无暂存时提交按钮禁用、无计数
  const commitBtn = page.locator("#git-commit-btn");
  await expect(commitBtn).toBeDisabled();

  // 3) hover 条目使 + 按钮显现（真实用户路径：CSS visibility 由 .scm-item:hover 驱动），再点暂存
  await item.hover();
  await item.locator(".scm-action").click();
  await expect(commitBtn).toBeEnabled({ timeout: 5_000 });
  await expect(commitBtn).toHaveText(/提交\(1\)/);

  // 4) 填消息 + Ctrl+Enter 提交
  await page.locator("#git-commit-msg").fill("e2e: update greeting");
  await page.locator("#git-commit-msg").press("Control+Enter");
  await expect(page.locator(".toast--success")).toBeVisible({ timeout: 10_000 });

  // 5) 真仓库出现第二个提交（直接查 git log 验证「真发生了提交」）
  const log = await repo.git(["log", "--pretty=format:%s"]);
  expect(log.split("\n")).toContain("e2e: update greeting");

  // 6) 面板回到干净态，提交按钮复位为「提交」
  await expect(changes.locator(".scm-item")).toHaveCount(0, { timeout: 10_000 });
  await expect(commitBtn).toHaveText(/^提交$/);
});
