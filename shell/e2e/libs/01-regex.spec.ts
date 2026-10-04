/**
 * 库特别支持 · 正则测试器 E2E 验收（PR-2，docs/python_library_support_dev_plan.md §4.3）。
 *
 * 覆盖：
 *  1. lens 入口带入当前正则（🧪 测试正则 → 面板预填模式）
 *  2. 输入测试串 → 匹配表 + 高亮（py_eval mock 预置匹配数据）
 *  3. 非法模式 → re.error 原文（mock err 态）+ caret 定位
 *  4. 超时 / 无解释器两态（mock 切换）
 *  5. sourceDirty 后「替换字面量」置灰
 *  6. 切走再切回输入不丢（面板实例缓存）
 *  7. 360px 下 flags 换行不被裁切（缺陷 #19）
 */
import { expect, test, type Page } from "@playwright/test";
import { equipPage, makePlainDir } from "../helpers";

const REGEX_PY = [
  "import re",
  "",
  'pattern = re.compile(r"\\d+", re.I)',
  'm = pattern.search("abc 123")',
  "print(m)",
  "",
].join("\n");

async function equip(page: Page, files: Record<string, string> = { "main.py": REGEX_PY }): Promise<string> {
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

/** 确保工具面板为打开态（toggle 语义防歧义：先归零再打开） */
async function openPanelFresh(page: Page): Promise<void> {
  const panelOpen = await page.locator("#right-panel:not(.hidden)").count();
  if (panelOpen > 0) {
    await page.locator("#devtools-close").click();
    await page.waitForTimeout(200);
  }
  await page.keyboard.press("Control+Shift+T");
  await expect(page.locator("#devtools-picker")).toBeVisible({ timeout: 5_000 });
}

async function openTool(page: Page, title: string): Promise<void> {
  await openPanelFresh(page);
  await page.locator("#devtools-picker-search").fill(title);
  await expect(page.locator(".picker-item")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.locator("#devtools-current")).toContainText(title);
}

/** 经文件树打开 main.py 并等待编辑器就绪 */
async function openMainPy(page: Page): Promise<void> {
  await page.locator('.tree-item.file[data-path*="main.py"]').first().dblclick();
  await expect(page.locator("#tabbar .tab", { hasText: "main.py" })).toBeVisible({ timeout: 5_000 });
}

test.describe("正则测试器（库支持 PR-2）", () => {
  test("01 lens 入口带入当前正则", async ({ page }) => {
    await equip(page);
    await openMainPy(page);
    // CodeLens 渲染「🧪 测试正则」→ 点击 → 面板预填 r"\d+"（值域 \d+）
    const lens = page.locator("span.codelens-decoration", { hasText: "测试正则" }).first();
    await expect(lens).toBeVisible({ timeout: 10_000 });
    await lens.click();
    await expect(page.locator("#devtools-current")).toContainText("正则测试器");
    await expect(page.locator("#rx-pattern")).toHaveValue("\\d+");
  });

  test("02 输入测试串 → 匹配表与高亮（预置 mock 匹配数据）", async ({ page }) => {
    await equip(page);
    // 预置两处匹配（mock 数据域：span 相对测试文本）
    await page.evaluate(() => {
      (window as unknown as { __E2E_PY_EVAL__?: object }).__E2E_PY_EVAL__ = {
        data: {
          match: { span: [4, 7], groups: ["123"], named: {} },
          matches: [
            { span: [4, 7], groups: ["123"], named: {} },
            { span: [9, 10], groups: ["8"], named: {} },
          ],
          count: 2,
          truncated: false,
        },
      };
    });
    await openTool(page, "正则测试器");
    await page.locator("#rx-pattern").fill("\\d");
    // 输入测试串（Monaco 可编辑测试区）
    await page.locator("#rx-test .monaco-editor").last().click();
    await page.keyboard.type("abc 123 x8");
    await expect(page.locator("#rx-table tbody tr")).toHaveCount(2);
    await expect(page.locator("#rx-status")).toContainText("共 2 处");
    // 奇偶交替高亮已落 DOM（Monaco decoration span）
    await expect(page.locator("#rx-test .oc-regex-hit-a").first()).toBeVisible();
    // 点击匹配行 → 选中加边框，且奇偶交替底色保留（§11.3.2：独立装饰集合，不互相覆盖）
    await page.locator("#rx-table tbody tr").first().click();
    await expect(page.locator("#rx-test .oc-regex-hit-sel").first()).toBeVisible();
    await expect(page.locator("#rx-test .oc-regex-hit-a").first()).toBeVisible();
  });

  test("03 非法模式 → re.error 原文（mock err 态）", async ({ page }) => {
    await equip(page);
    await page.evaluate(() => {
      (window as unknown as { __E2E_PY_EVAL__?: object }).__E2E_PY_EVAL__ = {
        mode: "err",
        error: "re.error: bad escape (end of pattern) at position 1",
      };
    });
    await openTool(page, "正则测试器");
    // 悬空反斜杠：静态诊断不拦（括号/命名组/区间之外），由真实 re 引擎报错 → 原文透传
    await page.locator("#rx-pattern").fill("a\\");
    await expect(page.locator("#rx-status")).toContainText("re.error");
    await expect(page.locator("#rx-status")).toContainText("at position 1");
  });

  test("04 超时 / 无解释器两态（mock 切换）", async ({ page }) => {
    await equip(page);
    await openTool(page, "正则测试器");
    // 超时态
    await page.evaluate(() => {
      (window as unknown as { __E2E_PY_EVAL__?: object }).__E2E_PY_EVAL__ = { mode: "timeout" };
    });
    await page.locator("#rx-pattern").fill("\\d+");
    await expect(page.locator("#rx-status")).toContainText("求值超时");
    // 无解释器态
    await page.evaluate(() => {
      (window as unknown as { __E2E_PY_EVAL__?: object }).__E2E_PY_EVAL__ = { mode: "noInterpreter" };
    });
    await page.locator("#rx-pattern").fill("\\w+");
    await expect(page.locator("#rx-status")).toContainText("未配置工作区解释器");
    // §11.2 / §11.3.3：求值产出区整块置灰 + [设置解释器] 引导按钮
    await expect(page.locator("#rx-eval-zone")).toHaveClass(/is-disabled/);
    await expect(page.locator("#rx-guide")).toBeVisible();
    await expect(page.locator("#rx-open-settings")).toBeVisible();
    // 恢复 ok 态后置灰撤销
    await page.evaluate(() => {
      (window as unknown as { __E2E_PY_EVAL__?: object }).__E2E_PY_EVAL__ = { data: { match: null, matches: [], count: 0, truncated: false } };
    });
    await page.locator("#rx-pattern").fill("\\w");
    await expect(page.locator("#rx-status")).toContainText("无匹配");
    await expect(page.locator("#rx-eval-zone")).not.toHaveClass(/is-disabled/);
    await expect(page.locator("#rx-guide")).toBeHidden();
  });

  test("05 sourceDirty 后替换字面量置灰", async ({ page }) => {
    await equip(page);
    await openMainPy(page);
    const lens = page.locator("span.codelens-decoration", { hasText: "测试正则" }).first();
    await expect(lens).toBeVisible({ timeout: 10_000 });
    await lens.click();
    await expect(page.locator("#rx-pattern")).toHaveValue("\\d+");
    // 未手改 → 可写回
    await expect(page.locator("#rx-replace")).toBeEnabled();
    // 手改一个字符 → sourceDirty → 置灰
    await page.locator("#rx-pattern").fill("\\d+ ");
    await expect(page.locator("#rx-replace")).toBeDisabled();
  });

  test("06 切走再切回输入不丢", async ({ page }) => {
    await equip(page);
    await openTool(page, "正则测试器");
    await page.locator("#rx-pattern").fill("(a|b)+");
    // 切到另一工具再切回（面板 LRU 缓存，不销毁实例）
    await page.locator("#devtools-current").click();
    await page.locator("#devtools-picker-search").fill("UUID 生成");
    await page.keyboard.press("Enter");
    await expect(page.locator("#devtools-current")).toContainText("UUID");
    await page.locator("#devtools-current").click();
    await page.locator("#devtools-picker-search").fill("正则测试器");
    await page.keyboard.press("Enter");
    await expect(page.locator("#rx-pattern")).toHaveValue("(a|b)+");
  });

  test("07 360px 下 flags 换行不被裁切", async ({ page }) => {
    await equip(page);
    await openTool(page, "正则测试器");
    await page.setViewportSize({ width: 360, height: 800 });
    const flagsBox = await page.locator("#rx-flags").boundingBox();
    const rootBox = await page.locator("#devtools-body").boundingBox();
    expect(flagsBox).not.toBeNull();
    expect(rootBox).not.toBeNull();
    // flags 容器整体落在面板可视宽度内（flex-wrap 换行而非溢出裁切）
    expect(flagsBox!.x).toBeGreaterThanOrEqual(rootBox!.x - 1);
    expect(flagsBox!.x + flagsBox!.width).toBeLessThanOrEqual(rootBox!.x + rootBox!.width + 1);
  });
});
