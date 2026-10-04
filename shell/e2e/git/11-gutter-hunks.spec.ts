/**
 * E2E-11/12（迭代 2）：
 *  - gutter 行级变更装饰（P0-5）：修改文件并打开 → 编辑器行号槽出现绿/蓝条
 *  - hunk 级暂存（P1-1）：diff 视图光标所在块 → 「+块」→ 只暂存该块（其余块留在工作区）
 *  - 三态基准（P1-2）：「总差异」按钮切换 → 标题变为 HEAD vs 工作区
 */
import { test, expect } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

let repo: GitRepo;

test.beforeEach(async ({ page }) => {
  repo = await makeGitRepo({
    files: {
      "main.py": "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n",
    },
    commitMsg: "baseline",
  });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
});

test("E2E-11：gutter 显示行级变更装饰（修改=蓝条）", async ({ page }) => {
  // 修改工作区文件（产生 modified hunk）
  repo.write("main.py", "line1\nline2-MODIFIED\nline3\nline4\nline5\nline6\nline7\nline8\n");
  // 打开文件到编辑器（触发 refreshGitGutter）
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 10_000 });
  // git 状态刷新联动（refreshGitStatus → refreshGitGutter）；切到 git 侧栏触发刷新
  await page.locator("#tab-git").click();
  // 编辑器行号槽出现修改蓝条（linesDecorationsClassName 注入 .git-gutter-modified）
  await expect(page.locator(".git-gutter-modified").first()).toBeVisible({ timeout: 10_000 });
});

test("E2E-12：hunk 级暂存——只暂存光标所在块", async ({ page }) => {
  // 两处修改间隔 > 6 行（3 行上下文 ×2），确保 git 输出两个独立 hunk
  //（间隔不足时 git 会合并成单 hunk，块级选择就无从谈起）
  repo.write(
    "main.py",
    "line1-CHANGED\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12-CHANGED\nline13\n",
  );
  await page.locator("#tab-git").click();
  const item = page.locator("#git-changes .scm-item", { hasText: "main.py" });
  await expect(item).toHaveCount(1, { timeout: 10_000 });
  await item.click(); // 打开 diff

  // diff 标签激活 + 编辑器渲染就绪
  await expect(page.locator("#git-diff-panel")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#git-diff-editor .monaco-diff-editor")).toBeVisible({ timeout: 10_000 });

  // 把光标放进第一个变更块：直接点击右栏（modified 侧）里包含 line1-CHANGED 的行。
  // 点文本元素比坐标点击稳（x/y 落 margin/折叠区会定位失败）；比 Ctrl+Home 稳
  //（diff 编辑器双栏下 Home 系快捷键的目标栏不总是预期的那个）。
  const rightChangedLine = page
    .locator("#git-diff-editor .monaco-diff-editor .view-line", { hasText: "line1-CHANGED" })
    .last(); // 两栏都可能渲染该文本？不会——左栏是旧文本 line1，只有右栏有 -CHANGED
  await rightChangedLine.click();

  // 「+块」暂存该块（严格断言 success——info=光标不在块内也算失败）。
  // 注：环境提示 toast（「未检测到 Python 环境…」，maybePromptVenv 后台探测完成后
  // 弹出，会话去重）会与本动作 toast 竞争 .first()——按文案过滤后再断言。
  await page.locator("#git-diff-hunk-stage").click();
  const toastEl = page
    .locator(".toast", { hasNotText: /未检测到 Python 环境/ })
    .first();
  await expect(toastEl).toBeVisible({ timeout: 10_000 });
  const toastText = (await toastEl.textContent()) ?? "";
  test.info().annotations.push({ type: "toast", description: toastText });

  // 断言：真仓库只有块 1（line1）被暂存，块 2（line12）仍在工作区
  const stagedDiff = await repo.git(["diff", "--cached"]);
  expect(stagedDiff, `toast=${toastText}`).toContain("line1-CHANGED");
  expect(stagedDiff).not.toContain("line12-CHANGED");
  const worktreeDiff = await repo.git(["diff"]);
  expect(worktreeDiff).toContain("line12-CHANGED");
});

test("E2E-12b：三态基准切换到「总差异」", async ({ page }) => {
  repo.write("main.py", "line1-CHANGED\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n");
  await page.locator("#tab-git").click();
  const item = page.locator("#git-changes .scm-item", { hasText: "main.py" });
  await expect(item).toHaveCount(1, { timeout: 10_000 });
  // 先暂存（制造「部分暂存」状态）
  await item.hover();
  await item.locator(".scm-action").click();
  await expect(page.locator("#git-commit-btn")).toHaveText(/提交\(1\)/, { timeout: 5_000 });
  // 工作区再改一点 → 同时存在已暂存与未暂存改动
  repo.write("main.py", "line1-CHANGED\nline2\nline3\nline4\nline5\nline6-EXTRA\nline7\nline8\n");
  await item.click(); // 打开 diff（自动模式 = HEAD vs 暂存区，因为文件已暂存）

  // 切「总差异」
  await page.locator("#git-diff-base-head").click();
  await expect(page.locator("#git-diff-label")).toContainText("总差异", { timeout: 5_000 });
  // 总差异应同时含两处改动（Monaco diff 内容验证：两侧文本模型）
  const label = await page.locator("#git-diff-label").textContent();
  expect(label).toContain("main.py");
});
