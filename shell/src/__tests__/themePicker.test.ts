// @vitest-environment happy-dom
// UI-26 回归：主题选择器（自绘预览色卡，替代原生 <select>）。
//
// 核心不变量：
// 1) 值真源 = DOM 的 aria-checked，getSelectedTheme / setSelectedTheme 都只读写这一处
//    （若后人另设模块级变量缓存选中值，表单填充与视觉态就会分叉——第四/六批的同款教训）；
// 2) radiogroup 语义完整：每项 role=radio、任意时刻恰好一项 aria-checked=true、
//    漫游 tabindex（选中项 0、其余 -1，组内只占一个 tab stop）；
// 3) 键盘 ←→↑↓ 移动即选中（radio 模式），Home/End 跳首尾；
// 4) 未知主题值（手改配置）回落深色，不留「无选中项」的悬空态。
// ⚠ 批 4：主题值从 Monaco 出厂名（vs-dark / vs）换成自定义名（pylume-*），
//    本文件的 DARK/LIGHT 改为引用 theme/tokens.ts 的常量——再手写字面量就多一处会漂的副本。
import { beforeEach, describe, expect, it } from "vitest";
import { getSelectedTheme, setSelectedTheme, wireThemePicker } from "../themePicker";
import { EDITOR_THEME_DARK, EDITOR_THEME_LIGHT } from "../theme/tokens";

const DARK = EDITOR_THEME_DARK;
const LIGHT = EDITOR_THEME_LIGHT;

function swatches(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".theme-swatch"));
}

function byTheme(value: string): HTMLElement {
  const el = swatches().find((s) => s.dataset.theme === value);
  if (!el) throw new Error(`未渲染主题卡 ${value}`);
  return el;
}

/** 在指定卡片上派发一次组内键盘事件（监听器委托在容器上，需冒泡） */
function key(el: HTMLElement, k: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  document.body.innerHTML = "";
  const picker = document.createElement("div");
  picker.id = "settings-theme-picker";
  picker.className = "theme-picker";
  picker.setAttribute("role", "radiogroup");
  document.body.appendChild(picker);
  wireThemePicker();
});

describe("主题选择器（UI-26）", () => {
  it("渲染深/浅两张预览卡，均为 role=radio，初始选中深色", () => {
    expect(swatches().length).toBe(2);
    for (const s of swatches()) expect(s.getAttribute("role")).toBe("radio");
    expect(getSelectedTheme()).toBe(DARK);
    expect(byTheme(DARK).getAttribute("aria-checked")).toBe("true");
    expect(byTheme(LIGHT).getAttribute("aria-checked")).toBe("false");
  });

  it("预览色块对读屏隐藏，可访问名称来自主题名文本", () => {
    for (const s of swatches()) {
      expect(s.querySelector(".theme-pv")?.getAttribute("aria-hidden")).toBe("true");
      expect(s.textContent).toMatch(/深色|浅色/);
    }
    expect(byTheme(DARK).textContent).toContain("深色");
    expect(byTheme(LIGHT).textContent).toContain("浅色");
  });

  it("任意时刻恰好一项 aria-checked=true，且漫游 tabindex 同源切换", () => {
    setSelectedTheme(LIGHT);
    const checked = swatches().filter((s) => s.getAttribute("aria-checked") === "true");
    expect(checked.length).toBe(1);
    expect(checked[0].dataset.theme).toBe(LIGHT);
    expect(byTheme(LIGHT).tabIndex).toBe(0);
    expect(byTheme(DARK).tabIndex).toBe(-1);
    expect(getSelectedTheme()).toBe(LIGHT); // 读的是 DOM，不是缓存
  });

  it("点击卡片即选中（表单值随之改变，但不即时套用主题）", () => {
    document.documentElement.dataset.theme = "dark"; // 当前生效主题
    byTheme(LIGHT).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(getSelectedTheme()).toBe(LIGHT);
    // 套主题是 saveSettingsPanel 的职责（否则「取消」无法回退）：本模块不得碰 html[data-theme]
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("未知主题值回落深色，不留无选中项的悬空态", () => {
    setSelectedTheme(LIGHT);
    setSelectedTheme("hc-black"); // 手改配置可能出现的值
    expect(getSelectedTheme()).toBe(DARK);
    expect(swatches().filter((s) => s.getAttribute("aria-checked") === "true").length).toBe(1);
  });

  it("方向键移动即选中并移动焦点；Home/End 跳首尾", () => {
    const dark = byTheme(DARK);
    dark.focus();
    key(dark, "ArrowRight");
    expect(getSelectedTheme()).toBe(LIGHT);
    expect(document.activeElement).toBe(byTheme(LIGHT));
    key(byTheme(LIGHT), "ArrowRight"); // 环绕
    expect(getSelectedTheme()).toBe(DARK);
    key(byTheme(DARK), "ArrowUp"); // 竖排方向键同样生效（横排排布下 ←→↑↓ 等价）
    expect(getSelectedTheme()).toBe(LIGHT);
    key(byTheme(LIGHT), "Home");
    expect(getSelectedTheme()).toBe(DARK);
    key(byTheme(DARK), "End");
    expect(getSelectedTheme()).toBe(LIGHT);
  });

  it("非导航键不改变选中态", () => {
    key(byTheme(DARK), "Tab");
    key(byTheme(DARK), "a");
    expect(getSelectedTheme()).toBe(DARK);
  });

  it("重复接线不重复渲染卡片（wireThemePicker 幂等）", () => {
    wireThemePicker();
    expect(swatches().length).toBe(2);
  });
});
