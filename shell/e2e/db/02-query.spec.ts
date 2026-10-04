/**
 * B3 SQLite 数据库 · SQL 查询 Tab（docs/sqlite_tool_dev_plan.md §17 · v1.4 Tab 化重设计）。
 *
 * 桩同 01：e2e/mocks/tauri-mock.js 的 db_* 分发（250 行结果，>200 才能测翻页）。
 * 断言「发了哪几条 SQL」看 window.__E2E_DB_QUERIES__；导出 CSV 写真实临时目录再读盘校验。
 * 查询 Tab 的入口：侧栏头部「新建查询」按钮（#db-new-query）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

let repo: GitRepo;
const pageErrors: string[] = [];

/** 只读连接的预设（默认桩即是） */
const READONLY_CONN = {
  id: "db-0000000000000001",
  path: "C:\\e2e\\app.db",
  name: "app.db",
  writable: false,
  sql: "",
  history: [],
};
/** 可写连接：跳过「只读拦截」，用于写语句确认链 */
const WRITABLE_CONN = { ...READONLY_CONN, writable: true };

async function presetDb(page: Page, preset: Record<string, unknown>): Promise<void> {
  await page.addInitScript((p) => {
    (window as unknown as { __E2E_DB__?: unknown }).__E2E_DB__ = p;
  }, preset);
}

/** 预置「另存为」对话框返回值（@tauri-apps/plugin-dialog 的 save） */
async function presetSavePath(page: Page, path: string): Promise<void> {
  await page.addInitScript((p) => {
    (window as unknown as { __E2E_DIALOG_PRESET__?: { save?: string } }).__E2E_DIALOG_PRESET__ = { save: p };
  }, path);
}

/** 切到数据库视图并新建一个查询 Tab（本文件的统一入口） */
async function openQueryTab(page: Page): Promise<void> {
  await page.locator("#tab-database").click();
  await expect(page.locator("#view-database")).toBeVisible({ timeout: 10_000 });
  await page.locator("#db-new-query").click();
  await expect(page.locator("#db-query-view")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#db-query-editor-host .monaco-editor")).toBeVisible({ timeout: 20_000 });
}

function db(page: Page, id: string) {
  return page.locator(`#${id}`);
}

/** 向 SQL 编辑器输入文本（Monaco 实例挂在 #db-query-editor-host 内） */
async function typeSql(page: Page, text: string): Promise<void> {
  const host = page.locator("#db-query-editor-host");
  await host.locator(".monaco-editor .view-lines").click();
  await page.keyboard.type(text, { delay: 5 });
}

/** 清空查询流水（只影响 mock 的内存记录，不动应用状态） */
async function resetQueries(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __E2E_DB_QUERIES__?: string[] }).__E2E_DB_QUERIES__ = [];
  });
}

function queries(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __E2E_DB_QUERIES__?: string[] }).__E2E_DB_QUERIES__ ?? [],
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

test("DB-Q-1：查询 Tab 打开即落 tab 条目（查询 N · 库名，code 图标）", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openQueryTab(page);

  const tab = page.locator('.tab[data-path^="db-query:"]');
  await expect(tab).toBeVisible();
  await expect(tab).toHaveClass(/active/);
  await expect(tab.locator(".name")).toHaveText("查询 1 · app.db");
  await expect(tab.locator(".codicon-code").first()).toBeAttached();
});

test("DB-Q-2：只读连接上执行写语句不发 IPC，直接提示", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openQueryTab(page);
  await resetQueries(page);

  await typeSql(page, "DELETE FROM users");
  await page.keyboard.press("Control+Enter");

  await expect(db(page, "db-query-view").locator(".db-tab-status")).toContainText("只读模式下不允许写操作");
  expect(await queries(page)).toEqual([]); // 省一次往返：前端前置拦截
});

test("DB-Q-3：可写连接执行写语句需确认，确认后回填影响行数", async ({ page }) => {
  await presetDb(page, { connections: [WRITABLE_CONN] });
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openQueryTab(page);
  await resetQueries(page);

  await typeSql(page, "DELETE FROM users WHERE id > 100");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#confirm-modal")).toContainText("即将执行");
  await page.locator("#confirm-ok").click();

  await expect(db(page, "db-query-view").locator(".db-tab-status")).toContainText("影响 1 行");
  expect(await queries(page)).toEqual(["DELETE FROM users WHERE id > 100"]);
});

test("DB-Q-4：查询失败时状态条转错误态并弹 toast，且保留上次结果", async ({ page }) => {
  await presetDb(page, { failQuery: true });
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openQueryTab(page);

  await typeSql(page, "SELECT 1");
  await page.keyboard.press("Control+Enter");
  await expect(db(page, "db-query-view").locator(".db-tab-status")).toHaveClass(/is-error/, { timeout: 10_000 });
  await expect(db(page, "db-query-view").locator(".db-tab-status")).toContainText("查询失败");
  await expect(page.locator(".toast.toast--error")).toBeVisible();
});

test("DB-Q-5：Ctrl+Enter 只执行光标所在的那条语句", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openQueryTab(page);
  await resetQueries(page);

  await typeSql(page, "SELECT 1;\nSELECT 2;");
  await page.keyboard.press("Control+Home"); // 光标移到第一条
  await page.keyboard.press("Control+Enter");

  await expect.poll(() => queries(page), { timeout: 5_000 }).toEqual(["SELECT 1"]);
});

test("DB-Q-6：Ctrl+Shift+Enter 逐条执行全部语句", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openQueryTab(page);
  await resetQueries(page);

  await typeSql(page, "SELECT 1;\nSELECT 2;");
  await page.keyboard.press("Control+Shift+Enter");

  await expect.poll(() => queries(page), { timeout: 5_000 }).toEqual(["SELECT 1", "SELECT 2"]);
});

test("DB-Q-7：查询历史下拉可回填编辑器，且草稿随连接落盘", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openQueryTab(page);
  await resetQueries(page);

  await typeSql(page, "SELECT 42 AS answer");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => queries(page), { timeout: 5_000 }).toEqual(["SELECT 42 AS answer"]);

  // 历史菜单含刚执行的语句
  await db(page, "db-history").click();
  await expect(page.locator("#ctx-menu")).toContainText("SELECT 42 AS answer");
  await page.keyboard.press("Escape");

  // 草稿写盘防抖 2s：等 db_connections_save 落盘并核对 sql 字段
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (window as unknown as { __E2E_DB_SAVED__?: { sql: string }[] }).__E2E_DB_SAVED__?.[0]?.sql ?? "",
        ),
      { timeout: 8_000 },
    )
    .toContain("SELECT 42 AS answer");
});

test("DB-Q-8：查询结果分页（250 行 / 每页 200 → 2 页，行号为绝对行号）", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openQueryTab(page);
  await resetQueries(page);

  await typeSql(page, "SELECT * FROM users");
  await page.keyboard.press("Control+Enter");

  const grid = db(page, "db-query-view").locator(".db-tab-grid");
  await expect(grid.locator("table.db-grid")).toBeVisible({ timeout: 10_000 });
  await expect(db(page, "db-query-page-label")).toHaveText("第 1/2 页");
  await expect(db(page, "db-query-prev")).toBeDisabled();
  await expect(db(page, "db-query-next")).toBeEnabled();
  const rows = grid.locator("tbody tr");
  await expect(rows).toHaveCount(200);
  await expect(rows.first().locator(".db-rowno")).toHaveText("1");

  await db(page, "db-query-next").click();
  await expect(db(page, "db-query-page-label")).toHaveText("第 2/2 页");
  await expect(rows).toHaveCount(50);
  await expect(rows.first().locator(".db-rowno")).toHaveText("201");
});

test("DB-Q-9：导出 CSV 写盘（UTF-8 BOM + 表头 + 全部行）", async ({ page }) => {
  const target = join(repo.root, "export.csv");
  await presetSavePath(page, target);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openQueryTab(page);
  await resetQueries(page);

  await typeSql(page, "SELECT * FROM users");
  await page.keyboard.press("Control+Enter");
  await expect(db(page, "db-query-view").locator("table.db-grid")).toBeVisible({ timeout: 10_000 });

  await db(page, "db-query-export").click();
  await expect(page.locator(".toast.toast--success")).toBeVisible({ timeout: 10_000 });

  const csv = readFileSync(target, "utf8");
  expect(csv.charCodeAt(0)).toBe(0xfeff); // BOM：Excel 双击不乱码
  const lines = csv.replace(/^\ufeff/, "").split("\r\n");
  expect(lines[0]).toBe("id,name,note");
  expect(lines.length).toBe(251); // 表头 + 250 行
  expect(lines[1]).toBe("1,user1,note 1");
});

test("DB-Q-10：设置面板「数据库」每页行数保存后对新查询生效", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  await page.keyboard.press("Control+Alt+S");
  await expect(page.locator("#settings-modal, .modal:has(#settings-save)").first()).toBeVisible({ timeout: 5_000 });
  await page.locator('.settings-nav-item[data-cat="database"]').click();
  await expect(page.locator("#settings-db-page-size")).toBeVisible({ timeout: 5_000 });
  await page.locator("#settings-db-page-size").selectOption("100");
  await page.locator("#settings-save").click();
  await expect(page.locator("#settings-modal")).toBeHidden({ timeout: 5_000 });

  await openQueryTab(page);
  await resetQueries(page);
  await typeSql(page, "SELECT * FROM users");
  await page.keyboard.press("Control+Enter");

  await expect(db(page, "db-query-page-label")).toHaveText("第 1/3 页");
  await expect(db(page, "db-query-page-size")).toHaveValue("100");
});

test("DB-Q-11：多个查询 Tab 各自独立，切换不丢草稿与结果", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openQueryTab(page);
  await resetQueries(page);
  await typeSql(page, "SELECT 1");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => queries(page), { timeout: 5_000 }).toEqual(["SELECT 1"]);

  // 再开一个查询 Tab：清掉回填的草稿后输入不同内容
  await db(page, "db-new-query").click();
  await expect(page.locator('.tab[data-path^="db-query:"]')).toHaveCount(2);
  await resetQueries(page);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await typeSql(page, "SELECT 2");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => queries(page), { timeout: 5_000 }).toEqual(["SELECT 2"]);

  // 切回第一个 Tab：草稿还在（内容 = SELECT 1），结果状态保留
  await page.locator('.tab[data-path^="db-query:"]').first().click();
  await expect(db(page, "db-query-view")).toBeVisible();
  await expect(db(page, "db-query-view").locator(".db-tab-status")).toContainText("200/250 行");
  await resetQueries(page);
  await db(page, "db-run").click();
  await expect.poll(() => queries(page), { timeout: 5_000 }).toEqual(["SELECT 1"]);
});
