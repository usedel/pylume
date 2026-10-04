/**
 * E2E：会话恢复（A-5，PyCharm 调研）
 *
 *  - S-1 重开应用后恢复标签 / 未保存草稿 / 光标位置（含脏标记）
 *  - S-2 无快照时干净启动（不恢复、不报错）
 *
 * 「重开」用 page.reload() 模拟：走 autoOpenRecentWorkspace → openWorkspace → restoreSession
 * 的真实启动链路（不是直接调内部函数）。快照由 tauri-mock 存 sessionStorage
 * （addInitScript 每次导航重跑会清模块级变量，sessionStorage 跨 reload 仍在）。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

let repo: GitRepo;
const pageErrors: string[] = [];

/** 读取当前标签/草稿/光标状态（经 state.ts，与真实运行时同一模块实例） */
function sessionFacts(page: Page) {
  return page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const a = app.tabs.find((t: { path: string }) => t.path.endsWith("a.py"));
    return {
      count: app.tabs.length,
      hasA: !!a,
      dirtyA: !!a?.dirty,
      threePresent: !!a?.model?.getValue().includes("three = 3"),
      activeIsA: !!app.activeTab?.path?.endsWith("a.py"),
      line: app.editor?.getPosition()?.lineNumber ?? 0,
    };
  });
}

async function openFile(page: Page, name: string): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: name }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makeGitRepo({
    files: { "a.py": "one = 1\ntwo = 2\n", "b.py": "print('b')\n" },
    commitMsg: "baseline",
  });
  await equipPage(page, repo);
});

test.afterEach(() => {
  // 「Canceled: Canceled」是 reload 导航取消在途请求的标准伪影（本 spec 是唯一用 reload
  // 模拟重启的用例），非应用缺陷，过滤之。
  const real = pageErrors.filter((e) => !e.includes("Canceled"));
  expect(real, real.join("\n")).toEqual([]);
});

test("S-1 重开应用后恢复标签 / 草稿 / 光标（含脏标记）", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  await openFile(page, "a.py");
  await openFile(page, "b.py");
  // 回到 a.py：追加一行（变脏）+ 把光标放到第 3 行
  await page.locator("#tabbar .tab", { hasText: "a.py" }).first().click();
  // 聚焦走 editor.focus()（直接点 .monaco-editor textarea 会被文本层拦截 pointer events）
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    app.editor.setPosition({ lineNumber: 2, column: 1 });
    app.editor.focus();
  });
  await expect(page.locator(".monaco-editor textarea")).toBeFocused({ timeout: 5_000 });
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nthree = 3");
  // 光标停在第 3 行（恢复后应落回此处）
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    app.editor.setPosition({ lineNumber: 3, column: 3 });
  });
  await page.waitForTimeout(1500); // 防抖 800ms + 余量，快照已落 sessionStorage

  // 重启应用：reload → autoOpenRecentWorkspace → openWorkspace → restoreSession
  await page.reload();
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });

  await expect
    .poll(() => sessionFacts(page), { timeout: 15_000 })
    .toEqual(
      expect.objectContaining({
        count: 2, // 两个标签都回来
        hasA: true,
        dirtyA: true, // 仍是脏的（草稿未落盘）
        threePresent: true, // 未保存的编辑还在
        activeIsA: true, // 激活的是上次活动的 a.py
        line: 3, // 光标落回第 3 行
      }),
    );
});

test("S-2 无快照时干净启动（不恢复、不报错）", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
  // 全新工作区无会话文件 → 不应凭空打开标签
  await expect.poll(() => sessionFacts(page), { timeout: 10_000 }).toEqual(
    expect.objectContaining({ count: 0, hasA: false }),
  );
});
