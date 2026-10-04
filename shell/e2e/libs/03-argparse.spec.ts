/**
 * 库特别支持 · 脚本参数表单 E2E 验收（PR-4，docs/python_library_support_dev_plan.md §6）。
 *
 * 覆盖：解析出参数 → 表单渲染（下拉/勾选/文本框）→ 拼出命令行 → 保存到运行配置 →
 * 手工改命令行后标注不一致 → 无参数脚本的空态 → lens 入口（⚙ N 个参数 → 聚焦参数区，D-3）。
 */
import { expect, test, type Page } from "@playwright/test";
import { equipPage, makePlainDir } from "../helpers";

const ARGPARSE_PY = [
  "import argparse",
  "",
  "parser = argparse.ArgumentParser()",
  'parser.add_argument("--input", required=True, help="输入文件")',
  'parser.add_argument("--lang", default="zh", choices=["zh", "en"])',
  'parser.add_argument("--verbose", action="store_true")',
  'parser.add_argument("-n", "--count", type=int, default=1)',
  "args = parser.parse_args()",
  "print(args)",
  "",
].join("\n");

const EMPTY_PY = "print('no args')\n";

/** 与 ast_argparse 产出同形的参数表（mock 预置） */
const PARAMS = [
  { name: "input", flag: "--input", type: "str", default: null, required: true, help: "输入文件", choices: null, source: "argparse" },
  { name: "lang", flag: "--lang", type: "str", default: "zh", required: false, help: null, choices: ["zh", "en"], source: "argparse" },
  { name: "verbose", flag: "--verbose", type: "bool", default: null, required: false, help: null, choices: null, source: "argparse" },
  { name: "count", flag: "-n", type: "int", default: 1, required: false, help: null, choices: null, source: "argparse" },
];

async function equip(page: Page, files: Record<string, string>): Promise<string> {
  const repo = await makePlainDir(files);
  await equipPage(page, repo);
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto("/");
  await expect(page.locator("#editor")).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const log = (window as unknown as { __TAURI_MOCK_INVOKE_LOG__?: string[] }).__TAURI_MOCK_INVOKE_LOG__ ?? [];
        return log.some((x) => x.startsWith("list_plugin_dirs")) && document.querySelectorAll(".menubar-item").length > 0 ? 1 : 0;
      }),
    )
    .toBe(1);
  return repo;
}

async function openMainPy(page: Page): Promise<void> {
  await page.locator('.tree-item.file[data-path*="main.py"]').first().dblclick();
  await expect(page.locator("#tabbar .tab", { hasText: "main.py" })).toBeVisible({ timeout: 5_000 });
}

async function openRunConfigPanel(page: Page): Promise<void> {
  await page.locator("#btn-run-config").click();
  await expect(page.locator("#run-config-modal")).toBeVisible({ timeout: 5_000 });
}

test.describe("脚本参数表单（库支持 PR-4）", () => {
  test("01 解析参数 → 表单渲染（下拉/勾选/文本框）", async ({ page }) => {
    await equip(page, { "main.py": ARGPARSE_PY });
    await page.evaluate((params) => {
      (window as unknown as { __E2E_PY_EVAL__?: object }).__E2E_PY_EVAL__ = { data: { params } };
    }, PARAMS);
    await openMainPy(page);
    await openRunConfigPanel(page);
    await expect(page.locator("#run-config-args-form")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("#ra-head")).toContainText("4 项");
    // choices → 下拉；store_true → 勾选；普通 str → 文本框
    await expect(page.locator("#ra-input")).toHaveAttribute("type", "text");
    await expect(page.locator("#ra-lang")).toBeVisible();
    await expect(page.locator("#ra-verbose")).toHaveAttribute("type", "checkbox");
    await expect(page.locator("#ra-count")).toHaveAttribute("type", "number");
    // default 作占位符（不是值）
    await expect(page.locator("#ra-count")).toHaveAttribute("placeholder", "1");
    await expect(page.locator("#ra-count")).toHaveValue("");
  });

  test("02 表单 → 拼出命令行", async ({ page }) => {
    await equip(page, { "main.py": ARGPARSE_PY });
    await page.evaluate((params) => {
      (window as unknown as { __E2E_PY_EVAL__?: object }).__E2E_PY_EVAL__ = { data: { params } };
    }, PARAMS);
    await openMainPy(page);
    await openRunConfigPanel(page);
    await expect(page.locator("#ra-input")).toBeVisible({ timeout: 5_000 });
    await page.locator("#ra-input").fill("a.csv");
    await page.locator("#ra-lang").selectOption("en");
    await page.locator("#ra-verbose").check();
    await expect(page.locator("#run-config-args")).toHaveValue("--input a.csv --lang en --verbose");
  });

  test("03 保存到运行配置", async ({ page }) => {
    await equip(page, { "main.py": ARGPARSE_PY });
    await page.evaluate((params) => {
      (window as unknown as { __E2E_PY_EVAL__?: object }).__E2E_PY_EVAL__ = { data: { params } };
    }, PARAMS);
    await openMainPy(page);
    await openRunConfigPanel(page);
    await expect(page.locator("#ra-input")).toBeVisible({ timeout: 5_000 });
    await page.locator("#ra-input").fill("a.csv");
    await expect(page.locator("#run-config-args")).toHaveValue("--input a.csv");
    await page.locator("#run-config-save").click();
    await expect(page.locator(".toast", { hasText: "已保存脚本运行配置" })).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(() =>
        page.evaluate(() =>
          ((window as unknown as { __TAURI_MOCK_INVOKE_LOG__?: string[] }).__TAURI_MOCK_INVOKE_LOG__ ?? []).some((x) => x.startsWith("set_run_config")),
        ),
      )
      .toBe(true);
  });

  test("04 手工改命令行后标注不一致（以命令行为准）", async ({ page }) => {
    await equip(page, { "main.py": ARGPARSE_PY });
    await page.evaluate((params) => {
      (window as unknown as { __E2E_PY_EVAL__?: object }).__E2E_PY_EVAL__ = { data: { params } };
    }, PARAMS);
    await openMainPy(page);
    await openRunConfigPanel(page);
    await expect(page.locator("#ra-input")).toBeVisible({ timeout: 5_000 });
    await page.locator("#run-config-args").fill("--input a.csv --wat x");
    await expect(page.locator("#ra-sync-note")).toContainText("不一致");
    await expect(page.locator("#ra-sync-note")).toContainText("以命令行为准");
    // 表单值未被静默覆盖
    await expect(page.locator("#ra-input")).toHaveValue("");
  });

  test("05 无参数脚本 → 空态（不阻止运行）", async ({ page }) => {
    await equip(page, { "main.py": EMPTY_PY });
    await page.evaluate(() => {
      (window as unknown as { __E2E_PY_EVAL__?: object }).__E2E_PY_EVAL__ = { data: { params: [] } };
    });
    await openMainPy(page);
    await openRunConfigPanel(page);
    await expect(page.locator("#ra-note")).toContainText("未声明命令行参数", { timeout: 5_000 });
    // 纯输入框仍可用
    await page.locator("#run-config-args").fill("--anything");
    await expect(page.locator("#run-config-args")).toHaveValue("--anything");
  });

  test("06 lens 入口：⚙ N 个参数 → 打开运行面板并聚焦参数区（D-3）", async ({ page }) => {
    await equip(page, { "main.py": ARGPARSE_PY });
    await page.evaluate((params) => {
      (window as unknown as { __E2E_PY_EVAL__?: object }).__E2E_PY_EVAL__ = { data: { params } };
    }, PARAMS);
    await openMainPy(page);
    const lens = page.locator("span.codelens-decoration", { hasText: "个参数" }).first();
    await expect(lens).toBeVisible({ timeout: 10_000 });
    await lens.click();
    await expect(page.locator("#run-config-modal")).toBeVisible({ timeout: 5_000 });
    // 参数区聚焦（document.activeElement = 参数输入框）
    await expect
      .poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.id ?? ""))
      .toBe("run-config-args");
  });
});
