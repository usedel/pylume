/**
 * P0 输出护栏验收（P-GUARD-*）：对标调研 `docs/pycharm_ux_review_and_proposal.md` §3.3 / A-2 / A-3。
 *
 * 背景：PyCharm 最受诟病的一条是「输出一大就冻结」。本项目输出面板原为无限 appendChild +
 * 无条件拽到底部，终端为 `writeData → term.write()` 直通——两者都有无界增长/独占主线程的隐患。
 * 本 spec 在**真实 Chromium** 下验证护栏生效：
 *  - P-GUARD-1 输出面板环形缓冲（DOM 行数封顶 + 顶部省略计数）
 *  - P-GUARD-2 条件滚动跟随（上滚锁定、回到底部解锁）
 *  - P-GUARD-3 终端洪峰背压：排队写入 vs 直接同步写（模拟改动前行为）的主线程占用对照
 *
 * 与 vitest 单测（src/__tests__/output.test.ts）不重复：单测管纯逻辑，这里管真实浏览器下的
 * DOM/滚动/主线程行为（本机 happy-dom 环境损坏，单测跑不了，此 spec 是主要验收手段）。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makeGitRepo, type GitRepo } from "../helpers";

let repo: GitRepo;
const pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makeGitRepo({ files: { "script.py": "print(1)\n" }, commitMsg: "baseline" });
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#status-git")).toContainText("main", { timeout: 20_000 });
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

/** 输出容器必须可滚动，否则滚动断言（gap）恒为 0、无意义 */
async function ensureOutputScrollable(page: Page): Promise<void> {
  await page.locator("#tab-output").click();
  await page.evaluate(() => {
    const out = document.getElementById("output") as HTMLElement | null;
    if (!out) throw new Error("未找到 #output");
    if (out.clientHeight < 120) {
      out.style.minHeight = "320px";
      out.style.overflow = "auto";
    }
  });
}

test(
  "P-GUARD-1 输出面板环形缓冲：DOM 行数封顶并显示已省略计数",
  // 5000+ 行真实 DOM 追加在本机约 20s。注意：Playwright 三参 details 只支持
  // tag/annotate/box，{ timeout } 写在这里会被静默忽略（实测一直跑在全局 30s 上限），
  // 必须用 test.setTimeout（验收实测踩坑）
  async ({ page }) => {
    test.setTimeout(90_000);
    await ensureOutputScrollable(page);
    // 两段追加必须在**同一个 evaluate 内**完成：两次 evaluate 之间是 Playwright 往返，
    // 主线程一空出来，被我们长时间阻塞的应用后台任务（LSP/env/git）会批量往面板写行，
    // 污染省略计数（实测多出 199 行）。同一 evaluate 内主线程不释放，计数才是干净的。
    const r = await page.evaluate(async () => {
      const mod = (await import(/* @vite-ignore */ "/src/output.ts")) as any;
      const out = document.getElementById("output") as HTMLElement;
      const readOmitted = (): number => {
        const t = (out.querySelector(".out-omitted") as HTMLElement)?.textContent ?? "";
        const m = /已省略前 (\d+) 行/.exec(t);
        return m ? parseInt(m[1], 10) : 0;
      };
      const rowsOf = () =>
        Array.from(out.children).filter((e) => !(e as HTMLElement).classList.contains("out-omitted"));

      mod.clearOutput(out);
      // 超过出厂上限（5000）200 行
      for (let i = 0; i < 5200; i++) mod.appendOutputLine(out, `行 ${i}`, "stdout", () => undefined);
      const rows = rowsOf();
      const omitted = out.querySelector(".out-omitted") as HTMLElement | null;
      const first = {
        rows: rows.length,
        first: rows[0]?.textContent,
        last: rows[rows.length - 1]?.textContent,
        omittedText: omitted?.textContent ?? null,
        omittedHidden: omitted?.hidden ?? null,
        nodes: out.getElementsByTagName("*").length,
        omittedCount: readOmitted(),
      };

      // 继续追加 100 行：行数仍封顶，省略计数只增 100（环形缓冲而非一次性截断）
      for (let i = 0; i < 100; i++) mod.appendOutputLine(out, `追加 ${i}`, "stdout", () => undefined);
      const rows2 = rowsOf();
      return {
        first,
        again: {
          rows: rows2.length,
          last: rows2[rows2.length - 1]?.textContent,
          omittedDelta: readOmitted() - first.omittedCount,
          nodes: out.getElementsByTagName("*").length,
        },
      };
    });

    expect(r.first.rows).toBe(5000); // 封顶，不再无界增长
    expect(r.first.first).toBe("行 200"); // 最旧的 200 行被丢弃
    expect(r.first.last).toBe("行 5199"); // 最新行保留
    expect(r.first.omittedHidden).toBe(false);
    expect(r.first.omittedText).toContain("已省略前 200 行");

    expect(r.again.rows).toBe(5000);
    expect(r.again.last).toBe("追加 99");
    expect(r.again.omittedDelta).toBe(100);
    expect(r.again.nodes).toBe(r.first.nodes); // 节点总数不再膨胀
  },
);

test("P-GUARD-2 条件滚动跟随：上滚锁定、回到底部解锁", async ({ page }) => {
  await ensureOutputScrollable(page);
  const r = await page.evaluate(async () => {
    const mod = (await import(/* @vite-ignore */ "/src/output.ts")) as any;
    const out = document.getElementById("output") as HTMLElement;
    mod.clearOutput(out);
    for (let i = 0; i < 800; i++) mod.appendOutputLine(out, `行 ${i}`, "stdout", () => undefined);
    const gapAtStart = out.scrollHeight - out.scrollTop - out.clientHeight;

    // 用户上滚 → 追加新行不得把视图拽回底部
    out.scrollTop = 0;
    out.dispatchEvent(new Event("scroll"));
    mod.appendOutputLine(out, "上滚后新增", "stdout", () => undefined);
    const afterUp = out.scrollTop;

    // 回到底部 → 恢复自动跟随
    out.scrollTop = out.scrollHeight;
    out.dispatchEvent(new Event("scroll"));
    mod.appendOutputLine(out, "回底后新增", "stdout", () => undefined);
    const gapAfter = out.scrollHeight - out.scrollTop - out.clientHeight;

    return { gapAtStart, afterUp, gapAfter, scrollable: out.scrollHeight > out.clientHeight };
  });

  expect(r.scrollable).toBe(true); // 前置条件：容器确实可滚动
  expect(r.gapAtStart).toBeLessThanOrEqual(24); // 默认贴底
  expect(r.afterUp).toBe(0); // 上滚后未被拽回底部（改动前这里会被强行置为 scrollHeight）
  expect(r.gapAfter).toBeLessThanOrEqual(24); // 回到底部后恢复跟随
});

test("P-GUARD-3 终端洪峰背压：入队削峰 + 限流提示 + 洪峰期间主线程仍出帧", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const mod = (await import(/* @vite-ignore */ "/src/terminal.ts")) as any;
    const el = document.createElement("div");
    el.style.cssText = "position:fixed;left:0;top:0;width:900px;height:600px;z-index:9999;background:#000";
    document.body.appendChild(el);
    const term = new mod.IntegratedTerminal("e2e-guard", el);

    const chunk = "x".repeat(4096) + "\r\n"; // 4KB/块
    const blocks = 600; // ≈2.4MB（>1MB 阈值，应触发限流提示）

    // ① 削峰：一次性灌入后，数据应留在队列里而不是同帧全部写进 xterm
    for (let i = 0; i < blocks; i++) term.writeData(chunk);
    const queuedImmediately = {
      chunks: term.pendingChunks.length,
      bytes: term.pendingBytes,
      throttleNotified: term.throttleNotified, // 积压已超 1MB → 应已标记提示
    };

    // ② 洪峰期间主线程仍在出帧
    let last = performance.now();
    let maxGap = 0;
    let stop = false;
    const tick = () => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      if (!stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await new Promise((res) => setTimeout(res, 1500));
    stop = true;

    // ③ 观察窗口结束后队列应被分帧消化干净（削峰不丢数据）
    const drained = { chunks: term.pendingChunks.length, bytes: term.pendingBytes };

    // ④ 洪峰结束后补写的收尾提示应留在缓冲区（中途那次提示会被后续输出冲出 scrollback）
    const buf = term.term.buffer.active;
    let throttled = false;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line && line.translateToString(true).includes("输出洪峰已结束")) {
        throttled = true;
        break;
      }
    }
    el.remove();
    return {
      queuedImmediately,
      drained,
      maxGap: Math.round(maxGap),
      throttled,
      bytes: blocks * chunk.length,
    };
  });

  console.log(
    `[P-GUARD-3] ${(r.bytes / 1024 / 1024).toFixed(1)}MB 洪峰 → ` +
      `入队瞬间{chunks:${r.queuedImmediately.chunks},bytes:${r.queuedImmediately.bytes},` +
      `限流标记:${r.queuedImmediately.throttleNotified}} ` +
      `1.5s 后{chunks:${r.drained.chunks},bytes:${r.drained.bytes}} ` +
      `maxFrameGap:${r.maxGap}ms 收尾提示:${r.throttled}`,
  );

  expect(r.queuedImmediately.chunks).toBeGreaterThan(0); // 确实在排队（未同帧一次写完）
  expect(r.queuedImmediately.bytes).toBeGreaterThan(256 * 1024); // 积压超过单帧预算
  expect(r.queuedImmediately.throttleNotified).toBe(true); // 积压超 1MB 触发限流
  expect(r.drained.bytes).toBe(0); // 被分帧消化干净（不丢数据、不残留）
  expect(r.throttled).toBe(true); // 洪峰结束的收尾提示留在缓冲区（用户看得见）
  expect(r.maxGap).toBeLessThan(1000); // 洪峰期间主线程仍在出帧
});
