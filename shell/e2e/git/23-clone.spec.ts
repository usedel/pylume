/**
 * E2E：迭代 6 Git 从远端克隆（docs/git_clone_dev_plan.md §7.2，E2E-15..20）
 *
 * mock 面：git_clone / git_default_branch / git_cancel_op("clone") 经 bridge 走
 * Node 侧模拟（helpers.ts「落盘模拟 clone」——本机 file 协议被 EDR 拦截，与 git_push
 * 同款取舍）；失败/延迟行为经 window.__E2E_CLONE_PRESET__ 注入（tauri-mock 附加进 args）。
 *
 * 编号说明：计划原文写 e2e/git/05-clone.spec.ts，但 git/05 已被 iteration0-fixes 占用，
 * 顺延为 23（与现有 git spec 递增编号一致）。
 */
import { test, expect, type Page } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

interface ClonePreset {
  fail?: "notEmpty" | "auth" | "net";
  delayMs?: number;
  branch?: string;
}

/** 每用例唯一 clone 目标（位于系统临时目录，不与并行 worker 冲突） */
function cloneTarget(name: string): string {
  return join(tmpdir(), `oc-clone-${name}-${Date.now()}`);
}

/** 启动到欢迎页（startEmpty：最近工作区为空 → autoOpenRecentWorkspace 无动作）。
 *  等待 list_plugin_dirs 出现 = init 完成中段信号（ux/03 同款，早期点击会被吞）。 */
async function bootEmpty(page: Page, dir: GitRepo, preset?: ClonePreset): Promise<void> {
  if (preset) {
    await page.addInitScript((p) => {
      (window as unknown as { __E2E_CLONE_PRESET__?: ClonePreset }).__E2E_CLONE_PRESET__ = p;
    }, preset);
  }
  await equipPage(page, dir, { startEmpty: true });
  await page.goto("/");
  await expect(page.locator("#ew-new-project")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const log = (window as unknown as { __TAURI_MOCK_INVOKE_LOG__?: string[] }).__TAURI_MOCK_INVOKE_LOG__ ?? [];
          return log.some((x) => x.startsWith("list_plugin_dirs")) ? 1 : 0;
        }),
      { timeout: 20_000 },
    )
    .toBe(1);
}

/** 打开新建项目面板并切到 clone tab */
async function openCloneTab(page: Page): Promise<void> {
  await page.locator("#ew-new-project").click();
  const modal = page.locator("#new-project-modal");
  await expect(modal).toBeVisible();
  await page.locator('.new-project-tab[data-tab="clone"]').click();
  await expect(page.locator("#new-project-local")).toBeHidden();
  await expect(page.locator("#new-project-clone")).toBeVisible();
}

async function fillCloneForm(page: Page, url: string, target: string): Promise<void> {
  await page.locator("#clone-url").fill(url);
  await page.locator("#clone-target").fill(target);
}

test("E2E-15 tab 互斥切换：字段显隐 + 双侧输入值保留", async ({ page }) => {
  const dir = await makePlainDir();
  await bootEmpty(page, dir);
  await page.locator("#ew-new-project").click();
  await expect(page.locator("#new-project-modal")).toBeVisible();

  // local 填值 → 切 clone → local 隐藏 / clone 可见 + aria-selected
  await page.locator("#new-project-name").fill("local-keep");
  await page.locator('.new-project-tab[data-tab="clone"]').click();
  await expect(page.locator("#new-project-local")).toBeHidden();
  await expect(page.locator("#new-project-clone")).toBeVisible();
  await expect(page.locator('.new-project-tab[data-tab="clone"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('.new-project-tab[data-tab="local"]')).toHaveAttribute("aria-selected", "false");

  // clone 填 URL → 切回 local → clone 输入保留、local 输入也保留（互不丢失）
  await page.locator("#clone-url").fill("https://github.com/user/repo.git");
  await page.locator('.new-project-tab[data-tab="local"]').click();
  await expect(page.locator("#new-project-clone")).toBeHidden();
  await expect(page.locator("#new-project-name")).toHaveValue("local-keep");
  await page.locator('.new-project-tab[data-tab="clone"]').click();
  await expect(page.locator("#clone-url")).toHaveValue("https://github.com/user/repo.git");
});

test("E2E-16 平台预设：GitHub 前缀填入 + 平台 hint 识别", async ({ page }) => {
  const dir = await makePlainDir();
  await bootEmpty(page, dir);
  await openCloneTab(page);

  await page.locator('.clone-preset[data-platform="github"]').click();
  await expect(page.locator("#clone-url")).toHaveValue("https://github.com/");

  // 光标在末尾，接着补 owner/repo → 平台 hint 显示 GitHub
  await page.locator("#clone-url").pressSequentially("user/repo.git");
  await expect(page.locator("#clone-url")).toHaveValue("https://github.com/user/repo.git");
  await expect(page.locator("#new-project-clone .clone-hint").first()).toBeVisible();
  await expect(page.locator("#new-project-clone .clone-hint").first()).toHaveText("GitHub");
});

test("E2E-17 主分支预览：防抖出现 origin/main，URL 清空即隐藏", async ({ page }) => {
  const dir = await makePlainDir();
  await bootEmpty(page, dir);
  await openCloneTab(page);

  await page.locator("#clone-url").fill("https://github.com/user/repo.git");
  const preview = page.locator("#clone-branch-preview");
  await expect(preview).toBeVisible({ timeout: 5_000 });
  await expect(preview).toContainText("origin/main");

  // 清空 URL → 预览隐藏（且重新输入后可再次出现）
  await page.locator("#clone-url").fill("");
  await expect(preview).toBeHidden({ timeout: 5_000 });
  await page.locator("#clone-url").fill("https://gitlab.com/user/repo.git");
  await expect(preview).toBeVisible({ timeout: 5_000 });
});

test("E2E-18 Clone 成功闭环：面板关闭 + 工作区切换 + README 自动打开 + 落盘", async ({ page }) => {
  const dir = await makePlainDir();
  await bootEmpty(page, dir);
  await openCloneTab(page);
  // 目标放在 mock 沙箱（repo.root）内——dispatchFs 的 guard 只放行沙箱内路径，
  // 完成后 openWorkspace/read_file 链路才可用
  const target = dir.abs("cloned-repo");
  await fillCloneForm(page, "https://github.com/user/repo.git", target);

  await page.locator("#clone-submit").click();

  // 面板关闭 + 工作区切换为克隆目录
  await expect(page.locator("#new-project-modal")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#tree-header-text")).toContainText("cloned-repo", { timeout: 20_000 });
  // 完成后自动打开 README.md（mock 落盘含 README.md + main.py，README 优先）
  await expect(page.locator("#tabbar .tab.active .name", { hasText: "README.md" })).toBeVisible({ timeout: 15_000 });
});

test("E2E-19 路径冲突：notEmpty → 三选项对话框 → 换个路径聚焦目标框", async ({ page }) => {
  const dir = await makePlainDir();
  await bootEmpty(page, dir, { fail: "notEmpty" });
  await openCloneTab(page);
  const target = cloneTarget("conflict");
  await fillCloneForm(page, "https://github.com/user/repo.git", target);

  await page.locator("#clone-submit").click();

  // 冲突对话框（openConfirm：ok=克隆到子目录 / cancel=换个路径）
  const confirmModal = page.locator("#confirm-modal");
  await expect(confirmModal).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#confirm-title")).toHaveText("目标目录已存在");
  await expect(page.locator("#confirm-ok")).toHaveText("克隆到子目录");
  await expect(page.locator("#confirm-cancel")).toHaveText("换个路径");

  // 选「换个路径」→ 对话框关闭 + focus 回目标输入框
  await page.locator("#confirm-cancel").click();
  await expect(confirmModal).toBeHidden({ timeout: 5_000 });
  await expect(page.locator("#clone-target")).toBeFocused();
});

test("E2E-20 流式进度 + 取消：busy 锁 tab，取消后 toast info 且不切工作区", async ({ page }) => {
  const dir = await makePlainDir();
  await bootEmpty(page, dir, { delayMs: 8_000 });
  await openCloneTab(page);
  const target = cloneTarget("cancel");
  await fillCloneForm(page, "https://github.com/user/repo.git", target);

  await page.locator("#clone-submit").click();

  // busy 态：进度区出现、提交禁用、面板 tab 锁定（clone busy 时不能切 local）
  await expect(page.locator("#clone-progress")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("#clone-submit")).toBeDisabled();
  await expect(page.locator('.new-project-tab[data-tab="local"]')).toBeDisabled();

  // 取消 → bridge 立即 reject「已取消」→ info toast + 进度区收起 + tab 解锁
  await page.locator("#clone-cancel").click();
  await expect(page.locator("#toast-stack .toast--info", { hasText: "已取消克隆" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#clone-progress")).toBeHidden({ timeout: 5_000 });
  await expect(page.locator('.new-project-tab[data-tab="local"]')).toBeEnabled();
  await expect(page.locator("#clone-submit")).toBeEnabled();
  // openWorkspace 未被调用：工作区仍是空态（tree-header 不出现克隆目录）
  await expect(page.locator("#tree-header-text")).not.toContainText(`oc-clone-cancel`);
});
