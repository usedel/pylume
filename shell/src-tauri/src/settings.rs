// 全局设置（P25-T08/T09）：<data_root>/config/settings.json。
// 读取链：settings.json → 前端内存 → Monaco/editor.updateOptions。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;

use crate::util::pylume_home;

/// 默认快捷键（PyCharm 风格）：id 语义与前端 keybindings.ts 的 KEYBINDING_META 保持一致，
/// 新增/改键需同步三处（此处 + state.ts DEFAULT_SETTINGS + keybindings.ts META）。
fn default_keybindings() -> HashMap<String, String> {
    let mut m = HashMap::new();
    m.insert("save".into(), "Ctrl+S".into());
    // v3.4 §17-7（M3-3.5）：run 拆为 run_script + run_project（三处同步）
    m.insert("run_script".into(), "Ctrl+F10".into());
    m.insert("run_project".into(), "Ctrl+Shift+F10".into());
    m.insert("stop".into(), "Ctrl+F2".into());
    m.insert("run_selection".into(), "Alt+Shift+E".into());
    m.insert("global_search".into(), "Ctrl+Shift+F".into());
    m.insert("goto_definition".into(), "Ctrl+B".into());
    m.insert("duplicate_line".into(), "Ctrl+D".into());
    m.insert("comment_line".into(), "Ctrl+/".into());
    m.insert("comment_block".into(), "Ctrl+Shift+/".into());
    m.insert("template_palette".into(), "Ctrl+J".into());
    m.insert("surround".into(), "Ctrl+Alt+T".into());
    // P0（PyCharm 调研）：Optimize Imports / 最近文件（与前端 KEYBINDING_META / DEFAULT_SETTINGS 三处同步）
    m.insert("optimize_imports".into(), "Ctrl+Alt+O".into());
    m.insert("recent_files".into(), "Ctrl+E".into());
    // P1（PyCharm 调研）：转到文件 / 转到行 / 导航后退前进 / 本地历史
    //（与前端 KEYBINDING_META / DEFAULT_SETTINGS 三处同步）
    m.insert("goto_file".into(), "Ctrl+Shift+N".into());
    m.insert("goto_line".into(), "Ctrl+G".into());
    m.insert("nav_back".into(), "Ctrl+Alt+Left".into());
    m.insert("nav_forward".into(), "Ctrl+Alt+Right".into());
    m.insert("local_history".into(), "Ctrl+Shift+H".into());
    // 调试五件套（debug dev plan §6.6；与前端 KEYBINDING_META / DEFAULT_SETTINGS 三处同步）
    m.insert("debug".into(), "F5".into());
    m.insert("debug_stop".into(), "Shift+F5".into());
    m.insert("debug_step_over".into(), "F10".into());
    m.insert("debug_step_into".into(), "F11".into());
    m.insert("debug_step_out".into(), "Shift+F11".into());
    // P1：断点处求值表达式（与前端 KEYBINDING_META / DEFAULT_SETTINGS 三处同步）
    m.insert("debug_evaluate".into(), "Alt+F8".into());
    // P2：调试打磨组 + 书签 / 草稿 / 运行历史
    m.insert("debug_run_to_cursor".into(), "Alt+F9".into());
    m.insert("bookmark_toggle".into(), "Ctrl+F11".into());
    m.insert("bookmark_list".into(), "Ctrl+Shift+F11".into());
    m.insert("scratch_new".into(), "Ctrl+Alt+Shift+Insert".into());
    m.insert("run_history".into(), "Ctrl+Shift+R".into());
    // Markdown 预览开关（markdown preview dev plan §5-T4；与前端 KEYBINDING_META / DEFAULT_SETTINGS 三处同步）
    m.insert("markdown_preview".into(), "Ctrl+Shift+V".into());
    // P1（UX 审查）：高频操作补键位（与前端 KEYBINDING_META / DEFAULT_SETTINGS 三处同步）
    m.insert("close_tab".into(), "Ctrl+F4".into());
    // 标签页循环切换（VS Code 同款；与前端 KEYBINDING_META / DEFAULT_SETTINGS 三处同步）
    m.insert("next_tab".into(), "Ctrl+Tab".into());
    m.insert("prev_tab".into(), "Ctrl+Shift+Tab".into());
    m.insert("new_file".into(), "Ctrl+Alt+Insert".into());
    m.insert("open_settings".into(), "Ctrl+Alt+S".into());
    m.insert("toggle_sidebar".into(), "Ctrl+Shift+F12".into());
    m.insert("toggle_bottom".into(), "Alt+F12".into());
    // 命令面板直达（VS Code 同款；与前端 KEYBINDING_META / DEFAULT_SETTINGS 三处同步）
    m.insert("command_palette".into(), "Ctrl+Shift+P".into());
    // PR-1（plugin_system_design §9.9）：开发工具面板 + picker（与前端三处同步）
    m.insert("open_devtools".into(), "Ctrl+Shift+T".into());
    // P1（查找引用）：PyCharm 同款 Alt+F7，完整引用列表落底部「引用」面板（与前端三处同步）
    m.insert("find_usages".into(), "Alt+F7".into());
    // P2（重命名）：跨文件重命名（PyCharm Shift+F6 同款；F2 仍是单文件快捷）（与前端三处同步）
    m.insert("rename_symbol".into(), "Shift+F6".into());
    // P1（PyCharm 调研 C-1/C-2）：编辑器基本功（与前端 KEYBINDING_META / DEFAULT_SETTINGS 三处同步）。
    // 注：Ctrl+W / Ctrl+Shift+W 是浏览器危险键，由 browserKeys.ts 在编辑器内放行给 Monaco。
    m.insert("smart_select_expand".into(), "Ctrl+W".into());
    m.insert("smart_select_shrink".into(), "Ctrl+Shift+W".into());
    m.insert("move_line_up".into(), "Ctrl+Shift+Up".into());
    m.insert("move_line_down".into(), "Ctrl+Shift+Down".into());
    // P4（C-3）：列选择开关（与前端 KEYBINDING_META / DEFAULT_SETTINGS 三处同步）
    m.insert("toggle_column_selection".into(), "Alt+Shift+Insert".into());
    // P4（C-4）：向右分屏（与前端三处同步）
    m.insert("split_editor".into(), "Ctrl+\\".into());
    // PR-A（dx_features_backlog §6.1）：键位补齐组（与前端 KEYBINDING_META / DEFAULT_SETTINGS 三处同步）。
    // Ctrl+Y 覆盖 Monaco/Windows 的「重做」内建（重做仍可走 Ctrl+Shift+Z）；
    // reopen_tab 不取 Ctrl+Shift+T（已被 open_devtools 占用）
    m.insert("delete_line".into(), "Ctrl+Y".into());
    m.insert("fold_all".into(), "Ctrl+Shift+-".into());
    m.insert("unfold_all".into(), "Ctrl+Shift+=".into());
    m.insert("jump_to_bracket".into(), "Ctrl+Shift+\\".into());
    m.insert("reopen_tab".into(), "Ctrl+Shift+Alt+T".into());
    // PR-D（dx_features_backlog §6.4）：最近编辑位置（与前端 KEYBINDING_META / DEFAULT_SETTINGS 三处同步）
    m.insert("recent_edit_locations".into(), "Ctrl+Shift+Backspace".into());
    // PR-G（dx_features_backlog §6.6）：文件内符号 Quick Pick（PyCharm Ctrl+F12 同款）
    m.insert("goto_symbol".into(), "Ctrl+F12".into());
    // PR-J（dx_features_backlog §6.6）：触发补全建议备选键（Ctrl+Space 被中文 IME 吞键，人工验证）
    m.insert("trigger_suggest".into(), "Alt+/".into());
    // 库特别支持 PR-2（python_library_support_dev_plan §4.2）：正则测试器（editor 级）
    m.insert("open_regex_tester".into(), "Ctrl+Alt+R".into());
    // 诊断导航（PyCharm 同款 F8 / Shift+F8）：下一个 / 上一个错误（与前端 KEYBINDING_META 三处同步）
    m.insert("goto_next_problem".into(), "F8".into());
    m.insert("goto_prev_problem".into(), "Shift+F8".into());
    // 问题面板（PyCharm Problems View 同款 Alt+0；window 级）
    m.insert("open_problems".into(), "Alt+0".into());
    m
}

fn settings_path() -> std::path::PathBuf {
    pylume_home().join("config").join("settings.json")
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    /// 批 4：主题名 "pylume-dark" | "pylume-light"（自定义 Monaco 主题，见 src/theme/tokens.ts）。
    /// 存量 "vs-dark" / "vs" 由前端 loadSettings::migrateLegacyThemeSettings 迁移
    /// （只改内存不落盘，Rust 侧不重复实现同一条规则）。
    pub theme: String,
    /// 字号（Ctrl+滚轮 8-32）
    pub font_size: u32,
    /// 编辑器字体族（批 3 起默认 JetBrains Mono 随包栈；空串 = Monaco 内置默认）
    pub font_family: String,
    /// 连字（font ligatures，批 3 起出厂默认开）
    pub font_ligatures: bool,
    /// Tab 宽度（1-8）
    pub tab_size: u32,
    /// 用空格替换 Tab 缩进
    pub insert_spaces: bool,
    /// 自动换行："off" | "on"
    pub word_wrap: String,
    /// 迷你地图开关
    pub minimap: bool,
    /// 缩进参考线（C-6：长脚本可读性；含当前缩进层级高亮）
    pub indent_guides: bool,
    /// 括号彩色化（C-6：多层嵌套括号配对辨识）
    pub bracket_colors: bool,
    /// 粘性滚动（PR-B：长文件滚动时当前作用域头部常驻编辑器顶部；须与前端 sticky_scroll 同步）
    pub sticky_scroll: bool,
    /// 参数名行内提示（PR-N：调用处灰字 `name=`；须与前端 inlay_param_hints 同步）
    pub inlay_param_hints: bool,
    /// 保存时清理行尾空白（PR-C；仅显式保存触发，autosave/运行前跳过；须与前端同步）
    pub trim_trailing_whitespace: bool,
    /// 保存时确保文件以换行结束（PR-C；仅显式保存触发；须与前端同步）
    pub final_newline: bool,
    /// 新建 .py/.pyw 文件后自动插 header 文件头模板（PR-K；默认关；须与前端 new_file_template 同步）
    pub new_file_template: bool,
    /// 粘贴 JSON 自动转 Python dict 字面量（PR-M；默认开，Ctrl+Z 可撤；须与前端同步）
    pub paste_json_to_python: bool,
    /// 调试「只步进我的代码」（B-3：不误入 site-packages；改动需重启调试会话生效）
    pub debug_just_my_code: bool,
    /// 自动保存："off" | "delay" | "blur"
    pub autosave: String,
    /// delay 模式的延迟毫秒
    pub autosave_delay: u64,
    /// 运行时探针开关（关闭时 run_script 不注入）
    pub probe_enabled: bool,
    /// LSP 引擎默认值："pyrefly" | "basedpyright"
    pub lsp_engine: String,
    /// 保存时用 ruff 格式化（Ctrl+S 联动）
    pub format_on_save: bool,
    /// 保存时用 ruff 整理导入（Ctrl+Alt+O 的保存联动，与 format_on_save 同模式）
    pub optimize_imports_on_save: bool,
    /// D-4：ruff 规则严重度映射——E（pycodestyle 风格）/ W（pycodestyle 警告）/
    /// F（pyflakes）三类规则的显示级别："hint" | "info" | "warning" | "error"
    /// （与前端字段逐一对应；非法值由前端归一化为 warning）
    pub ruff_severity_e: String,
    pub ruff_severity_w: String,
    pub ruff_severity_f: String,
    /// 运行时智能层（pylume-intel）开关——关闭时 LSP 桥不启动 intel（P3-T09）
    pub runtime_intel_enabled: bool,
    /// Pydantic 构造校验诊断与改名传播（阶段 4：pylume-pydantic 桶；须与前端同步）
    pub pydantic_diagnostics: bool,
    /// 零引擎静态关键字补全开关（无 LSP 引擎的语言；python 不受影响）
    pub keyword_completion: bool,
    /// 终端默认启动目录："workspace"（工作区根）| "file"（活动文件所在目录）
    pub terminal_cwd: String,
    /// 集成终端默认 shell："auto" | "pwsh" | "powershell" | "cmd"
    /// （"auto" 按 pwsh → powershell → cmd 依次回退；Unix 忽略该项用 $SHELL）
    pub terminal_shell: String,
    /// PyPI 包源（uv 拉取依赖用；默认官方源，国内网络可在设置面板切镜像）
    pub pypi_index: String,
    /// 快捷键自定义（id → 键位串如 "Ctrl+D"；空串 = 解绑）。
    /// 旧配置文件缺此字段时经 struct 级 #[serde(default)] 整体回落 default_keybindings；
    /// 部分键缺失（手改文件）由前端 loadSettings 逐项兜底。
    pub keybindings: HashMap<String, String>,
    /// 日志：总开关（关闭后仅 error 仍落盘）
    pub log_enabled: bool,
    /// 日志级别阈值："error" | "warn" | "info" | "debug"
    pub log_level: String,
    /// 日志轮转保留份数（1-10）
    pub log_keep: usize,
    /// 日志是否同时打印 stdout（dev 终端可见；release 无控制台可关）
    pub log_stdout: bool,
    /// 库特别支持：编辑器内工具 lens（关掉后入口降级到右键 + 命令面板；须与前端同步）
    pub libs_editor_lens: bool,
    /// 库特别支持：正则高亮/hover/诊断 + 测试器（须与前端同步）
    pub libs_regex: bool,
    /// 库特别支持：格式串 hover/诊断 + 工具（须与前端同步）
    pub libs_format: bool,
    /// 库特别支持：参数表单（关掉后运行面板不显示参数区；须与前端同步）
    pub libs_argparse: bool,
    /// 库特别支持：JSON 字面量注入（高亮/诊断；research §11.9，须与前端同步）
    pub libs_json_inject: bool,
    /// 输出面板日志级别着色与过滤（research §11.9，须与前端同步）
    pub log_level_colors: bool,
    /// B3：SQLite 结果每页行数（100/200/500/1000，须与前端同步）
    pub db_page_size: u32,
    /// B3：写语句执行前是否弹确认框（默认开；须与前端同步）
    pub db_warn_on_write: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            // 批 4：编辑器从出厂 vs-dark 切到自定义主题。色值真源仍是 style.css 的 token
            // （shell/src/theme/tokens.ts 只声明 Monaco 槽位 → CSS 变量的映射）。
            theme: "pylume-dark".into(),
            font_size: 14,
            // D3 P-14 起为常用等宽栈；批 3（ui_premium §5.3）起 JetBrains Mono 随包并排到首位，
            // 须与前端 DEFAULT_FONT_FAMILY / style.css --mono / index.html 字体族 preset 一致。
            // 存量 settings.json 的旧串由前端 loadSettings::migrateLegacyFontSettings 迁移
            //（只改内存不落盘，Rust 侧不重复实现同一条规则）。
            font_family: "\"JetBrains Mono\", \"Cascadia Code\", \"SF Mono\", Consolas, monospace".into(),
            // 批 3 起默认开：JetBrains Mono 的编程连字是它相对 Consolas 的核心卖点。
            font_ligatures: true,
            tab_size: 4,
            insert_spaces: true,
            word_wrap: "off".into(),
            minimap: false,
            // C-6（PyCharm 调研）：可读性默认开（与前端 DEFAULT_SETTINGS 保持一致）
            indent_guides: true,
            bracket_colors: true,
            sticky_scroll: true,
            inlay_param_hints: true,
            trim_trailing_whitespace: true,
            final_newline: true,
            // PR-K：默认关（避免污染草稿流；与前端 DEFAULT_SETTINGS 保持一致）
            new_file_template: false,
            // PR-M：默认开（Ctrl+Z 单步可撤；与前端 DEFAULT_SETTINGS 保持一致）
            paste_json_to_python: true,
            // B-3（PyCharm 调研）：只步进我的代码，默认开
            debug_just_my_code: true,
            // autosave 默认 delay 2s（须与前端 DEFAULT_SETTINGS 保持同步）
            autosave: "delay".into(),
            autosave_delay: 2000,
            probe_enabled: true,
            lsp_engine: "pyrefly".into(),
            format_on_save: false,
            optimize_imports_on_save: false,
            // D-4：默认全 Warning（维持映射引入前的行为，与前端 DEFAULT_SETTINGS 一致）
            ruff_severity_e: "warning".into(),
            ruff_severity_w: "warning".into(),
            ruff_severity_f: "warning".into(),
            runtime_intel_enabled: true,
            // 阶段 4：与前端 DEFAULT_SETTINGS.pydantic_diagnostics 保持同步
            pydantic_diagnostics: true,
            // 与前端 DEFAULT_SETTINGS.keyword_completion 保持同步
            keyword_completion: true,
            terminal_cwd: "workspace".into(),
            terminal_shell: "auto".into(),
            pypi_index: "https://pypi.org/simple".into(),
            keybindings: default_keybindings(),
            log_enabled: true,
            log_level: "info".into(),
            log_keep: 3,
            log_stdout: false,
            // 库特别支持 PR-2/PR-3/PR-4/P1（默认开，与前端 DEFAULT_SETTINGS 保持同步）
            libs_editor_lens: true,
            libs_regex: true,
            libs_format: true,
            libs_argparse: true,
            libs_json_inject: true,
            log_level_colors: true,
            // B3（SQLite 工具窗）：与前端 DEFAULT_SETTINGS.db_page_size 对齐；
            // 写前确认默认开——写库不可撤销，且「默认只读」是本功能的产品定位
            db_page_size: 200,
            db_warn_on_write: true,
        }
    }
}

/// 设置缓存（P2-1，2026-09-29 review）：logging 每条日志要读 3-4 次 settings
/// （enabled / effective_level / keep_count / stdout 开关），全量读盘 + JSON 反序列化
/// 在 LSP stderr 高频转发等场景被放大。以 (mtime, size) 失效——设置变更必然改写
/// 文件（set_settings / 前端保存），命中缓存即零 IO。读取失败回落默认（原语义）。
static SETTINGS_CACHE: std::sync::Mutex<Option<(Option<(std::time::SystemTime, u64)>, Settings)>> =
    std::sync::Mutex::new(None);

pub(crate) fn load() -> Settings {
    let p = settings_path();
    let stamp: Option<(std::time::SystemTime, u64)> = std::fs::metadata(&p)
        .and_then(|m| {
            let mt = m.modified().map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            Ok((mt, m.len()))
        })
        .ok();
    {
        let cache = crate::util::unpoison(SETTINGS_CACHE.lock());
        if let Some((cached_stamp, cached)) = cache.as_ref() {
            if *cached_stamp == stamp {
                return cached.clone();
            }
        }
    }
    let loaded = if stamp.is_none() && !p.is_file() {
        Settings::default()
    } else {
        fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_default()
    };
    let mut cache = crate::util::unpoison(SETTINGS_CACHE.lock());
    *cache = Some((stamp, loaded.clone()));
    loaded
}

/// 读取设置（文件不存在返回默认值；无效字段回落默认）
#[tauri::command]
pub fn get_settings() -> Result<Settings, String> {
    Ok(load())
}

/// 当前 `probe_enabled` 开关值（运行路径低频读取，直接落盘读 + 失败回落默认 true）。
/// §17-13：`terminal::run_in_terminal` 的 probe 注入由此控制；调试链路（dap.rs）
/// 恒 `probe=false`，不经此函数（§13.4）。
pub(crate) fn current_probe_enabled(_app: &tauri::AppHandle) -> bool {
    load().probe_enabled
}

/// 写入完整设置（写盘后主动失效缓存——NTFS mtime 粒度下「快速连写两次且大小相同」
/// 可能被 (mtime, size) 戳误判为未变，主动清缓存兜底；写失败保留旧缓存无害）。
#[tauri::command]
pub fn set_settings(settings: Settings) -> Result<(), String> {
    let p = settings_path();
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&p, json).map_err(|e| e.to_string())?;
    *crate::util::unpoison(SETTINGS_CACHE.lock()) = None;
    Ok(())
}

/// 读取设置文件的原始路径（供测试/诊断）
#[allow(dead_code)]
fn _settings_path_debug() -> std::path::PathBuf {
    settings_path()
}

/// 测试辅助：临时重定向 settings 路径不可行（path 固定），
/// 这里验证序列化往返与默认值。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_defaults() {
        let d = Settings::default();
        assert_eq!(d.theme, "pylume-dark");
        assert_eq!(d.font_size, 14);
        assert_eq!(d.font_family, "\"JetBrains Mono\", \"Cascadia Code\", \"SF Mono\", Consolas, monospace");
        assert_eq!(d.font_ligatures, true);
        assert_eq!(d.tab_size, 4);
        assert_eq!(d.insert_spaces, true);
        assert_eq!(d.word_wrap, "off");
        assert_eq!(d.minimap, false);
        // C-6（PyCharm 调研）：可读性默认开
        assert_eq!(d.indent_guides, true);
        assert_eq!(d.bracket_colors, true);
        // B-3（PyCharm 调研）：只步进我的代码，默认开
        assert_eq!(d.debug_just_my_code, true);
        assert_eq!(d.autosave, "delay");
        assert_eq!(d.autosave_delay, 2000);
        assert_eq!(d.probe_enabled, true);
        assert_eq!(d.lsp_engine, "pyrefly");
        assert_eq!(d.format_on_save, false);
        assert_eq!(d.runtime_intel_enabled, true);
        assert_eq!(d.keyword_completion, true);
        assert_eq!(d.terminal_cwd, "workspace");
        assert_eq!(d.terminal_shell, "auto");
        // 快捷键默认值（PyCharm 风格）
        assert_eq!(d.keybindings.get("save").map(String::as_str), Some("Ctrl+S"));
        // v3.4 §17-7（M3-3.5）：run 拆为 run_script + run_project
        assert_eq!(d.keybindings.get("run_script").map(String::as_str), Some("Ctrl+F10"));
        assert_eq!(d.keybindings.get("run_project").map(String::as_str), Some("Ctrl+Shift+F10"));
        assert_eq!(d.keybindings.get("duplicate_line").map(String::as_str), Some("Ctrl+D"));
        assert_eq!(d.keybindings.get("comment_line").map(String::as_str), Some("Ctrl+/"));
        assert_eq!(d.keybindings.get("comment_block").map(String::as_str), Some("Ctrl+Shift+/"));
        assert_eq!(d.keybindings.get("goto_definition").map(String::as_str), Some("Ctrl+B"));
        assert_eq!(d.keybindings.get("stop").map(String::as_str), Some("Ctrl+F2"));
        assert_eq!(d.keybindings.get("debug").map(String::as_str), Some("F5"));
        assert_eq!(d.keybindings.get("debug_stop").map(String::as_str), Some("Shift+F5"));
        assert_eq!(d.keybindings.get("debug_step_over").map(String::as_str), Some("F10"));
        assert_eq!(d.keybindings.get("debug_step_into").map(String::as_str), Some("F11"));
        assert_eq!(d.keybindings.get("debug_step_out").map(String::as_str), Some("Shift+F11"));
        assert_eq!(d.keybindings.get("markdown_preview").map(String::as_str), Some("Ctrl+Shift+V"));
        // P0（PyCharm 调研）：Optimize Imports / 最近文件
        assert_eq!(d.keybindings.get("optimize_imports").map(String::as_str), Some("Ctrl+Alt+O"));
        assert_eq!(d.keybindings.get("recent_files").map(String::as_str), Some("Ctrl+E"));
        // P1（PyCharm 调研）：Search Everywhere 三入口 + 导航历史 + 本地历史 + 求值
        assert_eq!(d.keybindings.get("goto_file").map(String::as_str), Some("Ctrl+Shift+N"));
        assert_eq!(d.keybindings.get("goto_line").map(String::as_str), Some("Ctrl+G"));
        assert_eq!(d.keybindings.get("nav_back").map(String::as_str), Some("Ctrl+Alt+Left"));
        assert_eq!(d.keybindings.get("nav_forward").map(String::as_str), Some("Ctrl+Alt+Right"));
        assert_eq!(d.keybindings.get("local_history").map(String::as_str), Some("Ctrl+Shift+H"));
        assert_eq!(d.keybindings.get("debug_evaluate").map(String::as_str), Some("Alt+F8"));
        // P2：Run to Cursor / 书签 / 草稿 / 运行历史
        assert_eq!(d.keybindings.get("debug_run_to_cursor").map(String::as_str), Some("Alt+F9"));
        assert_eq!(d.keybindings.get("bookmark_toggle").map(String::as_str), Some("Ctrl+F11"));
        assert_eq!(d.keybindings.get("scratch_new").map(String::as_str), Some("Ctrl+Alt+Shift+Insert"));
        // P1（UX 审查）：关闭标签 / 新建文件 / 打开设置 / 切换侧栏 / 切换底部面板
        assert_eq!(d.keybindings.get("close_tab").map(String::as_str), Some("Ctrl+F4"));
        // 标签页循环切换
        assert_eq!(d.keybindings.get("next_tab").map(String::as_str), Some("Ctrl+Tab"));
        assert_eq!(d.keybindings.get("prev_tab").map(String::as_str), Some("Ctrl+Shift+Tab"));
        assert_eq!(d.keybindings.get("new_file").map(String::as_str), Some("Ctrl+Alt+Insert"));
        assert_eq!(d.keybindings.get("open_settings").map(String::as_str), Some("Ctrl+Alt+S"));
        assert_eq!(d.keybindings.get("toggle_sidebar").map(String::as_str), Some("Ctrl+Shift+F12"));
        assert_eq!(d.keybindings.get("toggle_bottom").map(String::as_str), Some("Alt+F12"));
        // PR-1：开发工具面板
        assert_eq!(d.keybindings.get("open_devtools").map(String::as_str), Some("Ctrl+Shift+T"));
        // P1（PyCharm 调研 C-1/C-2）：智能选区 + 移动行
        assert_eq!(d.keybindings.get("smart_select_expand").map(String::as_str), Some("Ctrl+W"));
        assert_eq!(d.keybindings.get("smart_select_shrink").map(String::as_str), Some("Ctrl+Shift+W"));
        assert_eq!(d.keybindings.get("move_line_up").map(String::as_str), Some("Ctrl+Shift+Up"));
        assert_eq!(d.keybindings.get("move_line_down").map(String::as_str), Some("Ctrl+Shift+Down"));
        // P4（C-3）：列选择开关
        assert_eq!(d.keybindings.get("toggle_column_selection").map(String::as_str), Some("Alt+Shift+Insert"));
        // P4（C-4）：向右分屏
        assert_eq!(d.keybindings.get("split_editor").map(String::as_str), Some("Ctrl+\\"));
        // PR-A（dx_features_backlog §6.1）：键位补齐组
        assert_eq!(d.keybindings.get("delete_line").map(String::as_str), Some("Ctrl+Y"));
        assert_eq!(d.keybindings.get("fold_all").map(String::as_str), Some("Ctrl+Shift+-"));
        assert_eq!(d.keybindings.get("unfold_all").map(String::as_str), Some("Ctrl+Shift+="));
        assert_eq!(d.keybindings.get("jump_to_bracket").map(String::as_str), Some("Ctrl+Shift+\\"));
        assert_eq!(d.keybindings.get("reopen_tab").map(String::as_str), Some("Ctrl+Shift+Alt+T"));
        assert_eq!(d.keybindings.get("recent_edit_locations").map(String::as_str), Some("Ctrl+Shift+Backspace"));
        // PR-G（dx_features_backlog §6.6）：文件内符号 Quick Pick
        assert_eq!(d.keybindings.get("goto_symbol").map(String::as_str), Some("Ctrl+F12"));
        // PR-J（dx_features_backlog §6.6）：触发补全建议备选键（Ctrl+Space 被中文 IME 吞键，人工验证）
        assert_eq!(d.keybindings.get("trigger_suggest").map(String::as_str), Some("Alt+/"));
        // 诊断导航（PyCharm 同款 F8 / Shift+F8）：下一个 / 上一个错误
        assert_eq!(d.keybindings.get("goto_next_problem").map(String::as_str), Some("F8"));
        assert_eq!(d.keybindings.get("goto_prev_problem").map(String::as_str), Some("Shift+F8"));
        // 问题面板（PyCharm Problems View 同款 Alt+0）
        assert_eq!(d.keybindings.get("open_problems").map(String::as_str), Some("Alt+0"));
        // 键位表条目数 = 前端 KEYBINDING_META 条目数（漂移锁，新增键须同步改这里）
        assert_eq!(d.keybindings.len(), 60);
        assert_eq!(d.optimize_imports_on_save, false);
    }

    #[test]
    fn test_serde_roundtrip() {
        let s = Settings { font_size: 20, autosave: "delay".into(), format_on_save: true, ..Settings::default() };
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.font_size, 20);
        assert_eq!(back.autosave, "delay");
        assert_eq!(back.probe_enabled, true);
        assert_eq!(back.format_on_save, true);
    }

    #[test]
    fn test_partial_json_falls_back_to_default() {
        let json = r#"{"font_size":18}"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.font_size, 18);
        assert_eq!(s.theme, "pylume-dark"); // 未提供的字段走 default
        assert_eq!(s.probe_enabled, true);
        assert_eq!(s.format_on_save, false); // 旧配置文件无此字段 → 默认关闭
        assert_eq!(s.terminal_cwd, "workspace"); // 旧配置文件无此字段 → 默认工作区根
        assert_eq!(s.terminal_shell, "auto"); // 旧配置文件无此字段 → 默认自动回退
        assert_eq!(s.pypi_index, "https://pypi.org/simple"); // 旧配置文件无此字段 → 默认官方源
        // 编辑器新增项（P1）：旧配置文件无此字段 → 回落默认
        assert_eq!(s.tab_size, 4);
        assert_eq!(s.insert_spaces, true);
        assert_eq!(s.word_wrap, "off");
        assert_eq!(s.minimap, false);
        // 批 3 起连字出厂默认开，故「旧配置缺该字段」回落到 true 而非 false
        assert_eq!(s.font_ligatures, true);
        // C-6：旧配置文件无这两个字段 → 回落默认开
        assert_eq!(s.indent_guides, true);
        assert_eq!(s.bracket_colors, true);
        assert_eq!(s.debug_just_my_code, true);
        // 快捷键：旧配置文件无此字段 → 整体回落默认键位表
        assert_eq!(s.keybindings.get("duplicate_line").map(String::as_str), Some("Ctrl+D"));
        assert_eq!(s.keybindings.get("debug").map(String::as_str), Some("F5"));
        assert_eq!(s.keybindings.get("markdown_preview").map(String::as_str), Some("Ctrl+Shift+V"));
        assert_eq!(s.keybindings.get("optimize_imports").map(String::as_str), Some("Ctrl+Alt+O"));
        assert_eq!(s.keybindings.get("recent_files").map(String::as_str), Some("Ctrl+E"));
        // P1 新增键（旧配置无此字段 → 同样回落默认）
        assert_eq!(s.keybindings.get("goto_file").map(String::as_str), Some("Ctrl+Shift+N"));
        assert_eq!(s.keybindings.get("nav_back").map(String::as_str), Some("Ctrl+Alt+Left"));
        assert_eq!(s.keybindings.get("local_history").map(String::as_str), Some("Ctrl+Shift+H"));
        assert_eq!(s.keybindings.get("run_history").map(String::as_str), Some("Ctrl+Shift+R"));
        // v3.4 §17-7（M3-3.5）：run 拆分后旧配置无 run_script/run_project 字段 → 回落默认
        assert_eq!(s.keybindings.get("run_script").map(String::as_str), Some("Ctrl+F10"));
        assert_eq!(s.keybindings.get("run_project").map(String::as_str), Some("Ctrl+Shift+F10"));
        // PR-1：旧配置无 open_devtools → 回落默认
        assert_eq!(s.keybindings.get("open_devtools").map(String::as_str), Some("Ctrl+Shift+T"));
        // P1（PyCharm 调研 C-1/C-2）：旧配置无智能选区/移动行 → 回落默认
        assert_eq!(s.keybindings.get("smart_select_expand").map(String::as_str), Some("Ctrl+W"));
        assert_eq!(s.keybindings.get("move_line_down").map(String::as_str), Some("Ctrl+Shift+Down"));
        // PR-A：键位补齐组同步（与上方 default_keybindings 断言同批）
        assert_eq!(s.keybindings.get("delete_line").map(String::as_str), Some("Ctrl+Y"));
        // PR-J：触发补全建议备选键（与 default_keybindings 断言同批）
        assert_eq!(s.keybindings.get("trigger_suggest").map(String::as_str), Some("Alt+/"));
        // 库特别支持 PR-2：旧配置无正则测试器键位 → 回落默认
        assert_eq!(s.keybindings.get("open_regex_tester").map(String::as_str), Some("Ctrl+Alt+R"));
        // 诊断导航：旧配置无 F8 组 → 回落默认
        assert_eq!(s.keybindings.get("goto_next_problem").map(String::as_str), Some("F8"));
        assert_eq!(s.keybindings.get("goto_prev_problem").map(String::as_str), Some("Shift+F8"));
        assert_eq!(s.keybindings.len(), 60);
        assert_eq!(s.optimize_imports_on_save, false); // 旧配置文件无此字段 → 默认关闭
    }
}