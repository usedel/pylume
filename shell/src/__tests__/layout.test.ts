// @vitest-environment happy-dom
// UI-22 回归：文件树 / 大纲高度拖拽分隔条。
//
// 核心不变量：拖拽写自定义属性 --outline-h（px），而非内联 height。
// #outline-section.collapsed { height: auto } 靠样式表特异性（1,1,0）覆盖基础规则里的固定高（1,0,0）；
// 而内联 style 特异性最高——若拖拽「顺手」改成写内联 height（与 sidebar/bottom 同款写法），
// 折叠态会被内联值压过、再也收不起来：拖过一次就静默丧失折叠能力（且要拖过才暴露）。
// 一并验证 clamp 上下限 / localStorage 持久化 / 双击重置回落 40% / 折叠态拖动先展开 / restoreLayout 恢复。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreLayout, wireSplitters } from "../layout";

const OUTLINE_KEY = "pylume.outline_height";
const SIDEBAR_KEY = "pylume.sidebar_width";
const RIGHT_KEY = "pylume.rightpanel_width";
/** style.css 的 `#center { min-width }`；测试环境无样式表，layout.ts 回落到同值常量 */
const CENTER_MIN = 240;

/** 搭出 wireSplitters / restoreLayout 会 $() 解析的全部元素（缺一即抛错）。返回大纲相关三元素。 */
function setupDom(): { outline: HTMLElement; viewFiles: HTMLElement; splitter: HTMLElement } {
  document.body.innerHTML = "";
  const mk = (id: string, cls?: string): HTMLElement => {
    const el = document.createElement("div");
    el.id = id;
    if (cls) el.className = cls;
    document.body.appendChild(el);
    return el;
  };
  // 其余三个分隔条的元素（wireSplitters 一并接线，需存在才能过 $()）
  mk("sidebar");
  mk("sidebar-splitter", "splitter splitter-col");
  mk("right-panel");
  mk("right-splitter", "splitter splitter-col-left");
  mk("bottom");
  mk("bottom-splitter", "splitter splitter-row");
  mk("center"); // UI-23：dragMax 会读 #center 的 min-width（侧栏/右面板拖拽时）
  // Markdown 预览分栏三元素（wireSplitters / restoreLayout 一并解析，缺一即抛错）
  mk("editor-row");
  mk("md-preview");
  mk("md-splitter");
  // C-4 分屏两元素（同上，wireSplitters 接线需要）
  mk("split-editor-panel");
  mk("split-splitter");
  // 大纲拖拽三元素
  const viewFiles = mk("view-files");
  const outline = mk("outline-section");
  const splitter = mk("outline-splitter", "splitter splitter-row");
  // 大纲底边锚定在 500（不随高度变化）；文件视图高 600 → 拖拽上限 = floor(600×0.6)=360，下限 60
  outline.getBoundingClientRect = () => ({ bottom: 500 } as unknown as DOMRect);
  Object.defineProperty(viewFiles, "clientHeight", { value: 600, configurable: true });
  return { outline, viewFiles, splitter };
}

/** 模拟一次完整拖拽：splitter 上 mousedown → window 上 mousemove(toY) → mouseup。高度 = 底边500 − toY。 */
function drag(splitter: HTMLElement, toY: number): void {
  splitter.dispatchEvent(new MouseEvent("mousedown", { clientY: 300, bubbles: true, cancelable: true }));
  window.dispatchEvent(new MouseEvent("mousemove", { clientY: toY, bubbles: true, cancelable: true }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  localStorage.clear();
});

describe("大纲高度拖拽（UI-22）", () => {
  it("拖拽写 --outline-h 自定义属性而非内联 height，并持久化", () => {
    const { outline, splitter } = setupDom();
    wireSplitters();
    drag(splitter, 200); // 500 − 200 = 300
    expect(outline.style.getPropertyValue("--outline-h")).toBe("300px");
    expect(outline.style.getPropertyValue("--outline-max")).toBe("none"); // 解除 40% 封顶，可拖过默认比例
    expect(outline.style.height).toBe(""); // 关键不变量：绝不写内联 height（否则折叠失效）
    expect(localStorage.getItem(OUTLINE_KEY)).toBe("300");
  });

  it("高度 clamp 到 [60, 文件视图×0.6=360]", () => {
    const { outline, splitter } = setupDom();
    wireSplitters();
    drag(splitter, 550); // 500 − 550 = −50 → 下限 60
    expect(outline.style.getPropertyValue("--outline-h")).toBe("60px");
    drag(splitter, 50); // 500 − 50 = 450 → 上限 360
    expect(outline.style.getPropertyValue("--outline-h")).toBe("360px");
  });

  it("双击清除 --outline-h（回落 CSS 默认 40%）并移除持久化", () => {
    const { outline, splitter } = setupDom();
    wireSplitters();
    drag(splitter, 200);
    expect(localStorage.getItem(OUTLINE_KEY)).toBe("300");
    splitter.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(outline.style.getPropertyValue("--outline-h")).toBe("");
    expect(outline.style.getPropertyValue("--outline-max")).toBe(""); // 封顶覆盖一并清除 → 回落默认「内容高 + 上限 40%」
    expect(localStorage.getItem(OUTLINE_KEY)).toBeNull();
  });

  it("折叠态拖动先移除 .collapsed（否则 height:auto 会吞掉 --outline-h）", () => {
    const { outline, splitter } = setupDom();
    outline.classList.add("collapsed");
    wireSplitters();
    drag(splitter, 200);
    expect(outline.classList.contains("collapsed")).toBe(false);
    expect(outline.style.getPropertyValue("--outline-h")).toBe("300px");
  });

  it("restoreLayout 恢复上次高度：写 --outline-h，仍不碰内联 height", () => {
    const { outline } = setupDom();
    localStorage.setItem(OUTLINE_KEY, "250");
    restoreLayout(); // happy-dom window.innerHeight=768 → 上限 floor(768×0.6)=460，250 未被裁剪
    expect(outline.style.getPropertyValue("--outline-h")).toBe("250px");
    expect(outline.style.getPropertyValue("--outline-max")).toBe("none"); // 恢复定高同样解除封顶
    expect(outline.style.height).toBe("");
  });
});

// ---------- 遗留修复（第八批登记）：底部面板拖拽写 --bottom-h 而非内联 height ----------
//
// 与 UI-22 大纲区同款陷阱：内联 height 特异性最高，会压过样式表的 #bottom.collapsed{height:28px}，
// 拖过（或 restoreLayout 恢复过）底部面板高度之后就再也收不起来——且要拖过才暴露的静默回归。

describe("底部面板高度拖拽（--bottom-h）", () => {
  it("拖拽写 --bottom-h 自定义属性而非内联 height，并持久化", () => {
    setupDom();
    const bottom = document.getElementById("bottom")!;
    const splitter = document.getElementById("bottom-splitter")!;
    wireSplitters();
    drag(splitter, 500); // happy-dom innerHeight=768 → h = 768 − 500 = 268（在 [120, 460] 内）
    expect(bottom.style.getPropertyValue("--bottom-h")).toBe("268px");
    expect(bottom.style.height).toBe(""); // 关键不变量：绝不写内联 height（否则折叠失效）
    expect(localStorage.getItem("pylume.bottom_height")).toBe("268");
  });

  it("折叠态拖动先移除 .collapsed；双击清除 --bottom-h 回落 CSS 默认并移除持久化", () => {
    setupDom();
    const bottom = document.getElementById("bottom")!;
    const splitter = document.getElementById("bottom-splitter")!;
    bottom.classList.add("collapsed");
    wireSplitters();
    drag(splitter, 500);
    expect(bottom.classList.contains("collapsed")).toBe(false); // 收起态拖动 = 直接展开调整
    splitter.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(bottom.style.getPropertyValue("--bottom-h")).toBe(""); // 回落 var(--bottom-h, 220px)
    expect(bottom.style.height).toBe("");
    expect(localStorage.getItem("pylume.bottom_height")).toBeNull();
  });

  it("restoreLayout 恢复上次高度：写 --bottom-h，仍不碰内联 height", () => {
    setupDom();
    const bottom = document.getElementById("bottom")!;
    localStorage.setItem("pylume.bottom_height", "300");
    restoreLayout(); // innerHeight=768 → 上限 floor(768×0.6)=460，300 未被裁剪
    expect(bottom.style.getPropertyValue("--bottom-h")).toBe("300px");
    expect(bottom.style.height).toBe("");
  });
});

// ---------- UI-23：面板拖拽上限随窗口宽收口 ----------
//
// 核心不变量：写进 style 的宽度必须是「当下真能渲染出来的宽度」。
// 侧栏 / 右面板改成可收缩（flex:0 1 auto + min-width）后，窄窗口下设进去的宽度会被 flex 收缩吃掉，
// 若拖拽仍按 SIDEBAR_MAX/RIGHT_MAX 常量夹取，就会出现「鼠标在动、分隔条不跟」的粘滞手感。

/** 搭出侧栏 / 右侧面板拖拽所需元素，并注入窗口宽与两个面板的实际宽。
 *  happy-dom 无样式表 → getComputedStyle(#center).minWidth 取不到，layout.ts 回落到同值常量 CENTER_MIN。 */
function setupPanels(
  winWidth: number,
  sidebarW: number,
  rightW: number,
): { sidebar: HTMLElement; rightPanel: HTMLElement; sidebarSplitter: HTMLElement; rightSplitter: HTMLElement } {
  document.body.innerHTML = "";
  const mk = (id: string, cls?: string): HTMLElement => {
    const el = document.createElement("div");
    el.id = id;
    if (cls) el.className = cls;
    document.body.appendChild(el);
    return el;
  };
  const sidebar = mk("sidebar");
  const sidebarSplitter = mk("sidebar-splitter", "splitter splitter-col");
  const rightPanel = mk("right-panel");
  const rightSplitter = mk("right-splitter", "splitter splitter-col-left");
  mk("bottom");
  mk("bottom-splitter", "splitter splitter-row");
  mk("center");
  mk("editor-row");
  mk("md-preview");
  mk("md-splitter");
  mk("split-editor-panel");
  mk("split-splitter");
  mk("view-files");
  mk("outline-section");
  mk("outline-splitter", "splitter splitter-row");
  vi.stubGlobal("innerWidth", winWidth);
  sidebar.getBoundingClientRect = () => ({ left: 0, right: sidebarW, width: sidebarW }) as unknown as DOMRect;
  rightPanel.getBoundingClientRect = () =>
    ({ left: winWidth - rightW, right: winWidth, width: rightW }) as unknown as DOMRect;
  return { sidebar, rightPanel, sidebarSplitter, rightSplitter };
}

/** 模拟一次横向拖拽：splitter 上 mousedown → window 上 mousemove(toX) → mouseup */
function dragX(splitter: HTMLElement, toX: number): void {
  splitter.dispatchEvent(new MouseEvent("mousedown", { clientX: 0, bubbles: true, cancelable: true }));
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: toX, bubbles: true, cancelable: true }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
}

describe("面板拖拽上限（UI-23）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  it("窄窗口下侧栏上限 = 窗口宽 − 编辑区下限 − 对面面板宽（而非硬上限 480）", () => {
    const { sidebar, sidebarSplitter } = setupPanels(800, 280, 360);
    wireSplitters();
    dragX(sidebarSplitter, 400); // 上限 800−240−360=200 < 400
    expect(sidebar.style.width).toBe("200px");
    expect(localStorage.getItem(SIDEBAR_KEY)).toBe("200"); // 持久化的也是收口后的真值
  });

  it("对面面板收起（宽 0）时上限退回硬上限，宽窗口下不被误收口", () => {
    const { sidebar, sidebarSplitter } = setupPanels(1600, 280, 0);
    wireSplitters();
    dragX(sidebarSplitter, 400); // 上限 min(480, 1600−240−0)=480，400 未触顶
    expect(sidebar.style.width).toBe("400px");
    dragX(sidebarSplitter, 900); // 触硬上限
    expect(sidebar.style.width).toBe("480px");
  });

  it("可用空间不足对面面板下限时，右面板收到自身下限（上限不会低于下限）", () => {
    const { rightPanel, rightSplitter } = setupPanels(800, 400, 360);
    wireSplitters();
    // 上限 = max(260, min(560, 800−240−400=160)) = 260；拖到 400 宽也只到 260
    dragX(rightSplitter, 400); // w = right(800) − 400 = 400 → clamp 到 260
    expect(rightPanel.style.width).toBe("260px");
    expect(localStorage.getItem(RIGHT_KEY)).toBe("260");
  });

  it("可用空间被夹到下限以下时，侧栏仍守住自身下限 180（不写出比下限更小的宽度）", () => {
    // 窗口 700：700 − 240(编辑区下限) − 400(右面板) = 60 < SIDEBAR_MIN → 上限抬回 180
    const { sidebar, sidebarSplitter } = setupPanels(700, 180, 400);
    wireSplitters();
    dragX(sidebarSplitter, 40);
    expect(sidebar.style.width).toBe("180px");
    expect(Number(CENTER_MIN)).toBe(240); // 与 style.css `#center{min-width}` 同值（无样式表时的回落常量）
  });
});

// ---------- C-4：分屏面板宽度拖拽（--split-w + localStorage + 双击重置） ----------

describe("分屏面板宽度拖拽（C-4）", () => {
  function setupSplit(): { panel: HTMLElement; splitter: HTMLElement } {
    setupDom();
    const panel = document.getElementById("split-editor-panel")!;
    const splitter = document.getElementById("split-splitter")!;
    const row = document.getElementById("editor-row")!;
    // editor-row 底边锚定在 500、宽 800（拖拽宽度 = 500 − toX；上限 = 800 − 240 = 560）
    row.getBoundingClientRect = () => ({ right: 500 } as unknown as DOMRect);
    Object.defineProperty(row, "clientWidth", { value: 800, configurable: true });
    return { panel, splitter };
  }

  it("拖拽写 --split-w 自定义属性并持久化；下限 240", () => {
    const { panel, splitter } = setupSplit();
    wireSplitters();
    dragX(splitter, 150); // 500 − 150 = 350（在 [240, 560] 内）
    expect(panel.style.getPropertyValue("--split-w")).toBe("350px");
    expect(localStorage.getItem("pylume-split-w")).toBe("350");
    dragX(splitter, 450); // 500 − 450 = 50 → 下限 240
    expect(panel.style.getPropertyValue("--split-w")).toBe("240px");
  });

  it("双击清除 --split-w（回落 CSS 默认 50%）并移除持久化", () => {
    const { panel, splitter } = setupSplit();
    wireSplitters();
    dragX(splitter, 150);
    expect(localStorage.getItem("pylume-split-w")).toBe("350");
    splitter.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(panel.style.getPropertyValue("--split-w")).toBe("");
    expect(localStorage.getItem("pylume-split-w")).toBeNull();
  });
});
