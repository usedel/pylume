// Monaco 主题的「槽位 → CSS 变量」映射（ui_premium 批 4 · 设计报告 §5.4 / dev_plan §6.4）。
//
// ## 为什么本模块一个色值都没有
//
// 方案原文（§5.4）写的是「`theme/tokens.ts` 是 CSS 与 Monaco 的单一真源」，但批 2a/2b 已经把
// 外壳 token 落在 style.css，并配了三层同步义务：`styleTokens.test.ts` 的断言、index.html 的
// FOUC 内联兜底块、index.html 头部注释里的同步项清单。若再把色值抄一份进 TS，就出现第二套真值：
// 改 style.css 不会动 Monaco、改 TS 不会动外壳，两套漂移后**任何静态门禁都看不出来**
// （两边的值都是合法颜色，audit_tokens.py 与单测都无从报警）。
//
// 所以本模块只声明映射，色值在 defineTheme 时从 CSS 变量现读（见 monaco.ts::defineEditorThemes）。
// CSS 仍是唯一真源，批 2a 的成果与 FOUC 链零改动。
//
// 由此还得到一个结构性收益：**深浅两套主题共用同一份映射表**——差异全部落在 CSS 的
// [data-theme="light"] 覆盖层里。切主题只需切 data-theme 后重新注册，映射表永不重复。
//
// 断言见 __tests__/themeTokens.test.ts（映射引用的变量必须在两套主题下都有定义）。
//
// ## 已登记的缺口：Monaco 浮层圆角无法跟随外壳（批 5c 实测）
//
// 批 5c 把外壳圆角主档从 3px 提到 6px 后，Monaco 侧的浮层（补全建议框 / hover 浮层）
// **无法**跟着走：遍历 monaco-editor 0.52.2 的 esm 产物确认，它**没有注册任何
// `*.borderRadius` 主题槽位**（全仓只有 `scrollElement.style.borderRadius` 这个 DOM API，
// 以及 `editorSuggestWidget.background` 这类颜色槽位）。即在 0.52 上「用主题同步浮层圆角」
// 这条路走不通。
//
// 备选方案是 CSS 覆盖 `.monaco-editor .suggest-widget { border-radius: … }`，本批**不做**：
// ① 收益低——Monaco 浮层与外壳浮层几乎不同时同屏，感知度接近 0；
// ② 风险高——要用 `!important` 压 Monaco 的内联样式，而该 widget 挂载在
//    `.overflow-guard` 内且随补全弹窗反复重绘，改错了会连带影响补全框定位。
// 登记为已知缺口，待 Monaco 升级到支持该槽位的版本再补。

/** 出厂深色主题名（= Settings.theme 的深色取值） */
export const EDITOR_THEME_DARK = "pylume-dark";
/** 出厂浅色主题名（= Settings.theme 的浅色取值） */
export const EDITOR_THEME_LIGHT = "pylume-light";

/** 批 4 之前的出厂主题名 → 新名。
 *
 *  ⚠ 方案 §5.4 写的是 `vs-dark` / `vs-light`，但**存量浅色值实际是 `"vs"`**（themePicker 的候选值、
 *    applyShellTheme 的判定、terminal.ts 的判定三处都是 `"vs"`；`vs-light` 从未在本仓库出现过）。
 *    三种串一并映射，避免「照抄方案的迁移表漏掉唯一那个真实存量值」。
 *
 *  口径与批 3 的 migrateLegacyFontSettings 一致：**只认旧出厂名**，用户手改配置写的任意值原样保留
 *  （resolveEditorTheme 阶段会兜底回深色，不抛错）。 */
export const LEGACY_EDITOR_THEMES: Readonly<Record<string, string>> = {
  "vs-dark": EDITOR_THEME_DARK,
  vs: EDITOR_THEME_LIGHT,
  "vs-light": EDITOR_THEME_LIGHT,
};

/** 是否浅色主题（**浅色判定的唯一来源**）。
 *
 *  批 4 之前有三处各写一份 `theme === "vs"`：applyShellTheme（外壳 data-theme）、terminal.ts
 *  （终端配色）、markdownPreview（导出临时切主题）。主题改名后三处都会静默失效——浅色用户会
 *  得到深色外壳配深色终端这类「半深半浅」的界面，且不报任何错。集中到此函数后才可被单测钉死。 */
export function isLightEditorTheme(theme: string): boolean {
  return theme === EDITOR_THEME_LIGHT;
}

/** 主题名归一：旧出厂名映射到新名；未知值回落深色。
 *
 *  为什么不直接抛错：Monaco 对未注册的主题名会静默回落默认主题，用户看不出「配置写错了」，
 *  只觉得「主题被重置了」。这里显式兜底，并把兜底结果变成可断言的确定行为。 */
export function resolveEditorTheme(theme: string): string {
  const mapped = LEGACY_EDITOR_THEMES[theme];
  if (mapped) return mapped;
  return isLightEditorTheme(theme) ? EDITOR_THEME_LIGHT : EDITOR_THEME_DARK;
}

/** 主题名 → html[data-theme] 的取值（**data-theme 判定的唯一来源**，无 DOM 依赖，可纯 Node 单测）。
 *
 *  批 4 之前这里是 `theme === "vs"`，而三处（外壳 / 终端 / 导出）各写一份。改主题名后任何一处
 * 漏改都是静默故障，故抽成纯函数由单测钉死，实际赋值仍留在各自的调用点。 */
export function shellThemeOf(theme: string): "light" | "dark" {
  return isLightEditorTheme(resolveEditorTheme(theme)) ? "light" : "dark";
}

/** Monaco colors 槽位 → CSS 变量名。
 *
 *  只收「CSS 侧已有对应 token」的槽位——**不为 Monaco 内部件新增一堆专属变量**（方案精神是减法）。
 *  未列入的槽位靠 defineTheme 的 `inherit: true` 落到 base 主题（vs-dark / vs），与出厂观感一致。
 *
 *  `lineHighlightBorder` 是唯一硬编码的色值：Monaco 默认给当前行画一条边框（vs-dark 是 #282828），
 *  与本项目「层级靠表面差、不靠描边」的表面阶梯纪律冲突，故显式置透明（#00000000 = 8 位 hex 的全透明）。 */
const COLOR_SLOTS: Readonly<Record<string, string>> = {
  // —— 画布与前景 ——
  "editor.background": "--surface-2",
  "editor.foreground": "--fg",
  "editorCursor.foreground": "--fg",
  // —— gutter 与当前行 ——
  "editorGutter.background": "--surface-2",
  // ⚠ 槽位 id 必须是 Monaco **已注册**的颜色 id，否则 defineTheme 收下但 CSS 变量循环
  //   只遍历注册表 → 该槽位永不注入 → 映射静默失效（真机 R-FIXA-1 就是这么抓到的：
  //   `editorGutter.foreground` 在 0.52.2 里不存在，行号一直吃出厂色，浅色下仍是蓝
  //   `#237893`，与 ADR-0005 单色相轴冲突）。行号的真实 id 是 editorLineNumber.*。
  "editorLineNumber.foreground": "--fg-dim",
  "editorLineNumber.activeForeground": "--fg",
  "editor.lineHighlightBackground": "--editor-line-highlight",
  "editor.lineHighlightBorder": "#00000000",
  // —— 选区 ——
  "editor.selectionBackground": "--selected",
  "editor.inactiveSelectionBackground": "--control-hover",
  "editor.selectionHighlightBackground": "--selected",
  // —— 缩进参考线（实色，故走表面档而非 --indent-guide 的半透明）——
  //  ⚠ 取证状态：0.52.2 的缩进线走 guidesTextModelPart + `guides.enabled` 配置，本次 e2e 未能取到
  //    其 DOM（`indent-guide` class 在该版本 esm 产物里不作为 .view-line 子节点出现），故
  //    e2e/editor/11 未断言这两项；槽位本身在 standalone/common/themes.js 中存在、映射有效，
  //    视觉由基线截图覆盖。若日后要加断言，先在浏览器里确认实际 class 再写选择器。
  "editorIndentGuide.background1": "--surface-3",
  "editorIndentGuide.activeBackground1": "--surface-4",
  // —— 浮层：建议 / hover / 参数提示（bg 抬升到 S3，边框走 --border）——
  "editorWidget.background": "--surface-3",
  "editorWidget.border": "--border",
  "editorHoverWidget.background": "--surface-3",
  "editorHoverWidget.border": "--border",
  "editorSuggestWidget.background": "--surface-3",
  "editorSuggestWidget.border": "--border",
  "editorSuggestWidget.selectedBackground": "--selected",
  // —— 滚动条 / 焦点环 ——
  "scrollbarSlider.background": "--scrollbar-thumb",
  "scrollbarSlider.hoverBackground": "--scrollbar-thumb-hover",
  "scrollbarSlider.activeBackground": "--scrollbar-thumb-hover",
  focusBorder: "--accent",
  // —— 诊断下划线（配色源语义色，与外壳 --danger 一致）——
  "editorError.foreground": "--danger",
  "editorWarning.foreground": "--warn",
  "editorInfo.foreground": "--meta",
};

/** Monaco token（Monarch token 名）→ CSS 变量名。
 *
 *  token 名取自本项目实际启用的词法定义（monaco.ts 静态引入的 python.js 及其余 basic-languages），
 *  不是照抄某份主题：python.js 的 root 产出 `identifier` / `keyword` / `tag` / `string` /
 *  `string.escape` / `number` / `number.hex` / `delimiter` / `delimiter.bracket` /
 *  `delimiter.parenthesis` / `comment` / `white`。Monaco 的 rules 按**后缀**匹配，
 *  故写 `string` 即覆盖 `string.escape`。
 *
 *  `--syntax-boolean` 的语义在批 4 从「布尔」扩展为「关键字/常量」：Monarch 把 `True/False/None`
 *  与 `def/class/if/return` 统统归进 `keyword`，词法层面无法再细分（VS Code 靠 TextMate 的
 *  `constant.language` 区分，本项目用的是 Monarch）。染成紫轴是 One Dark Pro 等主题的主流做法。 */
const TOKEN_SLOTS: Readonly<Record<string, string>> = {
  identifier: "--syntax-var",
  variable: "--syntax-var",
  tag: "--syntax-var",
  string: "--syntax-string",
  number: "--syntax-number",
  keyword: "--syntax-boolean",
  constant: "--syntax-boolean",
  type: "--syntax-object",
  comment: "--fg-dim",
  delimiter: "--fg-dim",
  operator: "--fg",
  invalid: "--danger",
};

/** 每个主题的 base：Monaco 内置主题名，defineTheme 的 inherit 兜底底座。
 *  ⚠ 浅色 base 必须是 `"vs"`——Monaco 没有名为 `vs-light` 的内置主题（这也是存量值是 `"vs"` 的由来）。 */
export const THEME_BASES: Readonly<Record<string, "vs-dark" | "vs">> = {
  [EDITOR_THEME_DARK]: "vs-dark",
  [EDITOR_THEME_LIGHT]: "vs",
};

/* ------------------------------------------------------------------------- *
 * 色值格式归一（本模块唯一的「非映射」职责）
 *
 * ## 为什么必须有这一步（2026-10-03 实测，取证链见下）
 *
 * Monaco 的主题色**只接受 hex**。monaco-editor 0.52.2 的解析链是：
 *   standaloneThemeService.js::StandaloneTheme.getColors()
 *     → `Color.fromHex(themeData.colors[id])`
 *     → base/common/color.js::Color.Format.CSS.parseHex()  // 只认 #RGB/#RGBA/#RRGGBB/#RRGGBBAA
 *     → 解析失败 **返回 `Color.red`**
 *
 * 也就是说：把 `rgba(255, 255, 255, 0.14)` 这类 CSS 合法色喂给 defineTheme，
 * **不报错、不警告**，槽位直接变成纯红 `#ff0000`。
 *
 * 本项目的 token 恰好大量用 rgba（半透明是批 2b 的核心手法），故这条路径真实被踩到：
 * `--scrollbar-thumb` / `--scrollbar-thumb-hover` 是 rgba → 编辑器滚动条**纯红**；
 * `--border` 是 `var(--border-subtle)`（computed 后是 rgba）→ 补全框 / hover 框**红边框**；
 * 而 `minimapSlider.*` 在 minimapColors.js 里的出厂默认是
 * `transparent(scrollbarSlider.background, 0.5)` —— **由坏值派生**，于是缩略图滑块也变半透明红。
 * e2e 注入自检实测报全 6 个红槽位：3 个 `scrollbarSlider` + 3 个
 * `editorWidget.border` / `editorHoverWidget.border` / `editorSuggestWidget.border`（`--border`
 * 的 authored 值是 `var(--border-subtle)`，computed 后是 rgba），以及不在本表内的
 * 3 个 `minimapSlider` 派生值。
 *
 * ## 为什么不反过来改 CSS token 成 hex
 * CSS 侧用 rgba 是刻意的（alpha 档位是批 2b/5b 的设计语言），而且同一 token 还要喂给
 * `::-webkit-scrollbar-thumb` 等原生选择器。**边界归一**才是正确层：CSS 仍是唯一真源，
 * 本函数只负责把「CSS 语法」翻译成「Monaco 语法」，不新增任何色值真值。
 * ------------------------------------------------------------------------- */

/** 把任意 CSS 颜色串归一成 Monaco 能解析的 hex；无法解析返回 null（**绝不把非法值原样传下去**）。
 *
 *  支持：`#RGB` / `#RGBA` / `#RRGGBB` / `#RRGGBBAA`（大小写不限，输出统一小写）、
 *  `rgb(r,g,b)` / `rgba(r,g,b,a)`（逗号或空格分隔，通道支持 `0-255` 与 `0%-100%`）。
 *  alpha 为 1 时输出 6 位（Monaco 的 `Color.isOpaque()` 会把 6 位渲成 hex、8 位渲成 rgba，
 *  两种都能被 `parseHex` 读回，故此处只求「能被解析」，不追求与 `format()` 逐字节一致）。
 *
 *  返回 null 的场景交给调用方**跳过该槽位**（回落 base 主题）并打警告——静默变红是最坏结果。 */
export function toMonacoHexColor(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;

  // ① 已是 hex
  if (v.startsWith("#")) {
    const digits = v.slice(1);
    if (!/^[0-9a-f]+$/.test(digits)) return null;
    const pair = (d: string) => parseInt(d + d, 16);
    if (digits.length === 3 || digits.length === 4) {
      const hex = [digits[0], digits[1], digits[2]].map((d) => pair(d).toString(16)).join("");
      return digits.length === 4 ? `#${hex}${pair(digits[3]).toString(16)}` : `#${hex}`;
    }
    if (digits.length === 6 || digits.length === 8) return `#${digits}`;
    return null;
  }

  // ② rgb() / rgba()（Monaco 不认，必须转）
  const m = v.match(/^rgba?\(([^)]*)\)$/);
  if (!m) return null;
  // 两种分隔都要认：现代语法 `rgb(r g b / a)`、传统语法 `rgb(r, g, b, a)`。
  // ⚠ 传统语法是**逗号分隔的 4 段**——按 `/[\s,]+/` 一刀切会把 alpha 当成第 4 个通道，
  //   从而把合法的 rgba() 判成非法（这正是本函数自身的第一版 bug，单测当场抓到）。
  const inner = m[1];
  let chanParts: string[];
  let alphaRaw: string | undefined;
  if (inner.includes("/")) {
    const [head, tail] = inner.split("/");
    chanParts = head.trim().split(/[\s,]+/).filter(Boolean);
    alphaRaw = tail.trim();
  } else {
    const all = inner.trim().split(/[\s,]+/).filter(Boolean);
    if (all.length === 4) alphaRaw = all.pop();
    chanParts = all;
  }
  if (chanParts.length !== 3) return null;
  const chan = (raw: string): number | null => {
    const isPct = raw.endsWith("%");
    const n = Number.parseFloat(isPct ? raw.slice(0, -1) : raw);
    if (!Number.isFinite(n)) return null;
    const scaled = isPct ? (n / 100) * 255 : n;
    return Math.max(0, Math.min(255, Math.round(scaled)));
  };
  const rgb = chanParts.map(chan);
  if (rgb.some((n) => n === null)) return null;
  let alpha = 1;
  if (alphaRaw !== undefined && alphaRaw !== "") {
    const a = alphaRaw.endsWith("%")
      ? Number.parseFloat(alphaRaw.slice(0, -1)) / 100
      : Number.parseFloat(alphaRaw);
    if (!Number.isFinite(a)) return null;
    alpha = Math.max(0, Math.min(1, a));
  }
  const hex = rgb.map((n) => (n as number).toString(16).padStart(2, "0")).join("");
  return alpha >= 1 ? `#${hex}` : `#${hex}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

/** 两套主题共用的槽位表（导出供单测断言「深浅一致」——本表按设计不得分主题） */
export const MONACO_COLOR_SLOTS = COLOR_SLOTS;
export const MONACO_TOKEN_SLOTS = TOKEN_SLOTS;
