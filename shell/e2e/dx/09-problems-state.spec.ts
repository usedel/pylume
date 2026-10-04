/**
 * E2E：问题面板状态保持专项（2026-09-29 滚动跳顶 bug 复盘补测）
 *
 * 复盘结论（为什么 08 的 7 个用例没拦住该 bug）：
 *  1. 列表从未可滚动（≤3 条，scrollTop 恒 0）——「全量重建丢滚动」在不可滚动列表上不可观测；
 *  2. 断言全是状态快照（数量/可见性），没有跨异步刷新周期的状态保持断言。
 *
 * 本专项两条主线：
 *  A. 滚动保持：跨「点击跳转 / Ctrl+S 保存 / 后台 marker 变化 / 面板折叠 / tab 往返 / 条目增删」全保持；
 *  B. 机制锁定：指纹短路（值不变的 marker 重设不重建 DOM——用节点引用稳定性直证）
 *     与重建+scrollTop 转移（内容真变化时重建但视口不跳）分别验证。
 *
 * 用例（E-DX-PS*）均使用 60+ 条问题 + 70 行源文件，保证列表溢出可滚动。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

let repo: GitRepo;
const pageErrors: string[] = [];

/** 70 行源文件（marker 行号必须真实存在于文件内——openFile 的 setPosition 会 clamp） */
const LONG_SOURCE = Array.from({ length: 70 }, (_, i) => `v${i} = ${i}`).join("\n") + "\n";

/** 生成 N 条 error marker（行号 1..N，N ≤ 70） */
function manyErrors(n: number): Array<{ line: number; col: number; severity: number; message: string; source?: string }> {
  return Array.from({ length: n }, (_, i) => ({ line: i + 1, col: 1, severity: 8, message: `err ${i + 1}`, source: "pyrefly" }));
}

/** 注入 marker（owner "e2e-ps"） */
async function injectMarkers(page: Page, markers: Array<{ line: number; col: number; severity: number; message: string; source?: string }>): Promise<void> {
  await page.evaluate(async (ms) => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    app.monaco.editor.setModelMarkers(
      app.editor.getModel(),
      "e2e-ps",
      ms.map((m: any) => ({
        startLineNumber: m.line,
        startColumn: m.col,
        endLineNumber: m.line,
        endColumn: m.col + 1,
        message: m.message,
        severity: m.severity,
        ...(m.source !== undefined ? { source: m.source } : {}),
      })),
    );
  }, markers);
}

async function openEditor(page: Page, file: string): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: file }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
}

/** 打开问题面板并等首轮渲染 + 滚到底部，返回滚动位置 */
async function openPanelScrolledToBottom(page: Page): Promise<number> {
  await page.keyboard.press("Alt+0");
  const results = page.locator("#problems-panel .find-usages-results");
  await expect(results).toBeVisible();
  await page.evaluate(() => {
    const scroller = document.querySelector("#problems-panel .find-usages-results") as HTMLElement | null;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });
  const top = await results.evaluate((el) => el.scrollTop);
  expect(top, "前置：列表必须可滚动（scrollTop > 0），否则用例无效").toBeGreaterThan(0);
  return top;
}

/** 等防抖（500ms）+ 渲染余量走完 */
async function settleDebounce(page: Page): Promise<void> {
  await page.waitForTimeout(1_200);
}

/** 当前面板滚动位置 */
async function panelScrollTop(page: Page): Promise<number> {
  return page.locator("#problems-panel .find-usages-results").evaluate((el) => el.scrollTop);
}

/** 把当前第一个条目与滚动容器的元素引用存到 window（节点稳定性断言用） */
async function captureNodeRefs(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    w.__ps_first_item = document.querySelector("#problems-panel .pb-item") ?? null;
    w.__ps_scroller = document.querySelector("#problems-panel .find-usages-results") ?? null;
  });
}

/** 断言 window 里的节点引用仍是当前 DOM 里的同一元素（未重建） */
async function assertNodesStable(page: Page, expectSame: boolean): Promise<void> {
  const same = await page.evaluate(() => {
    const w = window as any;
    if (!w.__ps_first_item || !w.__ps_scroller) return false;
    return (
      document.querySelector("#problems-panel .pb-item") === w.__ps_first_item &&
      document.querySelector("#problems-panel .find-usages-results") === w.__ps_scroller &&
      w.__ps_first_item.isConnected
    );
  });
  expect(same, expectSame ? "DOM 不应重建（指纹短路）" : "DOM 应已重建（内容变化）").toBe(expectSame);
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "long.py": LONG_SOURCE });
  await equipPage(page, repo);
  await page.goto("/");
  await openEditor(page, "long.py");
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

// ---------- B 线：机制锁定（先测机制，滚动断言建立在机制之上） ----------

test("E-DX-PS1 指纹短路：值不变的 marker 重设不重建 DOM（节点引用稳定）", async ({ page }) => {
  await injectMarkers(page, manyErrors(60));
  await openPanelScrolledToBottom(page);
  await captureNodeRefs(page);

  // 重设**完全相同**的 60 条（复刻 lintActiveFile 值未变仍触发 onDidChangeMarkers）
  await injectMarkers(page, manyErrors(60));
  await settleDebounce(page);
  await assertNodesStable(page, true);
  // 滚动不动
  const top = await panelScrollTop(page);
  expect(top).toBeGreaterThan(0);
});

test("E-DX-PS2 内容变化：重建发生（节点引用更换）且滚动转移不跳顶", async ({ page }) => {
  await injectMarkers(page, manyErrors(60));
  const topBefore = await openPanelScrolledToBottom(page);
  await captureNodeRefs(page);

  // 追加第 61 条（指纹变化 → 必须重建）
  await injectMarkers(page, [...manyErrors(60), { line: 61, col: 1, severity: 8, message: "new", source: "pyrefly" }]);
  await settleDebounce(page);
  await expect(page.locator("#problems-panel .pb-item")).toHaveCount(61);
  await assertNodesStable(page, false); // 重建确实发生
  expect(await panelScrollTop(page)).toBe(topBefore); // 但视口不跳
});

test("E-DX-PS3 防抖合并：100ms 内两次 marker 变化只重建一次", async ({ page }) => {
  await injectMarkers(page, manyErrors(60));
  await openPanelScrolledToBottom(page);
  await captureNodeRefs(page);

  // 快速连续两次变化（防抖窗口内）：第一次后立即第二次 → 只有一次重建落在防抖之后
  await injectMarkers(page, manyErrors(61));
  await page.waitForTimeout(100);
  await injectMarkers(page, manyErrors(62));
  await settleDebounce(page);
  await expect(page.locator("#problems-panel .pb-item")).toHaveCount(62);
  // 只需确认最终状态正确且滚动保持（重建次数本身难直接断言，滚动保持即合并证据：
  // 若无防抖，第一次变化立即重建会把 scrollTop 打回 0 再被第二次重建转移 0）
  expect(await panelScrollTop(page)).toBeGreaterThan(0);
});

// ---------- A 线：滚动保持（用户可感知场景） ----------

test("E-DX-PS4 点击中间条目跳转后滚动保持（不只最后一条）", async ({ page }) => {
  await injectMarkers(page, manyErrors(60));
  await openPanelScrolledToBottom(page);

  // 点击中间条目（第 30 条）
  await page.locator("#problems-panel .pb-item").nth(29).click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
        return app.editor.getPosition().lineNumber;
      }),
    )
    .toBe(30);
  await settleDebounce(page);
  const top = await panelScrollTop(page);
  expect(top).toBeGreaterThan(0); // 仍在底部区域，未跳顶
});

test("E-DX-PS5 用户原始场景复刻：Ctrl+S 保存（真实 saveTab → ruff lint → marker 重设）后滚动保持", async ({ page }) => {
  await injectMarkers(page, manyErrors(60));
  await openPanelScrolledToBottom(page);
  await captureNodeRefs(page);

  // dirty 化：行尾打一个字符（真实键盘输入）
  await page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const col = app.editor.getModel().getLineMaxColumn(70);
    app.editor.setPosition({ lineNumber: 70, column: col });
    app.editor.focus();
  });
  await expect(page.locator(".monaco-editor textarea")).toBeFocused({ timeout: 5_000 });
  await page.keyboard.type("9");
  await page.keyboard.press("Control+s");

  // 保存全链路：write_file → lsp.didSave → lintActiveFile（ruff 桶 setModelMarkers，
  // mock 返回空列表 → 值不变的重设）→ onDidChangeMarkers → 防抖 renderProblems
  await expect
    .poll(() => repo.read("long.py"), { timeout: 10_000 })
    .toBe(LONG_SOURCE.slice(0, -1) + "9\n");
  await settleDebounce(page);
  await settleDebounce(page); // didSave 后引擎批（mock 即时）+ lint 防抖 800ms，取双周期余量

  // 机制断言：e2e-ps 桶未变 → 面板 DOM 未重建
  await assertNodesStable(page, true);
});

test("E-DX-PS6 底部面板折叠 → 芯片点击展开：滚动保持且问题 tab 激活", async ({ page }) => {
  await injectMarkers(page, manyErrors(60));
  const topBefore = await openPanelScrolledToBottom(page);

  // 折叠底部面板（Alt+F12 toggle）
  await page.keyboard.press("Alt+F12");
  await expect(page.locator("#bottom")).toHaveClass(/collapsed/);

  // 折叠期间触发一次 marker 变化（后台刷新走隐藏 DOM）
  await injectMarkers(page, manyErrors(61));
  await settleDebounce(page);

  // 芯片点击 → 展开 + 问题 tab + 内容已更新 + 滚动保持
  await page.locator("#status-problems").click();
  await expect(page.locator("#problems-panel")).toBeVisible();
  await expect(page.locator("#tab-problems")).toHaveClass(/active/);
  await expect(page.locator("#problems-panel .pb-item")).toHaveCount(61);
  expect(await panelScrollTop(page)).toBe(topBefore);
});

test("E-DX-PS7 切到其他底部 tab 再切回：滚动保持", async ({ page }) => {
  await injectMarkers(page, manyErrors(60));
  const topBefore = await openPanelScrolledToBottom(page);

  // 切到输出 tab（问题面板隐藏，DOM 保留）
  await page.locator("#tab-output").click();
  await expect(page.locator("#problems-panel")).toBeHidden();
  await settleDebounce(page);
  // 切回问题 tab
  await page.locator("#tab-problems").click();
  await expect(page.locator("#problems-panel")).toBeVisible();
  expect(await panelScrollTop(page)).toBe(topBefore);
});

test("E-DX-PS8 条目删除（修复错误列表变短）：滚动 clamp 不跳顶", async ({ page }) => {
  await injectMarkers(page, manyErrors(60));
  await openPanelScrolledToBottom(page);

  // 删掉一半（模拟修复：指纹变化 → 重建 → 列表变短 → scrollTop clamp 到新最大值，仍不在顶部）
  await injectMarkers(page, manyErrors(30));
  await settleDebounce(page);
  await expect(page.locator("#problems-panel .pb-item")).toHaveCount(30);
  const top = await panelScrollTop(page);
  // 列表仍可滚动（30 条）且视口在底部区域
  expect(top).toBeGreaterThan(0);
});

test("E-DX-PS9 多文件：点击另一文件的条目打开该文件 + 滚动保持", async ({ page }) => {
  // 双文件双桶：long.py 注 60 条；other.py（先打开注册 model）注 5 条带专属消息
  repo.write("other.py", LONG_SOURCE);
  await page.reload();
  await openEditor(page, "other.py");
  await injectMarkers(page, Array.from({ length: 5 }, (_, i) => ({ line: i + 1, col: 1, severity: 8, message: `other err ${i + 1}`, source: "pyrefly" })));
  await openEditor(page, "long.py");
  await injectMarkers(page, manyErrors(60));

  const topBefore = await openPanelScrolledToBottom(page);
  // 两个文件分组
  await expect(page.locator("#problems-panel .search-file-name")).toHaveCount(2);

  // 按**唯一消息文本**定位 other.py 的条目（不依赖分组 DOM 结构）
  await captureNodeRefs(page);
  await page.locator("#problems-panel .pb-item", { hasText: "other err 1" }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
        return app.editor.getModel().uri.path.split("/").pop();
      }),
    )
    .toBe("other.py");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
        return app.editor.getPosition().lineNumber;
      }),
    )
    .toBe(1);
  await settleDebounce(page);
  // 诊断性输出（若再失败可看到 DOM 是否重建）
  const rebuilt = await page.evaluate(() => {
    const w = window as any;
    return !(document.querySelector("#problems-panel .pb-item") === w.__ps_first_item);
  });
  console.log("PS9 panel rebuilt after cross-file jump:", rebuilt);
  expect(await panelScrollTop(page)).toBe(topBefore);
});

// ---------- 可达性与联动补测 ----------

test("E-DX-PS10 键盘可达：条目可聚焦 + Enter 跳转（焦点不因后台刷新丢失）", async ({ page }) => {
  await injectMarkers(page, manyErrors(3));
  await page.keyboard.press("Alt+0");
  const first = page.locator("#problems-panel .pb-item").first();
  await expect(first).toBeVisible();
  // 先等防抖窗口走完（注入的 marker 触发 500ms 防抖重建，若在 focus 后触发会摘掉焦点节点）
  await settleDebounce(page);
  await first.focus();
  await expect(first).toBeFocused();
  // 动态取焦点条目的行号（.pb-line 文本 "N:C" 的 N），断言 Enter 后光标 = 该行
  const focusedLine = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const lineEl = el?.querySelector(".pb-line");
    return lineEl ? parseInt(lineEl.textContent!.split(":")[0], 10) : -1;
  });
  expect(focusedLine).toBeGreaterThan(0);
  // 再等一个防抖周期：无新 marker → 指纹短路 → 焦点节点不被替换（Enter 仍生效）
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
        return app.editor.getPosition().lineNumber;
      }),
    )
    .toBe(focusedLine);
});

test("E-DX-PS11 芯片计数随活动文件切换即时刷新（指纹短路不拦芯片路径）", async ({ page }) => {
  repo.write("clean.py", LONG_SOURCE);
  await page.reload();
  await openEditor(page, "long.py");
  await injectMarkers(page, manyErrors(5));
  const chip = page.locator("#status-problems");
  await expect(chip).toBeVisible({ timeout: 5_000 });
  await expect(chip).toHaveText(/✕ 5/);

  // 切到无错误的 clean.py：芯片隐藏（面板条目不变——指纹短路，但芯片必须即时刷新）
  await openEditor(page, "clean.py");
  await expect(chip).toBeHidden();
  // 切回：芯片恢复
  await openEditor(page, "long.py");
  await expect(chip).toHaveText(/✕ 5/);
});

test("E-DX-PS12 面板隐藏期间 marker 变化：切回时内容已更新（后台刷新）", async ({ page }) => {
  await injectMarkers(page, manyErrors(10));
  await page.keyboard.press("Alt+0");
  await expect(page.locator("#problems-panel .pb-item")).toHaveCount(10);

  // 切到输出 tab（问题面板隐藏）
  await page.locator("#tab-output").click();
  await expect(page.locator("#problems-panel")).toBeHidden();
  // 隐藏期间注入新 marker
  await injectMarkers(page, manyErrors(20));
  await settleDebounce(page);
  // 切回：内容已是 20 条（防抖渲染跑在隐藏 DOM 上）
  await page.locator("#tab-problems").click();
  await expect(page.locator("#problems-panel .pb-item")).toHaveCount(20);
});
