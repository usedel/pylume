// @vitest-environment happy-dom
// UX P0-1 回归：全局 toast 通知的基础行为（此前同类失败只 console.warn，用户完全无感知）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast, toastFail } from "../toast";

afterEach(() => {
  document.getElementById("toast-stack")?.remove();
  vi.useRealTimers();
});

describe("toast 全局通知（UX P0-1）", () => {
  it("默认 info：入栈 #toast-stack，带文案与关闭按钮", () => {
    toast("复制路径失败", "info");
    const el = document.querySelector<HTMLElement>("#toast-stack .toast");
    expect(el, "应创建 toast 元素").toBeTruthy();
    expect(el?.textContent).toContain("复制路径失败");
    expect(el?.querySelector(".toast-close"), "应有关闭按钮").toBeTruthy();
  });

  it("toastFail：error 带 role=alert 与 --error 类，文案组装为「{动作}失败：{原因}」", () => {
    toastFail("粘贴", "disk full");
    const el = document.querySelector<HTMLElement>("#toast-stack .toast--error");
    expect(el).toBeTruthy();
    expect(el?.getAttribute("role")).toBe("alert");
    expect(el?.textContent).toContain("粘贴失败：disk full");
  });

  it("同屏超过 5 条时最旧的先移除；到期自动消失", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 7; i++) toast(`第 ${i} 条`, "info");
    const stack = document.getElementById("toast-stack")!;
    expect(stack.children.length, "同屏上限 5 条").toBe(5);
    expect(stack.children[0]?.textContent).toContain("第 2 条");
    vi.advanceTimersByTime(4100); // info 4s + 余量
    expect(stack.children.length).toBe(0);
  });
});
