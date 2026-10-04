// @vitest-environment happy-dom
// v3.4 §17-3：RunTranscript 交互用例已随 stdin 体系删除（运行输出统一走终端控制台）；
// 保留**非交互输出渲染**用例——输出面板承载调试输出（debug-stdout / debug-stderr，§13.3）。
import { describe, expect, it, vi } from "vitest";
import { appendOutputLine, TRACEBACK_RE } from "../output";
import { t } from "../i18n"; // 断言走 t(key)：默认中文等价于原文断言，切默认语言也不用改

describe("channel 过滤（P2：调试 / 环境 / Git 分组）", () => {
  it("未标注与 all 永远显示；切 debug 过滤后 env/git 行隐藏、debug/all 行可见", async () => {
    const { setOutputChannelFilter, refilterOutputChannel } = await import("../output");
    const container = document.createElement("div");
    appendOutputLine(container, "普通输出（未标注）", "stdout", vi.fn());
    appendOutputLine(container, "pip 行", "stdout", vi.fn(), "env");
    appendOutputLine(container, "git 行", "cmd", vi.fn(), "git");
    appendOutputLine(container, "debug 行", "stderr", vi.fn(), "debug");
    // 默认（null）全部可见
    expect(container.querySelectorAll(".out-ch-hidden").length).toBe(0);
    // 切 debug 过滤：已有行经 refilter 重刷
    setOutputChannelFilter("debug");
    refilterOutputChannel(container);
    const hidden = Array.from(container.querySelectorAll(".out-ch-hidden")) as HTMLElement[];
    expect(hidden.length).toBe(2); // env + git 隐藏
    expect(hidden.every((el) => el.dataset.channel === "env" || el.dataset.channel === "git")).toBe(true);
    // 过滤态下新追加的行直接按过滤渲染
    appendOutputLine(container, "新增 debug 行", "stdout", vi.fn(), "debug");
    expect(container.querySelectorAll(".out-ch-hidden").length).toBe(2);
    appendOutputLine(container, "新增 env 行", "stdout", vi.fn(), "env");
    expect(container.querySelectorAll(".out-ch-hidden").length).toBe(3);
    // 恢复 null：全部重新可见
    setOutputChannelFilter(null);
    refilterOutputChannel(container);
    expect(container.querySelectorAll(".out-ch-hidden").length).toBe(0);
    setOutputChannelFilter(null); // 复位全局态，不污染后续用例
  });
});

describe("appendOutputLine（一次性整行；调试输出承载）", () => {
  it("traceback 帧渲染为可点击链接并回传路径与行号", () => {
    const container = document.createElement("div");
    const onLink = vi.fn();
    appendOutputLine(container, '  File "main.py", line 7, in <module>', "stderr", onLink);
    const link = container.querySelector(".out-link") as HTMLElement;
    expect(link).toBeTruthy();
    link.click();
    expect(onLink).toHaveBeenCalledWith({ path: "main.py", line: 7 });
  });

  it("探针摘要行用中性色（probe）而非报错色", () => {
    const container = document.createElement("div");
    appendOutputLine(container, "[pylume-probe] 采集完成", "stderr", vi.fn());
    expect(container.querySelector(".out-line")?.classList.contains("probe")).toBe(true);
  });

  it("TRACEBACK_RE 连续复用不漏匹配（lastIndex 已重置）", () => {
    const container = document.createElement("div");
    const onLink = vi.fn();
    for (let i = 0; i < 3; i++) {
      appendOutputLine(container, 'File "a.py", line 1, in f', "stderr", onLink);
    }
    expect(container.querySelectorAll(".out-link").length).toBe(3);
    expect(TRACEBACK_RE.lastIndex).toBe(0);
  });
});

describe("输出护栏（P0：环形缓冲 + 条件滚动跟随）", () => {
  // 护栏由来：输出面板原为「无限 appendChild + 无条件拽到底部」，狂打印的长任务会把 DOM
  // 撑爆并对抗用户上翻（对标调研 §3.3 / A-2）。
  it("超出上限丢弃最前面的行，顶部提示累计省略行数", async () => {
    const { setMaxOutputLines, getMaxOutputLines } = await import("../output");
    const prev = getMaxOutputLines();
    setMaxOutputLines(100); // 下限 100（更小的取值会回落出厂默认，防误设自伤）
    const container = document.createElement("div");
    for (let i = 0; i < 103; i++) appendOutputLine(container, `行 ${i}`, "stdout", vi.fn());
    const rows = Array.from(container.children).filter(
      (el) => !(el as HTMLElement).classList.contains("out-omitted"),
    );
    expect(rows.length).toBe(100);
    expect(rows[0].textContent).toBe("行 3"); // 最旧的 0..2 被丢弃
    const omitted = container.querySelector(".out-omitted") as HTMLElement;
    expect(omitted.hidden).toBe(false);
    expect(omitted.textContent).toContain(t("run.out.omitted", { n: 3, max: 100 }));
    setMaxOutputLines(prev); // 复位，不污染后续用例
  });

  it("clearOutput 复位省略计数与提示行", async () => {
    const { setMaxOutputLines, getMaxOutputLines, clearOutput } = await import("../output");
    const prev = getMaxOutputLines();
    setMaxOutputLines(100);
    const container = document.createElement("div");
    for (let i = 0; i < 103; i++) appendOutputLine(container, `行 ${i}`, "stdout", vi.fn());
    expect(container.querySelector(".out-omitted")).toBeTruthy();
    clearOutput(container);
    expect(container.querySelector(".out-omitted")).toBeNull();
    appendOutputLine(container, "新行", "stdout", vi.fn()); // 计数已复位 → 不再出现提示行
    expect(container.querySelector(".out-omitted")).toBeNull();
    setMaxOutputLines(prev);
  });

  it("用户上滚即暂停自动跟随，回到底部恢复", async () => {
    const { isScrollFollowPaused } = await import("../output");
    const container = document.createElement("div");
    // 自管 scrollTop/scrollHeight/clientHeight，不依赖 happy-dom 的滚动实现
    let top = 0;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    Object.defineProperty(container, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(container, "clientHeight", { configurable: true, get: () => 500 });

    appendOutputLine(container, "第一行", "stdout", vi.fn());
    top = 500; // 贴底：gap = 1000 - 500 - 500 = 0
    container.dispatchEvent(new Event("scroll"));
    expect(isScrollFollowPaused(container)).toBe(false);

    top = 0; // 上滚：暂停跟随
    container.dispatchEvent(new Event("scroll"));
    expect(isScrollFollowPaused(container)).toBe(true);

    appendOutputLine(container, "第二行", "stdout", vi.fn());
    expect(top).toBe(0); // 新行不再把视图拽到底部

    top = 500; // 回到底部：自动恢复跟随
    container.dispatchEvent(new Event("scroll"));
    expect(isScrollFollowPaused(container)).toBe(false);
  });
});

describe("URL 链接识别（P2-L）", () => {
  it("行内 URL 渲染为可点击链接，点击回传 URL", async () => {
    const { setOutputUrlHandler } = await import("../output");
    const handler = vi.fn();
    setOutputUrlHandler(handler);
    const container = document.createElement("div");
    appendOutputLine(container, "Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)", "stdout", vi.fn());
    const link = Array.from(container.querySelectorAll(".out-link")).find(
      (el) => el.textContent?.startsWith("http"),
    ) as HTMLElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toBe("http://127.0.0.1:8000");
    link.click();
    expect(handler).toHaveBeenCalledWith("http://127.0.0.1:8000");
  });

  it("句尾标点剥离（句号/右括号不算链接一部分），多 URL 各自成链", async () => {
    const { setOutputUrlHandler } = await import("../output");
    const handler = vi.fn();
    setOutputUrlHandler(handler);
    const container = document.createElement("div");
    appendOutputLine(container, "访问 http://a.dev. 与 https://b.dev/docs) 对比", "stdout", vi.fn());
    const links = Array.from(container.querySelectorAll(".out-link"))
      .map((el) => el.textContent)
      .filter((t) => t?.startsWith("http"));
    expect(links).toEqual(["http://a.dev", "https://b.dev/docs"]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("traceback 帧内不误生 URL 链接（两种链接分层叠加不冲突）", () => {
    const container = document.createElement("div");
    const onLink = vi.fn();
    appendOutputLine(container, 'File "main.py", line 7, in <module>', "stderr", onLink);
    const links = Array.from(container.querySelectorAll(".out-link"));
    expect(links.length).toBe(1);
    (links[0] as HTMLElement).click();
    expect(onLink).toHaveBeenCalledWith({ path: "main.py", line: 7 });
  });
});

describe("日志级别识别与过滤（P1 · 库支持 §7-1）", () => {
  it("detectLogLevel 规则表：常见格式命中、普通句子不误判", async () => {
    const { detectLogLevel } = await import("../output");
    // error：logging / pip / uv / 带括号
    expect(detectLogLevel("ERROR: pip's dependency resolver ...")).toBe("error");
    expect(detectLogLevel("CRITICAL:root:boom")).toBe("error");
    expect(detectLogLevel("FATAL  something")).toBe("error");
    expect(detectLogLevel("[ERROR] failed")).toBe("error");
    // warn / info / debug
    expect(detectLogLevel("WARNING:root:deprecated")).toBe("warn");
    expect(detectLogLevel("[WARN] disk almost full")).toBe("warn");
    expect(detectLogLevel("INFO:     Uvicorn running on http://0.0.0.0:8000")).toBe("info");
    expect(detectLogLevel("NOTICE hi")).toBe("info");
    expect(detectLogLevel("DEBUG:详细的调试信息")).toBe("debug");
    expect(detectLogLevel("TRACE: trace")).toBe("debug");
    // 不误判：小写句子 / 前缀后紧跟单词字符 / 空行 / 普通输出
    expect(detectLogLevel("Error opening file")).toBeNull();
    expect(detectLogLevel("INFOfoo")).toBeNull();
    expect(detectLogLevel("")).toBeNull();
    expect(detectLogLevel("hello world")).toBeNull();
    expect(detectLogLevel("Traceback (most recent call last):")).toBeNull();
    // §11.7 第四条形态：- LEVEL -（行首短横线包裹，如 uvicorn / structlog 风格）
    expect(detectLogLevel("- ERROR - boom")).toBe("error");
    expect(detectLogLevel("- WARNING - careful")).toBe("warn");
    expect(detectLogLevel("- INFO - hi")).toBe("info");
    expect(detectLogLevel("- DEBUG - verbose")).toBe("debug");
  });

  it("级别计数徽标（§11.7）：按级累计，clearOutput 归零", async () => {
    const { clearOutput, getOutputLevelCounts, resetOutputLevelCounts } = await import("../output");
    resetOutputLevelCounts();
    const container = document.createElement("div");
    appendOutputLine(container, "ERROR: a", "stderr", vi.fn());
    appendOutputLine(container, "ERROR: b", "stderr", vi.fn());
    appendOutputLine(container, "WARNING: c", "stdout", vi.fn());
    appendOutputLine(container, "普通输出", "stdout", vi.fn());
    expect(getOutputLevelCounts().error).toBe(2);
    expect(getOutputLevelCounts().warn).toBe(1);
    clearOutput(container);
    expect(getOutputLevelCounts().error).toBe(0);
  });

  it("默认只着色不过滤；多选级别过滤后未分级行仍显示", async () => {
    const { setOutputLevelFilter, refilterOutputLevels } = await import("../output");
    const container = document.createElement("div");
    const err = appendOutputLine(container, "ERROR: bad", "stderr", vi.fn());
    const warn = appendOutputLine(container, "WARNING: careful", "stdout", vi.fn());
    const info = appendOutputLine(container, "INFO: hi", "stdout", vi.fn());
    const plain = appendOutputLine(container, "普通输出", "stdout", vi.fn());
    // 默认（null）：全部可见，但已按级别着色
    expect(container.querySelectorAll(".out-ch-hidden").length).toBe(0);
    expect(err.classList.contains("lvl-error")).toBe(true);
    expect(warn.classList.contains("lvl-warn")).toBe(true);
    expect(info.classList.contains("lvl-info")).toBe(true);
    expect(plain.classList.contains("lvl-error")).toBe(false);
    // 多选过滤：error + info 可见，warn 隐藏，未分级行永远显示
    setOutputLevelFilter(["error", "info"]);
    refilterOutputLevels(container);
    expect(err.classList.contains("out-ch-hidden")).toBe(false);
    expect(warn.classList.contains("out-ch-hidden")).toBe(true);
    expect(info.classList.contains("out-ch-hidden")).toBe(false);
    expect(plain.classList.contains("out-ch-hidden")).toBe(false);
    // 过滤态下新追加的行直接按过滤渲染
    const dbg = appendOutputLine(container, "DEBUG: x", "stdout", vi.fn());
    expect(dbg.classList.contains("out-ch-hidden")).toBe(true);
    // 复位 null：全部重新可见
    setOutputLevelFilter(null);
    refilterOutputLevels(container);
    expect(container.querySelectorAll(".out-ch-hidden").length).toBe(0);
  });

  it("级别过滤与 channel 过滤联合判定（任一不可见即隐藏）", async () => {
    const { setOutputChannelFilter, setOutputLevelFilter, refilterOutputChannel, refilterOutputLevels } =
      await import("../output");
    const container = document.createElement("div");
    const envErr = appendOutputLine(container, "ERROR: pip fail", "stdout", vi.fn(), "env");
    setOutputLevelFilter(["error"]);
    refilterOutputLevels(container);
    expect(envErr.classList.contains("out-ch-hidden")).toBe(false);
    // channel 过滤开到 git：env 行即使级别命中也隐藏
    setOutputChannelFilter("git");
    refilterOutputChannel(container);
    expect(envErr.classList.contains("out-ch-hidden")).toBe(true);
    // 复位全局态，不污染后续用例
    setOutputChannelFilter(null);
    setOutputLevelFilter(null);
  });
});
