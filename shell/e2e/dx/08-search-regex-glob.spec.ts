/**
 * E2E：PR-H 全局搜索正则 + 文件掩码（dx_features_backlog §6.6/§6.8 第二梯队 D3）
 *
 *  - E-DX-SR1 正则开关：同一个查询串 `t.tal`，关=子串（永不可命中）→ 开=正则（命中 3 处）
 *  - E-DX-SR2 文件掩码：打开的标签模式搜 `42`，掩码 `*.py` 后 .txt 不再参与
 *  - E-DX-SR3 非法正则有明确提示（不静默退回子串匹配）
 *
 * ⚠ 范围说明：e2e 只覆盖 **scope 模式（当前文件 / 打开的标签）** 的 TS 侧筛选链路——
 *   workspace 模式要经 Rust `search_workspace` 命令，而浏览器 mock 里没有 Rust 进程
 *   （tauri-mock 未实现该命令），那部分由 `fs_cmds.rs` 的 impl 级单测覆盖。
 *   文件经 FS bridge 落在真实临时目录，read_file 走真实磁盘。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

const PY = ["def calculate_total(price, quantity):", "    total = price * quantity", "    return total", ""].join("\n");
const TXT = ["notes 2024: 42 items", "42 again", ""].join("\n");

let repo: GitRepo;
const pageErrors: string[] = [];

async function openFile(page: Page, name: string): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: name }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
}

async function openSearchView(page: Page): Promise<void> {
  await page.locator('[data-view="search"], #tab-search').first().click();
  await expect(page.locator("#view-search")).toBeVisible({ timeout: 5_000 });
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "calc.py": PY, "note.txt": TXT });
  await equipPage(page, repo);
  await page.goto("/");
  await openFile(page, "calc.py");
  // 注意：搜索视图打开后文件树不可见（侧栏单视图），需要开文件的动作必须在此之前完成
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-DX-SR1 正则开关：同一查询串 关=无匹配 开=3 处命中", async ({ page }) => {
  await openSearchView(page);
  const input = page.locator("#search-input");
  await page.locator("#search-scope").selectOption("file");

  // 关（默认子串）：`t.tal` 是字面串，文件里没有 → 空态
  await input.fill("t.tal");
  await input.press("Enter");
  await expect(page.locator("#search-results")).toContainText("无匹配结果", { timeout: 10_000 });

  // 开：`t.tal` 作为正则匹配 total（calculate_total / total / return total）
  await page.locator("#search-regex").click();
  await expect(page.locator("#search-regex")).toHaveAttribute("aria-pressed", "true");
  await input.press("Enter");
  await expect(page.locator("#search-results .search-summary")).toContainText("3 个匹配", { timeout: 10_000 });
});

test("E-DX-SR2 文件掩码：*.py 把 .txt 排除在外", async ({ page }) => {
  await openFile(page, "note.txt"); // 趁文件树可见时开第二个标签
  await openSearchView(page);
  const input = page.locator("#search-input");
  await page.locator("#search-scope").selectOption("tabs");

  // 掩码前：note.txt 两条（"… 42 items" / "42 again"）
  await input.fill("42");
  await input.press("Enter");
  await expect(page.locator("#search-results .search-summary")).toContainText("2 个匹配", { timeout: 10_000 });
  await expect(page.locator("#search-results")).toContainText("note.txt");

  // 掩码 *.py → .txt 不参与
  await page.locator("#search-mask").fill("*.py");
  await page.locator("#search-mask").press("Enter");
  await expect(page.locator("#search-results")).toContainText("无匹配结果", { timeout: 10_000 });
  await expect(page.locator("#search-results")).not.toContainText("note.txt");
});

test("E-DX-SR3 非法正则有明确提示，不静默降级", async ({ page }) => {
  await openSearchView(page);
  const input = page.locator("#search-input");
  await page.locator("#search-scope").selectOption("file");
  await page.locator("#search-regex").click();
  await input.fill("foo(");
  await input.press("Enter");
  await expect(page.locator("#search-results")).toContainText("正则表达式无效", { timeout: 10_000 });
});
