/**
 * E2E-17/18/19（迭代 5 · 旗舰体验）：
 *  - E2E-17：SCM 内嵌 tab（更改/历史/贮藏）切换 + 内容随 tab 加载
 *  - E2E-18：多选批量（Ctrl 点选两个文件 → 批量暂存条 → 只暂存这两项）
 *  - E2E-19：提交建议 chips（暂存 .py 文件 → 出现 feat 前缀建议 → 点击填入）
 */
import { test, expect } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

let repo: GitRepo;

test.beforeEach(async ({ page }) => {
  repo = await makeGitRepo({
    files: {
      "main.py": "print('v1')\n",
      "util.py": "x = 1\n",
      "README.md": "# demo\n",
    },
    commitMsg: "baseline",
  });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
});

test("E2E-17：SCM tab 切换（更改/历史/贮藏）", async ({ page }) => {
  await page.locator("#tab-git").click();
  // 默认「更改」tab 激活
  await expect(page.locator("#git-subtab-changes")).toHaveClass(/active/);
  await expect(page.locator("#git-commit-box")).toBeVisible();

  // 切「历史」→ 提交列表出现、提交框隐藏
  await page.locator("#git-subtab-history").click();
  await expect(page.locator("#git-subtab-history")).toHaveClass(/active/);
  await expect(page.locator("#git-history .git-commit-item")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator("#git-commit-box")).toBeHidden();

  // 切「贮藏」→ 贮藏面板（空态）出现
  await page.locator("#git-subtab-stash").click();
  await expect(page.locator("#git-stash-panel")).toBeVisible();
  await expect(page.locator("#git-stash-panel")).toContainText("无贮藏", { timeout: 5_000 });

  // 切回「更改」→ 提交框回来
  await page.locator("#git-subtab-changes").click();
  await expect(page.locator("#git-commit-box")).toBeVisible();
});

test("E2E-18：Ctrl 多选 + 批量暂存只作用选中项", async ({ page }) => {
  repo.write("main.py", "print('v2')\n");
  repo.write("util.py", "x = 2\n");
  repo.write("README.md", "# demo2\n");
  await page.locator("#tab-git").click();
  const changes = page.locator("#git-changes");
  await expect(changes.locator(".scm-item")).toHaveCount(3, { timeout: 10_000 });

  // Ctrl 点选 main.py 与 util.py（不打开 diff）
  await changes.locator(".scm-item", { hasText: "main.py" }).click({ modifiers: ["Control"] });
  await expect(page.locator("#git-scm-bulk")).toContainText("已选 1 项");
  await changes.locator(".scm-item", { hasText: "util.py" }).click({ modifiers: ["Control"] });
  await expect(page.locator("#git-scm-bulk")).toContainText("已选 2 项");

  // 批量暂存
  await page.locator("#git-scm-bulk button", { hasText: "批量暂存" }).click();
  // 提交按钮计数 = 2（README 未暂存）
  await expect(page.locator("#git-commit-btn")).toHaveText(/提交\(2\)/, { timeout: 10_000 });

  // 真仓库：只有 main.py 与 util.py 进暂存区
  const staged = await repo.git(["diff", "--cached", "--name-only"]);
  expect(staged.split("\n").filter(Boolean).sort()).toEqual(["main.py", "util.py"]);
});

test("E2E-19：提交建议 chips 出现且点击填入", async ({ page }) => {
  repo.write("main.py", "print('v2')\n");
  await page.locator("#tab-git").click();
  const item = page.locator("#git-changes .scm-item", { hasText: "main.py" });
  await expect(item).toHaveCount(1, { timeout: 10_000 });
  await item.hover();
  await item.locator(".scm-action").click();
  await expect(page.locator("#git-commit-btn")).toHaveText(/提交\(1\)/, { timeout: 5_000 });

  // 建议条出现：含「建议前缀」与 feat chip
  const suggest = page.locator("#git-commit-suggest");
  await expect(suggest).toBeVisible();
  await expect(suggest.locator(".git-suggest-chip", { hasText: "feat" }).first()).toBeVisible();

  // 点击 feat(main) chip → 填入提交框
  await suggest.locator(".git-suggest-chip", { hasText: "feat" }).first().click();
  await expect(page.locator("#git-commit-msg")).toHaveValue(/^feat(\([^)]*\))?: /);
});
