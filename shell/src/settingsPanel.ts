// 设置面板功能域（TD-007 迁出 main.ts；P1 升级为左右分栏分类导航 + Live Templates 内嵌）：
// 全局设置加载/保存（P25-T08）+ 设置面板 UI（P25-T09）+ 运行时智能层开关（P3-T09）。
// 设置值本体在 state.ts 的 app.settings（多域共读）。

import { invoke } from "@tauri-apps/api/core";
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { app, $, $btn, DEFAULT_SETTINGS, lazyEl, migrateLegacyFontSettings, migrateLegacyThemeSettings, outputEl, type Settings } from "./state";
import * as lsp from "./lsp/client";
import { renderEngineChip } from "./engineChip";
import { repaintRunWidget } from "./runWidget";
import * as ltUi from "./live-templates/ui/manager";
import { KEYBINDING_META, chordFromEvent, modsFromEvent, validateKeybindingMap, applyEditorKeybindings } from "./keybindings";
import { KEYBINDING_GROUP_ORDER, keybindingsOfGroup } from "./keybindingDefaults";
import { refreshTerminalFonts, refreshTerminalMotion, refreshTerminalThemes, syncOutputLevelChips } from "./termUi";
import { applyOutputLevelSetting } from "./output";
import { shellThemeOf } from "./theme/tokens";
import { applyReduceMotion, hideEl, motionDisabled, reduceMotionEnabled, showEl } from "./anim";
import { trapFocus } from "./focusTrap";
import { openAlert, openConfirm } from "./dialog";
import { fuzzyScore } from "./quickOpen";
import { toast, toastFail } from "./toast";
import { loadStorageUsage, wireStoragePanel } from "./storagePanel";
import { renderPluginsTab } from "./extensions/pluginsTab";
import { lintActiveFile, normalizeSeverity } from "./ruffLint"; // D-4：映射保存后立即重查当前文件
import { refreshPydanticDiagnostics } from "./pydanticDiagnostics"; // 阶段 4：开关保存后即时生效
import { refreshSplitEditorOptions } from "./splitEditor"; // C-4：分屏编辑器参数同步（splitEditor 不 import 本模块，无环）
import { refreshDbSqlOptions } from "./sqliteTabs"; // B3：数据库 SQL 编辑器参数同步（sqliteTabs 不 import 本模块，无环）
// UI-26：主题选择改自绘预览色卡（原生 <option> 放不下色卡），值读写经 themePicker
import { getSelectedTheme, setSelectedTheme, wireThemePicker } from "./themePicker";
// UI-25：欢迎页快捷键网格跟随键位系统，改键保存后需刷新
import { renderWelcomeShortcuts } from "./welcomeShortcuts";
// 零引擎关键字补全开关（provider 只注册一次，此处只翻运行时真值）
import { setKeywordCompletionEnabled } from "./completion/keywordCompletion";
import { getLocale, onLocaleChange, setLocale, t } from "./i18n"; // 第八批 i18n：设置域动态文案走语言包

// ---------- 注入（main 的 init 中 setSettingsPanelHandlers） ----------
// TD-13：解「settingsPanel.ts → main.ts」循环边——切换静态引擎后需重启 LSP，
// 由 main 注入 startLsp（参照 terminal.ts::setTerminalLinkHandler 先例）。

interface SettingsPanelHandlers {
  startLsp: () => Promise<void>;
}

let handlers: SettingsPanelHandlers | null = null;

/** 注入 main 域函数（main 在 init 中调用；设置面板交互都发生在 init 之后） */
export function setSettingsPanelHandlers(h: SettingsPanelHandlers): void {
  handlers = h;
}

function sh(): SettingsPanelHandlers {
  if (!handlers) throw new Error("[Pylume] settingsPanel 尚未接线（setSettingsPanelHandlers 须在 init 中先于设置面板交互）");
  return handlers;
}

/** B3：结果每页行数的候选档（与 index.html 的 select 选项一致；手改配置塞进非法值时回落 200） */
const DB_PAGE_SIZES = [100, 200, 500, 1000];

// ---------- 域内 DOM ----------// P2-6（2026-09-29 review）：顶层快照改惰性（铁律 1——此前模块加载期解析 60 个控件，
// 精简 DOM 测试环境 import 即炸，设置域因此零单测）。用法均为 .value/.checked/
// .classList 方法访问，Proxy 安全；作为参数传给 DOM/组件 API 的元素不可用 lazyEl。

const statusFontEl = lazyEl("status-font");
const settingsModalEl = lazyEl("settings-modal");
const settingsFontEl = lazyEl<HTMLInputElement>("settings-font");
const settingsFontFamilyEl = lazyEl<HTMLInputElement>("settings-font-family");
const settingsFontLigaturesEl = lazyEl<HTMLInputElement>("settings-font-ligatures");
const settingsTabSizeEl = lazyEl<HTMLInputElement>("settings-tab-size");
const settingsInsertSpacesEl = lazyEl<HTMLInputElement>("settings-insert-spaces");
const settingsWordWrapEl = lazyEl<HTMLSelectElement>("settings-word-wrap");
const settingsMinimapEl = lazyEl<HTMLInputElement>("settings-minimap");
const settingsKeywordCompletionEl = lazyEl<HTMLInputElement>("settings-keyword-completion");
// C-6（PyCharm 调研）：可读性配置
const settingsIndentGuidesEl = lazyEl<HTMLInputElement>("settings-indent-guides");
const settingsBracketColorsEl = lazyEl<HTMLInputElement>("settings-bracket-colors");
// PR-B（dx_features_backlog §6.2）：粘性滚动
const settingsStickyScrollEl = lazyEl<HTMLInputElement>("settings-sticky-scroll");
// PR-N（dx_features_backlog §6.8）：参数名行内提示
const settingsInlayParamHintsEl = lazyEl<HTMLInputElement>("settings-inlay-param-hints");
// PR-C（dx_features_backlog §6.3）：保存清理
const settingsTrimTrailingEl = lazyEl<HTMLInputElement>("settings-trim-trailing");
const settingsFinalNewlineEl = lazyEl<HTMLInputElement>("settings-final-newline");
// PR-K（dx_features_backlog §6.6）：新建 .py 文件自动插文件头模板
const settingsNewFileTemplateEl = lazyEl<HTMLInputElement>("settings-new-file-template");
// PR-M（dx_features_backlog §6.6）：粘贴 JSON 自动转 Python 字面量
const settingsPasteJsonEl = lazyEl<HTMLInputElement>("settings-paste-json");
// B-3（PyCharm 调研）：调试只步进我的代码
const settingsDebugJmcEl = lazyEl<HTMLInputElement>("settings-debug-jmc");
// 库特别支持 PR-2：编辑器工具 lens / 正则高亮与测试器
const settingsLibsEditorLensEl = lazyEl<HTMLInputElement>("settings-libs-editor-lens");
const settingsLibsRegexEl = lazyEl<HTMLInputElement>("settings-libs-regex");
// 库特别支持 PR-3：格式串 hover/诊断 + 工具
const settingsLibsFormatEl = lazyEl<HTMLInputElement>("settings-libs-format");
// 库特别支持 PR-4：参数表单
const settingsLibsArgparseEl = lazyEl<HTMLInputElement>("settings-libs-argparse");
// 库特别支持 P1：JSON 字面量注入 / 输出面板日志级别着色（research §11.9）
const settingsLibsJsonInjectEl = lazyEl<HTMLInputElement>("settings-libs-json-inject");
const settingsLogLevelColorsEl = lazyEl<HTMLInputElement>("settings-log-level-colors");
// B3（SQLite 数据库工具窗）：结果每页行数 / 写前确认
const settingsDbPageSizeEl = lazyEl<HTMLSelectElement>("settings-db-page-size");
const settingsDbWarnOnWriteEl = lazyEl<HTMLInputElement>("settings-db-warn-on-write");
// 阶段 4：Pydantic 构造校验诊断开关
const settingsPydanticDiagnosticsEl = lazyEl<HTMLInputElement>("settings-pydantic-diagnostics");
const settingsAutosaveEl = lazyEl<HTMLSelectElement>("settings-autosave");
const settingsProbeEl = lazyEl<HTMLInputElement>("settings-probe");
const settingsIntelEl = lazyEl<HTMLInputElement>("settings-intel");
const settingsEngineEl = lazyEl<HTMLSelectElement>("settings-engine");
const settingsFormatOnSaveEl = lazyEl<HTMLInputElement>("settings-format-on-save");
const settingsOptimizeImportsOnSaveEl = lazyEl<HTMLInputElement>("settings-optimize-imports-on-save");
// D-4（PyCharm 调研）：ruff 规则严重度映射（E/W/F 三类）
const settingsRuffSeverityEEl = lazyEl<HTMLSelectElement>("settings-ruff-severity-e");
const settingsRuffSeverityWEl = lazyEl<HTMLSelectElement>("settings-ruff-severity-w");
const settingsRuffSeverityFEl = lazyEl<HTMLSelectElement>("settings-ruff-severity-f");
const settingsTerminalCwdEl = lazyEl<HTMLSelectElement>("settings-terminal-cwd");
const settingsTerminalShellEl = lazyEl<HTMLSelectElement>("settings-terminal-shell");
const settingsReduceMotionEl = lazyEl<HTMLInputElement>("settings-reduce-motion");
// i18n：语言下拉（值不来自 settings.locale——语言存 localStorage，见 i18n/index.ts 头注）
const settingsLocaleEl = lazyEl<HTMLSelectElement>("settings-locale");
const settingsFontFamilyPresetEl = lazyEl<HTMLSelectElement>("settings-font-family-preset");
const settingsPypiIndexPresetEl = lazyEl<HTMLSelectElement>("settings-pypi-index-preset");
const settingsPypiIndexEl = lazyEl<HTMLInputElement>("settings-pypi-index");
const settingsLogEnabledEl = lazyEl<HTMLInputElement>("settings-log-enabled");
const settingsLogLevelEl = lazyEl<HTMLSelectElement>("settings-log-level");
const settingsLogKeepEl = lazyEl<HTMLInputElement>("settings-log-keep");
const settingsLogStdoutEl = lazyEl<HTMLInputElement>("settings-log-stdout");
const settingsLogOpenEl = lazyEl<HTMLButtonElement>("settings-log-open");
const settingsDataOpenEl = lazyEl<HTMLButtonElement>("settings-data-open");
// E-1（PyCharm 调研）：设置搜索
const settingsSearchEl = lazyEl<HTMLInputElement>("settings-search");
const settingsSearchEmptyEl = lazyEl("settings-search-empty");
// UI-31：搜索框内的一键清除按钮（有输入时才出现）
const settingsSearchClearEl = lazyEl<HTMLButtonElement>("settings-search-clear");
// UI-32：键位冲突即时提示条（位于快捷键分类顶部）
const settingsKbConflictEl = lazyEl("settings-kb-conflict");

// ---------- E-1：设置搜索 ----------

/** 动态内容页（列表 + 编辑器形态，不是 settings-row 表单行），搜索时整体隐藏 */
const NON_ROW_SECTIONS = new Set(["settings-section-templates", "settings-section-plugins"]);

/**
 * 控件 id → 搜索关键词（G-7「可发现性税」：每个设置行的英文/别名关键词，集中一处，
 * 避免给 index.html 每行加 data-kw 的漂移风险）。匹配时拼进行搜索域。
 */
// i18n：关键词表为模块级缓存，语言切换时整体重建（搜索在运行期读表，见 wireSettingsPanel 的订阅）
let SETTINGS_ROW_KEYWORDS: Record<string, string> = {
  "settings-theme-picker": t("settings.kw.themePicker"),
  "settings-font": t("settings.kw.font"),
  "settings-font-family": t("settings.kw.fontFamily"),
  "settings-font-family-preset": t("settings.kw.fontFamily"),
  "settings-font-ligatures": t("settings.kw.ligatures"),
  "settings-reduce-motion": t("settings.kw.reduceMotion"),
  "settings-tab-size": t("settings.kw.tabSize"),
  "settings-insert-spaces": t("settings.kw.insertSpaces"),
  "settings-word-wrap": t("settings.kw.wordWrap"),
  "settings-minimap": t("settings.kw.minimap"),
  "settings-indent-guides": t("settings.kw.indentGuides"),
  "settings-bracket-colors": t("settings.kw.bracketColors"),
  "settings-debug-jmc": t("settings.kw.debugJmc"),
  "settings-autosave": t("settings.kw.autosave"),
  "settings-format-on-save": t("settings.kw.formatOnSave"),
  "settings-optimize-imports-on-save": t("settings.kw.optimizeImports"),
  "settings-ruff-severity-e": t("settings.kw.ruffSeverityE"),
  "settings-ruff-severity-w": t("settings.kw.ruffSeverityW"),
  "settings-ruff-severity-f": t("settings.kw.ruffSeverityF"),
  "settings-engine": t("settings.kw.engine"),
  "settings-probe": t("settings.kw.probe"),
  "settings-intel": t("settings.kw.intel"),
  "settings-pypi-index": t("settings.kw.pypiIndex"),
  "settings-pypi-index-preset": t("settings.kw.pypiIndex"),
  "settings-terminal-cwd": t("settings.kw.terminalCwd"),
  "settings-terminal-shell": t("settings.kw.terminalShell"),
  "settings-log-enabled": t("settings.kw.logEnabled"),
  "settings-log-level": t("settings.kw.logLevel"),
  "settings-log-keep": t("settings.kw.logKeep"),
  "settings-log-stdout": t("settings.kw.logStdout"),
  "settings-data-open": t("settings.kw.dataOpen"),
  "settings-log-open": t("settings.kw.logOpen"),
  "storage-open": t("settings.kw.storageOpen"),
  "storage-refresh": t("settings.kw.storageRefresh"),
  "storage-clean-webview": t("settings.kw.cleanWebview"),
  "storage-clean-logs": t("settings.kw.cleanLogs"),
  "storage-uv-prune": t("settings.kw.uvPrune"),
  "storage-uv-clean": t("settings.kw.uvClean"),
  "storage-migrate-path": t("settings.kw.migrate"),
  "storage-migrate": t("settings.kw.migrate"),
  // UI-31：键位行纳入搜索（此前搜「保存」只命中保存分类，搜不到快捷键分类里的同名动作）
  ...keybindingKeywords(),
};

/** 键位行的搜索域：动作名 + 出厂键位串（如 "Ctrl+S"），让键位可被名字或直接按键位串搜到。
 *  ⚠ 内联 id 规则、不调 kbInputId：本函数在模块初始化期（SETTINGS_ROW_KEYWORDS 初值）就会执行，
 *  而 kbInputId 是定义在后面的 const，此时仍在 TDZ——调用会直接 ReferenceError。 */
function keybindingKeywords(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of KEYBINDING_META) map[`settings-kb-${m.id}`] = `${m.label} ${m.def}`;
  return map;
}

/** 行的搜索域：行文本 + 提示文本不在此（hint 归 section 层）+ 控件关键词 + data-kw */
function settingsRowHaystack(row: HTMLElement): string {
  const kws: string[] = [];
  if (row.dataset.kw) kws.push(row.dataset.kw);
  row.querySelectorAll("[id]").forEach((el) => {
    const kw = SETTINGS_ROW_KEYWORDS[el.id];
    if (kw) kws.push(kw);
  });
  return `${row.textContent ?? ""} ${kws.join(" ")}`;
}

/** 是否处于搜索态（E-1：空态恢复只在此为 true 时做一次，防止重复触发动态页渲染） */
let searchActive = false;

/** 搜索框清除按钮的显隐：有输入才出现（UI-31） */
function syncSearchClearBtn(): void {
  settingsSearchClearEl.classList.toggle("hidden", settingsSearchEl.value.length === 0);
}

/**
 * UI-31：搜索态的「分类归属」与导航态同步。
 * 此前搜索跨分类平铺命中行，却仍高亮着某个分类、也不说明这些行来自哪个分类——
 * 导航态与内容不一致，看上去像切到了别的分类。
 * 分类名直接取导航项文本（已 i18n、随语言切换更新），故不新增词条。
 */
function syncSearchCategoryLabels(searching: boolean): void {
  for (const s of Array.from(document.querySelectorAll<HTMLElement>(".settings-section"))) {
    const existing = s.querySelector<HTMLElement>(".settings-section-cat");
    if (!searching) {
      existing?.remove();
      continue;
    }
    if (NON_ROW_SECTIONS.has(s.id)) continue; // 动态页不参与搜索，无需标签
    const cat = s.id.replace("settings-section-", "");
    const navItem = document.querySelector<HTMLElement>(`.settings-nav-item[data-cat="${cat}"]`);
    const name = navItem?.textContent?.trim() ?? cat;
    if (existing) {
      existing.textContent = name;
      continue;
    }
    const label = document.createElement("div");
    label.className = "settings-section-cat";
    label.textContent = name;
    s.prepend(label);
  }
  // 导航态：搜索时不高亮任何分类（内容已跨分类）；退出搜索时还原到 currentCategory
  document.querySelectorAll<HTMLElement>(".settings-nav-item").forEach((b) => {
    const sel = !searching && b.dataset.cat === currentCategory;
    b.classList.toggle("active", sel);
    b.setAttribute("aria-selected", String(sel)); // UI-16：role=tab 的选中态与 .active 同源
  });
}

/** 应用设置搜索过滤：query 非空时跨分类显示所有含匹配行的 section，隐藏不匹配的行 */
function applySettingsFilter(rawQuery: string): void {
  const query = rawQuery.trim();
  const sections = Array.from(document.querySelectorAll<HTMLElement>(".settings-section"));
  syncSearchClearBtn();
  if (!query) {
    if (!searchActive) return; // 本就是分类视图：无状态可恢复（多余 switchCategory 会双渲染插件/模板页）
    searchActive = false;
    settingsSearchEmptyEl.classList.add("hidden");
    // 恢复：清掉行级/组级 hidden，按当前分类还原 section 显隐。
    // 刻意不走 switchCategory——它对 plugins/templates 有渲染副作用，恢复显隐不该触发重渲染
    for (const s of sections) {
      s.classList.toggle("hidden", s.id !== `settings-section-${currentCategory}`);
      s.querySelectorAll<HTMLElement>(".settings-row").forEach((r) => r.classList.remove("hidden"));
      s.querySelectorAll<HTMLElement>(".settings-group").forEach((g) => g.classList.remove("hidden"));
    }
    syncSearchCategoryLabels(false);
    document.querySelector(".settings-card")?.classList.toggle("settings-card--wide", currentCategory === "templates");
    return;
  }
  searchActive = true;
  document.querySelector(".settings-card")?.classList.remove("settings-card--wide");
  let totalMatches = 0;
  for (const s of sections) {
    if (NON_ROW_SECTIONS.has(s.id)) {
      s.classList.add("hidden");
      continue;
    }
    let sectionMatches = 0;
    s.querySelectorAll<HTMLElement>(".settings-row").forEach((row) => {
      const hit = fuzzyScore(settingsRowHaystack(row), query) !== null;
      row.classList.toggle("hidden", !hit);
      if (hit) sectionMatches++;
    });
    // UI-31：分组是过滤的最小单位——组内无命中行则整组连标题一起隐藏，否则会留下孤立的小标题
    s.querySelectorAll<HTMLElement>(".settings-group").forEach((g) => {
      const visibleRows = g.querySelectorAll<HTMLElement>(".settings-row:not(.hidden)").length;
      g.classList.toggle("hidden", visibleRows === 0);
    });
    s.classList.toggle("hidden", sectionMatches === 0);
    totalMatches += sectionMatches;
  }
  syncSearchCategoryLabels(true);
  settingsSearchEmptyEl.classList.toggle("hidden", totalMatches > 0);
}

/** 清空搜索框并恢复分类视图（切分类 / 关闭面板 / 空态跳转时调用） */
function clearSettingsSearch(): void {
  if (!searchActive && !settingsSearchEl.value) return;
  settingsSearchEl.value = "";
  applySettingsFilter("");
}

// ---------- 分类导航（P1） ----------

export type SettingsCategory = "appearance" | "editor" | "keybindings" | "save" | "python" | "templates" | "terminal" | "logging" | "storage" | "plugins";

/** 当前分类（E-1 设置搜索：清空搜索后恢复到该分类的显隐状态） */
let currentCategory: SettingsCategory = "appearance";

/** 切换到指定分类并更新导航高亮；进入 Live Templates 分类时渲染模板列表 */
function switchCategory(cat: SettingsCategory): void {
  currentCategory = cat;
  document.querySelectorAll<HTMLElement>(".settings-nav-item").forEach((b) => {
    const sel = b.dataset.cat === cat;
    b.classList.toggle("active", sel);
    b.setAttribute("aria-selected", String(sel)); // UI-16：role=tab 的选中态与 .active 同源
  });
  document.querySelectorAll<HTMLElement>(".settings-section").forEach((s) => {
    s.classList.toggle("hidden", s.id !== `settings-section-${cat}`);
  });
  // 模板页为「列表 + 编辑器」双栏，加宽卡片以获得足够编辑空间
  document.querySelector(".settings-card")?.classList.toggle("settings-card--wide", cat === "templates");
  if (cat === "templates") ltUi.openPanel();
  // 存储页每次进入刷新占用明细（体积随使用变化）
  if (cat === "storage") void loadStorageUsage();
  // 插件页每次进入重渲染（启停/热重载后记录变化）
  if (cat === "plugins") void renderPluginsTab();
}

/** UI-24：窄窗口断点，须与 style.css 的 `@media (max-width: 720px)` 保持一致。
 *  该断点下分类导航由竖排改为横向滚动 tab 条，role=tablist 的 aria-orientation 必须跟着改——
 *  读屏播报的方向键语义（竖排 ↑↓ / 横排 ←→）与视觉排布不符会直接误导键盘用户。 */
const NARROW_NAV_QUERY = "(max-width: 720px)";

function syncNavOrientation(): void {
  const nav = document.querySelector(".settings-nav");
  if (!nav) return;
  const horizontal = window.matchMedia(NARROW_NAV_QUERY).matches;
  nav.setAttribute("aria-orientation", horizontal ? "horizontal" : "vertical");
}

// ---------- 加载 / 保存 ----------

/** 外壳主题联动（D1 P-01 · 批 4 改判定）：Monaco 主题值驱动 html[data-theme]，
 *  style.css 的 [data-theme="light"] 覆盖层负责外壳配色。
 *  ⚠ 浅色判定走 shellThemeOf（theme/tokens.ts 单一真源）——批 4 前这里是 `=== "vs"` 字面量，
 *  改主题名后若漏改，外壳会与编辑器/终端**半深半浅**且不报任何错。 */
export function applyShellTheme(theme: string): void {
  document.documentElement.dataset.theme = shellThemeOf(theme);
}

export async function loadSettings(): Promise<void> {
  try {
    app.settings = await invoke<Settings>("get_settings");
  } catch (e) {
    console.warn("设置加载失败，使用默认", e);
    // UX P0-1：原先只 console，用户不知道自己在设置面板里的改动不会持久化
    toast(t("settings.loadFailedToast"), "error");
  }
  // 快捷键逐项兜底：旧配置 / 手改文件缺项时回落出厂默认（Rust 侧仅保证整表缺省）
  app.settings.keybindings = { ...DEFAULT_SETTINGS.keybindings, ...(app.settings.keybindings ?? {}) };
  migrateLegacyFontSettings(app.settings);
  migrateLegacyThemeSettings(app.settings);
  applyShellTheme(app.settings.theme);
}

export async function saveSettings(): Promise<void> {
  try {
    await invoke("set_settings", { settings: app.settings });
  } catch (e) {
    console.warn("设置保存失败", e);
    toastFail(t("settings.failSave"), e);
  }
}

/**
 * 把当前编辑器字号镜像到根节点变量（供 style.css 的 --editor-font-size 使用）。
 * 为什么要镜像：Monaco 只把 fontInfo 内联到 .view-lines / .view-overlays 等节点，glyphMargin
 * 不在它的子树内、继承不到；而 0.52.2 也没有输出 --vscode-editor-font-size 之类的 CSS 变量可读。
 * 不用 editor.applyFontInfo(#editor) 替代：那会给整个编辑器子树注入 font-size，连带影响 Monaco
 * 内部按继承取字号的浮层控件，副作用面太大。
 */
function applyEditorFontVar(): void {
  document.documentElement.style.setProperty("--editor-font-size", `${app.settings.font_size}px`);
}

/** 字号生效后的统一收口：状态栏文案 + CSS 变量镜像。
 *  init（main.ts 建完编辑器）、Ctrl+滚轮缩放、设置保存三条路径都只调本函数，故镜像放这里一处全覆盖。 */
export function applyFontStatus(): void {
  statusFontEl.textContent = t("settings.statusFontSize", { size: app.settings.font_size });
  applyEditorFontVar();
}

/** 等随包等宽字体真正就绪（ui_premium 批 3；应在创建编辑器**之前** await）。
 *
 *  为什么需要等：Monaco 用 canvas `measureText` 测字符宽度并缓存（CharConfig），字体异步
 *  到位后实测宽度与缓存值不符 → 网格与光标列整体错位；0.52 不会自动重测，只能由调用方
 *  在建编辑器前把字体等出来。`font-display: swap` 下浏览器先画回退字体再交换，不等就是这个窗口。
 *
 *  与 CSS 侧的分工：`--mono` / @font-face 只管外壳，Monaco 字体不读 CSS，走
 *  `settings.font_family` → `buildEditorOptions` 注入，故等字体只能在这里做。
 *
 *  ⚠ **必须带超时**（实测教训，2026-10-03）：`document.fonts.load()` 在 Playwright 的
 *  Chromium 里可能长时间不 settle，直接 await 会把 init 整条链卡死（症状：app.editor 永不
 *  创建，8 个编辑器相关 e2e 全红）。字体加载是**渐进增强**，任何情况下都不该拦住编辑器创建，
 *  故超时后放行——最坏情况是短暂用回退字体测量一次，而不是没有编辑器。
 */
const EDITOR_FONT_LOAD_TIMEOUT_MS = 1500;

export async function ensureEditorFontLoaded(settings: Settings): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const family = settings.font_family.trim();
  if (!family) return; // 空串 = Monaco 内置默认，无需等
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, EDITOR_FONT_LOAD_TIMEOUT_MS));
  try {
    // load() 接受完整 CSS font 语法（含逗号分隔的字体栈），会加载栈中所有能命中的 face
    await Promise.race([document.fonts.load(`${settings.font_size}px ${family}`), timeout]);
  } catch (e) {
    console.warn("等宽字体加载失败，回落系统等宽栈", e);
  }
}

/** 由 Settings 构造 Monaco 编辑器选项（P1：外观/编辑器高频项收敛）。
 *  注：tabSize / insertSpaces 属 model 层选项（Monaco ITextModel），经 applyModelIndent 应用。 */
export function buildEditorOptions(settings: Settings): MonacoApi.editor.IEditorOptions {
  const opts: MonacoApi.editor.IEditorOptions = {
    fontSize: settings.font_size,
    fontLigatures: settings.font_ligatures,
    wordWrap: settings.word_wrap === "on" ? "on" : "off",
    minimap: { enabled: settings.minimap },
    // C-6（PyCharm 调研）：可读性——缩进参考线（含当前层级高亮）+ 括号彩色化。
    // 旧配置无这两个字段时 serde(default) 落在 false，故用 `!== false` 兜底为开。
    guides: {
      indentation: settings.indent_guides !== false,
      highlightActiveIndentation: settings.indent_guides !== false,
    },
    bracketPairColorization: { enabled: settings.bracket_colors !== false },
    // 方案 2：收窄行号右侧的折叠箭头区。Monaco 默认 lineDecorationsWidth=10，且 folding 开启时
    // 会再 +16（实际约 26px，其中大半是只有少数带折叠箭头的行才占用的空白）。压到 6 让 gutter 更紧凑。
    lineDecorationsWidth: 6,
    // 方案 3：行号列最小宽度。Monaco 默认 minChars=5，行号数字右对齐，短文件里数字左侧会留
    // 大片空，视觉上拉大了「断点红点 ↔ 行号数字」的距离——这才是红点与行号间空白的头号来源。
    // 压到 3；文件行数变多时仍按实际位数自动伸缩。
    lineNumbersMinChars: 3,
    // PR-B：粘性滚动（Monaco 0.52 内建 stickyScroll；旧配置无字段时兜底为开，同 C-6 惯例）
    stickyScroll: { enabled: settings.sticky_scroll !== false },
    // 修记 A 配套（ui_premium §7.9）：Monaco 出厂垂直滚动条 14px，比外壳 `::-webkit-scrollbar`
    // 的 8px 明显粗——右侧滑块与左侧/底部三处粗细不一致，本身就是「拼装感」的一个来源。
    // 压到 10px：与 8px 视觉协调，又留得住滑块的拖拽目标（取 8px 与外壳等宽但滑块偏窄，手感下降）。
    // ⚠ 只能走 editorOption：Monaco 0.52 的滚动条是**自绘控件**，`::-webkit-scrollbar` 对它无效
    //   （这也是为什么外壳那条 CSS 规则一直管不到它）。滑块宽度（verticalSliderSize）默认跟随本值。
    // 本函数是创建与设置变更的唯一共用入口，故分屏（splitEditor 复用它）也一并同步。
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  };
  const family = settings.font_family.trim();
  if (family) opts.fontFamily = family;
  // UI-11：「减少动画」也要管住 Monaco 内部动画——CSS 的 --motion 倍率到不了编辑器内部，
  // 而光标闪烁是编辑器里最显眼的常驻动画。本函数是创建（main.ts:2315 展开）与设置变更
  // （applySettings 的 updateOptions）的唯一共用入口，故在此一处写入即全覆盖。
  //
  // 必须【双向】显式赋值：updateOptions 是合并语义，未列出的项不会复位到默认值。
  // 若只在开启时写 "solid"，关掉开关后光标会一直不闪、直到重启才恢复。
  // "blink" 正是 Monaco 出厂默认，故未开启减少动画时行为与改动前完全一致。
  opts.cursorBlinking = motionDisabled() ? "solid" : "blink";
  // 下面两项出厂即为关闭，此处显式写出：一是表明「本开关负责管住它们」，
  // 二是将来若别处打开了，也会随本函数一并关回去。
  opts.smoothScrolling = false;
  opts.cursorSmoothCaretAnimation = "off";
  return opts;
}

/** 把缩进选项应用到所有已打开 model（Monaco 的 tabSize/insertSpaces 属 model 层） */
export function applyModelIndent(settings: Settings): void {
  for (const t of app.tabs) {
    t.model.updateOptions({ tabSize: settings.tab_size, insertSpaces: settings.insert_spaces });
  }
}

// ---------- 快捷键分区（渲染 / 读写） ----------

/** 快捷键输入框 id 规则 */
const kbInputId = (id: string): string => `settings-kb-${id}`;

/**
 * 渲染快捷键分区（UI-32：按功能分组渲染）。
 * 此前 60 项按单一列表平铺，找一项要滚很久；分组后每组一个小标题，组内仍保持出厂顺序。
 * 分组容器复用 .settings-group：与其余分类同款观感，且自动成为搜索过滤的最小单位
 * （组内无命中行则连标题一起隐藏，见 applySettingsFilter）。
 */
function renderKeybindingRows(): void {
  const container = $("settings-keybinding-rows");
  container.textContent = "";
  for (const g of KEYBINDING_GROUP_ORDER) {
    const items = keybindingsOfGroup(g);
    if (items.length === 0) continue;
    const group = document.createElement("div");
    group.className = "settings-group";
    const title = document.createElement("h3");
    title.className = "settings-group-title";
    // 同时挂 data-i18n：语言切换时 applyDomI18n 会重刷静态骨架，与本处 t() 结果一致
    title.dataset.i18n = `settings.kb.group.${g}`;
    title.textContent = t(`settings.kb.group.${g}`);
    const grid = document.createElement("div");
    grid.className = "settings-grid";
    for (const m of items) grid.appendChild(buildKeybindingRow(m));
    group.append(title, grid);
    container.appendChild(group);
  }
}

/** 单个键位行：label + chip 包裹的录入框 */
function buildKeybindingRow(m: (typeof KEYBINDING_META)[number]): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "settings-row";
  const label = document.createElement("label");
  label.textContent = m.label;
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.id = kbInputId(m.id);
  input.placeholder = m.def;
  input.spellcheck = false;
  label.htmlFor = input.id; // 遗留修复：动态生成的行同样要 label↔控件关联（读屏聚焦输入框报得出动作名）
  wireKeybindingCapture(input); // UX：改为「按键录入」，不必手写字面量
  // UI-31：键位改 chip 胶囊外观（等宽 + 描边），只是多包一层装饰容器，录入器与 input 本身不动
  const chip = document.createElement("span");
  chip.className = "kb-chip";
  chip.appendChild(input);
  row.append(label, chip);
  return row;
}

/**
 * UI-32：键位冲突即时提示。
 * 此前只在点「保存」时才弹 alert——录完一个撞车的键位毫无反馈，要等到保存被拒才知道。
 * 现在每次改键就地校验，把冲突写进键位区顶部的提示条（不打断录入）。
 */
function refreshKeybindingConflict(): void {
  const err = validateKeybindingMap(readKeybindingForm());
  settingsKbConflictEl.textContent = err ?? "";
  settingsKbConflictEl.classList.toggle("hidden", !err);
}

/** 修饰键的 keydown/keyup（用于「按住 Ctrl 还没按主键」的预览与回退） */
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/** 写入键位输入框并同步「已成键基线」（回退/预览以基线为准，见 wireKeybindingCapture） */
function setKeybindingValue(input: HTMLInputElement, v: string): void {
  input.value = v;
  input.dataset.kbCommitted = v;
}

/**
 * 快捷键输入框改「按键录入」（PyCharm / VS Code 同款）：聚焦后直接按组合键即写入，
 * 不再是逐字母手输字面量（用户按 Ctrl+0 想改保存键时，此前只会触发浏览器/外壳行为）。
 * 语义：
 * - 主键按下即成键（"Ctrl+0"）；按住修饰键未成键时显示 "Ctrl+" 预览，抬起回退到基线；
 * - Backspace / Delete 清空（= 解绑）；Esc 撤销本次录入（吞掉事件，避免连带关闭面板丢掉其它未保存改动）；
 * - Tab 不拦截（保留键盘在表单里移动焦点）；输入框 readOnly，杜绝 IME/手输产生非键位串文本。
 */
function wireKeybindingCapture(input: HTMLInputElement): void {
  input.readOnly = true;
  input.title = t("settings.keybindTip");
  const committed = (): string => input.dataset.kbCommitted ?? input.value;
  // UI-32：成键/解绑后立即就地校验冲突（此前要等点「保存」才弹窗）
  const commit = (v: string): void => {
    setKeybindingValue(input, v);
    refreshKeybindingConflict();
  };
  input.addEventListener("focus", () => input.classList.add("kb-capture"));
  input.addEventListener("blur", () => {
    input.classList.remove("kb-capture");
    input.value = committed(); // 离开时丢弃未成键的预览
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Tab") return;
    e.preventDefault();
    e.stopPropagation(); // 不让 event 冒泡到 window 级快捷键分发（虽已按 INPUT 排除，仍显式隔离）
    if (e.key === "Escape") {
      input.value = committed();
      refreshKeybindingConflict();
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      commit("");
      return;
    }
    if (MODIFIER_KEYS.has(e.key)) {
      const mods = modsFromEvent(e);
      input.value = mods.length > 0 ? `${mods.join("+")}+` : ""; // 预览：等主键
      return;
    }
    const chord = chordFromEvent(e);
    if (chord) commit(chord);
  });
  input.addEventListener("keyup", (e) => {
    if (!MODIFIER_KEYS.has(e.key)) return;
    if (input.value !== committed()) input.value = committed(); // 只按了修饰键：回退预览
  });
}

/** 读取快捷键表单 → id → 键位串（已 trim；未成键的预览回退到基线） */
function readKeybindingForm(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of KEYBINDING_META) {
    const input = document.getElementById(kbInputId(m.id)) as HTMLInputElement | null;
    const raw = (input?.value ?? "").trim();
    map[m.id] = raw.endsWith("+") ? (input?.dataset.kbCommitted ?? "").trim() : raw;
  }
  return map;
}

// ---------- 设置面板（P25-T09 + P1） ----------

function clampFontSize(raw: number, fallback: number): number {
  const n = Number.isFinite(raw) ? raw : fallback;
  return Math.max(8, Math.min(32, n));
}

/**
 * UI-31：预设下拉 + 自定义输入的显隐联动——只有预设选「自定义…」时才展开输入框。
 * 此前两个控件在行内对半分，选了预设仍留一个空输入框占位，且长值（字体栈 / 包源 URL）被挤成半截。
 * @param focusCustom 用户刚切到「自定义…」时为 true，顺带把焦点交给输入框
 */
function syncPresetControls(preset: HTMLSelectElement, custom: HTMLInputElement, focusCustom = false): void {
  const show = preset.value === "__custom__";
  custom.classList.toggle("hidden", !show);
  if (show && focusCustom) custom.focus();
}

/** 字体族下拉候选 ↔ 自定义输入框同步（D3 P-14：命中候选则选中，否则落「自定义…」） */
function syncFontPreset(family: string): void {
  const hit = Array.from(settingsFontFamilyPresetEl.options).find(
    (o) => o.value === family && o.value !== "__custom__",
  );
  settingsFontFamilyPresetEl.value = hit ? hit.value : "__custom__";
  syncPresetControls(settingsFontFamilyPresetEl, settingsFontFamilyEl);
}

/** PyPI 源下拉候选 ↔ 自定义输入框同步（命中候选则选中，否则落「自定义…」） */
function syncPypiIndexPreset(index: string): void {
  const hit = Array.from(settingsPypiIndexPresetEl.options).find(
    (o) => o.value === index && o.value !== "__custom__",
  );
  settingsPypiIndexPresetEl.value = hit ? hit.value : "__custom__";
  syncPresetControls(settingsPypiIndexPresetEl, settingsPypiIndexEl);
}

/** 字体族实时预览（设置面板内即时生效；正式保存仍走「保存」按钮） */
function previewFontFamily(): void {
  const family = settingsFontFamilyEl.value.trim();
  if (family) app.editor.updateOptions({ fontFamily: family });
}

/** 终端 shell 别名 → 展示名（与 index.html 初始下拉、termUi 菜单文案保持一致） */
const TERMINAL_SHELL_LABELS: Record<string, string> = {
  auto: t("settings.shellAuto"),
  pwsh: "PowerShell 7（pwsh）",
  powershell: "Windows PowerShell",
  cmd: t("settings.shellCmd"),
};

/** 按后端探测结果重建「终端 Shell」下拉（auto 恒保留，其余仅列出可用项）并回填当前值。
 * 回填逻辑：优先保持 select 当前值（openSettingsPanel 先 fillForm、reset 先填默认），
 * 若该值不在可用列表（如手改配置成机器上没有的 shell）则退为 "auto"。 */
async function refreshTerminalShellSelect(): Promise<void> {
  let avail: string[] = [];
  try {
    avail = await invoke<string[]>("list_shells");
  } catch {
    avail = [];
  }
  const keys = ["auto", ...avail.filter((k) => k !== "auto")];
  const prev = settingsTerminalShellEl.value || "auto";
  settingsTerminalShellEl.textContent = "";
  for (const k of keys) {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = TERMINAL_SHELL_LABELS[k] ?? k;
    settingsTerminalShellEl.appendChild(opt);
  }
  settingsTerminalShellEl.value = keys.includes(prev) ? prev : "auto";
}

/** 用给定 settings 填充表单控件 */
function fillForm(settings: Settings): void {
  setSelectedTheme(settings.theme); // UI-26：原为 settingsThemeEl.value = settings.theme
  settingsFontEl.value = String(settings.font_size);
  settingsFontFamilyEl.value = settings.font_family;
  syncFontPreset(settings.font_family);
  settingsReduceMotionEl.checked = reduceMotionEnabled();
  settingsFontLigaturesEl.checked = settings.font_ligatures;
  settingsTabSizeEl.value = String(settings.tab_size);
  settingsInsertSpacesEl.checked = settings.insert_spaces;
  settingsWordWrapEl.value = settings.word_wrap;
  settingsMinimapEl.checked = settings.minimap;
  // 旧配置缺字段时兜底出厂默认（Rust 侧 struct 级 serde(default) 已保证整表缺省）
  settingsKeywordCompletionEl.checked = settings.keyword_completion ?? DEFAULT_SETTINGS.keyword_completion;
  settingsIndentGuidesEl.checked = settings.indent_guides !== false; // C-6
  settingsBracketColorsEl.checked = settings.bracket_colors !== false;
  settingsStickyScrollEl.checked = settings.sticky_scroll !== false; // PR-B
  settingsInlayParamHintsEl.checked = settings.inlay_param_hints !== false; // PR-N
  settingsTrimTrailingEl.checked = settings.trim_trailing_whitespace !== false; // PR-C
  settingsFinalNewlineEl.checked = settings.final_newline !== false;
  // PR-K：默认关，旧配置缺字段时兜底关（与 DEFAULT_SETTINGS 同向，!== true 反向兼容不适用）
  settingsNewFileTemplateEl.checked = settings.new_file_template ?? DEFAULT_SETTINGS.new_file_template;
  // PR-M：默认开，旧配置缺字段兜底开（!== false 惯例）
  settingsPasteJsonEl.checked = settings.paste_json_to_python !== false;
  settingsDebugJmcEl.checked = settings.debug_just_my_code !== false; // B-3
  // 库特别支持 PR-2：默认开，旧配置缺字段兜底开（!== false 惯例）
  settingsLibsEditorLensEl.checked = settings.libs_editor_lens !== false;
  settingsLibsRegexEl.checked = settings.libs_regex !== false;
  settingsLibsFormatEl.checked = settings.libs_format !== false;
  settingsLibsArgparseEl.checked = settings.libs_argparse !== false;
  settingsLibsJsonInjectEl.checked = settings.libs_json_inject !== false;
  settingsLogLevelColorsEl.checked = settings.log_level_colors !== false;
  // B3：每页行数（旧配置缺字段兜底 200）；写前确认默认开（!== false 惯例）
  settingsDbPageSizeEl.value = String(settings.db_page_size ?? 200);
  settingsDbWarnOnWriteEl.checked = settings.db_warn_on_write !== false;
  // 阶段 4：Pydantic 诊断默认开（!== false 惯例）
  settingsPydanticDiagnosticsEl.checked = settings.pydantic_diagnostics !== false;
  settingsAutosaveEl.value = settings.autosave;
  settingsProbeEl.checked = settings.probe_enabled;
  settingsIntelEl.checked = settings.runtime_intel_enabled;
  settingsEngineEl.value = settings.lsp_engine;
  settingsFormatOnSaveEl.checked = settings.format_on_save;
  settingsOptimizeImportsOnSaveEl.checked =
    settings.optimize_imports_on_save ?? DEFAULT_SETTINGS.optimize_imports_on_save;
  // D-4：旧配置缺字段回落 warning（select 的 value 若不在候选中会显示空白，故先归一）
  settingsRuffSeverityEEl.value = normalizeSeverity(settings.ruff_severity_e);
  settingsRuffSeverityWEl.value = normalizeSeverity(settings.ruff_severity_w);
  settingsRuffSeverityFEl.value = normalizeSeverity(settings.ruff_severity_f);
  settingsTerminalCwdEl.value = settings.terminal_cwd;
  settingsTerminalShellEl.value = settings.terminal_shell ?? DEFAULT_SETTINGS.terminal_shell;
  // 旧配置缺 pypi_index 时兜底出厂默认（官方源）
  settingsPypiIndexEl.value = settings.pypi_index || DEFAULT_SETTINGS.pypi_index;
  syncPypiIndexPreset(settingsPypiIndexEl.value);
  // 日志配置（旧配置缺字段时兜底出厂默认）
  settingsLogEnabledEl.checked = settings.log_enabled ?? DEFAULT_SETTINGS.log_enabled;
  settingsLogLevelEl.value = settings.log_level || DEFAULT_SETTINGS.log_level;
  settingsLogKeepEl.value = String(settings.log_keep ?? DEFAULT_SETTINGS.log_keep);
  settingsLogStdoutEl.checked = settings.log_stdout ?? DEFAULT_SETTINGS.log_stdout;
  for (const m of KEYBINDING_META) {
    const input = document.getElementById(kbInputId(m.id)) as HTMLInputElement | null;
    // 经 setKeybindingValue：同步成键基线，否则录入器回退时会用上一次的旧基线
    if (input) setKeybindingValue(input, settings.keybindings[m.id] ?? "");
  }
  refreshKeybindingConflict(); // UI-32：回填后立刻反映已有配置的冲突（含旧配置撞车）
}

/** UI-05：设置面板模态的焦点陷阱解除句柄 */
let releaseSettingsFocus: (() => void) | null = null;

/** tech-debt #18：Esc 关闭设置面板（document 级，open 时挂、close 时移除）。
 *  守卫：前台有更上层对话框（.modal 显隐约定）时 Esc 归对话框，防连带关闭丢失未保存改动
 * （与 envPanel.onEnvKeydown / bookmarks 同款守卫） */
function onSettingsKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  if (document.querySelectorAll(".modal:not(.hidden)").length > 1) return;
  closeSettingsPanel();
}

/** 打开设置面板（可指定初始分类；「视图 → Live Templates」快捷入口复用） */
export function openSettingsPanel(category: SettingsCategory = "appearance"): void {
  clearSettingsSearch(); // E-1：每次打开重置搜索状态
  // i18n：打开即回显当前语言（语言可能在别处被改过，下拉不能停留在上次打开时的值）
  settingsLocaleEl.value = getLocale();
  fillForm(app.settings);
  void refreshTerminalShellSelect(); // 异步探测可用 shell，完成后重建下拉
  switchCategory(category);
  showEl(settingsModalEl);
  document.addEventListener("keydown", onSettingsKeydown); // tech-debt #18：Esc 关闭
  // UI-05：焦点陷阱（防御性先解除上一次未释放的陷阱，避免异常路径下重复叠加）
  releaseSettingsFocus?.();
  releaseSettingsFocus = trapFocus(settingsModalEl);
}

/**
 * 恢复默认：仅重置表单控件为出厂默认，待用户「保存」才持久化/应用（与「取消」语义对称）。
 * UI-32：这是毁掉面板里全部改动的动作却无门槛——补一次确认 + 一条「已重置，待保存」的反馈，
 * 让用户知道重置了什么、还需要点保存才落盘。
 */
async function resetSettingsPanel(): Promise<void> {
  const ok = await openConfirm({
    title: t("settings.reset"),
    message: t("settings.resetConfirm"),
    okLabel: t("settings.resetOk"),
    kind: "danger",
  });
  if (!ok) return;
  fillForm(DEFAULT_SETTINGS);
  void refreshTerminalShellSelect(); // 重建下拉并回填 auto（DEFAULT 值）
  settingsReduceMotionEl.checked = false; // 出厂默认不减少动画
  toast(t("settings.resetDone"), "success");
}

function closeSettingsPanel(): void {
  document.removeEventListener("keydown", onSettingsKeydown); // tech-debt #18
  releaseSettingsFocus?.();
  releaseSettingsFocus = null;
  hideEl(settingsModalEl);
}

/**
 * 读表单 → 校验 → 套用到运行时 → 落盘。
 * UI-32：抽出「套用」这一步供两个入口复用——
 *  · 「保存」= 套用 + 关闭面板（既有行为，e2e 断言依赖它）
 *  · 「应用」= 套用但留在面板里继续微调（此前想预览字号/主题只能先保存再重开）
 * @returns 是否套用成功（校验不通过为 false）
 */
async function commitSettingsPanel(closeAfter: boolean): Promise<boolean> {
  // 快捷键先行校验（格式 / 冲突），不通过则整体不保存
  const keybindings = readKeybindingForm();
  const kbError = validateKeybindingMap(keybindings);
  if (kbError) {
    await openAlert({ message: kbError, kind: "danger" });
    return false;
  }
  const theme = getSelectedTheme(); // UI-26：原为 settingsThemeEl.value
  const fontSize = clampFontSize(Number(settingsFontEl.value), app.settings.font_size);
  const fontFamily = settingsFontFamilyEl.value.trim();
  const fontLigatures = settingsFontLigaturesEl.checked;
  const tabSize = Math.max(1, Math.min(8, Number(settingsTabSizeEl.value) || app.settings.tab_size));
  const insertSpaces = settingsInsertSpacesEl.checked;
  const wordWrap = settingsWordWrapEl.value;
  const minimap = settingsMinimapEl.checked;
  const indentGuides = settingsIndentGuidesEl.checked; // C-6
  const bracketColors = settingsBracketColorsEl.checked;
  const stickyScroll = settingsStickyScrollEl.checked; // PR-B
  const inlayParamHints = settingsInlayParamHintsEl.checked; // PR-N
  const trimTrailing = settingsTrimTrailingEl.checked; // PR-C
  const finalNewline = settingsFinalNewlineEl.checked;
  const newFileTemplate = settingsNewFileTemplateEl.checked; // PR-K
  const pasteJson = settingsPasteJsonEl.checked; // PR-M
  const autosave = settingsAutosaveEl.value;
  const probeEnabled = settingsProbeEl.checked;
  const lspEngine = settingsEngineEl.value;
  const formatOnSave = settingsFormatOnSaveEl.checked;
  const optimizeImportsOnSave = settingsOptimizeImportsOnSaveEl.checked;
  // D-4：严重度映射（select 固定候选；normalizeSeverity 兜底归一，双保险）
  const ruffSeverityE = normalizeSeverity(settingsRuffSeverityEEl.value);
  const ruffSeverityW = normalizeSeverity(settingsRuffSeverityWEl.value);
  const ruffSeverityF = normalizeSeverity(settingsRuffSeverityFEl.value);
  const runtimeIntelEnabled = settingsIntelEl.checked;
  const keywordCompletion = settingsKeywordCompletionEl.checked;
  const terminalCwd = settingsTerminalCwdEl.value;
  const terminalShell = settingsTerminalShellEl.value;
  const pypiIndex = settingsPypiIndexEl.value.trim();
  const logEnabled = settingsLogEnabledEl.checked;
  const logLevel = settingsLogLevelEl.value;
  const logKeep = Math.max(1, Math.min(10, Number(settingsLogKeepEl.value) || DEFAULT_SETTINGS.log_keep));
  const logStdout = settingsLogStdoutEl.checked;
  const engineChanged = lspEngine !== app.settings.lsp_engine;
  const intelChanged = runtimeIntelEnabled !== app.settings.runtime_intel_enabled;

  app.settings = {
    theme,
    font_size: fontSize,
    font_family: fontFamily,
    font_ligatures: fontLigatures,
    tab_size: tabSize,
    insert_spaces: insertSpaces,
    word_wrap: wordWrap,
    minimap,
    indent_guides: indentGuides,
    bracket_colors: bracketColors,
    sticky_scroll: stickyScroll,
    inlay_param_hints: inlayParamHints,
    trim_trailing_whitespace: trimTrailing,
    final_newline: finalNewline,
    new_file_template: newFileTemplate, // PR-K
    paste_json_to_python: pasteJson, // PR-M
    debug_just_my_code: settingsDebugJmcEl.checked, // B-3
    libs_editor_lens: settingsLibsEditorLensEl.checked, // 库支持 PR-2
    libs_regex: settingsLibsRegexEl.checked, // 库支持 PR-2
    libs_format: settingsLibsFormatEl.checked, // 库支持 PR-3
    libs_argparse: settingsLibsArgparseEl.checked, // 库支持 PR-4
    libs_json_inject: settingsLibsJsonInjectEl.checked, // 库支持 P1
    log_level_colors: settingsLogLevelColorsEl.checked, // 库支持 P1
    // B3：数据库工具窗（page_size 只在候选档内取值，防手改配置塞进非法值）
    db_page_size: DB_PAGE_SIZES.includes(Number(settingsDbPageSizeEl.value))
      ? Number(settingsDbPageSizeEl.value)
      : 200,
    db_warn_on_write: settingsDbWarnOnWriteEl.checked,
    pydantic_diagnostics: settingsPydanticDiagnosticsEl.checked, // 阶段 4
    autosave,
    autosave_delay: app.settings.autosave_delay,
    probe_enabled: probeEnabled,
    lsp_engine: lspEngine,
    format_on_save: formatOnSave,
    optimize_imports_on_save: optimizeImportsOnSave,
    ruff_severity_e: ruffSeverityE,
    ruff_severity_w: ruffSeverityW,
    ruff_severity_f: ruffSeverityF,
    runtime_intel_enabled: runtimeIntelEnabled,
    keyword_completion: keywordCompletion,
    terminal_cwd: terminalCwd,
    terminal_shell: terminalShell,
    pypi_index: pypiIndex,
    keybindings,
    log_enabled: logEnabled,
    log_level: logLevel,
    log_keep: logKeep,
    log_stdout: logStdout,
  };
  // P1 副作用表：外观/编辑器即时生效（model 层缩进单独应用）；引擎变化重启；intel 变化起停
  //
  // ⚠ 顺序不可调换（批 4 引入的新约束）：Monaco 主题的色值是**注册那一刻从 CSS 变量读的快照**，
  // 故必须先切 data-theme（applyShellTheme）再重注册 + setTheme（app.applyEditorTheme）。
  // 反过来写的话，编辑器会拿到上一套主题的表面色——症状是「切到浅色后编辑器背景仍是深灰」，
  // 且因为 rules 的 token 色恰好也错成深色值，contrast 检查也发现不了。
  applyShellTheme(theme); // D1：外壳 CSS 主题与 Monaco 同步切换
  app.applyEditorTheme(theme); // 批 4：重注册（读新 data-theme 的 CSS 变量快照）+ setTheme
  refreshTerminalThemes(); // D1：已打开的终端实例重套深浅配色
  // UI-29：已打开的终端实例跟随新字号/字体族（内部含 refit + PTY resize）。
  // 两个 devtools 只读预览器沿用第四批 UI-11 的既定裁决——随工具挂载新建、创建时读一次设置，
  // 重新挂载（切换工具 / 收起再展开面板）即刷新，不做运行时接线。
  refreshTerminalFonts();
  applyReduceMotion(settingsReduceMotionEl.checked); // D3：「减少动画」开关
  // UI-11：同步已存在的终端实例（光标闪烁）。这条路径不能省——「恢复默认」是直接给
  // .checked 赋值的，不会派发 change 事件，故下方那个即时生效的监听器不会被触发。
  refreshTerminalMotion();
  app.editor.updateOptions(buildEditorOptions(app.settings)); // UI-11：内部按 motionDisabled() 决定光标闪烁
  applyModelIndent(app.settings);
  // 关键字补全开关：provider 内部短路，不重注册（「恢复默认」同样经本路径落地）
  setKeywordCompletionEnabled(app.settings.keyword_completion);
  applyFontStatus();
  applyEditorKeybindings(); // 编辑器级键位即时重建（window 级实时匹配无需处理）
  refreshSplitEditorOptions(); // C-4：分屏编辑器同源 options（字号/主题/连字等即时生效）
  refreshDbSqlOptions(); // B3：数据库 SQL 编辑器同源 options（同上；sqliteView 不 import 本模块，无环）
  repaintRunWidget(); // 改键后运行组 tooltip 副文本跟随新键位（window 级键位变化不走 renderTabs）
  // UI-25：欢迎页快捷键网格同理——保存路径不经 updateEditorOverlay，不显式刷就会留着旧键位
  renderWelcomeShortcuts();
  // PR-N：参数名提示开关 → 立即把 inlay 配置推给静态引擎（引擎侧 150ms 防抖，无需重启引擎）
  void lsp.pushInlayHintSettings();
  // 库支持 P1：日志级别着色开关即时生效（既有行重刷 + chips 显隐，research §11.9）
  applyOutputLevelSetting(outputEl);
  syncOutputLevelChips();
  await saveSettings();
  // tech-debt #19：即时操作结果统一轻提示；UI-32：「应用」与「保存」各说各的结果
  toast(t(closeAfter ? "settings.saved" : "settings.applied"), "success");
  // D-4：严重度映射保存后立即重查当前文件（波浪线级别即时生效，无需等下次编辑）
  void lintActiveFile();
  // 阶段 4：Pydantic 诊断开关即时生效（开→立扫，关→清空）
  refreshPydanticDiagnostics();
  // UI-32：引擎切换与 intel 起停原本排在关闭面板之后，「应用」不关面板，故统一提到这里
  if (engineChanged) {
    renderEngineChip(); // 真值已写入 app.settings.lsp_engine，chip 从 settings 读取（不再写 DOM select）
    await sh().startLsp();
  } else if (intelChanged) {
    // 运行时智能层开关变化：只起停 intel，不重启静态引擎（P3-T09 一键关闭）
    await applyIntelToggle(runtimeIntelEnabled);
  }
  if (closeAfter) closeSettingsPanel();
  return true;
}

/** 「保存」= 套用 + 关闭面板 */
async function saveSettingsPanel(): Promise<void> {
  await commitSettingsPanel(true);
}

/** UI-32：「应用」= 套用但留在面板里（可继续微调再决定保存或放弃） */
async function applySettingsPanel(): Promise<void> {
  await commitSettingsPanel(false);
}

/** 一键开启/关闭运行时智能层（pylume-intel），不影响静态引擎 */
async function applyIntelToggle(enabled: boolean): Promise<void> {
  if (!app.workspaceRoot) return;
  if (enabled) {
    const rootUri = lsp.workspaceRootUri(app.workspaceRoot); // CR-29：正确百分号编码
    try {
      await lsp.startIntel(app.workspaceRoot, rootUri);
      for (const t of app.tabs) lsp.didOpen(t.path, t.model);
    } catch (e) {
      toastFail(t("settings.failStartIntel"), e);
    }
  } else {
    await lsp.stopIntel();
  }
}

// ---------- 事件接线 ----------

/** 接线设置面板交互（菜单栏齿轮 + 分类导航 + 面板内按钮 + 遮罩点击关闭） */
export function wireSettingsPanel(): void {
  // 语言切换：重建搜索关键词缓存 + 刷新状态栏字号文案；面板主体在下次打开时以新语言填充
  onLocaleChange(() => {
    SETTINGS_ROW_KEYWORDS = {
      "settings-theme-picker": t("settings.kw.themePicker"),
      "settings-font": t("settings.kw.font"),
      "settings-font-family": t("settings.kw.fontFamily"),
      "settings-font-family-preset": t("settings.kw.fontFamily"),
      "settings-font-ligatures": t("settings.kw.ligatures"),
      "settings-reduce-motion": t("settings.kw.reduceMotion"),
      "settings-tab-size": t("settings.kw.tabSize"),
      "settings-insert-spaces": t("settings.kw.insertSpaces"),
      "settings-word-wrap": t("settings.kw.wordWrap"),
      "settings-minimap": t("settings.kw.minimap"),
      "settings-indent-guides": t("settings.kw.indentGuides"),
      "settings-bracket-colors": t("settings.kw.bracketColors"),
      "settings-debug-jmc": t("settings.kw.debugJmc"),
      "settings-autosave": t("settings.kw.autosave"),
      "settings-format-on-save": t("settings.kw.formatOnSave"),
      "settings-optimize-imports-on-save": t("settings.kw.optimizeImports"),
      "settings-ruff-severity-e": t("settings.kw.ruffSeverityE"),
      "settings-ruff-severity-w": t("settings.kw.ruffSeverityW"),
      "settings-ruff-severity-f": t("settings.kw.ruffSeverityF"),
      "settings-engine": t("settings.kw.engine"),
      "settings-probe": t("settings.kw.probe"),
      "settings-intel": t("settings.kw.intel"),
      "settings-pypi-index": t("settings.kw.pypiIndex"),
      "settings-pypi-index-preset": t("settings.kw.pypiIndex"),
      "settings-terminal-cwd": t("settings.kw.terminalCwd"),
      "settings-terminal-shell": t("settings.kw.terminalShell"),
      "settings-log-enabled": t("settings.kw.logEnabled"),
      "settings-log-level": t("settings.kw.logLevel"),
      "settings-log-keep": t("settings.kw.logKeep"),
      "settings-log-stdout": t("settings.kw.logStdout"),
      "settings-data-open": t("settings.kw.dataOpen"),
      "settings-log-open": t("settings.kw.logOpen"),
      "storage-open": t("settings.kw.storageOpen"),
      "storage-refresh": t("settings.kw.storageRefresh"),
      "storage-clean-webview": t("settings.kw.cleanWebview"),
      "storage-clean-logs": t("settings.kw.cleanLogs"),
      "storage-uv-prune": t("settings.kw.uvPrune"),
      "storage-uv-clean": t("settings.kw.uvClean"),
      "storage-migrate-path": t("settings.kw.migrate"),
      "storage-migrate": t("settings.kw.migrate"),
      ...keybindingKeywords(),
    };
    applyFontStatus();
  });

  renderKeybindingRows(); // 快捷键分区行一次性构建（值由 fillForm 填充）
  wireThemePicker(); // UI-26：主题预览色卡（卡片构建 + radiogroup 键盘导航；值由 fillForm 填充）
  // UI-24：窄窗口断点下分类导航转横排，aria-orientation 随之同步（先跑一次覆盖「启动即窄窗口」）
  syncNavOrientation();
  window.matchMedia(NARROW_NAV_QUERY).addEventListener("change", syncNavOrientation);
  // i18n：切换语言即时生效并持久化（不经过「保存」——语言不是 Settings 字段，见 index.html 对应注释）。
  // setLocale 内部会重刷静态骨架并广播给订阅者重绘动态内容，这里无需再调 applyDomI18n。
  settingsLocaleEl.addEventListener("change", () => {
    const v = settingsLocaleEl.value;
    if (v === "zh-CN" || v === "en-US") setLocale(v);
  });
  $btn("btn-settings").addEventListener("click", () => openSettingsPanel());
  $btn("settings-close").addEventListener("click", closeSettingsPanel);
  $btn("settings-cancel").addEventListener("click", closeSettingsPanel);
  $btn("settings-save").addEventListener("click", () => saveSettingsPanel());
  // UI-32：「应用」= 套用但不关闭（与「保存」共用 commitSettingsPanel）
  $btn("settings-apply").addEventListener("click", () => applySettingsPanel());
  $btn("settings-reset").addEventListener("click", resetSettingsPanel);
  document.querySelectorAll<HTMLElement>(".settings-nav-item").forEach((b) => {
    b.addEventListener("click", () => {
      clearSettingsSearch(); // E-1：切分类即退出搜索态（搜索覆盖所有分类，与单分类视图互斥）
      switchCategory((b.dataset.cat ?? "appearance") as SettingsCategory);
    });
  });
  // E-1：设置搜索（防抖 150ms；空态提供「查找快捷键」跳转）
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  settingsSearchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => applySettingsFilter(settingsSearchEl.value), 150);
  });
  // UI-31：一键清除——清空并立刻退出搜索态（不等防抖），焦点回到输入框
  settingsSearchClearEl.addEventListener("click", () => {
    settingsSearchEl.value = "";
    applySettingsFilter("");
    settingsSearchEl.focus();
  });
  $("settings-search-goto-kb").addEventListener("click", () => {
    clearSettingsSearch();
    switchCategory("keybindings");
  });
  // tech-debt #18：含可编辑内容，点遮罩不关闭（仅 X / 取消 / Esc 关闭）
  // D3 P-14：字体族下拉候选 → 写入自定义框 + 实时预览
  settingsFontFamilyPresetEl.addEventListener("change", () => {
    if (settingsFontFamilyPresetEl.value !== "__custom__") {
      settingsFontFamilyEl.value = settingsFontFamilyPresetEl.value;
    }
    syncPresetControls(settingsFontFamilyPresetEl, settingsFontFamilyEl, true);
    previewFontFamily();
  });
  settingsFontFamilyEl.addEventListener("input", () => {
    syncFontPreset(settingsFontFamilyEl.value.trim());
    previewFontFamily();
  });
  // PyPI 源：预设命中写入输入框；输入框失配时落「自定义…」
  settingsPypiIndexPresetEl.addEventListener("change", () => {
    if (settingsPypiIndexPresetEl.value !== "__custom__") {
      settingsPypiIndexEl.value = settingsPypiIndexPresetEl.value;
    }
    syncPypiIndexPreset(settingsPypiIndexEl.value);
    syncPresetControls(settingsPypiIndexPresetEl, settingsPypiIndexEl, true);
  });
  settingsPypiIndexEl.addEventListener("input", () => {
    syncPypiIndexPreset(settingsPypiIndexEl.value.trim());
  });
  // D3 P-06：「减少动画」勾选即时生效（localStorage 持久化，独立于 Settings 结构）
  // UI-11：开关即时生效。CSS 侧靠 applyReduceMotion 切换 html[data-reduce-motion] 立即生效，
  // 这里补上两个管不到的地方：已存在的终端实例、以及主编辑器光标。
  // 编辑器只单独写 cursorBlinking，不调 buildEditorOptions(app.settings)——后者会读「已保存」的
  // settings，在用户还没点保存时套用，会把表单里正在调整的字号/字体等改动先视觉回退掉。
  settingsReduceMotionEl.addEventListener("change", () => {
    applyReduceMotion(settingsReduceMotionEl.checked);
    refreshTerminalMotion();
    app.editor?.updateOptions({ cursorBlinking: motionDisabled() ? "solid" : "blink" });
  });
  // 日志：打开日志目录（系统资源管理器）
  settingsLogOpenEl.addEventListener("click", () => {
    invoke("open_log_dir").catch((e) => toastFail(t("settings.failOpenLogDir"), e));
  });
  // 数据：打开数据根目录（系统资源管理器）
  settingsDataOpenEl.addEventListener("click", () => {
    invoke("open_data_dir").catch((e) => toastFail(t("settings.failOpenDataDir"), e));
  });
  // 存储：占用可视化 / 清理 / 迁移（storagePanel.ts）
  wireStoragePanel();
}