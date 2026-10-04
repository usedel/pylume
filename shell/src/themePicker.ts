// 主题选择器（UI-26：预览色卡）。
//
// 原先是原生 <select id="settings-theme">，选项只有纯文字 Dark / Light——用户看不到两套主题的基调差异，
// 只能靠猜或切过去试。而 <option> 内不支持复杂 HTML（色卡放不进去），故改为自绘单选组：
// 每个主题一张迷你预览卡（左侧栏条 + 三条正文色带，取该主题自身的基调色，见 style.css 的 --theme-pv-* token）。
//
// 三条设计约束：
// 1) 值真源 = DOM 的 aria-checked，不另设模块级变量。settingsPanel 的 fillForm / saveSettingsPanel
//    各经 setSelectedTheme / getSelectedTheme 读写这一处，避免「表单值与视觉态分叉」
//    （第四批 syncHiddenFilesBtn、第六批 setTreeItemSelected 的同款教训：散落两写必然漂移）。
// 2) 语义走 WAI-ARIA radiogroup 模式：role=radio + aria-checked + 漫游 tabindex（组内只一个 tab stop），
//    ←→↑↓ 移动即选中（radio 语义）、Home/End 跳首尾；Space/Enter 由 <button> 原生激活，无需另接。
// 3) 切换只改表单值、不即时套用主题——与原 select 行为一致（点「保存」才 setTheme）。
//    若改成即时预览，「取消」就无法回退，与设置面板其余控件的语义不一致。

import { $ } from "./state";
import { EDITOR_THEME_DARK, EDITOR_THEME_LIGHT } from "./theme/tokens";
import { onLocaleChange, t } from "./i18n"; // i18n：主题名随语言重建（卡片文本就地更新，见底部订阅）
import { codicon } from "./util";

/** 可选主题：value 与 Monaco 主题名 / Settings.theme 一致；pv 对应 .theme-pv--{pv} 预览配色。
 *  name 是展示文案——构建函数 + let + onLocaleChange 重建（⑧/⑮ 模式），语言切换后卡片名就地更新。
 *  ⚠ 批 4 起 value 是自定义主题名（pylume-*）而非 Monaco 出厂名，判定浅色一律走
 *  shellThemeOf（theme/tokens.ts），不要在本文件里写 `=== "vs"` 字面量。 */
function buildThemes(): Array<{ value: string; name: string; pv: string }> {
  return [
    { value: EDITOR_THEME_DARK, name: t("settings.theme.dark"), pv: "dark" },
    { value: EDITOR_THEME_LIGHT, name: t("settings.theme.light"), pv: "light" },
  ];
}

let THEMES = buildThemes();

/** 兜底主题（= state.ts DEFAULT_SETTINGS.theme）：无选中项或值不在候选内时使用 */
const FALLBACK_THEME = EDITOR_THEME_DARK;
const PICKER_ID = "settings-theme-picker";

/** 方向键 → 步进（radiogroup 模式：移动焦点即选中） */
const MOVE_STEP: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

function swatches(): HTMLElement[] {
  return Array.from($(PICKER_ID).querySelectorAll<HTMLElement>(".theme-swatch"));
}

/** 当前选中的主题值（读 aria-checked；无选中项时回落深色） */
export function getSelectedTheme(): string {
  const hit = swatches().find((el) => el.getAttribute("aria-checked") === "true");
  return hit?.dataset.theme ?? FALLBACK_THEME;
}

/** 写入选中态：aria-checked（读屏 + CSS 选中样式）与漫游 tabindex 同源切换。
 *  值不在候选内（如手改配置写了 "hc-black"）时退回默认项，避免「无选中」的悬空态。 */
export function setSelectedTheme(value: string): void {
  const list = swatches();
  const target =
    list.find((el) => el.dataset.theme === value) ??
    list.find((el) => el.dataset.theme === FALLBACK_THEME);
  for (const el of list) {
    const sel = el === target;
    el.setAttribute("aria-checked", String(sel));
    el.tabIndex = sel ? 0 : -1; // radiogroup：组内只有一个 tab stop
  }
}

/** 预览卡内的迷你窗口示意（纯装饰，对读屏隐藏；可访问名称来自卡内的主题名文本） */
function buildPreview(pv: string): HTMLElement {
  const box = document.createElement("span");
  box.className = `theme-pv theme-pv--${pv}`;
  box.setAttribute("aria-hidden", "true");
  const side = document.createElement("span");
  side.className = "theme-pv-side";
  const body = document.createElement("span");
  body.className = "theme-pv-body";
  for (const cls of [
    "theme-pv-line theme-pv-line--accent",
    "theme-pv-line",
    "theme-pv-line theme-pv-line--short",
  ]) {
    const line = document.createElement("span");
    line.className = cls;
    body.appendChild(line);
  }
  box.append(side, body);
  return box;
}

/** 一次性构建两张预览卡（卡片结构静态，此后选中态只改属性、不重建节点）。
 *  容器的 role="radiogroup" 与 aria-labelledby 是结构性语义，静态写在 index.html（与 settings-nav 的
 *  role="tablist" 同一处理方式），此处不重复设置。 */
function renderPicker(): void {
  const root = $(PICKER_ID);
  root.textContent = "";
  for (const th of THEMES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-swatch";
    btn.dataset.theme = th.value;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", "false");
    btn.tabIndex = -1;
    btn.appendChild(buildPreview(th.pv));

    const name = document.createElement("span");
    name.className = "theme-swatch-name";
    name.appendChild(codicon("check")); // 勾选态图标：CSS 按 aria-checked 切可见性（占位常驻，两卡等宽不跳动）
    name.append(th.name);
    btn.appendChild(name);

    btn.addEventListener("click", () => setSelectedTheme(th.value));
    root.appendChild(btn);
  }
  setSelectedTheme(FALLBACK_THEME); // 初始态：默认深色（打开面板时 fillForm 会写入真实值）
}

/** 组内键盘导航（事件委托到容器：卡片是动态构建的，逐个绑定易漏） */
function wireKeyboard(): void {
  $(PICKER_ID).addEventListener("keydown", (e) => {
    const list = swatches();
    if (list.length < 2) return;
    const from = list.indexOf(e.target as HTMLElement);
    if (from < 0) return;
    let to: number;
    if (e.key === "Home") to = 0;
    else if (e.key === "End") to = list.length - 1;
    else if (e.key in MOVE_STEP) to = (from + MOVE_STEP[e.key] + list.length) % list.length;
    else return;
    e.preventDefault();
    const target = list[to];
    setSelectedTheme(target.dataset.theme ?? FALLBACK_THEME);
    target.focus();
  });
}

/** 接线（wireSettingsPanel 内调用一次）：构建卡片 + 组内键盘导航 */
export function wireThemePicker(): void {
  renderPicker();
  wireKeyboard();
}

// 语言切换：重建 THEMES，并就地把已构建卡片的名称文本换新——
// 不整卡重渲染（renderPicker 会把选中态重置为兜底值，覆盖 fillForm 写入的真实选中项），
// 只换 .theme-swatch-name 里的文本节点，aria-checked / tabIndex 原样保留。
onLocaleChange(() => {
  THEMES = buildThemes();
  const byValue = new Map(THEMES.map((th) => [th.value, th.name]));
  for (const el of swatches()) {
    const label = byValue.get(el.dataset.theme ?? "");
    const nameEl = el.querySelector<HTMLElement>(".theme-swatch-name");
    if (!label || !nameEl) continue;
    const icon = nameEl.firstElementChild; // 勾选态 codicon 占位常驻，保留
    nameEl.textContent = "";
    if (icon) nameEl.appendChild(icon);
    nameEl.append(label);
  }
});
