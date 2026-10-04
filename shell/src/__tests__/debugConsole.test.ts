// @vitest-environment happy-dom
// Debug Console 的一次性初始化、状态文案和语言切换回归。
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setLocale } from "../i18n";

let debugConsole: typeof import("../debugConsole");

beforeAll(async () => {
  const host = document.createElement("div");
  host.id = "view-debug";
  document.body.appendChild(host);
  debugConsole = await import("../debugConsole");
  debugConsole.initDebugConsole();
});

afterEach(() => {
  setLocale("zh-CN");
  document.getElementById("debug-console-log")?.replaceChildren();
});

describe("Debug Console 国际化", () => {
  it("初始化幂等：不会重复创建 DOM", () => {
    debugConsole.initDebugConsole();
    expect(document.querySelectorAll("#debug-console-header")).toHaveLength(1);
    expect(document.querySelectorAll("#debug-console-log")).toHaveLength(1);
    expect(document.querySelectorAll("#debug-console-input")).toHaveLength(1);
  });

  it("语言切换更新控件文案，历史输出不被重写", async () => {
    const input = document.getElementById("debug-console-input") as HTMLInputElement;
    const run = document.getElementById("debug-console-run")!;
    expect(input.placeholder).toContain("命中断点后");
    expect(run.textContent).toBe("求值");

    setLocale("en-US");
    expect(document.getElementById("debug-console-header")?.textContent).toBe("Debug Console");
    expect(input.placeholder).toContain("Available after");
    expect(input.getAttribute("aria-label")).toBe("Evaluate expression");
    expect(run.textContent).toBe("Evaluate");

    await debugConsole.evaluate("user.name");
    const log = document.getElementById("debug-console-log")!;
    expect(log.textContent).toContain("No breakpoint hit");
    setLocale("zh-CN");
    expect(log.textContent).toContain("No breakpoint hit");
  });
});
