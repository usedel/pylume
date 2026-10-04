// @vitest-environment happy-dom
// UI-16 回归：tooltip 模式——浮层 role="tooltip" + 触发元素 aria-describedby 动态关联。
//
// 核心不变量（最容易被后人「顺手简化」破坏，故专门固化）：
// 1) 浮层必须有 role="tooltip" 与稳定 id（读屏靠它把提示文本归到 tooltip 语义下）；
// 2) 显示期间触发元素必须挂 aria-describedby 指向该 id，隐藏时必须解除；
// 3) 元素原有的 aria-describedby 不得被吞掉（追加显示、还原隐藏），否则
//    「tooltip 关联」会把表单校验提示等既有描述挤掉——一次静默的无障碍回归。
import { beforeAll, describe, expect, it, vi } from "vitest";
import { wireTooltip } from "../tooltip";

/** document 级委托只需接线一次（wireTooltip 重复调用会叠加监听器） */
beforeAll(() => {
  vi.useFakeTimers();
  wireTooltip();
});

let seq = 0;
function makeTarget(tip: string): HTMLElement {
  const el = document.createElement("button");
  el.id = `tip-target-${++seq}`;
  el.dataset.tip = tip;
  document.body.appendChild(el);
  return el;
}

function hover(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  vi.advanceTimersByTime(300); // 显示延迟
}

function press(): void {
  document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

describe("自绘 tooltip（UI-16：role=tooltip + aria-describedby）", () => {
  it("悬停 300ms 后出现：浮层带 role=tooltip 与 id，触发元素挂 aria-describedby", () => {
    const el = makeTarget("运行");
    hover(el);
    const tip = document.querySelector(".oc-tooltip") as HTMLElement;
    expect(tip, "浮层应已创建").toBeTruthy();
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.id, "浮层应有稳定 id 供 aria-describedby 引用").toBeTruthy();
    expect(tip.classList.contains("hidden")).toBe(false);
    expect(el.getAttribute("aria-describedby")).toBe(tip.id);
  });

  it("隐藏（mousedown）后解除关联；无既有描述时不留空属性", () => {
    const el = makeTarget("停止运行");
    hover(el);
    press();
    const tip = document.querySelector(".oc-tooltip") as HTMLElement;
    expect(tip.classList.contains("hidden")).toBe(true);
    expect(el.hasAttribute("aria-describedby"), "隐藏后应彻底移除关联").toBe(false);
  });

  it("元素原有的 aria-describedby 被保留：显示时追加、隐藏时还原", () => {
    const el = makeTarget("更多运行选项");
    el.setAttribute("aria-describedby", "help-existing");
    hover(el);
    const tip = document.querySelector(".oc-tooltip") as HTMLElement;
    expect(el.getAttribute("aria-describedby")).toBe(`help-existing ${tip.id}`);
    press();
    expect(el.getAttribute("aria-describedby"), "还原而非删除既有描述").toBe("help-existing");
  });

  it("悬停目标切换时，关联随之迁移（旧目标解除、新目标建立）", () => {
    const a = makeTarget("调试");
    const b = makeTarget("设置");
    hover(a);
    hover(b);
    const tip = document.querySelector(".oc-tooltip") as HTMLElement;
    expect(a.hasAttribute("aria-describedby"), "旧目标应已解除").toBe(false);
    expect(b.getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.textContent).toContain("设置");
  });
});
