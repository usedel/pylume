// AppState 上下文对象（TD-007）：收敛原 main.ts 中跨功能域共享的模块级状态与 DOM 引用。
// 各功能域模块（fileTree / git / termUi / settingsPanel）经 app 读写共享状态；
// 域内私有状态（如文件树选中集、Git 变更列表、终端会话）仍留在各域模块内部。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { KEYBINDING_META } from "./keybindingDefaults";
import { EDITOR_THEME_DARK, resolveEditorTheme } from "./theme/tokens";

export type MonacoModule = typeof MonacoApi;

/** 文件树条目 */
export interface Entry { name: string; path: string; is_dir: boolean }

/** 打开的文件标签。
 *  diff 视图 tab（第 2 步迁移）：kind="diff" 时 path 为目标文件仓库相对路径，
 *  diff 元数据携带三态基准与冲突态；model 为占位（diff 宿主不消费主编辑器模型，
 *  但保留字段避免 90+ 处 t.model 访问点判空——占位模型随 tab 关闭一并 dispose）。 */
export interface Tab {
  path: string;
  model: MonacoApi.editor.ITextModel;
  dirty: boolean;
  /** 切标签时的编辑器视图状态（光标/滚动/选区），activateTab 保存与恢复 */
  viewState?: MonacoApi.editor.ICodeEditorViewState;
  /** tab 类型：普通文件（默认）| git diff 视图 | 数据库视图（表数据 / SQL 查询） */
  kind?: "file" | "diff" | "db";
  /** kind="diff" 时的元数据 */
  diff?: {
    /** 三态基准（auto/index/head），切 tab 恢复 */
    base: "auto" | "index" | "head";
    /** 冲突视图（当前 vs 传入 + 接受按钮组） */
    conflict: boolean;
  };
}

/** 保存选项：自动保存路径（autosave 定时器 / 失焦 / 运行前落盘）传 runOnSaveActions=false——
 *  ruff isort/format 只跟显式 Ctrl+S 走（保存动作与落盘解耦，避免 autosave 每 2s 跑 ruff、
 *  产生意外 diff；PyCharm 移除 reformat-on-save 的同一结论） */
export interface SaveOptions {
  /** 是否执行保存时动作（isort / format），默认 true */
  runOnSaveActions?: boolean;
}

/** 全局设置（P25-T08/T09；P1 扩展编辑器高频项） */
export interface Settings {
  theme: string;
  font_size: number;
  font_family: string;
  font_ligatures: boolean;
  tab_size: number;
  insert_spaces: boolean;
  word_wrap: string;
  minimap: boolean;
  /** 缩进参考线（C-6：长脚本可读性；含当前缩进层级高亮） */
  indent_guides: boolean;
  /** 括号彩色化（C-6：多层嵌套括号配对辨识） */
  bracket_colors: boolean;
  /** Sticky Scroll（PR-B · dx_features_backlog §6.2：长文件滚动时当前作用域头部常驻顶部） */
  sticky_scroll: boolean;
  /** 参数名行内提示（PR-N · dx_features_backlog §6.8：调用处灰字 `name=`，走 pyrefly inlayHint） */
  inlay_param_hints: boolean;
  /** 调试「只步进我的代码」（B-3：不误入 site-packages；改动需重启调试会话生效） */
  debug_just_my_code: boolean;
  autosave: string;
  autosave_delay: number;
  probe_enabled: boolean;
  lsp_engine: string;
  format_on_save: boolean;
  /** 保存时用 ruff 整理导入（Ctrl+Alt+O 的保存联动；与 format_on_save 同模式） */
  optimize_imports_on_save: boolean;
  /** 保存时清理行尾空白（PR-C · dx_features_backlog §6.3；仅显式保存，autosave/运行前跳过） */
  trim_trailing_whitespace: boolean;
  /** 保存时确保文件以换行结束（PR-C；仅显式保存） */
  final_newline: boolean;
  /** 新建 .py/.pyw 文件后自动插 header 文件头模板（PR-K · dx_features_backlog §6.6；
   *  默认关——避免污染草稿流；草稿（Ctrl+Alt+Shift+Insert）不走此路径天然豁免） */
  new_file_template: boolean;
  /** 粘贴 JSON 自动转 Python dict 字面量（PR-M · dx_features_backlog §6.6；默认开——
   *  单次 executeEdits = 单一撤销粒度，Ctrl+Z 一步回原文，非破坏性） */
  paste_json_to_python: boolean;
  /** D-4：ruff 规则严重度映射——E（pycodestyle 风格）/ W（pycodestyle 警告）/
   *  F（pyflakes）三类规则各自的显示级别："hint" | "info" | "warning" | "error"
   *  （其余规则类别回落 warning；非法值由 ruffLint.ts 归一化为 warning） */
  ruff_severity_e: string;
  ruff_severity_w: string;
  ruff_severity_f: string;
  runtime_intel_enabled: boolean;
  /** 阶段 4：Pydantic 构造校验诊断（pylume-pydantic 桶 + rename 传播补充）总开关 */
  pydantic_diagnostics: boolean;
  /** 零引擎静态关键字补全（无 LSP 引擎的语言；python 不受影响——由三段语义补全负责） */
  keyword_completion: boolean;
  terminal_cwd: string;
  /** 集成终端 shell："auto" | "pwsh" | "powershell" | "cmd"（auto 按顺序回退） */
  terminal_shell: string;
  /** PyPI 包源（uv 拉取依赖用；默认官方源，国内网络可切镜像） */
  pypi_index: string;
  /** 快捷键自定义（id → 键位串如 "Ctrl+D"；空串 = 解绑）。
   *  id 清单与出厂默认见 keybindings.ts 的 KEYBINDING_META（两处须同步）。 */
  keybindings: Record<string, string>;
  /** 日志：总开关（关闭后仅 error 仍落盘） */
  log_enabled: boolean;
  /** 日志级别阈值："error" | "warn" | "info" | "debug" */
  log_level: string;
  /** 日志轮转保留份数（1-10） */
  log_keep: number;
  /** 日志是否同时打印 stdout（dev 终端可见；release 无控制台可关） */
  log_stdout: boolean;
  /** 库特别支持：编辑器内工具 lens（关掉后入口降级到右键 + 命令面板；须与 Rust settings.rs 同步） */
  libs_editor_lens: boolean;
  /** 库特别支持：正则高亮/hover/诊断 + 测试器（须与 Rust settings.rs 同步） */
  libs_regex: boolean;
  /** 库特别支持：格式串 hover/诊断 + 工具（须与 Rust settings.rs 同步） */
  libs_format: boolean;
  /** 库特别支持：参数表单（关掉后运行面板不显示参数区；须与 Rust settings.rs 同步） */
  libs_argparse: boolean;
  /** 库特别支持：JSON 字面量注入（高亮/诊断；research §11.9，须与 Rust settings.rs 同步） */
  libs_json_inject: boolean;
  /** 输出面板日志级别着色与过滤（research §11.7，须与 Rust settings.rs 同步） */
  log_level_colors: boolean;
  /** B3：SQLite 结果每页行数（100/200/500/1000；须与 Rust settings.rs 同步） */
  db_page_size: number;
  /** B3：写语句执行前是否弹确认框（默认开——写库不可撤销；须与 Rust settings.rs 同步） */
  db_warn_on_write: boolean;
}

/** 从单一来源（keybindingDefaults.ts）派生出厂键位表，避免三处手写漂移（tech-debt #6） */
function defaultKeybindings(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of KEYBINDING_META) map[m.id] = m.def;
  return map;
}

/** 出厂等宽字体栈（ui_premium §5.3 · 批 3）：JetBrains Mono 随包分发（`shell/public/fonts/`，
 *  @font-face 见 style.css 文件头），其后依次是本机可能已装的可选字体与系统兜底。
 *  旧栈把 2007 年的 Consolas 排第一，而它命中的恰是 80% 注视时间的代码区。
 *  ⚠ 同步义务（共 4 处）：① 本常量 ② Rust `Settings::default` ③ style.css `--mono`
 *     ④ index.html 字体族 preset 的首选项。 */
export const DEFAULT_FONT_FAMILY = '"JetBrains Mono", "Cascadia Code", "SF Mono", Consolas, monospace';

/** 批 3 之前的出厂等宽串（D3 P-14）。**仅供存量配置迁移**：settings.json 里
 *  `font_family` 已固化为旧串，不迁移的话随包字体对老用户 100% 无效；判定为「等于旧出厂串」
 *  才替换，用户自定义过的一律保留。改动此值需同步 settingsPanel.ts::loadSettings。 */
export const LEGACY_FONT_FAMILY = 'Consolas, "Cascadia Code", "JetBrains Mono", monospace';

/** 存量设置迁移：等宽字体（ui_premium 批 3 · §5.3-3a 第 4 项）。
 *
 *  为什么必须做：老用户的 `settings.json` 里 `font_family` 已固化为**旧出厂串**，不迁移的话
 *  随包的 JetBrains Mono 对他们 100% 无效（CSS 的 `--mono` 只管外壳，编辑器字体不读 CSS，
 *  走 `settings.font_family` → `buildEditorOptions` 注入 Monaco）。
 *
 *  口径：**仅当等于旧出厂串时替换**，用户自定义过的一律保留、绝不覆盖。
 *  只改内存不落盘——用户下次点「保存」时自然写回，且每次启动重跑是幂等的。
 *  放在本文件而非 settingsPanel.ts：这是纯数据规则，不该让它的单测拖入面板的整条 Tauri 依赖链。
 */
export function migrateLegacyFontSettings<T extends { font_family: string }>(settings: T): T {
  if (settings.font_family === LEGACY_FONT_FAMILY) {
    settings.font_family = DEFAULT_FONT_FAMILY;
  }
  return settings;
}

/** 存量设置迁移：主题名（ui_premium 批 4 · §5.4 连带项 2）。
 *
 *  为什么必须做：老用户 `settings.json` 里存的是出厂串（深 `vs-dark` / 浅 `vs`）。批 4 把编辑器
 *  切到自定义主题 `pylume-dark` / `pylume-light`，而 **Monaco 对未注册的主题名不报错、
 *  静默回落到出厂 vs-dark**——不迁移的症状是「用户升级后编辑器悄悄变回原厂主题且无任何提示」，
 *  这是最难排查的一类静默回归。
 *
 *  与 migrateLegacyFontSettings 的口径差异（有意）：这里对**未知值也兜底**到深色出厂主题。
 *  字体栈不能这样——写错的字体名应当原样保留让用户自己看到「字体没生效」；而主题名是一个
 *  二值枚举，不存在「用户自选了第三套主题」的场景（themePicker 只有两个候选），故兜底更安全。
 *  纯数据规则（无 DOM），单测见 __tests__/themeTokens.test.ts。 */
export function migrateLegacyThemeSettings<T extends { theme: string }>(settings: T): T {
  settings.theme = resolveEditorTheme(settings.theme);
  return settings;
}

/** Settings 出厂默认值（「恢复默认」与 app.settings 初始值共用；须与 Rust Settings::default 保持一致） */
export const DEFAULT_SETTINGS: Settings = {
  // 批 4：编辑器从出厂 vs-dark 切到自定义主题 pylume-dark（色值真源仍是 style.css 的 token，
  // 见 theme/tokens.ts）。存量 `vs-dark` / `vs` 由 migrateLegacyThemeSettings 迁移。
  theme: EDITOR_THEME_DARK,
  font_size: 14,
  font_family: DEFAULT_FONT_FAMILY,
  // 批 3 起默认开：JetBrains Mono 的编程连字（=> != >= 合成单符）是它相对 Consolas 的
  // 核心卖点，也是本项目「有身份感」的主要来源。Monaco 侧由 buildEditorOptions 的
  // fontLigatures 消费（settingsPanel.ts:397），与 CSS 的 font-variant-ligatures 是两套开关。
  font_ligatures: true,
  tab_size: 4,
  insert_spaces: true,
  word_wrap: "off",
  minimap: false,
  // C-6（PyCharm 调研）：可读性默认开——PyCharm 出厂即有缩进参考线，「默认就对」
  indent_guides: true,
  bracket_colors: true,
  // PR-B（PyCharm/VSCode 对标）：粘性滚动默认开——长文件可读性「默认就对」
  sticky_scroll: true,
  // PR-N：参数名行内提示默认开（PyCharm 同款感知；走 pyrefly inlayHint，见 lsp/client.ts）
  inlay_param_hints: true,
  // B-3（PyCharm 调研）：只步进我的代码，默认开（与 DAP attach 硬编码时代行为一致）
  debug_just_my_code: true,
  // autosave 默认 delay 2s（PyCharm 式数据安全优先，对标 VSCode/PyCharm 调研结论）；
  // 与 Rust Settings::default 保持同步
  autosave: "delay",
  autosave_delay: 2000,
  probe_enabled: true,
  lsp_engine: "pyrefly",
  format_on_save: false,
  optimize_imports_on_save: false,
  // PR-C（PyCharm 对标）：保存清理默认开——「保存即干净」，不影响 autosave 静默落盘
  trim_trailing_whitespace: true,
  final_newline: true,
  // PR-K：新建 .py 文件自动插文件头模板，默认关（避免污染草稿流；须与 Rust Settings::default 保持同步）
  new_file_template: false,
  // PR-M：粘贴 JSON 自动转 Python 字面量，默认开（Ctrl+Z 单步可撤；须与 Rust Settings::default 保持同步）
  paste_json_to_python: true,
  // D-4：默认全 Warning（维持映射引入前的行为，默认值保守）
  ruff_severity_e: "warning",
  ruff_severity_w: "warning",
  ruff_severity_f: "warning",
  runtime_intel_enabled: true,
  // 阶段 4：Pydantic 诊断默认开（须与 Rust Settings::default 保持同步）
  pydantic_diagnostics: true,
  // 关键字补全默认开（须与 Rust Settings::default 保持同步）
  keyword_completion: true,
  terminal_cwd: "workspace",
  terminal_shell: "auto",
  // PyPI 包源默认官方源（须与 Rust Settings::default 保持同步）
  pypi_index: "https://pypi.org/simple",
  // 出厂默认键位（PyCharm 风格）：由 keybindingDefaults.ts 单一来源派生（tech-debt #6），
  // 与 Rust settings.rs default_keybindings 保持同步（keybindings.test.ts 有漂移锁）。
  keybindings: defaultKeybindings(),
  // 日志默认（须与 Rust settings.rs Default 保持同步）
  log_enabled: true,
  log_level: "info",
  log_keep: 3,
  log_stdout: false,
  // 库特别支持 PR-2/PR-3/PR-4（默认开；须与 Rust Settings::default 保持同步）
  libs_editor_lens: true,
  libs_regex: true,
  libs_format: true,
  libs_argparse: true,
  // 库特别支持 P1（research §11.9，默认开，与 Rust Settings::default 同步）
  libs_json_inject: true,
  log_level_colors: true,
  // B3（SQLite 数据库工具窗）：每页 200 行（与后端默认 limit 一致）；写前确认默认开
  // （写库不可撤销，且「默认只读」是本功能的产品定位，须与 Rust Settings::default 保持同步）
  db_page_size: 200,
  db_warn_on_write: true,
};

export interface AppState {
  /** Monaco 模块（init 动态加载后赋值；此前访问即为 bug——getter 抛出带上下文的错误） */
  monaco: MonacoModule;
  /** 主编辑器（init 创建后赋值；约定同 monaco） */
  editor: MonacoApi.editor.IStandaloneCodeEditor;
  /** 当前工作区根路径（null = 无工作区） */
  workspaceRoot: string | null;
  /** 打开的标签页 */
  tabs: Tab[];
  /** 当前激活标签 */
  activeTab: Tab | null;
  /** 待同步的文件（200ms 防抖后发增量/全量 didChange）；value = 自上次同步起的 Monaco 增量编辑序列 */
  pendingChanges: Map<string, MonacoApi.editor.IModelContentChange[]>;
  /** 全局设置 */
  settings: Settings;
  /** 批 4：应用编辑器主题（重注册 CSS 变量快照 + setTheme）。
   *
   *  经 app 注入而不是让 settingsPanel / markdownPreview 直接 import monaco.ts：后者静态引入
   *  整个 monaco-editor（~3 MB 主 chunk），会让「设置面板」这类冷路径平白付掉按需加载的代价。
   *  约定同 monaco / editor——init 动态加载后赋值，此前访问抛错而非静默 undefined。 */
  applyEditorTheme: (theme: string) => void;
  /** 批 4：临时切主题执行 fn 并在 finally 恢复（现仅 markdownPreview 导出 HTML 用）。
   *  同样经 app 注入而非 import monaco.ts——理由同 applyEditorTheme。 */
  withEditorTheme: <T>(to: string, from: string, fn: () => Promise<T>) => Promise<T>;
}

// CR-26：私有存储 + getter 抛错——原 `null as unknown as T` 双重断言把「初始化前访问」
// 变成静默 undefined 崩溃（错误信息晦涩、远离根因）。现在：
// - 类型保持非空（正常路径零判空，90+ 调用点无需改动）；
// - init 前访问立即抛出带上下文的清晰错误。
let _monaco: MonacoModule | null = null;
let _editor: MonacoApi.editor.IStandaloneCodeEditor | null = null;
let _applyEditorTheme: ((theme: string) => void) | null = null;
let _withEditorTheme: (<T>(to: string, from: string, fn: () => Promise<T>) => Promise<T>) | null = null;

export const app: AppState = {
  get monaco(): MonacoModule {
    if (_monaco === null) throw new Error("[Pylume] Monaco 尚未初始化（app.monaco 在 init 动态加载后才可用）");
    return _monaco;
  },
  set monaco(m: MonacoModule) {
    _monaco = m;
  },
  get editor(): MonacoApi.editor.IStandaloneCodeEditor {
    if (_editor === null) throw new Error("[Pylume] 编辑器尚未初始化（app.editor 在 init 创建后才可用）");
    return _editor;
  },
  set editor(e: MonacoApi.editor.IStandaloneCodeEditor) {
    _editor = e;
  },
  get applyEditorTheme(): (theme: string) => void {
    if (_applyEditorTheme === null) {
      throw new Error("[Pylume] applyEditorTheme 尚未注入（init 加载 monaco.ts 后赋值）");
    }
    return _applyEditorTheme;
  },
  set applyEditorTheme(fn: (theme: string) => void) {
    _applyEditorTheme = fn;
  },
  get withEditorTheme(): <T>(to: string, from: string, fn: () => Promise<T>) => Promise<T> {
    if (_withEditorTheme === null) {
      throw new Error("[Pylume] withEditorTheme 尚未注入（init 加载 monaco.ts 后赋值）");
    }
    return _withEditorTheme;
  },
  set withEditorTheme(fn: <T>(to: string, from: string, fn: () => Promise<T>) => Promise<T>) {
    _withEditorTheme = fn;
  },
  workspaceRoot: null,
  tabs: [],
  activeTab: null,
  pendingChanges: new Map<string, MonacoApi.editor.IModelContentChange[]>(),
  settings: { ...DEFAULT_SETTINGS },
};

// ---------- DOM 工具 ----------

/**
 * CR-26：按 id 取元素（找不到即抛错——原 `as T` 断言 90+ 调用点 id 拼错只在
 * 运行时静默 undefined，后续属性访问报晦涩错误）。合并 manager.ts:98 的同名实现。
 */
export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

/** 按钮专用（语义 + 类型收窄；同样抛错） */
export const $btn = (id: string): HTMLButtonElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}（应为 <button>）`);
  return el as HTMLButtonElement;
};

/** 跨域共享 DOM 引用（被 2 个以上域模块引用的才放这里，其余各域自行缓存）。
 * CR-26：改惰性 Proxy——模块加载期（含测试环境的 jsdom/happy-dom，无完整 DOM）
 * 不再因顶层快照抛错；首次属性访问时才解析（生产 DOM 在入口 HTML 静态存在）。
 * 导出供各域模块的顶层 DOM 快照统一使用（如 fileTree 的 treeEl、dialog 的 modalEl）。 */
export function lazyEl<T extends HTMLElement = HTMLElement>(id: string): T {
  let cached: T | null = null;
  const resolve = (): T => (cached ??= $(id) as T);
  return new Proxy({} as T, {
    get(_t, prop) {
      const el = resolve();
      const v = Reflect.get(el, prop, el); // receiver 用真实元素：Proxy 非真实 Element/Node 子类
      if (typeof v === "function") return v.bind(el); // DOM 方法必须以真实元素为 this
      return v;
    },
    set(_t, prop, value) {
      const el = resolve();
      return Reflect.set(el, prop, value, el);
    },
    has(_t, prop) {
      return Reflect.has(resolve(), prop);
    },
  });
}

/** 输出面板元素（惰性解析，见 lazyEl 说明） */
export const outputEl: HTMLElement = lazyEl("output");
/** 状态栏文件路径元素（惰性解析） */
export const statusFileEl: HTMLElement = lazyEl("status-file");
