// @vitest-environment happy-dom
// MB-01/02/04（menubar_improvement_plan.md 第二批）：menuBar.ts 交互不变量。
// 环境范式照抄 menu.test.ts——先建齐 #menu-dropdown / #menu-submenu / .menubar-item 再动态 import，
// 否则模块顶层 $() 直接抛「缺少元素」。
// 注意：wireMenuBar 的监听器挂在共享 DOM 上会叠加（menuKeys.ts 头注释「每个容器只可调用一次」），
// 故全程只 wire 一次，数据源用可替换的闭包（switchItems）驱动。
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as MenuBarModule from "../menuBar";
import type { MenuEntry } from "../menuBar";

let menuBar: typeof MenuBarModule;

const dropdown = () => document.getElementById("menu-dropdown")!;
const submenu = () => document.getElementById("menu-submenu")!;

/** 可替换的菜单数据源（wireMenuBar 只接一次，用例内切换返回值） */
let currentItems: (menu: string) => MenuEntry[] = () => [];

/** 组装一个带 submenu 父项 + 普通项的「文件」菜单数据源（结构对齐 main.ts::getMenuItems） */
function fileItems(): MenuEntry[] {
  return [
    { label: "最近的工作区", submenu: () => [{ label: "ws-a", action: () => undefined }] },
    { label: "保存" },
    { label: "关闭工作区" },
  ];
}

function openFileMenu(): void {
  // 用例间状态隔离：菜单可能因上一用例而处于展开态（click 走「同按钮=关闭」分支会导致
  // 本用例实际没打开菜单），先按 Esc 归零再点击
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: false }));
  const btn = document.querySelector<HTMLButtonElement>('.menubar-item[data-menu="file"]')!;
  btn.click();
}

/** 展开第一个 submenu 父项（点击即同步展开路径），推进 openSubmenu 的 await 后返回 */
async function openFirstSubmenu(): Promise<void> {
  const parent = dropdown().querySelector(".ctx-menu-item.with-submenu") as HTMLElement;
  parent.click();
  await vi.advanceTimersByTimeAsync(0);
}

beforeAll(async () => {
  // 第二批改动依赖的元素骨架（menuBar.ts 顶层 $() 的取值目标）
  for (const id of ["menu-dropdown", "menu-submenu"]) {
    const el = document.createElement("div");
    el.id = id;
    el.className = "hidden";
    document.body.appendChild(el);
  }
  // MB-05：漫游 keydown 挂在 #menubar 容器上，按钮须在其内（closest 匹配）
  const bar = document.createElement("nav");
  bar.id = "menubar";
  bar.setAttribute("role", "menubar");
  document.body.appendChild(bar);
  for (const m of ["file", "edit"]) {
    const btn = document.createElement("button");
    btn.className = "menubar-item";
    btn.dataset.menu = m;
    btn.setAttribute("role", "menuitem");
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    bar.appendChild(btn);
  }
  menuBar = await import("../menuBar");
  menuBar.wireMenuBar((menu) => currentItems(menu));
});

describe("menuBar.ts MB-02 · 顶级菜单 hover 切换", () => {
  it("未展开任何菜单时，hover 不弹菜单（避免乱弹）", () => {
    currentItems = () => fileItems();
    const editBtn = document.querySelector<HTMLButtonElement>('.menubar-item[data-menu="edit"]')!;
    editBtn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    expect(dropdown().classList.contains("hidden")).toBe(true);
  });

  it("已展开时，hover 相邻按钮直接切换菜单（无需点击）", () => {
    const getItems = vi.fn((menu: string) => (menu === "edit" ? [{ label: "撤销" }] : fileItems()));
    currentItems = getItems;
    openFileMenu();
    expect(dropdown().classList.contains("hidden")).toBe(false);
    const editBtn = document.querySelector<HTMLButtonElement>('.menubar-item[data-menu="edit"]')!;
    editBtn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    expect(getItems).toHaveBeenCalledWith("edit");
    expect(dropdown().querySelector(".ctx-menu-item")?.textContent).toContain("撤销");
    // 旧按钮开合态复位、新按钮激活（aria 同源切换）
    expect(document.querySelector('.menubar-item[data-menu="file"]')!.getAttribute("aria-expanded")).toBe("false");
    expect(editBtn.getAttribute("aria-expanded")).toBe("true");
  });

  it("hover 当前已展开的按钮无操作（不闪烁）", () => {
    currentItems = () => fileItems();
    openFileMenu();
    const btn = document.querySelector<HTMLButtonElement>('.menubar-item[data-menu="file"]')!;
    const before = dropdown().querySelector(".ctx-menu-item");
    btn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    expect(dropdown().querySelector(".ctx-menu-item")).toBe(before);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("menuBar.ts MB-01 · 三角缓冲（普通项延时关闭）", () => {
  it("悬停普通项不立即关闭已展开的子菜单（延时缓冲）", async () => {
    vi.useFakeTimers();
    try {
      currentItems = () => fileItems();
      openFileMenu();
      await openFirstSubmenu();
      expect(submenu().classList.contains("hidden")).toBe(false);
      // 斜移扫过普通项：mouseenter 不再瞬间关（旧实现为 hideSubmenu 立即关）
      const normal = dropdown().querySelectorAll(".ctx-menu-item")[1] as HTMLElement;
      normal.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      expect(submenu().classList.contains("hidden")).toBe(false); // 关键断言：仍在
      // 停留超过缓冲窗口后收起
      await vi.advanceTimersByTimeAsync(600);
      expect(submenu().classList.contains("hidden")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("斜移落入子菜单容器会取消关闭（三角缓冲闭合）", async () => {
    vi.useFakeTimers();
    try {
      currentItems = () => fileItems();
      openFileMenu();
      await openFirstSubmenu();
      const normal = dropdown().querySelectorAll(".ctx-menu-item")[1] as HTMLElement;
      normal.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      // 关闭计时内进入子菜单容器（其 mouseenter 取消计时）
      await vi.advanceTimersByTimeAsync(100);
      submenu().dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      await vi.advanceTimersByTimeAsync(600);
      expect(submenu().classList.contains("hidden")).toBe(false); // 未被关掉
    } finally {
      vi.useRealTimers();
    }
  });

  it("悬停父项 200ms 后子菜单展开（既有行为不回归）", async () => {
    vi.useFakeTimers();
    try {
      currentItems = () => fileItems();
      openFileMenu();
      const parent = dropdown().querySelector(".ctx-menu-item.with-submenu") as HTMLElement;
      parent.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      await vi.advanceTimersByTimeAsync(250);
      expect(submenu().classList.contains("hidden")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("menuBar.ts MB-04 · 嵌套 submenu 降级拦截", () => {
  it("子项带 submenu 时 console.warn 并按普通项渲染（不再静默丢弃）", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      currentItems = () => [
        { label: "父", submenu: () => [{ label: "嵌套项", submenu: () => [{ label: "孙项" }] }] },
      ];
      openFileMenu();
      await openFirstSubmenu();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][1])).toContain("嵌套项");
      // 渲染为普通项：无 with-submenu 类、无箭头、label 完整
      const child = submenu().querySelector(".ctx-menu-item") as HTMLElement;
      expect(child.classList.contains("with-submenu")).toBe(false);
      expect(child.querySelector(".sub-arrow")).toBeNull();
      expect(child.querySelector(".sub-label")?.textContent).toBe("嵌套项");
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("menuBar.ts MB-05 · menubar 键盘漫游", () => {
  /** 在菜单按钮上派发冒泡 keydown（漫游监听挂在 #menubar 容器） */
  function barKey(el: Element, k: string): void {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  }

  it("聚焦菜单按钮后 → 移到下一个按钮；环绕到首", () => {
    currentItems = () => fileItems();
    // 用例隔离：上一用例可能残留展开态（焦点在下拉项上），先 Esc 归零
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: false }));
    const fileBtn = document.querySelector<HTMLButtonElement>('.menubar-item[data-menu="file"]')!;
    const editBtn = document.querySelector<HTMLButtonElement>('.menubar-item[data-menu="edit"]')!;
    fileBtn.focus();
    barKey(fileBtn, "ArrowRight");
    expect(document.activeElement).toBe(editBtn);
    barKey(editBtn, "ArrowRight");
    expect(document.activeElement).toBe(fileBtn); // 环绕
    barKey(fileBtn, "ArrowLeft");
    expect(document.activeElement).toBe(editBtn); // ← 环绕
    barKey(editBtn, "Home");
    expect(document.activeElement).toBe(fileBtn);
    barKey(fileBtn, "End");
    expect(document.activeElement).toBe(editBtn);
  });

  it("展开态下 ← 在下拉内切到上一个菜单（含子菜单收回）", async () => {
    vi.useFakeTimers();
    try {
      currentItems = () => fileItems();
      openFileMenu();
      // 焦点在下拉首项上（showMenuDropdown 移入），按 ← 应切到上一个菜单（edit，环绕）
      const first = dropdown().querySelector(".ctx-menu-item") as HTMLElement;
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
      // moveMenubarFocus 切换菜单后焦点移入新下拉首项
      expect(document.querySelector('.menubar-item[data-menu="edit"]')!.getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector('.menubar-item[data-menu="file"]')!.getAttribute("aria-expanded")).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("menuBar.ts MB-08 · MenuEntry 新字段渲染（下拉）", () => {
  it("icon/checked/disabled/disabledReason/danger 映射到 DOM（下拉分支）", () => {
    currentItems = () => [
      { label: "有图标", icon: "terminal" },
      { label: "已选引擎", checked: true },
      { label: "未选引擎", checked: false },
      { label: "不可用", disabled: true, disabledReason: "没有工作区" },
      { label: "危险", danger: true },
    ];
    openFileMenu();
    const items = Array.from(dropdown().querySelectorAll(".ctx-menu-item"));
    expect(items[0].querySelector(".mi-icon .codicon-terminal")).not.toBeNull();
    const checked = items[1];
    expect(checked.getAttribute("role")).toBe("menuitemradio");
    expect(checked.getAttribute("aria-checked")).toBe("true");
    expect(checked.querySelector(".mi-icon .codicon-check")).not.toBeNull();
    // checked=false 也是 menuitemradio（防「只标 true 项」的组语义残缺）
    expect(items[2].getAttribute("role")).toBe("menuitemradio");
    expect(items[2].getAttribute("aria-checked")).toBe("false");
    const disabled = items[3] as HTMLElement;
    expect(disabled.classList.contains("disabled")).toBe(true);
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.dataset.tip).toBe("没有工作区");
    expect(items[4].classList.contains("danger")).toBe(true);
  });

  it("disabled 项点击不执行 action 也不关闭菜单（下拉分支）", () => {
    let called = false;
    currentItems = () => [{ label: "不可用", disabled: true, action: () => { called = true; } }];
    openFileMenu();
    const item = dropdown().querySelector(".ctx-menu-item") as HTMLElement;
    item.click();
    expect(called).toBe(false);
    expect(dropdown().classList.contains("hidden")).toBe(false); // 菜单仍在
  });

  it("disabled 父项不接线展开（with-submenu + disabled）", async () => {
    vi.useFakeTimers();
    try {
      currentItems = () => [
        { label: "禁用父项", disabled: true, disabledReason: "无记录", submenu: () => [{ label: "子" }] },
      ];
      openFileMenu();
      const parent = dropdown().querySelector(".ctx-menu-item.with-submenu") as HTMLElement;
      parent.click();
      await vi.advanceTimersByTimeAsync(300);
      expect(submenu().classList.contains("hidden")).toBe(true); // 未展开
      expect(parent.getAttribute("aria-disabled")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("子菜单分支同样支持 icon/checked/disabled/danger", async () => {
    vi.useFakeTimers();
    try {
      currentItems = () => [
        {
          label: "父",
          submenu: () => [
            { label: "子-图标", icon: "json" },
            { label: "子-勾选", checked: true },
            { label: "子-禁用", disabled: true, disabledReason: "路径不存在" },
            { label: "子-危险", danger: true },
          ],
        },
      ];
      openFileMenu();
      await openFirstSubmenu();
      const kids = Array.from(submenu().querySelectorAll(".ctx-menu-item"));
      expect(kids[0].querySelector(".mi-icon .codicon-json")).not.toBeNull();
      expect(kids[1].getAttribute("role")).toBe("menuitemradio");
      expect(kids[1].getAttribute("aria-checked")).toBe("true");
      expect(kids[2].classList.contains("disabled")).toBe(true);
      expect((kids[2] as HTMLElement).dataset.tip).toBe("路径不存在");
      expect(kids[3].classList.contains("danger")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
