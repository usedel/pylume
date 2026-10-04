/**
 * 体验修复第 5 则（2026-09-20 用户报告）：git 改写工作区后编辑器不刷新。
 *  - E2E-16：丢弃块 → 已打开的编辑器内容同步（核心报告场景）
 *  - E2E-16b：dirty tab 保护——未保存修改不被磁盘覆盖 + 提示
 *  - E2E-16c：stash pop → 编辑器内容同步
 *  审计全量接入点：applyCurrentHunk(discard/unstage)、refreshAfterBranchChange
 *  （checkout/merge/rebase/revert/cherry-pick 公共收尾）、gitStashPop(At)、
 *  pull、切分支自动 pop、reset --hard（统一走 reloadTabsFromGitChange）。
 */
import { test, expect } from "@playwright/test";
import { equipPage, makeGitRepo } from "../helpers";

test("E2E-16：丢弃块后已打开的编辑器同步刷新", async ({ page }) => {
  const repo = await makeGitRepo({
    files: { "main.py": "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\nl15\n" },
    commitMsg: "baseline",
  });
  // 两处改动相隔 >6 行（默认 3 行上下文不会把 hunk 连成一块）
  repo.write("main.py", "l1\nCHANGE-A\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\nCHANGE-B\n");
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  // 打开文件（编辑器常驻）→ 打开 diff
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().dblclick();
  await expect(page.locator("#editor .monaco-editor")).toBeVisible({ timeout: 10_000 });
  await page.locator("#tab-git").click();
  const item = page.locator("#git-changes .scm-item", { hasText: "main.py" });
  await expect(item).toHaveCount(1, { timeout: 10_000 });
  await item.click();
  await expect(page.locator("#git-diff-editor")).toContainText("CHANGE-A", { timeout: 10_000 });

  // 光标放进第二个 hunk（CHANGE-B 行——点击 view-line，11-gutter-hunks 同款定位法）
  await page.locator("#git-diff-editor .view-line", { hasText: "CHANGE-B" }).last().click();
  await page.locator("#git-diff-hunk-discard").click();
  await page.locator("#confirm-ok").click();
  await expect(page.locator(".toast--success").first()).toBeVisible({ timeout: 10_000 });

  // 切回文件 tab（title 精确匹配——文件 tab 的 title 是绝对路径，diff tab 是 diff: 前缀）
  await page.locator('#tabbar .tab[title*="main.py"]:not([title^="diff:"])').first().click();
  await expect(page.locator("#editor .monaco-editor")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("#editor .monaco-editor")).toContainText("CHANGE-A", { timeout: 5_000 });
  await expect(page.locator("#editor .monaco-editor")).not.toContainText("CHANGE-B");
  // 磁盘真身一致
  expect(repo.read("main.py")).toContain("CHANGE-A");
  expect(repo.read("main.py")).not.toContain("CHANGE-B");
});

test("E2E-16b：丢弃块时 dirty tab 不被磁盘覆盖（保护 + 提示）", async ({ page }) => {
  const repo = await makeGitRepo({
    files: { "main.py": "a = 1\nb = 2\nc = 3\nd = 4\ne = 5\nf = 6\n" },
    commitMsg: "baseline",
  });
  repo.write("main.py", "a = 1\nb = 2-changed\nc = 3\nd = 4\ne = 5-changed\nf = 6\n");
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  // 打开文件 → 编辑器里再打一处未保存内容（dirty）
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().dblclick();
  const editor = page.locator("#editor .monaco-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("# UNSAVED-NOTES\n");
  // dirty 圆点出现
  await expect(page.locator("#tabbar .tab.active .dirty")).toBeVisible({ timeout: 5_000 });

  // 打开 diff 丢弃一个块（光标进 hunk 后丢弃）
  await page.locator("#tab-git").click();
  const item = page.locator("#git-changes .scm-item", { hasText: "main.py" });
  await expect(item).toHaveCount(1, { timeout: 10_000 });
  await item.click();
  await expect(page.locator("#git-diff-editor")).toContainText("b = 2-changed", { timeout: 10_000 });
  await page.locator("#git-diff-editor .view-line", { hasText: "b = 2-changed" }).last().click();
  await page.locator("#git-diff-hunk-discard").click();
  await page.locator("#confirm-ok").click();

  // 切回文件 tab：未保存内容仍在（未被磁盘覆盖）+ 提示出现
  await page.locator('#tabbar .tab[title*="main.py"]:not([title^="diff:"])').first().click();
  await expect(page.locator("#editor .monaco-editor")).toContainText("UNSAVED-NOTES", { timeout: 5_000 });
  await expect(page.locator(".toast").filter({ hasText: "未保存" })).toBeVisible({ timeout: 5_000 });
});

test("E2E-16c：stash pop 后已打开的编辑器同步刷新", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "main.py": "v1\n" }, commitMsg: "baseline" });
  // 先做一处修改并贮藏
  repo.write("main.py", "v1\nSTASHED-LINE\n");
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  // 打开文件（此刻有 STASHED-LINE）→ 贮藏（两层弹窗：choice 选「仅已跟踪」→ prompt 确认）
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().dblclick();
  await expect(page.locator("#editor .monaco-editor")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#editor .monaco-editor")).toContainText("STASHED-LINE");
  await page.locator("#tab-git").click();
  await page.locator("#git-btn-more").click();
  await page.locator(".ctx-menu-item", { hasText: "贮藏更改" }).click();
  const choiceNeutral = page.locator("button", { hasText: "仅已跟踪" }).last();
  await expect(choiceNeutral).toBeVisible({ timeout: 5_000 });
  await choiceNeutral.click();
  const promptOk = page.locator("button", { hasText: "确定" }).last();
  await expect(promptOk).toBeVisible({ timeout: 5_000 });
  await promptOk.click();
  await expect(page.locator("#git-changes")).toContainText("无更改", { timeout: 10_000 });
  // 磁盘已回退 + 编辑器同步刷新（push 侧修复的新行为）
  expect(repo.read("main.py")).not.toContain("STASHED-LINE");
  await expect(page.locator("#editor .monaco-editor")).not.toContainText("STASHED-LINE", { timeout: 10_000 });

  // 弹出贮藏 → 编辑器内容必须同步回来
  await page.locator("#git-btn-more").click();
  await page.locator(".ctx-menu-item", { hasText: "弹出贮藏" }).click();
  await expect(page.locator("#editor .monaco-editor")).toContainText("STASHED-LINE", { timeout: 10_000 });
  expect(repo.read("main.py")).toContain("STASHED-LINE");
});
