/**
 * R-5 遗留复测（docs/python_library_support_dev_plan.md §9 / 探针 P7）：
 * 面板内第二个 Monaco 实例（正则测试器测试文本区）的内存开销实测。
 *
 * 背景：devtools 面板实例缓存 LRU ≤5（panel.ts CACHE_MAX）——切走工具时实例驻留
 * （隐藏但存活），仅面板关闭或 LRU 逐出时 dispose。P6 只量化了创建耗时（~8ms），
 * 内存未测出，故 CACHE_MAX=5 是否调整悬而未决。
 *
 * 本探针在真实面板环境（vite dev + tauri mock）测量五组数字：
 *  1. 激活态成本：打开正则测试器（含 Monaco 实例 + 面板 DOM）相对基线的堆增量；
 *  2. 驻留成本：切到其他工具后（正则面板隐藏但被 LRU 缓存）保留的堆增量；
 *  3. 缓存填满：缓存达 5 项（含正则）后的回归态；
 *  4. dispose-all 回收：关闭面板（disposeAllCached 全实例销毁）的回收量与残余；
 *  5. 重挂泄漏：6 轮「真重挂（LRU 逐出后重建）→ 输入 → 轮转」循环的堆趋势。
 *
 * 判定口径（写入文档 §9 R-5 回填）：
 *  - 驻留成本 < 15MB → CACHE_MAX=5 维持不变；
 *  - dispose-all 回收 > 1MB、残余距基线 < 5MB（一次性成本：模块代码 + Monaco 静态结构）；
 *  - 重挂堆趋势每轮 < 512KB 且末轮增量 < 256KB（收敛平台）。
 *
 * 测量手段：CDP Performance.getMetrics（JSHeapUsedSize，精确值）+ HeapProfiler.collectGarbage
 * 强制全量 GC（performance.memory 有 ~5% 量化，不足以分辨个位数 MB 的增量）。
 */
import { expect, test, type Page } from "@playwright/test";
import { equipPage, makePlainDir } from "../helpers";

/** 测试文本（模拟真实使用量：一行匹配 + 少量上下文，内存占比可忽略，主要为触发高亮路径） */
const TEST_TEXT = "abc 123 user@mail.com x8\nsecond line 456\n";

/** 确保 picker 可见：面板隐藏 → Ctrl+Shift+T 展开（自带 picker）；面板展开但 picker 收起 → 点 current */
async function ensurePicker(page: Page): Promise<void> {
  if (await page.locator("#devtools-picker").isVisible()) return;
  const panelHidden = await page.locator("#right-panel").evaluate((el) => el.classList.contains("hidden"));
  if (panelHidden) {
    await page.keyboard.press("Control+Shift+T");
  } else {
    await page.locator("#devtools-current").click();
  }
  await expect(page.locator("#devtools-picker")).toBeVisible({ timeout: 5_000 });
}

/** 经 #devtools-current 切换工具（面板保持打开，实例走 LRU 缓存而非 dispose）。
 *  picker 搜索是大小写不敏感的模糊子序列匹配（短词易多命中），故按标题精确定位后点击。 */
async function switchTool(page: Page, search: string, title: string): Promise<void> {
  await ensurePicker(page);
  await page.locator("#devtools-picker-search").fill(search);
  const item = page
    .locator(".picker-item")
    .filter({ has: page.locator(".picker-item-title", { hasText: title }) })
    .first();
  await expect(item).toBeVisible({ timeout: 5_000 });
  await item.click();
  await expect(page.locator("#devtools-current")).toContainText(title);
}

async function equip(page: Page): Promise<void> {
  const repo = await makePlainDir({ "main.py": "print('r5')\n" });
  await equipPage(page, repo);
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
}

test.describe("R-5 面板 Monaco 实例内存复测", () => {
  test("驻留成本 / 逐出回收 / 重挂泄漏实测", async ({ page }) => {
    test.setTimeout(120_000); // 多轮切换 + 多次强制 GC，超出默认 30s
    await equip(page);

    // ---------- 测量基建：CDP 强制 GC + 精确堆指标 ----------
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.enable");
    const gc = async (): Promise<void> => {
      // CDP Runtime.enable 会保留 console 消息参数引用（mock 每次 invoke 都 console.log），
      // 不丢弃会造成伪泄漏；先丢弃再双次全量 GC。
      await cdp.send("Runtime.discardConsoleEntries").catch(() => undefined);
      await cdp.send("HeapProfiler.collectGarbage");
      await page.waitForTimeout(150);
      await cdp.send("HeapProfiler.collectGarbage");
      await page.waitForTimeout(250);
    };
    const heapUsed = async (): Promise<number> => {
      const { metrics } = await cdp.send("Performance.getMetrics");
      const m = metrics.find((x) => x.name === "JSHeapUsedSize");
      if (!m) throw new Error("JSHeapUsedSize 指标不可用");
      return m.value; // 字节
    };
    const mb = (b: number): string => (b / 1024 / 1024).toFixed(2);
    /** DOM 侧佐证：devtools-body 内残留的 monaco 编辑器数 + 全文档节点数（泄漏时 detached 节点滞留） */
    const domStat = async (): Promise<{ panelMonacos: number; nodes: number }> =>
      page.evaluate(() => ({
        panelMonacos: document.querySelectorAll("#devtools-body .monaco-editor").length,
        nodes: document.getElementsByTagName("*").length,
      }));

    // ---------- 基线：编辑器就绪、面板未开 ----------
    await gc();
    const base = await heapUsed();

    // ---------- ① 激活态成本：打开正则测试器（Monaco 实例 #2 + 面板 DOM） ----------
    await page.keyboard.press("Control+Shift+T");
    await expect(page.locator("#devtools-picker")).toBeVisible({ timeout: 5_000 });
    await page.locator("#devtools-picker-search").fill("正则测试器");
    const item = page
      .locator(".picker-item")
      .filter({ has: page.locator(".picker-item-title", { hasText: "正则测试器" }) })
      .first();
    await expect(item).toBeVisible({ timeout: 5_000 });
    await item.click();
    await expect(page.locator("#devtools-current")).toContainText("正则测试器");
    // 输入测试文本走真实 Monaco 路径（含高亮 decoration）
    await page.locator("#rx-test .monaco-editor").last().click();
    await page.keyboard.insertText(TEST_TEXT);
    await expect(page.locator("#rx-test .monaco-editor")).toBeVisible();
    await gc();
    const heapActive = await heapUsed();
    const activeCost = heapActive - base;

    // ---------- ② 驻留成本：切走（正则面板隐藏但被 LRU 缓存） ----------
    await switchTool(page, "UUID 生成", "UUID");
    await gc();
    const heapHidden = await heapUsed();
    const retainedCost = heapHidden - base;

    // ---------- ③ 填满缓存：正则面板隐藏驻留于 LRU 缓存 ----------
    for (const [search, title] of [
      ["MD5 / SHA-256", "MD5"],
      ["Base64 编码/解码", "Base64"],
      ["URL 编码/解码", "URL"],
      ["时间戳转换", "时间戳"],
    ] as const) {
      await switchTool(page, search, title);
    }
    // 回到正则（重挂，此时缓存 5 项：MD5/Base64/URL/时间戳/正则）
    await switchTool(page, "正则测试器", "正则测试器");
    await page.locator("#rx-test .monaco-editor").last().click();
    await page.keyboard.insertText(TEST_TEXT);

    // ---------- ④ 关闭面板 dispose-all 回收验证（无混淆：全部实例一次 dispose） ----------
    // 注：不做「LRU 单实例逐出」的直接测量——逐出必然伴随新工具挂载，新增内存掩盖回收量，
    // 数值为负属测量混淆而非泄漏；dispose 路径一致性由关闭面板的 disposeAllCached 验证。
    await gc();
    const heapBeforeClose = await heapUsed();
    const domBeforeClose = await domStat();
    await page.locator("#devtools-close").click();
    await gc();
    const heapClosed = await heapUsed();
    const domClosed = await domStat();
    const reclaimedAll = heapBeforeClose - heapClosed;
    const closedResidual = heapClosed - base;
    console.log("[R-5] DOM 关面板前:", JSON.stringify(domBeforeClose), "→ 关面板后:", JSON.stringify(domClosed));

    // ---------- ⑤ 重挂泄漏检查：4 轮真重挂（正则实例每轮被 LRU 逐出后重建） ----------
    // 轮内序列 [正则, UUID, MD5, Base64, URL, 时间戳]：第 6 次激活逐出正则实例（缓存恒 5 项轮转），
    // 保证每轮都是全新 mount → dispose，而非缓存命中。每轮清空 mock invoke 日志（数组无上限，
    // 属 harness 噪音，不计入应用堆趋势）。
    const clearMockLog = (): Promise<void> =>
      page.evaluate(() => {
        (window as unknown as { __TAURI_MOCK_INVOKE_LOG__?: string[] }).__TAURI_MOCK_INVOKE_LOG__ = [];
      });
    const CYCLES = 6;
    const cycleHeaps: number[] = [];
    for (let i = 0; i < CYCLES; i++) {
      for (const [search, title] of [
        ["正则测试器", "正则测试器"],
        ["UUID 生成", "UUID"],
        ["MD5 / SHA-256", "MD5"],
        ["Base64 编码/解码", "Base64"],
        ["URL 编码/解码", "URL"],
        ["时间戳转换", "时间戳"],
      ] as const) {
        await switchTool(page, search, title);
        if (search === "正则测试器") {
          await page.locator("#rx-test .monaco-editor").last().click();
          await page.keyboard.insertText(TEST_TEXT);
        }
      }
      await clearMockLog();
      await gc();
      cycleHeaps.push(await heapUsed());
      console.log(`[R-5] 第 ${i + 1} 轮 DOM:`, JSON.stringify(await domStat()));
    }
    const cycleGrowth = cycleHeaps[CYCLES - 1] - cycleHeaps[0];
    const leakPerCycle = cycleGrowth / (CYCLES - 1);

    // ---------- 汇总输出（list reporter 直接可见，回填文档 §9 R-5） ----------
    console.log("[R-5] 基线堆:", mb(base), "MB");
    console.log("[R-5] ① 激活态增量（Monaco#2 + DOM）:", mb(activeCost), "MB");
    console.log("[R-5] ② 驻留增量（LRU 缓存隐藏态）:", mb(retainedCost), "MB");
    console.log("[R-5] ④ 关面板 dispose-all 回收:", mb(reclaimedAll), "MB（残余距基线", mb(closedResidual), "MB）");
    cycleHeaps.forEach((h, i) => console.log(`[R-5] ⑤ 重挂第 ${i + 1} 轮后堆:`, mb(h), "MB"));
    console.log("[R-5] ⑤ 重挂堆趋势:", mb(cycleGrowth), "MB /", CYCLES - 1, "轮 =", (leakPerCycle / 1024).toFixed(1), "KB/轮");

    // ---------- 断言（宽松阈值防 CI 噪音；数字以日志为准回填文档） ----------
    // dispose-all 应回收可观内存（5 个面板实例的可回收部分；首次加载的模块代码与
    // Monaco 静态注册结构不随 dispose 回收，实测回收 ~1.5MB）
    expect(reclaimedAll, "关闭面板应回收缓存实例内存").toBeGreaterThan(1024 * 1024);
    // 回收后残余距基线 < 5MB（一次性成本：模块代码 + Monaco 静态结构，实测 ~3.7MB）
    expect(closedResidual, "dispose 后残余应限于一次性成本").toBeLessThan(5 * 1024 * 1024);
    // 重挂堆趋势：每轮净增长 < 512KB 且末轮增量 < 256KB（收敛平台；线性累积即为泄漏）
    expect(leakPerCycle, "重挂不应累积泄漏").toBeLessThan(512 * 1024);
    const tailDelta = cycleHeaps[CYCLES - 1] - cycleHeaps[CYCLES - 2];
    expect(tailDelta, "末轮增量应趋近平台").toBeLessThan(256 * 1024);
  });
});
