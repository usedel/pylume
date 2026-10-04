/**
 * B3 SQLite 数据库 · 表数据 Tab（docs/sqlite_tool_dev_plan.md §17 · v1.4 Tab 化重设计）。
 *
 * 数据 Tab 走新命令 db_rows（结构化 sort / filter / 分页，后端拼装 SQL）。
 * mock 桩记录入参流水到 window.__E2E_DB_ROWS__（排序/筛选做形状级模拟），断言「发了什么参数」
 * 与「网格渲染结果」两端；导出 CSV 写真实临时目录再读盘校验。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

let repo: GitRepo;
const pageErrors: string[] = [];

async function presetDb(page: Page, preset: Record<string, unknown>): Promise<void> {
  await page.addInitScript((p) => {
    (window as unknown as { __E2E_DB__?: unknown }).__E2E_DB__ = p;
  }, preset);
}

async function presetSavePath(page: Page, path: string): Promise<void> {
  await page.addInitScript((p) => {
    (window as unknown as { __E2E_DIALOG_PRESET__?: { save?: string } }).__E2E_DIALOG_PRESET__ = { save: p };
  }, path);
}

function db(page: Page, id: string) {
  return page.locator(`#${id}`);
}

/** 切到数据库视图并双击 users 表打开数据 Tab */
async function openUsersDataTab(page: Page): Promise<void> {
  await page.locator("#tab-database").click();
  await expect(page.locator("#view-database")).toBeVisible({ timeout: 10_000 });
  await page.locator('#db-tree .db-tree-item[data-name="users"]').dblclick();
  await expect(db(page, "db-data-view").locator("table.db-grid")).toBeVisible({ timeout: 10_000 });
}

/** db_rows 参数流水 */
function rowsCalls(page: Page): Promise<{ name: string; sort: string | null; dir: string | null; filter: string | null; offset: number }[]> {
  return page.evaluate(
    () => (window as unknown as { __E2E_DB_ROWS__?: { name: string; sort: string | null; dir: string | null; filter: string | null; offset: number }[] }).__E2E_DB_ROWS__ ?? [],
  );
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makeGitRepo({ files: { "main.py": "print(1)\n" }, commitMsg: "baseline" });
  await equipPage(page, repo);
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("DB-D-1：数据 Tab 打开即全列渲染，状态条含行数与只读标记", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openUsersDataTab(page);

  const grid = db(page, "db-data-view").locator(".db-tab-grid");
  const head = await grid.locator("thead th").allTextContents();
  expect(head.map((s) => s.trim())).toEqual(["#", "id", "name", "note"]);
  await expect(grid.locator("tbody tr")).toHaveCount(200);
  await expect(db(page, "db-data-view").locator(".db-tab-status")).toContainText("200/250 行");
  await expect(db(page, "db-data-view").locator(".db-tab-status")).toContainText("只读");
  await expect(db(page, "db-data-title")).toHaveText("users");
  await expect(db(page, "db-data-prev")).toBeDisabled();
});

test("DB-D-2：翻页（250 行 / 每页 200 → 2 页，行号为绝对行号）", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openUsersDataTab(page);

  const rows = db(page, "db-data-view").locator(".db-tab-grid tbody tr");
  await expect(rows).toHaveCount(200);
  await db(page, "db-data-next").click();
  await expect(db(page, "db-data-page-label")).toHaveText("第 2/2 页");
  await expect(rows).toHaveCount(50);
  await expect(rows.first().locator(".db-rowno")).toHaveText("201");
  await expect(rows.last().locator(".db-rowno")).toHaveText("250");
  await expect(db(page, "db-data-next")).toBeDisabled();
  await db(page, "db-data-prev").click();
  await expect(db(page, "db-data-page-label")).toHaveText("第 1/2 页");
});

test("DB-D-3：每页行数切换后重查并重算页数", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openUsersDataTab(page);
  await expect(db(page, "db-data-page-label")).toHaveText("第 1/2 页");

  await db(page, "db-data-page-size").selectOption("100");
  await expect(db(page, "db-data-page-label")).toHaveText("第 1/3 页");
  await expect(db(page, "db-data-view").locator(".db-tab-grid tbody tr")).toHaveCount(100);
});

test("DB-D-4：列头点击排序三态（升 → 降 → 无），参数流水可查", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openUsersDataTab(page);

  const idTh = db(page, "db-data-view").locator('thead th:has-text("id")');
  // 无 → 升序
  await idTh.click();
  await expect(idTh).toHaveClass(/db-th-asc/);
  await expect(idTh).toHaveAttribute("aria-sort", "ascending");
  // 升序 → 降序
  await idTh.click();
  await expect(idTh).toHaveClass(/db-th-desc/);
  await expect(idTh).toHaveAttribute("aria-sort", "descending");
  // 降序 → 无
  await idTh.click();
  await expect(idTh).not.toHaveClass(/db-th-asc/);
  await expect(idTh).not.toHaveClass(/db-th-desc/);

  const calls = await rowsCalls(page);
  const sorts = calls.map((c) => (c.sort ? `${c.sort} ${c.dir}` : "-"));
  expect(sorts).toEqual(["-", "id asc", "id desc", "-"]);
  // 每次排序翻回第一页
  expect(calls.map((c) => c.offset)).toEqual([0, 0, 0, 0]);
});

test("DB-D-5：筛选条回车应用（id > 240 → 10 行），Esc 清除恢复全量", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openUsersDataTab(page);

  const filter = db(page, "db-data-filter");
  await filter.fill("id > 240");
  await filter.press("Enter");

  const grid = db(page, "db-data-view").locator(".db-tab-grid");
  await expect(grid.locator("tbody tr")).toHaveCount(10);
  await expect(db(page, "db-data-page-label")).toHaveText("第 1/1 页");
  await expect(db(page, "db-data-view").locator(".db-tab-status")).toContainText("10/10 行");

  const calls = await rowsCalls(page);
  expect(calls[calls.length - 1]?.filter).toBe("id > 240");

  // Esc 清除：恢复全量 250 行
  await filter.press("Escape");
  await expect(grid.locator("tbody tr")).toHaveCount(200);
  await expect(db(page, "db-data-page-label")).toHaveText("第 1/2 页");
  const calls2 = await rowsCalls(page);
  expect(calls2[calls2.length - 1]?.filter).toBeNull();
});

test("DB-D-6：NULL 与空串视觉可分；单元格详情显示完整值并可复制", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openUsersDataTab(page);

  const grid = db(page, "db-data-view").locator(".db-tab-grid");
  // 桩数据：第 7 行 name 为 NULL，第 5 行 note 为空串
  const nullCell = grid.locator("tbody tr").nth(6).locator("td").nth(2);
  await expect(nullCell).toHaveClass(/db-cell-null/);
  await expect(nullCell).toHaveText("NULL");
  const emptyCell = grid.locator("tbody tr").nth(4).locator("td").nth(3);
  await expect(emptyCell).toHaveClass(/db-cell-empty/);
  await expect(emptyCell).toHaveText('""');

  const cell = grid.locator("tbody tr").nth(1).locator("td").nth(1);
  await cell.click();
  const detail = db(page, "db-data-view").locator(".db-cell-detail");
  await expect(detail).toBeVisible();
  await expect(detail.locator(".db-cell-detail-head")).toContainText("id");
  await expect(detail.locator(".db-cell-detail-head")).toContainText("#2");
  await expect(detail.locator(".db-cell-detail-body")).toHaveText("2");
  await detail.locator("button").click();
  const copied = await page.evaluate(
    () => (window as unknown as { __E2E_COPIED__?: string[] }).__E2E_COPIED__ ?? [],
  );
  expect(copied).toContain("2");
});

test("DB-D-7：单元格右键可复制整行为 JSON / CSV", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openUsersDataTab(page);

  const cell = db(page, "db-data-view").locator(".db-tab-grid tbody tr").nth(0).locator("td").nth(2);
  await cell.click({ button: "right" });
  await page.locator("#ctx-menu").getByText("复制整行为 JSON").click();
  const copied = await page.evaluate(
    () => (window as unknown as { __E2E_COPIED__?: string[] }).__E2E_COPIED__ ?? [],
  );
  expect(copied.some((c) => c.includes('"id": "1"') && c.includes('"name": "user1"'))).toBe(true);

  await cell.click({ button: "right" });
  await page.locator("#ctx-menu").getByText("复制整行为 CSV").click();
  const copied2 = await page.evaluate(
    () => (window as unknown as { __E2E_COPIED__?: string[] }).__E2E_COPIED__ ?? [],
  );
  expect(copied2).toContain("1,user1,note 1");
});

test("DB-D-8：导出 CSV 按筛选/排序拉全量写盘（UTF-8 BOM）", async ({ page }) => {
  const target = join(repo.root, "users-export.csv");
  await presetSavePath(page, target);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openUsersDataTab(page);

  const filter = db(page, "db-data-filter");
  await filter.fill("id > 240");
  await filter.press("Enter");
  await expect(db(page, "db-data-view").locator(".db-tab-grid tbody tr")).toHaveCount(10);

  await db(page, "db-data-export").click();
  await expect(page.locator(".toast.toast--success")).toBeVisible({ timeout: 10_000 });

  const csv = readFileSync(target, "utf8");
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  const lines = csv.replace(/^\ufeff/, "").split("\r\n");
  expect(lines.length).toBe(11); // 表头 + 10 行（筛选生效）
  expect(lines[1]).toBe("241,user241,note 241");
});

test("DB-D-9：刷新按钮按当前排序/筛选重查；切 Tab 状态保留不重查", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openUsersDataTab(page);
  const before = (await rowsCalls(page)).length;

  // 刷新：按当前状态重查一次
  await db(page, "db-data-refresh").click();
  await expect(db(page, "db-data-view").locator("table.db-grid")).toBeVisible();
  expect((await rowsCalls(page)).length).toBe(before + 1);

  // 打开一个查询 Tab 再切回数据 Tab：不额外发 db_rows（结果缓存在 Tab 状态）
  await db(page, "db-new-query").click();
  await expect(db(page, "db-query-view")).toBeVisible();
  const afterQuery = (await rowsCalls(page)).length;
  await page.locator('.tab[data-path^="db-data:"]').click();
  await expect(db(page, "db-data-view")).toBeVisible();
  await expect(db(page, "db-data-view").locator(".db-tab-grid tbody tr")).toHaveCount(200);
  expect((await rowsCalls(page)).length).toBe(afterQuery);
});

test("DB-D-10：查询失败保留上次结果并转错误态（toast 提示）", async ({ page }) => {
  await presetDb(page, { failQuery: true });
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await page.locator("#tab-database").click();
  await expect(page.locator("#view-database")).toBeVisible({ timeout: 10_000 });
  await page.locator('#db-tree .db-tree-item[data-name="users"]').dblclick();

  await expect(db(page, "db-data-view").locator(".db-tab-status")).toHaveClass(/is-error/, { timeout: 10_000 });
  await expect(db(page, "db-data-view").locator(".db-tab-status")).toContainText("查询失败");
  await expect(page.locator(".toast.toast--error")).toBeVisible();
});
