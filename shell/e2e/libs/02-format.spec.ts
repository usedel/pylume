/**
 * 库特别支持 · 格式串工具 E2E 验收（PR-3，docs/python_library_support_dev_plan.md §5）。
 *
 * 覆盖：三模式切换 · chips 插入光标处 · 预览结果（mock ok）· hover 分段解释 ·
 * 未知码诊断（squiggly-warning）· 降级置灰（noInterpreter mock）。
 */
import { expect, test, type Page } from "@playwright/test";
import { equipPage, makePlainDir } from "../helpers";

const FORMAT_PY = [
  "from datetime import datetime",
  "",
  "now = datetime.now()",
  's = now.strftime("%Y-%m-%d")',
  'bad = now.strftime("%Q")',
  "print(s, bad)",
  "",
].join("\n");

async function equip(page: Page, files: Record<string, string> = { "main.py": FORMAT_PY }): Promise<string> {
  const repo = await makePlainDir(files);
  await equipPage(page, repo);
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`[console.${m.type()}] ${m.text().slice(0, 200)}`);
  });
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

async function openTool(page: Page, title: string): Promise<void> {
  const panelOpen = await page.locator("#right-panel:not(.hidden)").count();
  if (panelOpen > 0) {
    await page.locator("#devtools-close").click();
    await page.waitForTimeout(200);
  }
  await page.keyboard.press("Control+Shift+T");
  await expect(page.locator("#devtools-picker")).toBeVisible({ timeout: 5_000 });
  await page.locator("#devtools-picker-search").fill(title);
  await expect(page.locator(".picker-item")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.locator("#devtools-current")).toContainText(title);
}

test.describe("格式串工具（库支持 PR-3）", () => {
  test("01 三模式切换：chips 随模式变化", async ({ page }) => {
    await equip(page);
    await openTool(page, "格式串预览");
    await expect(page.locator("#fmt-chips .rx-chip").first()).toHaveText("%Y");
    await page.locator(".tool-radio", { hasText: "数字 format" }).click();
    await expect(page.locator("#fmt-chips .rx-chip").first()).toHaveText(".2f");
    await page.locator(".tool-radio", { hasText: "logging" }).click();
    await expect(page.locator("#fmt-chips .rx-chip").first()).toHaveText("%(asctime)s");
  });

  test("02 chips 点击插入光标处", async ({ page }) => {
    await equip(page);
    await openTool(page, "格式串预览");
    // 无选区 → 插到末尾
    await page.locator("#fmt-input").fill("%Y");
    await page.locator('#fmt-chips .rx-chip[aria-label*="两位日期"]').click();
    await expect(page.locator("#fmt-input")).toHaveValue("%Y%d");
  });

  test("03 预览结果（mock ok）", async ({ page }) => {
    await equip(page);
    await page.evaluate(() => {
      (window as unknown as { __E2E_PY_EVAL__?: object }).__E2E_PY_EVAL__ = {
        data: { result: "2026-09-27" },
      };
    });
    await openTool(page, "格式串预览");
    await page.locator("#fmt-input").fill("%Y-%m-%d");
    await expect(page.locator("#fmt-out .view-lines")).toContainText("2026-09-27", { timeout: 5_000 });
  });

  test("04 hover 分段解释（strftime 字面量）", async ({ page }) => {
    await equip(page);
    await page.locator('.tree-item.file[data-path*="main.py"]').first().dblclick();
    await expect(page.locator("#tabbar .tab", { hasText: "main.py" })).toBeVisible({ timeout: 5_000 });
    // 悬停须落在字面量实际字符上：对目标行横向扫掠，命中字面量后 hover 弹出
    //（lsp hover 先例同款：循环内重取 box + 分步 mousemove + 整体重试）。
    const line = page.locator("#editor .monaco-editor .view-line", { hasText: 'strftime("%Y-%m-%d")' }).first();
    await expect(line).toBeVisible({ timeout: 10_000 });
    await expect(async () => {
      const lineBox = (await line.boundingBox())!;
      expect(lineBox).not.toBeNull();
      const y = lineBox.y + lineBox.height / 2;
      // 像素级扫掠 + 每档停顿：Monaco hover 有延迟计时器，连续移动会不断重置导致 provider 永不触发
      for (const dx of [130, 150, 170, 190, 110, 210, 90]) {
        await page.mouse.move(lineBox.x + dx, y, { steps: 2 });
        await page.waitForTimeout(500); // hover delay（默认 300ms）+ provider 查询
        const hover = page.locator(".monaco-hover:not(.hidden)").first();
        if ((await hover.count()) > 0) break;
      }
      const hover = page.locator(".monaco-hover:not(.hidden)").first();
      await expect(hover).toContainText("日期 strftime", { timeout: 1_000 });
    }, { timeout: 15_000 }).toPass();
    const hover = page.locator(".monaco-hover:not(.hidden)").first();
    await expect(hover).toContainText("四位年份");
  });

  test("05 未知码诊断（%Q → warning 波浪线）", async ({ page }) => {
    await equip(page);
    await page.locator('.tree-item.file[data-path*="main.py"]').first().dblclick();
    await expect(page.locator("#tabbar .tab", { hasText: "main.py" })).toBeVisible({ timeout: 5_000 });
    // pylume-libs 桶下发 warning marker → Monaco 渲染 .squiggly-warning
    await expect(page.locator(".monaco-editor .squiggly-warning").first()).toBeVisible({ timeout: 10_000 });
  });

  test("06 降级：无解释器 → 预览置灰 + 速查表照常", async ({ page }) => {
    await equip(page);
    await page.evaluate(() => {
      (window as unknown as { __E2E_PY_EVAL__?: object }).__E2E_PY_EVAL__ = { mode: "noInterpreter" };
    });
    await openTool(page, "格式串预览");
    await page.locator("#fmt-input").fill("%Y");
    await expect(page.locator("#fmt-status")).toContainText("未配置工作区解释器");
    await expect(page.locator("#fmt-out")).toHaveClass(/fmt-out--degraded/);
    // 速查表照常可用（插入仍生效）
    await page.locator('#fmt-chips .rx-chip[aria-label*="两位日期"]').click();
    await expect(page.locator("#fmt-input")).toHaveValue("%Y%d");
  });
});
