/**
 * E2E：资源可观测面板（A-1，PyCharm 调研）
 *
 *  - R-1 状态栏 MEM 芯片显示采样值（外壳 + 子进程合计）
 *  - R-2 面板打开：进程明细表（外壳 + 子进程）、合计、CPU 首采样为「—」
 *  - R-3 面板可关闭、重启 LSP 引擎可用、界面不崩
 *
 * proc_stats 由 tauri-mock 提供固定样本（外壳 182.3MB + pyrefly 96.4 + python 48.1 = 326.8MB）。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

let repo: GitRepo;
const pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makeGitRepo({ files: { "main.py": "print(1)\n" }, commitMsg: "baseline" });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("R-1 状态栏 MEM 芯片显示合计内存", async ({ page }) => {
  // 首次采样在 wireResourcePanel 内同步发起；mock 返回 326.8 → 显示 "MEM 327 MB"
  await expect(page.locator("#status-mem")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#status-mem")).toContainText("MEM 327 MB");
});

test("R-2 面板打开：明细表含外壳与子进程，CPU 首采样为「—」", async ({ page }) => {
  await page.locator("#status-mem").click();
  const modal = page.locator("#resource-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("#resource-summary")).toContainText("合计 326.8 MB");
  await expect(page.locator("#resource-summary")).toContainText("子进程 2 个");

  const rows = page.locator("#resource-rows tr");
  await expect(rows).toHaveCount(3); // 外壳 + pyrefly + python
  await expect(rows.nth(0)).toContainText("Pylume（外壳）");
  await expect(rows.nth(1)).toContainText("pyrefly.exe");
  await expect(rows.nth(2)).toContainText("python.exe");
  // 子进程按内存降序：pyrefly(96.4) 在 python(48.1) 之前
  await expect(rows.nth(1)).toContainText("96.4 MB");
  await expect(rows.nth(2)).toContainText("48.1 MB");
  // CPU 语义：样本里 pyrefly cpu=1.2 → 显示百分比；python cpu=0（无基线/空闲）→ 显示「—」
  await expect(rows.nth(1)).toContainText("1.2%");
  await expect(rows.nth(2)).toContainText("—");
});

test("R-3 面板可关闭、重启 LSP 引擎可用且不崩", async ({ page }) => {
  await page.locator("#status-mem").click();
  await expect(page.locator("#resource-modal")).toBeVisible({ timeout: 5_000 });

  // 重启 LSP 引擎（走 main.ts 的 startLsp 真实链路；mock 环境下正常完成）
  await page.locator("#resource-restart-lsp").click();
  await expect(page.locator("#resource-modal")).toBeVisible({ timeout: 10_000 }); // 不闪退、面板仍在

  // Esc 关闭（模态规范：Esc = 关闭）
  await page.keyboard.press("Escape");
  await expect(page.locator("#resource-modal")).toBeHidden({ timeout: 5_000 });
  // 关闭后芯片仍在（30s 周期采样未受影响）
  await expect(page.locator("#status-mem")).toBeVisible();
});
