// 出厂快捷键元数据（零依赖单一来源，tech-debt #6）。
// 原「KEYBINDING_META.def / state.ts DEFAULT_SETTINGS.keybindings / Rust default_keybindings」
// 三处手写易漂移；本文件收敛前端两处的出处：keybindings.ts（分发/解析）与 state.ts
// （DEFAULT_SETTINGS）都从这里取，Rust 一侧保留 default_keybindings 并由漂移锁测试兜底。

export type KeybindingId =
  | "save"
  | "run_script"
  | "run_project"
  | "stop"
  | "run_selection"
  | "global_search"
  | "goto_definition"
  | "duplicate_line"
  | "comment_line"
  | "comment_block"
  | "template_palette"
  | "surround"
  | "optimize_imports"
  | "recent_files"
  | "goto_file"
  | "goto_line"
  | "nav_back"
  | "nav_forward"
  | "local_history"
  | "debug"
  | "debug_stop"
  | "debug_step_over"
  | "debug_step_into"
  | "debug_step_out"
  | "debug_evaluate"
  | "debug_run_to_cursor"
  | "bookmark_toggle"
  | "bookmark_list"
  | "scratch_new"
  | "run_history"
  | "markdown_preview"
  // P1（UX 审查）：高频但此前无键位的操作
  | "close_tab"
  // 标签页循环切换（VS Code 风格 Ctrl+Tab / Ctrl+Shift+Tab；Alt+←/→ 被 browserKeys 护栏占用）
  | "next_tab"
  | "prev_tab"
  | "new_file"
  | "open_settings"
  | "toggle_sidebar"
  | "toggle_bottom"
  // 命令面板直达（VS Code Ctrl+Shift+P 同款；E2E 验收依赖此入口）
  | "command_palette"
  // PR-1（plugin_system_design §9.9）：开发工具面板 + 选择器（picker 专用，不触发 inline 变换）
  | "open_devtools"
  // P1（查找引用）：PyCharm 同款 Alt+F7，完整引用列表落底部「引用」面板（Shift+F12 仍是 Monaco peek）
  | "find_usages"
  // P2（重命名）：PyCharm 同款 Shift+F6，就地改名（prepareRename 锚定 + ghost 预览 +
  // Enter 全部文件一次性写入，见 renameWidget.ts）；F2 为同一入口的固定快捷键
  | "rename_symbol"
  // P1（PyCharm 调研 C-1/C-2）：编辑器基本功——语法感知选区扩展/收缩 + 行上下移动。
  // 注：Ctrl+W / Ctrl+Shift+W 属浏览器危险键（关窗口），已由 browserKeys.ts 在编辑器内
  // 「只 preventDefault、不 stopPropagation」放行给 Monaco（见该文件 CLAIMED_IN_MONACO）。
  | "smart_select_expand"
  | "smart_select_shrink"
  | "move_line_up"
  | "move_line_down"
  // P4（C-3）：列（矩形）选择开关——Monaco 0.52 是核心 option（columnSelection），
  // 开启后鼠标拖拽 / Shift+点击按矩形选择；无浏览器危险键冲突（Insert 不在护栏清单）
  | "toggle_column_selection"
  // P4（C-4）：向右分屏——同 model 第二编辑器实例（splitEditor.ts）；Backslash 非浏览器危险键
  | "split_editor"
  // PR-A（dx_features_backlog §6.1）：键位补齐组——删除行 / 折叠全部 / 展开全部 / 括号跳转 / 重开标签
  | "delete_line"
  | "fold_all"
  | "unfold_all"
  | "jump_to_bracket"
  | "reopen_tab"
  // PR-D（dx_features_backlog §6.4）：最近编辑位置（PyCharm Ctrl+Shift+Backspace 同款）
  | "recent_edit_locations"
  // PR-G（dx_features_backlog §6.6）：文件内符号 Quick Pick（PyCharm Ctrl+F12「文件结构」同位）
  | "goto_symbol"
  // PR-J（dx_features_backlog §6.6）：触发补全建议的可配置备选键——Ctrl+Space 是 Monaco 内建
  // 固定键，实测被 Windows 中文输入法切换热键吞掉（2026-09-27 人工验证），Alt+/ 保底
  | "trigger_suggest"
  // 库特别支持 PR-2（python_library_support_dev_plan §4.2）：正则测试器（editor 级，需焦点；
  // Ctrl+Alt+R 与既有 56 项无冲突，2026-09-27 核对）
  | "open_regex_tester"
  // 诊断导航（2026-09-29 保存错误排查交付）：F8 / Shift+F8 逐个跳转 error/warning marker。
  // PyCharm 同款 F8 = 下一个错误；editor 级（导航目标依附编辑器上下文）
  | "goto_next_problem"
  | "goto_prev_problem"
  // 问题面板（对标 PyCharm Problems View；Alt+0 = PyCharm 同款打开 Problems 工具窗）
  | "open_problems";

export interface KeybindingMeta {
  id: KeybindingId;
  /** 设置面板显示名 */
  label: string;
  /** 出厂默认键位 */
  def: string;
  /** window = 全局生效；editor = 仅编辑器聚焦时生效 */
  scope: "window" | "editor";
}

export const KEYBINDING_META: KeybindingMeta[] = [
  { id: "save", label: "保存", def: "Ctrl+S", scope: "window" },
  // v3.4 §17-7（M3-3.5）：run 拆为 run_script + run_project（标签「运行当前文件」改为「运行脚本」）
  { id: "run_script", label: "运行脚本", def: "Ctrl+F10", scope: "window" },
  { id: "run_project", label: "运行项目", def: "Ctrl+Shift+F10", scope: "window" },
  { id: "stop", label: "停止运行", def: "Ctrl+F2", scope: "window" },
  { id: "run_selection", label: "运行选区 / 行", def: "Alt+Shift+E", scope: "editor" },
  { id: "global_search", label: "全局搜索", def: "Ctrl+Shift+F", scope: "window" },
  { id: "goto_definition", label: "跳转定义（F12 / Ctrl+点击固定保留）", def: "Ctrl+B", scope: "editor" },
  // P1（查找引用）：完整引用列表（PyCharm Alt+F7 同款）；Shift+F12 仍保留 Monaco peek 快速预览
  { id: "find_usages", label: "查找引用", def: "Alt+F7", scope: "editor" },
  // P2（重命名）：就地改名（PyCharm Shift+F6 同款）；F2 触发同一入口（编辑器级固定键）
  { id: "rename_symbol", label: "重命名符号（跨文件）", def: "Shift+F6", scope: "editor" },
  { id: "duplicate_line", label: "复制行 / 选区", def: "Ctrl+D", scope: "editor" },
  { id: "comment_line", label: "行注释开关", def: "Ctrl+/", scope: "editor" },
  { id: "comment_block", label: "块注释开关", def: "Ctrl+Shift+/", scope: "editor" },
  { id: "template_palette", label: "Live Templates 面板", def: "Ctrl+J", scope: "editor" },
  { id: "surround", label: "环绕模板（需选区）", def: "Ctrl+Alt+T", scope: "editor" },
  // P0（PyCharm 调研）：Optimize Imports（Ctrl+Alt+O）/ 最近文件（Ctrl+E），均为 PyCharm 同款默认键
  { id: "optimize_imports", label: "Optimize Imports（整理导入）", def: "Ctrl+Alt+O", scope: "editor" },
  { id: "recent_files", label: "最近打开的文件", def: "Ctrl+E", scope: "window" },
  // P1（PyCharm 调研）：Search Everywhere / Go to File / Go to Line / 导航历史 / 本地历史。
  // 注：Search Everywhere 的 **Double Shift** 是双击手势，无法用「单键位串」表达
  // （同 F12 / Ctrl+点击，属固定保留入口，不可自定义），故不进本表。
  { id: "goto_file", label: "转到文件（Search Everywhere 文件模式）", def: "Ctrl+Shift+N", scope: "window" },
  { id: "goto_line", label: "转到行 / 列", def: "Ctrl+G", scope: "window" },
  { id: "nav_back", label: "导航后退", def: "Ctrl+Alt+Left", scope: "window" },
  { id: "nav_forward", label: "导航前进", def: "Ctrl+Alt+Right", scope: "window" },
  { id: "local_history", label: "本地历史", def: "Ctrl+Shift+H", scope: "window" },
  // 调试五件套（debug dev plan §6.6；window 级——调试中编辑器可能失焦）
  { id: "debug", label: "启动调试 / 继续", def: "F5", scope: "window" },
  { id: "debug_stop", label: "停止调试", def: "Shift+F5", scope: "window" },
  { id: "debug_step_over", label: "单步跳过", def: "F10", scope: "window" },
  { id: "debug_step_into", label: "单步进入", def: "F11", scope: "window" },
  { id: "debug_step_out", label: "单步退出", def: "Shift+F11", scope: "window" },
  // P1：断点处求值表达式（PyCharm Alt+F8 同款）
  { id: "debug_evaluate", label: "求值表达式（调试控制台）", def: "Alt+F8", scope: "window" },
  // P2：调试打磨组 + 书签 / 草稿 / 运行历史
  { id: "debug_run_to_cursor", label: "运行到光标处（Run to Cursor）", def: "Alt+F9", scope: "window" },
  { id: "bookmark_toggle", label: "切换书签", def: "Ctrl+F11", scope: "window" },
  { id: "bookmark_list", label: "书签列表", def: "Ctrl+Shift+F11", scope: "window" },
  { id: "scratch_new", label: "新建草稿文件（Scratch）", def: "Ctrl+Alt+Shift+Insert", scope: "window" },
  { id: "run_history", label: "运行历史", def: "Ctrl+Shift+R", scope: "window" },
  // Markdown 预览开关（window 级——编辑器聚焦/失焦均可用）
  { id: "markdown_preview", label: "Markdown 预览", def: "Ctrl+Shift+V", scope: "window" },
  // P1（UX 审查）：高频操作补键位。默认值取 PyCharm 同款（Ctrl+F4 关闭标签 / Ctrl+Alt+Insert 新建
  // / Ctrl+Alt+S 设置）；侧栏/底部面板取 PyCharm 工具窗口习惯键（Ctrl+Shift+F12 / Alt+F12）
  { id: "close_tab", label: "关闭标签", def: "Ctrl+F4", scope: "window" },
  // 标签页循环切换（VS Code 同款默认键；不取 PyCharm 的 Alt+→/←，那组键被浏览器护栏吞掉）
  { id: "next_tab", label: "下一个标签", def: "Ctrl+Tab", scope: "window" },
  { id: "prev_tab", label: "上一个标签", def: "Ctrl+Shift+Tab", scope: "window" },
  { id: "new_file", label: "新建文件", def: "Ctrl+Alt+Insert", scope: "window" },
  { id: "open_settings", label: "打开设置", def: "Ctrl+Alt+S", scope: "window" },
  { id: "toggle_sidebar", label: "切换侧栏", def: "Ctrl+Shift+F12", scope: "window" },
  { id: "toggle_bottom", label: "切换底部面板", def: "Alt+F12", scope: "window" },
  // 命令面板直达（VS Code 同款；不注册时 Ctrl+Shift+P 会落进浏览器「打印」，E2E 验收也被堵）
  { id: "command_palette", label: "命令面板（只搜命令）", def: "Ctrl+Shift+P", scope: "window" },
  // PR-1：开发工具面板（右侧）+ picker；window 级——工具动作不应依赖编辑器聚焦
  { id: "open_devtools", label: "开发工具面板", def: "Ctrl+Shift+T", scope: "window" },
  // P1（PyCharm 调研 C-1/C-2）：编辑器基本功。默认值取 PyCharm 同款
  // （Ctrl+W / Ctrl+Shift+W 扩大/缩小选区；Ctrl+Shift+↑/↓ 移动行）。
  { id: "smart_select_expand", label: "扩大选区（语法感知）", def: "Ctrl+W", scope: "editor" },
  { id: "smart_select_shrink", label: "缩小选区（语法感知）", def: "Ctrl+Shift+W", scope: "editor" },
  { id: "move_line_up", label: "行 / 选区上移", def: "Ctrl+Shift+Up", scope: "editor" },
  { id: "move_line_down", label: "行 / 选区下移", def: "Ctrl+Shift+Down", scope: "editor" },
  // P4（C-3）：列选择开关（VS Code 同款默认键；开启后 Alt+Shift+方向键列向扩展始终可用）
  { id: "toggle_column_selection", label: "切换列选择模式", def: "Alt+Shift+Insert", scope: "editor" },
  // P4（C-4）：向右分屏（VS Code 同款 Ctrl+\；反斜杠按 SYMBOL_KEYS 字面写法，同 "/" 的先例）
  { id: "split_editor", label: "向右分屏", def: "Ctrl+\\", scope: "editor" },
  // PR-A（dx_features_backlog §6.1）：键位补齐组。键位解析器不支持和弦，折叠组不取 VS Code 的
  // Ctrl+K Ctrl+0/J，取单和弦 Ctrl+Shift+- / =（Monaco/浏览器无内建冲突）
  // Ctrl+Y 覆盖 Monaco/Windows 的「重做」内建——重做仍可走 Ctrl+Shift+Z（同 Ctrl+D 覆盖「选中下一匹配」先例）
  { id: "delete_line", label: "删除行", def: "Ctrl+Y", scope: "editor" },
  { id: "fold_all", label: "折叠全部", def: "Ctrl+Shift+-", scope: "editor" },
  { id: "unfold_all", label: "展开全部", def: "Ctrl+Shift+=", scope: "editor" },
  // Monaco 内建同键（jumpToBracket）；登记进键位表使其可配置可发现
  { id: "jump_to_bracket", label: "括号匹配跳转", def: "Ctrl+Shift+\\", scope: "editor" },
  // 重开关闭的标签：Ctrl+Shift+T 已被 open_devtools 占用，故取 Ctrl+Shift+Alt+T（window 级，tabReopen.ts）
  { id: "reopen_tab", label: "重新打开关闭的标签", def: "Ctrl+Shift+Alt+T", scope: "window" },
  // PR-D：最近编辑位置（PyCharm Ctrl+Shift+Backspace 同款；window 级，editPoints.ts；
  // Backspace 在 NAMED_KEYS 内可解析，browserKeys DANGER 清单只含 Ctrl+Shift+Delete 不冲突）
  { id: "recent_edit_locations", label: "上一个编辑位置", def: "Ctrl+Shift+Backspace", scope: "window" },
  // PR-G：文件内符号 Quick Pick（PyCharm Ctrl+F12 同款；editor 级——符号列表依附编辑器上下文。
  // handler 在 main.ts（避免 keybindings.ts 反向依赖 quickOpen 成环），命令面板/前往菜单同走该 handler）
  { id: "goto_symbol", label: "转到文件内符号", def: "Ctrl+F12", scope: "editor" },
  // PR-J：触发补全建议（Alt+/，editor 级）——Ctrl+Space 被中文 IME 吞键（人工验证），此为可配置保底；
  // handler 在 keybindings.ts（纯 app.editor.trigger，无循环依赖），命令面板同走该 handler
  { id: "trigger_suggest", label: "触发补全建议", def: "Alt+/", scope: "editor" },
  // 库特别支持 PR-2：正则测试器（editor 级）
  { id: "open_regex_tester", label: "在正则测试器中打开", def: "Ctrl+Alt+R", scope: "editor" },
  // 诊断导航（PyCharm 同款 F8 / Shift+F8）：下一个 / 上一个错误（error+warning 序列，循环回绕）
  { id: "goto_next_problem", label: "下一个问题", def: "F8", scope: "editor" },
  { id: "goto_prev_problem", label: "上一个问题", def: "Shift+F8", scope: "editor" },
  // 问题面板（PyCharm Problems View 同款 Alt+0；window 级——面板打开不依赖编辑器聚焦）
  { id: "open_problems", label: "打开问题面板", def: "Alt+0", scope: "window" },
];

// ---------- UI-32：快捷键的功能分组（设置面板按组渲染）----------
// 60 项平铺成一列时看不出层次，按功能切六组。分组不写进 KeybindingMeta 数组（那是出厂键位真源，
// 改动面太大且会牵动 Rust 侧同步义务），改用独立映射表：Record<KeybindingId, …> 覆盖全集，
// 新增键位若漏标分组会编译期报错，不存在「悄悄归到未分组」的情况。

export type KeybindingGroup = "file" | "edit" | "navigate" | "run" | "debug" | "view";

/** 分组顺序 = 面板里的渲染顺序 */
export const KEYBINDING_GROUP_ORDER: KeybindingGroup[] = ["file", "edit", "navigate", "run", "debug", "view"];

export const KEYBINDING_GROUP: Record<KeybindingId, KeybindingGroup> = {
  // 文件
  save: "file",
  new_file: "file",
  close_tab: "file",
  reopen_tab: "file",
  scratch_new: "file",
  recent_files: "file",
  // 编辑
  duplicate_line: "edit",
  comment_line: "edit",
  comment_block: "edit",
  template_palette: "edit",
  surround: "edit",
  optimize_imports: "edit",
  smart_select_expand: "edit",
  smart_select_shrink: "edit",
  move_line_up: "edit",
  move_line_down: "edit",
  toggle_column_selection: "edit",
  delete_line: "edit",
  fold_all: "edit",
  unfold_all: "edit",
  jump_to_bracket: "edit",
  trigger_suggest: "edit",
  open_regex_tester: "edit",
  // 导航与搜索
  goto_definition: "navigate",
  find_usages: "navigate",
  rename_symbol: "navigate",
  goto_file: "navigate",
  goto_line: "navigate",
  goto_symbol: "navigate",
  nav_back: "navigate",
  nav_forward: "navigate",
  local_history: "navigate",
  recent_edit_locations: "navigate",
  global_search: "navigate",
  bookmark_toggle: "navigate",
  bookmark_list: "navigate",
  goto_next_problem: "navigate",
  goto_prev_problem: "navigate",
  open_problems: "navigate",
  // 运行
  run_script: "run",
  run_project: "run",
  stop: "run",
  run_selection: "run",
  run_history: "run",
  // 调试
  debug: "debug",
  debug_stop: "debug",
  debug_step_over: "debug",
  debug_step_into: "debug",
  debug_step_out: "debug",
  debug_evaluate: "debug",
  debug_run_to_cursor: "debug",
  // 视图与面板
  next_tab: "view",
  prev_tab: "view",
  split_editor: "view",
  toggle_sidebar: "view",
  toggle_bottom: "view",
  command_palette: "view",
  open_devtools: "view",
  open_settings: "view",
  markdown_preview: "view",
};

/** 分组内按键位在 KEYBINDING_META 中的原始顺序取项（分组只归类、不改出厂顺序） */
export function keybindingsOfGroup(group: KeybindingGroup): KeybindingMeta[] {
  return KEYBINDING_META.filter((m) => KEYBINDING_GROUP[m.id] === group);
}