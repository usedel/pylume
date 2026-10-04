// @vitest-environment happy-dom
// 调试 Watches 的文案与语言切换回归：切换语言不能清掉表达式/结果，也不能额外触发 DAP 求值。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";

const dapEvaluate = vi.hoisted(() => vi.fn());
vi.mock("../dap/client", () => ({ dapEvaluate }));

let watches: typeof import("../debugWatches");
let host: HTMLDivElement;

beforeAll(async () => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  watches = await import("../debugWatches");
  watches.initWatchesPanel(host, () => 1);
});

afterEach(() => {
  setLocale("zh-CN");
  dapEvaluate.mockReset();
});

describe("Debug Watches 国际化", () => {
  it("初始化时提供标题、输入提示、ARIA 和空态", () => {
    expect(host.querySelector(".debug-section-header")?.textContent).toBe("监视（Watches）");
    expect(host.querySelector<HTMLInputElement>(".debug-watch-input")?.placeholder).toContain("输入表达式");
    expect(host.querySelector<HTMLInputElement>(".debug-watch-input")?.getAttribute("aria-label")).toBe("添加监视表达式");
    expect(host.querySelector(".debug-watch-empty")?.textContent).toContain("调试暂停时自动求值");
  });

  it("求值失败与切换语言只更新文案，不重新求值", async () => {
    dapEvaluate.mockRejectedValueOnce(new Error("not paused"));
    const input = host.querySelector<HTMLInputElement>(".debug-watch-input")!;
    input.value = "user.name";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(host.querySelector(".debug-watch-value-failed")?.textContent).toBe("无法求值"));
    expect(dapEvaluate).toHaveBeenCalledTimes(1);
    const row = host.querySelector(".debug-watch-row")!;

    setLocale("en-US");
    expect(host.querySelector(".debug-section-header")?.textContent).toBe("Watches");
    expect(host.querySelector<HTMLInputElement>(".debug-watch-input")?.placeholder).toContain("Press Enter");
    expect(host.querySelector(".debug-watch-value-failed")?.textContent).toBe("Unable to evaluate");
    expect(host.querySelector(".debug-watch-row")).toBe(row);
    expect(host.querySelector("[data-watch-expr]")?.getAttribute("aria-label")).toBe("Delete watch user.name");
    expect(dapEvaluate).toHaveBeenCalledTimes(1);
  });
});
