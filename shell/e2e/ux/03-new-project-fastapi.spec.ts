/**
 * E2E：F9 新建 FastAPI 项目（2026-09-30，docs/pycharm_framework_support_report.md §8.3.1 / PR-R）
 *
 *  - NP-1 默认「Python 脚本」创建 → main.py 为 def main() 模板（回归）
 *  - NP-2 选 FastAPI 创建 → 工作区切换成功 → main.py 打开且含 app = FastAPI( →
 *        磁盘 pyproject 含 "fastapi" → busy 复位 + 面板关闭
 *  - NP-3 下游零接线：创建完成后（预置 mock 探针状态）「检测到 FastAPI 项目」hint 出现
 *
 * mock 面：create_project 经 bridge 走真实磁盘（helpers.ts dispatchFs）；pip_install
 * 静态返回 0；探针表状态经 __E2E_FRAMEWORK_PRESET__ 预置（同 ux/02-frameworks）。
 * 注意：parent 必须填 repo.root（dispatchFs 的 guard 限仓库根内），项目目录为
 * repo.root/<name>。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

interface FrameworkPreset {
  deps?: string;
  hasFastApiApp?: boolean;
}

/** 启动到欢迎页（startEmpty：最近工作区为空 → autoOpenRecentWorkspace 无动作）。
 *  #ew-new-project 可见 ≠ init 完成（wireNewProject 在 init 后段接线，早期点击会被吞）——
 *  再等 invoke 流水出现 list_plugin_dirs（init 中段信号，onboarding OG spec 同款等待）。 */
async function bootEmpty(page: Page, repo: GitRepo, fw?: FrameworkPreset): Promise<void> {
  if (fw) {
    await page.addInitScript((preset) => {
      (window as unknown as { __E2E_FRAMEWORK_PRESET__?: FrameworkPreset }).__E2E_FRAMEWORK_PRESET__ = preset;
    }, fw);
  }
  await equipPage(page, repo, { startEmpty: true });
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

/** 打开新建项目面板并填表（名称 / 位置=repo.root / 类型） */
async function openPanelAndFill(page: Page, repo: GitRepo, name: string, type: "script" | "fastapi"): Promise<void> {
  await page.locator("#ew-new-project").click();
  const modal = page.locator("#new-project-modal");
  await expect(modal).toBeVisible();
  // 面板打开复位校验：类型应重置为 script（默认）
  await expect(page.locator("#new-project-type")).toHaveValue("script");
  await page.locator("#new-project-name").fill(name);
  await page.locator("#new-project-location").fill(repo.root);
  if (type !== "script") {
    await page.locator("#new-project-type").selectOption(type);
  }
}

test("NP-1 默认脚本类型：main.py 为 def main() 模板", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "keep.py": "print('keep')\n" }, commitMsg: "baseline" });
  await bootEmpty(page, repo);

  // 预览行：script 无追加说明
  await openPanelAndFill(page, repo, "demo-script", "script");
  await expect(page.locator("#new-project-preview")).toContainText(`将创建于：`);
  await expect(page.locator("#new-project-preview")).not.toContainText("FastAPI");

  await page.locator("#new-project-create").click();
  // 工作区切换成功（#tree-header-text 显示新工作区路径，同 git/22 spec 判定方式）
  await expect(page.locator("#tree-header-text")).toContainText("demo-script", { timeout: 20_000 });
  await expect(page.locator("#tabbar .tab.active .name", { hasText: "main.py" })).toBeVisible({ timeout: 15_000 });
  // 磁盘：脚本模板（回归——F9 不破坏默认路径）
  expect(repo.read("demo-script/main.py")).toContain("def main()");
  expect(repo.read("demo-script/pyproject.toml")).not.toContain("fastapi");
  // 面板关闭 + busy 复位
  await expect(page.locator("#new-project-modal")).toBeHidden({ timeout: 10_000 });
  await expect(page.locator("#new-project-create")).not.toHaveText(/创建中|安装依赖/);
});

test("NP-2 FastAPI 类型：模板 + 依赖落盘 + 全链路反馈", async ({ page }) => {
  const repo = await makeGitRepo({ files: { "keep.py": "print('keep')\n" }, commitMsg: "baseline" });
  await bootEmpty(page, repo);

  await openPanelAndFill(page, repo, "demo-api", "fastapi");
  // 预览行（q2 裁决）：入口 + 依赖说明
  await expect(page.locator("#new-project-preview")).toContainText("FastAPI 服务 入口 main.py + fastapi / uvicorn 依赖");

  await page.locator("#new-project-create").click();
  await expect(page.locator("#tree-header-text")).toContainText("demo-api", { timeout: 20_000 });
  await expect(page.locator("#tabbar .tab.active .name", { hasText: "main.py" })).toBeVisible({ timeout: 15_000 });

  // 磁盘断言：FastAPI 模板 + pyproject 依赖（mock 模板与 Rust 粗粒度同步）
  const mainPy = repo.read("demo-api/main.py");
  expect(mainPy).toContain("from fastapi import FastAPI");
  expect(mainPy).toContain("app = FastAPI(");
  const pyproject = repo.read("demo-api/pyproject.toml");
  expect(pyproject).toContain("\"fastapi\"");
  expect(pyproject).toContain("\"uvicorn\"");

  // 依赖安装走 pip_install mock（成功路径：不弹失败 toast）
  await expect(page.locator("#toast-stack .toast--error", { hasText: "依赖安装" })).toHaveCount(0);
  // uv add 回显行（cmd 样式，env 域）
  await expect(page.locator("#output .out-line", { hasText: "uv add fastapi uvicorn" })).toBeVisible({ timeout: 10_000 });
  // 面板关闭 + busy 复位
  await expect(page.locator("#new-project-modal")).toBeHidden({ timeout: 10_000 });
  await expect(page.locator("#new-project-create")).not.toHaveText(/创建中|安装依赖/);
});

test("NP-3 下游零接线：FastAPI 项目创建完成后探针 hint 出现", async ({ page }) => {
  // 预置探针状态（deps 含 fastapi + 源码命中）：创建切工作区后 openWorkspace →
  // maybeSuggestFramework → detect_framework 命中 → hint（NP-3 = q4 裁决）
  const repo = await makeGitRepo({ files: { "keep.py": "print('keep')\n" }, commitMsg: "baseline" });
  await bootEmpty(page, repo, { deps: "fastapi\nuvicorn\n", hasFastApiApp: true });

  await openPanelAndFill(page, repo, "demo-hint", "fastapi");
  await page.locator("#new-project-create").click();

  const hint = page.locator("#output .out-line.hint", { hasText: "检测到 FastAPI 项目" });
  await expect(hint).toBeVisible({ timeout: 20_000 });
  // hint 带一键生成链接（下游 F3 预设链路在 ux/02 FW-2 已覆盖，此处只验入口存在）
  await expect(hint.locator(".out-link", { hasText: "生成「FastAPI」配置并运行" })).toBeVisible();
});
