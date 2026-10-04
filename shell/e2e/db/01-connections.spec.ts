/**
 * B3 SQLite 数据库侧栏「资源管理器」· 连接管理与对象树
 * （docs/sqlite_tool_dev_plan.md §17 · v1.4 Tab 化重设计）。
 *
 * 桩：e2e/mocks/tauri-mock.js 的 db_* 分发（内存连接列表 + 默认 2 表 1 视图 1 索引 + 250 行结果），
 * 不触达真实 SQLite（rusqlite 是 Rust 进程内库），只驱动前端状态机与渲染。
 * 预置入口：window.__E2E_DB__ = { connections, objects, result, ddl, pick, failOpen, failQuery }。
 *
 * v1.4 架构：侧栏 = 连接列表 + 对象树；数据面（网格 / SQL）在编辑器区 Tab（02 / 03 spec）。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

let repo: GitRepo;
const pageErrors: string[] = [];

/** 预置数据库桩（mock 在 invoke 时才读，顺序无所谓；仍统一放 goto 前便于阅读） */
async function presetDb(page: Page, preset: Record<string, unknown>): Promise<void> {
  await page.addInitScript((p) => {
    (window as unknown as { __E2E_DB__?: unknown }).__E2E_DB__ = p;
  }, preset);
}

/** 切到数据库视图（Activity Bar 项）。 */
async function openDbView(page: Page): Promise<void> {
  await page.locator("#tab-database").click();
  await expect(page.locator("#view-database")).toBeVisible({ timeout: 10_000 });
}

function db(page: Page, id: string) {
  return page.locator(`#${id}`);
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

test("DB-CONN-1：Activity Bar 可切，视图互斥且 tab 选中态同步", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  await openDbView(page);
  await expect(page.locator("#tab-database")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#view-files")).toBeHidden();

  // 切回文件视图：database 收起、files 展开（注册表的单根互斥语义）
  await page.locator("#tab-files").click();
  await expect(page.locator("#view-database")).toBeHidden();
  await expect(page.locator("#view-files")).toBeVisible();
});

test("DB-CONN-2：无连接时空态（树区提示选 .sqlite / .db 文件）", async ({ page }) => {
  await presetDb(page, { connections: [] });
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openDbView(page);

  await expect(db(page, "db-tree")).toContainText("没有数据库连接");
  await expect(db(page, "db-tree")).toContainText(".sqlite");
});

test("DB-CONN-3：有连接时自动打开并渲染连接节点 + 三组对象树", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openDbView(page);

  const tree = db(page, "db-tree");
  // 连接节点（活动连接展开树体）
  const conn = tree.locator('.db-conn-node[data-id="db-0000000000000001"]');
  await expect(conn).toContainText("app.db");
  await expect(conn).toHaveClass(/active/);

  // 三组标题带条数（表 2 / 视图 1 / 索引 1）
  await expect(tree.locator(".db-tree-group")).toHaveCount(3);
  await expect(tree.locator(".db-tree-group").nth(0)).toContainText("表 (2)");
  await expect(tree.locator(".db-tree-group").nth(1)).toContainText("视图 (1)");
  await expect(tree.locator(".db-tree-group").nth(2)).toContainText("索引 (1)");

  // 组内按名排序 + 行数显示
  await expect(tree.locator('.db-tree-item[data-name="users"]')).toContainText("250 行");
  await expect(tree.locator('.db-tree-item[data-name="logs"]')).toContainText("12 行");

  // 布局回归（真机 bug：对象列表是连接行的 flex 子项时，名字被挤没、图标垂直居中到列表中部）：
  // 连接名必须可见（宽度 > 0）且其所在行在第一个分组头的上方
  const nameBox = await conn.locator(".db-tree-name").first().boundingBox();
  const groupBox = await tree.locator(".db-tree-group").first().boundingBox();
  expect(nameBox, "连接名应有可见宽度").toBeTruthy();
  expect(nameBox!.width).toBeGreaterThan(0);
  expect(nameBox!.height).toBeLessThan(30, "连接行不应被对象列表撑高");
  expect(groupBox, "分组头应存在").toBeTruthy();
  expect(nameBox!.y).toBeLessThan(groupBox!.y, "连接行应在对象分组上方");
});

test("DB-CONN-4：单击表节点展开列（名 + 类型 + PK/NN），索引无子项", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openDbView(page);

  const users = page.locator('#db-tree .db-tree-item[data-name="users"]');
  const cols = users.locator(".db-tree-cols");
  await expect(cols).toBeHidden();
  await users.click();
  await expect(cols).toBeVisible();
  await expect(cols.locator(".db-tree-col").nth(0)).toContainText("id");
  await expect(cols.locator(".db-tree-col").nth(0)).toContainText("INTEGER");
  await expect(cols.locator(".db-tree-col").nth(0)).toContainText("PK");
  await expect(cols.locator(".db-tree-col").nth(1)).toContainText("NN");

  // 索引节点没有列容器
  await expect(page.locator('#db-tree .db-tree-item[data-name="idx_users_name"] .db-tree-cols')).toHaveCount(0);
});

test("DB-CONN-5：双击表节点打开编辑器区数据 Tab（最常用路径）", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openDbView(page);

  await page.locator('#db-tree .db-tree-item[data-name="users"]').dblclick();
  const dataView = db(page, "db-data-view");
  await expect(dataView).toBeVisible();
  await expect(db(page, "db-tab-panel")).toBeVisible();
  await expect(dataView.locator("table.db-grid")).toBeVisible({ timeout: 10_000 });
  // 标题 = 表名；tab 条目名 = 表名 · 库名
  await expect(db(page, "db-data-title")).toHaveText("users");
  await expect(page.locator('.tab[data-path^="db-data:"] .name')).toHaveText("users · app.db");
});

test("DB-CONN-6：可写开关（连接行锁形按钮）需二次确认，aria-pressed 同步", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openDbView(page);

  const lock = page.locator(".db-conn-node .db-conn-lock");
  await expect(lock).toHaveAttribute("aria-pressed", "false");

  await lock.click();
  // 自绘确认框：取消则不改变状态
  await expect(page.locator("#confirm-modal")).toBeVisible();
  await page.locator("#confirm-cancel").click();
  await expect(lock).toHaveAttribute("aria-pressed", "false");

  await lock.click();
  await page.locator("#confirm-ok").click();
  await expect(page.locator(".db-conn-node .db-conn-lock")).toHaveAttribute("aria-pressed", "true");
});

test("DB-CONN-7：右键移除连接只从列表摘除（确认框 + 落盘列表不含它）", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openDbView(page);
  await expect(db(page, "db-tree")).toContainText("users");

  // 右键点连接行头部（y=10 落在首行；元素中心会落在对象列表的表项上，弹的是表项菜单）
  await page.locator(".db-conn-node").click({ button: "right", position: { x: 120, y: 10 } });
  await page.locator("#ctx-menu").getByText("移除连接").click();
  await expect(page.locator("#confirm-modal")).toContainText("不会删除文件");
  await page.locator("#confirm-ok").click();

  await expect(db(page, "db-tree")).toContainText("没有数据库连接");

  const saved = await page.evaluate(
    () => (window as unknown as { __E2E_DB_SAVED__?: { id: string }[] }).__E2E_DB_SAVED__,
  );
  expect(saved).toEqual([]);
});

test("DB-CONN-8：＋ 添加连接走 pick_file，成功后进入列表并自动打开", async ({ page }) => {
  await presetDb(page, { pick: "C:\\e2e\\extra.db" });
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openDbView(page);

  await expect(page.locator(".db-conn-node")).toHaveCount(1);
  await db(page, "db-add").click();
  await expect(page.locator(".db-conn-node")).toHaveCount(2);
  await expect(page.locator(".db-conn-node").nth(1)).toContainText("extra.db");
  // 新增连接后自动切换过去并刷新树
  await expect(db(page, "db-tree")).toContainText("users");
});

test("DB-CONN-9：树内过滤框实时收敛对象列表（跨三组匹配）", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  await openDbView(page);
  await expect(db(page, "db-tree").locator(".db-tree-item")).toHaveCount(4);

  await db(page, "db-filter-input").fill("log");
  await expect(db(page, "db-tree").locator(".db-tree-item")).toHaveCount(1);
  await expect(db(page, "db-tree").locator('.db-tree-item[data-name="logs"]')).toBeVisible();
  await expect(db(page, "db-tree").locator(".db-tree-group").nth(0)).toContainText("表 (1)");

  // 清空过滤后恢复全量
  await db(page, "db-filter-input").fill("");
  await expect(db(page, "db-tree").locator(".db-tree-item")).toHaveCount(4);
});
