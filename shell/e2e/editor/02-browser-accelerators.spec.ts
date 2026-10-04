/**
 * E2E：浏览器原生加速器护栏（browserKeys.ts）
 *
 * 说明：Playwright 的 headless Chromium **不响应**浏览器加速器（裸页按 Ctrl+R 也不重载，
 * 已用正对照验证），故这里不测「浏览器真的没动作」，而是测护栏契约：
 *  1. 应用未认领的组合派发到侧栏输入框 → 被 preventDefault（浏览器拿不到）；
 *  2. 应用已认领的组合（Ctrl+S / Ctrl+Shift+R / Ctrl+Shift+P）同样被 preventDefault
 *     ——main.ts 在输入框内会整段跳过，这正是原先的泄漏口；
 *  3. 未列入清单的普通组合（Ctrl+A）不被拦；
 *  4. 认领的组合不能被吞掉动作：真按 Ctrl+Shift+P 仍能打开命令面板。
 */
import { test, expect } from "@playwright/test";
import { equipPage, makePlainDir } from "../helpers";

/** 在指定元素上派发 keydown，返回是否被 preventDefault */
async function fire(
  page: import("@playwright/test").Page,
  sel: string,
  init: { key: string; code: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean },
): Promise<boolean> {
  return page.evaluate(
    ([s, i]) => {
      const el = document.querySelector(s);
      if (!el) throw new Error(`缺少元素 ${s}`);
      const ev = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...(i as KeyboardEventInit),
      });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    [sel, init] as const,
  );
}

test.beforeEach(async ({ page }) => {
  const repo = await makePlainDir({ "main.py": "alpha = 1\n" });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#tree .tree-item .name", { hasText: "main.py" }).first()).toBeVisible({ timeout: 20_000 });
  await page.locator("#tab-search").click(); // 露出 #search-input（输入框 = 原泄漏口）
  await expect(page.locator("#search-input")).toBeVisible({ timeout: 5_000 });
});

test("侧栏输入框内：浏览器加速器被护栏 preventDefault", async ({ page }) => {
  const blocked: Array<[string, Parameters<typeof fire>[2]]> = [
    ["Ctrl+R 重载", { key: "r", code: "KeyR", ctrlKey: true }],
    ["Ctrl+F5 硬重载", { key: "F5", code: "F5", ctrlKey: true }],
    ["Ctrl+P 打印", { key: "p", code: "KeyP", ctrlKey: true }],
    ["Ctrl+O 打开文件", { key: "o", code: "KeyO", ctrlKey: true }],
    ["Ctrl+U 查看源代码", { key: "u", code: "KeyU", ctrlKey: true }],
    ["Ctrl+W 关窗口", { key: "w", code: "KeyW", ctrlKey: true }],
    ["Ctrl+Shift+Delete 清数据", { key: "Delete", code: "Delete", ctrlKey: true, shiftKey: true }],
    ["F7 插入符浏览", { key: "F7", code: "F7" }],
    ["Alt+ArrowLeft 后退", { key: "ArrowLeft", code: "ArrowLeft", altKey: true }],
    ["Ctrl+D 书签", { key: "d", code: "KeyD", ctrlKey: true }],
    ["Ctrl+H 历史", { key: "h", code: "KeyH", ctrlKey: true }],
    ["F3 查找下一个", { key: "F3", code: "F3" }],
  ];
  for (const [label, init] of blocked) {
    expect(await fire(page, "#search-input", init), label).toBe(true);
  }
});

test("应用认领的组合：输入框内也阻断浏览器，且不吞掉自身动作", async ({ page }) => {
  // 认领但焦点在输入框时 main.ts 整段跳过 → 护栏补 preventDefault
  expect(await fire(page, "#search-input", { key: "s", code: "KeyS", ctrlKey: true }), "Ctrl+S 保存").toBe(true);
  expect(await fire(page, "#search-input", { key: "R", code: "KeyR", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+R 运行历史").toBe(true);
  expect(await fire(page, "#search-input", { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+P 命令面板").toBe(true);
  // 未列入清单的普通组合不被拦（Ctrl+A 全选照常）
  expect(await fire(page, "#search-input", { key: "a", code: "KeyA", ctrlKey: true }), "Ctrl+A 全选").toBe(false);

  // 真按键（焦点移出输入框，走 main.ts 正常分发）：命令面板仍打得开
  // ——护栏对认领组合只 preventDefault、不 stopPropagation
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press("Control+Shift+P");
  await expect(page.locator("#quick-open-input")).toBeVisible({ timeout: 5_000 });
});
