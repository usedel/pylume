// @vitest-environment happy-dom
// UI-09 / UI-11 / UI-12 / UI-16 回归：调试侧栏工具栏、三处空态与断点列表语义。
//
// 核心不变量（最容易被后人「顺手简化」破坏，故专门固化）：
// 工具栏按钮的禁用态必须用 .is-disabled + aria-disabled，**不能用 disabled 属性**。
// 原因：Chromium 不向禁用的表单控件派发鼠标事件，而自绘 tooltip 靠 document 级 mouseover
// 委托命中 [data-tip] —— 一旦改回 disabled 属性，「未调试时整排灰按钮」的提示会静默失效，
// 而那恰恰是最需要提示的场景。用 disabled 属性在功能上看不出任何异常，只有提示悄悄消失。
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import type * as DebugViewModule from "../debugView";
import { clearBreakpoints, getBreakpointLines, setBreakpointLines } from "../debugGutter";

let dv: typeof DebugViewModule;

const btn = (id: string): HTMLButtonElement => document.getElementById(id) as HTMLButtonElement;

/** §6.1 工具栏的六个按钮（顺序即渲染顺序） */
const TOOLBAR_IDS = [
  "debug-continue",
  "debug-pause",
  "debug-step-over",
  "debug-step-into",
  "debug-step-out",
  "debug-stop",
];

beforeAll(async () => {
  // initDebugView 用 $() 取 #view-debug，缺元素会抛错，须先备好容器再动态导入。
  // dap 的 phase 默认为 "idle"、断点表默认为空，故无需任何 mock 即可渲染出目标空态。
  if (!document.getElementById("view-debug")) {
    const el = document.createElement("div");
    el.id = "view-debug";
    document.body.appendChild(el);
  }
  dv = await import("../debugView");
  dv.initDebugView();
});

describe("调试工具栏提示（UI-09：tooltip 单一轨 + 图标按钮可访问名称）", () => {
  it("六个按钮都走 data-tip，且不再带原生 title（两者共存会双重提示）", () => {
    for (const id of TOOLBAR_IDS) {
      const b = btn(id);
      expect(b, `${id} 应已渲染`).toBeTruthy();
      expect(b.dataset.tip, `${id} 应有 data-tip`).toBeTruthy();
      expect(b.hasAttribute("title"), `${id} 不应再保留原生 title`).toBe(false);
    }
  });

  it("图标按钮带 aria-label（内部 <i> 是 aria-hidden，可访问名称只能由此提供）", () => {
    for (const id of TOOLBAR_IDS) {
      expect(btn(id).getAttribute("aria-label"), `${id} 应有 aria-label`).toBeTruthy();
      expect(btn(id).querySelector("i.codicon")?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("快捷键拆到 data-tip-key 并读键位系统，正文不再内嵌硬编码键位", () => {
    // 出厂默认键位（state.ts::DEFAULT_SETTINGS.keybindings）
    expect(btn("debug-continue").dataset.tipKey).toBe("F5");
    expect(btn("debug-step-over").dataset.tipKey).toBe("F10");
    expect(btn("debug-step-into").dataset.tipKey).toBe("F11");
    expect(btn("debug-step-out").dataset.tipKey).toBe("Shift+F11");
    expect(btn("debug-stop").dataset.tipKey).toBe("Shift+F5");
    // 「暂停」在键位系统里没有条目 → 不应残留空 data-tip-key（否则渲染出空 kbd 框）
    expect(btn("debug-pause").dataset.tipKey).toBeUndefined();
    // 正文是纯动作名：原先写成「继续 (F5)」，用户改键后提示就与实际键位不符
    expect(btn("debug-continue").dataset.tip).toBe("继续");
    expect(btn("debug-stop").dataset.tip).toBe("停止调试");
  });
});

describe("调试工具栏禁用态（UI-11：禁用不得用 disabled 属性）", () => {
  it("idle 态整排置灰，用的是 .is-disabled + aria-disabled，disabled 属性必须为 false", () => {
    for (const id of TOOLBAR_IDS) {
      const b = btn(id);
      expect(b.disabled, `${id} 不应设 disabled 属性（会让 data-tip 静默失效）`).toBe(false);
      expect(b.classList.contains("is-disabled"), `${id} 应带 .is-disabled`).toBe(true);
      expect(b.getAttribute("aria-disabled"), `${id} 应带 aria-disabled`).toBe("true");
    }
  });

  it("置灰时点击不触发动作——守卫在 click 回调内（因为浏览器确实会派发这次点击）", () => {
    let stopCalls = 0;
    dv.setDebugViewHandlers({
      start: () => undefined,
      stop: () => { stopCalls += 1; },
      openFile: () => undefined,
      refreshGutter: () => undefined,
    });
    btn("debug-stop").click();
    // 若守卫缺失，这里会变成 1：disabled 属性没设，浏览器不会替我们拦下这次点击
    expect(stopCalls).toBe(0);
    // 点击不应意外改变可用态
    expect(btn("debug-stop").classList.contains("is-disabled")).toBe(true);
  });
});

describe("调试侧栏空态（UI-12：统一走 emptyState 组件）", () => {
  it("调用栈：图标 + 标题 + 下一步指引，且指引引用当前键位", () => {
    const es = document.querySelector("#debug-stack .empty-state.compact");
    expect(es, "调用栈应使用 emptyState 的紧凑档").toBeTruthy();
    expect(es!.querySelector(".codicon-debug-alt")).toBeTruthy();
    expect(es!.querySelector(".empty-title")?.textContent).toBe("未在调试");
    expect(es!.textContent).toContain("按 F5 启动调试");
  });

  it("变量：不再是 textContent 为空的占位 div，而是说明可见条件", () => {
    const es = document.querySelector("#debug-vars .empty-state.compact");
    expect(es).toBeTruthy();
    expect(es!.querySelector(".empty-title")?.textContent).toBe("未在调试");
    expect(es!.textContent).toContain("变量仅在命中断点暂停时可见");
  });

  it("断点：标题与操作指引分两层，图标与编辑器 gutter 的断点图形呼应", () => {
    const es = document.querySelector("#debug-breakpoints .empty-state.compact");
    expect(es).toBeTruthy();
    expect(es!.querySelector(".codicon-debug-breakpoint")).toBeTruthy();
    expect(es!.querySelector(".empty-title")?.textContent).toBe("无断点");
    expect(es!.textContent).toContain("点击编辑器行号左侧的空白处添加");
  });

  it("已废弃的 .debug-empty 不再出现（其 CSS 规则也已删除）", () => {
    expect(document.querySelector("#view-debug .debug-empty")).toBeNull();
  });
});

describe("调试域语言切换", () => {
  afterEach(() => setLocale("zh-CN"));

  it("切换语言时就地刷新工具栏和空态，不重复初始化 DOM", () => {
    const root = document.getElementById("view-debug")!;
    const toolbar = document.getElementById("debug-toolbar")!;
    dv.initDebugView();
    expect(document.getElementById("debug-toolbar")).toBe(toolbar);
    expect(root.querySelectorAll("#debug-toolbar")).toHaveLength(1);

    setLocale("en-US");
    expect(document.getElementById("debug-continue")?.dataset.tip).toBe("Continue");
    expect(document.getElementById("debug-stack-header")?.textContent).toBe("Call Stack");
    expect(document.querySelector("#debug-stack .empty-title")?.textContent).toBe("Not debugging");
    expect(document.getElementById("debug-continue")).toBe(toolbar.firstElementChild);
  });
});

describe("断点列表（UI-16：span 按钮的 role/tabindex/键盘激活）", () => {
  const file = "F:/proj/app.py";

  it("删除按钮：role=button + 带定位的 aria-label + 可聚焦，Enter 即删除断点", () => {
    setBreakpointLines(file, [3, 7]);
    dv.renderDebugView();
    const dels = document.querySelectorAll<HTMLElement>("#debug-breakpoints .debug-bp-del");
    expect(dels.length, "两个断点应渲染两个删除按钮").toBe(2);
    const first = dels[0]!;
    // role=generic 的 span 上 aria-label 不会被读屏暴露，必须显式 role=button（第四批待办）
    expect(first.getAttribute("role")).toBe("button");
    expect(first.tabIndex, "无 tabindex 则键盘不可达").toBe(0);
    expect(first.getAttribute("aria-label")).toContain("app.py:3");
    // 键盘激活：Enter 与点击等价（动作收敛在同一个 removeBp 闭包）
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(getBreakpointLines(file), "Enter 应删除该断点").toEqual([7]);
    clearBreakpoints(file);
    dv.renderDebugView();
  });

  it("定位标签同样键盘可达（点击/Enter 跳转源码的入口不能只有鼠标）", () => {
    setBreakpointLines(file, [10]);
    dv.renderDebugView();
    const label = document.querySelector<HTMLElement>("#debug-breakpoints .debug-bp-label");
    expect(label!.getAttribute("role")).toBe("button");
    expect(label!.tabIndex).toBe(0);
    expect(label!.textContent).toBe("app.py:10");
    clearBreakpoints(file);
    dv.renderDebugView();
    expect(document.querySelector("#debug-breakpoints .empty-state"), "清理后应回到空态").toBeTruthy();
  });
});
