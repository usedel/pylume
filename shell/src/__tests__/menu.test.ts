// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import type * as MenuModule from "../menu";

let menu: typeof MenuModule;

const ctx = () => document.getElementById("ctx-menu")!;

beforeAll(async () => {
  // 动态导入：让 menu.ts 在 #ctx-menu 已存在的环境下求值（模块顶层会捕获该元素）
  if (!document.getElementById("ctx-menu")) {
    const el = document.createElement("div");
    el.id = "ctx-menu";
    el.className = "ctx-menu hidden";
    document.body.appendChild(el);
  }
  menu = await import("../menu");
});

describe("menu.ts 通用弹出菜单", () => {
  it("映射 label/icon/shortcut/detail/checked/danger/sep 到 DOM", () => {
    menu.showMenu(
      [
        { label: "在终端中运行", icon: "terminal", detail: "真 TTY", shortcut: "Ctrl+F2" },
        { label: "pyrefly", checked: true },
        { sep: true },
        { label: "删除", danger: true },
      ],
      { x: 0, y: 0 },
    );
    const el = ctx();
    expect(el.classList.contains("hidden")).toBe(false);
    expect(el.querySelectorAll(".ctx-menu-item").length).toBe(4);
    expect(el.querySelector(".mi-icon .codicon-terminal")).not.toBeNull();
    expect(el.querySelector(".mi-detail")?.textContent).toBe("真 TTY");
    expect(el.querySelector(".menu-shortcut")?.textContent).toBe("Ctrl+F2");
    expect(el.querySelector(".mi-icon .codicon-check")).not.toBeNull();
    expect(el.querySelector(".ctx-menu-item.danger")).not.toBeNull();
    expect(el.querySelector(".sep-item")).not.toBeNull();
  });

  it("disabled 项不执行 action、带 disabledReason，也不关闭菜单", () => {
    let called = false;
    menu.showMenu(
      [{ label: "已禁用", disabled: true, disabledReason: "已有脚本在运行", action: () => { called = true; } }],
      { x: 0, y: 0 },
    );
    const item = ctx().querySelector(".ctx-menu-item.disabled") as HTMLElement;
    expect(item.dataset.tip).toBe("已有脚本在运行");
    item.click();
    expect(called).toBe(false);
    expect(menu.isMenuOpen()).toBe(true);
  });

  it("普通项点击执行 action 并关闭菜单", () => {
    let called = false;
    menu.showMenu([{ label: "运行", action: () => { called = true; } }], { x: 0, y: 0 });
    const item = ctx().querySelector(".ctx-menu-item:not(.sep-item)") as HTMLElement;
    item.click();
    expect(called).toBe(true);
    expect(menu.isMenuOpen()).toBe(false);
  });
});

// ---------- UI-30：ARIA 语义与键盘导航（APG menu 模式） ----------

/** 在指定元素上派发一个冒泡的 keydown（wireMenuKeyNav 的监听挂在 #ctx-menu 容器上） */
function key(el: Element, k: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}

/** 焦点项的 label 文本（null = 焦点不在菜单项上） */
function focusedLabel(): string | null {
  const ae = document.activeElement;
  return ae?.classList.contains("ctx-menu-item") ? (ae.querySelector(".mi-label")?.textContent ?? "") : null;
}

describe("menu.ts UI-30 ARIA 与键盘导航", () => {
  it("菜单项 role=menuitem + tabindex=-1；分隔符 role=separator；禁用项 aria-disabled", () => {
    menu.showMenu(
      [
        { label: "运行" },
        { sep: true },
        { label: "已禁用", disabled: true },
      ],
      { x: 0, y: 0 },
    );
    const items = ctx().querySelectorAll<HTMLElement>(".ctx-menu-item");
    expect(items[0].getAttribute("role")).toBe("menuitem");
    expect(items[0].tabIndex).toBe(-1);
    expect(items[1].getAttribute("role")).toBe("separator");
    expect(items[2].getAttribute("role")).toBe("menuitem");
    expect(items[2].getAttribute("aria-disabled")).toBe("true");
    expect(items[0].hasAttribute("aria-disabled")).toBe(false);
  });

  it("checked 显式传入（含 false）即为单选组：role=menuitemradio + aria-checked", () => {
    menu.showMenu(
      [
        { label: "pyrefly", checked: true },
        { label: "basedpyright", checked: false },
        { label: "普通项" },
      ],
      { x: 0, y: 0 },
    );
    const items = ctx().querySelectorAll(".ctx-menu-item");
    expect(items[0].getAttribute("role")).toBe("menuitemradio");
    expect(items[0].getAttribute("aria-checked")).toBe("true");
    expect(items[1].getAttribute("role")).toBe("menuitemradio");
    expect(items[1].getAttribute("aria-checked")).toBe("false");
    expect(items[2].getAttribute("role")).toBe("menuitem");
  });

  it("打开即聚焦首个可用项", () => {
    menu.showMenu([{ label: "第一项" }, { label: "第二项" }], { x: 0, y: 0 });
    expect(focusedLabel()).toBe("第一项");
  });

  it("↑↓ 环绕漫游且跳过禁用项与分隔符；Home/End 跳首末", () => {
    menu.showMenu(
      [
        { label: "A" },
        { label: "B", disabled: true },
        { sep: true },
        { label: "C" },
      ],
      { x: 0, y: 0 },
    );
    const focusables = () => Array.from(ctx().querySelectorAll<HTMLElement>(".ctx-menu-item:not(.sep-item):not(.disabled)"));
    expect(focusedLabel()).toBe("A");
    key(focusables()[0], "ArrowDown");
    expect(focusedLabel()).toBe("C"); // B 禁用、分隔符不可聚焦，直达 C
    key(focusables()[1], "ArrowDown");
    expect(focusedLabel()).toBe("A"); // 越界环绕
    key(focusables()[0], "ArrowUp");
    expect(focusedLabel()).toBe("C"); // 反向环绕
    key(focusables()[1], "Home");
    expect(focusedLabel()).toBe("A");
    key(focusables()[0], "End");
    expect(focusedLabel()).toBe("C");
  });

  it("Enter 激活聚焦项并关闭菜单；Tab 只关闭不激活", () => {
    let called = 0;
    menu.showMenu([{ label: "A", action: () => { called++; } }, { label: "B", action: () => { called += 10; } }], { x: 0, y: 0 });
    const a = ctx().querySelectorAll<HTMLElement>(".ctx-menu-item")[0];
    key(a, "Enter");
    expect(called).toBe(1);
    expect(menu.isMenuOpen()).toBe(false);

    menu.showMenu([{ label: "A", action: () => { called += 100; } }], { x: 0, y: 0 });
    key(ctx().querySelector(".ctx-menu-item")!, "Tab");
    expect(called).toBe(1); // Tab 不激活任何项
    expect(menu.isMenuOpen()).toBe(false);
  });

  it("aria-haspopup 触发元素的 aria-expanded 随开合同步", () => {
    const btn = document.createElement("button");
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    document.body.appendChild(btn);
    btn.focus();
    menu.showMenu([{ label: "pyrefly", checked: true }], btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    menu.hideMenu();
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    btn.remove();
  });

  it("Escape 关闭菜单并把焦点归还触发元素", () => {
    const btn = document.createElement("button");
    btn.setAttribute("aria-haspopup", "menu");
    document.body.appendChild(btn);
    btn.focus();
    menu.showMenu([{ label: "A" }], btn);
    expect(focusedLabel()).toBe("A"); // 焦点已在菜单内
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.isMenuOpen()).toBe(false);
    expect(document.activeElement).toBe(btn); // APG：焦点回到调用元素
    btn.remove();
  });
});

// ---------- 回归：lazyEl 代理锚点（生产路径，原测试只用真实元素故漏掉） ----------

describe("menu.ts 锚点判定：lazyEl 代理必须按「元素」处理", () => {
  /** 造一个与生产同源的 lazyEl 代理：真实按钮 + `lazyEl(id)` 包装（Proxy target 是普通对象） */
  async function proxyAnchor(): Promise<{ btn: HTMLButtonElement; proxy: HTMLButtonElement }> {
    const { lazyEl } = await import("../state");
    const btn = document.createElement("button");
    btn.id = "run-target-probe";
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.style.position = "fixed";
    document.body.appendChild(btn);
    // 模拟标题栏右上角按钮：Proxy 的 get 陷阱会转发到真元素，故这里生效
    btn.getBoundingClientRect = () =>
      ({ left: 900, top: 4, right: 980, bottom: 32, width: 80, height: 28, x: 900, y: 4 }) as DOMRect;
    return { btn, proxy: lazyEl<HTMLButtonElement>("run-target-probe") };
  }

  it("代理锚点按元素定位（不得退化成 {x,y} 分支 → NaN → 菜单停在 0,0）", async () => {
    const { btn, proxy } = await proxyAnchor();
    // lazyEl 的 Proxy target 是 `{}` 且无 getPrototypeOf 陷阱 —— 这正是老代码 instanceof 误判的根因
    expect(proxy instanceof HTMLElement).toBe(false);

    const menuEl = ctx();
    const realRect = menuEl.getBoundingClientRect.bind(menuEl);
    menuEl.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 320, bottom: 160, width: 320, height: 160, x: 0, y: 0 }) as DOMRect;
    try {
      menu.showMenu([{ label: "A" }], proxy);
      // 期望：贴住按钮下缘（aRect.bottom + 2）；横向右侧放不下则右对齐，再夹进视口
      const M = 6;
      const menuW = 320;
      let expectLeft = 900;
      if (expectLeft + menuW > window.innerWidth - M) expectLeft = 980 - menuW;
      expectLeft = Math.max(M, Math.min(expectLeft, Math.max(M, window.innerWidth - menuW - M)));
      expect(menuEl.style.top).toBe("34px");
      expect(menuEl.style.left).toBe(`${expectLeft}px`);
      // 老代码的症状：坐标算成 NaN，写 style 被静默丢弃 → 停在复位值（窗口左上角）
      expect(menuEl.getAttribute("style")).not.toContain("NaN");
      expect(menuEl.style.top).not.toBe("0px");
    } finally {
      menuEl.getBoundingClientRect = realRect;
      menu.hideMenu();
      btn.remove();
    }
  });

  it("代理锚点的 aria-expanded 同源开合（老代码因 instanceof 误判永不置 true）", async () => {
    const { btn, proxy } = await proxyAnchor();
    try {
      menu.showMenu([{ label: "A" }], proxy);
      expect(btn.getAttribute("aria-expanded")).toBe("true");
      menu.hideMenu();
      expect(btn.getAttribute("aria-expanded")).toBe("false");
    } finally {
      btn.remove();
    }
  });
});