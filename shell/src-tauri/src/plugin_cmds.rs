// 插件域命令（PR-2，plugin_system_design §9.5）：开发工具插件的发现与读取。
// v1 仅扫全局目录 <data_root>/extensions/<plugin-id>/pylume.plugin.json。
//
// 设计边界（§9.15）：
// - 本模块只做「列出 + 读文件 + 监听变更」三件事，不做校验/解析业务——
//   manifest 校验、权限判断、动态 import 全在前端 extensions/loader.ts（单测友好）；
// - 目录监听不承诺细粒度事件语义（Windows 原子写不可靠），前端收到事件后
//   自行去抖 + 全量 diff（见 loader.ts 的 debounceDiff），「重新扫描」按钮兜底。

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

use crate::util::pylume_home;

/// 全局插件目录：<data_root>/extensions（v1 唯一扫描根，决策点 #7）
pub fn extensions_dir() -> PathBuf {
    pylume_home().join("extensions")
}

/// 一个插件的磁盘信息（manifest 内容由前端读取解析，这里只透传路径）
#[derive(Clone, Serialize)]
pub struct PluginDirEntry {
    /// 插件目录名（约定 = plugin id，如 "com.example.my-tools"）
    pub dir_name: String,
    /// 插件目录绝对路径（跨平台分隔符原样）
    pub dir_path: String,
}

/// 扫描插件目录：列出 <data_root>/extensions 下所有含 pylume.plugin.json 的一级子目录。
/// 目录不存在返回空列表（首启无任何插件是正常态）；非目录条目静默跳过。
#[tauri::command]
pub fn list_plugin_dirs() -> Result<Vec<PluginDirEntry>, String> {
    let root = extensions_dir();
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&root).map_err(|e| e.to_string())?;
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        if !p.join("pylume.plugin.json").is_file() {
            continue;
        }
        let dir_name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if dir_name.is_empty() {
            continue;
        }
        out.push(PluginDirEntry {
            dir_name,
            dir_path: p.to_string_lossy().to_string(),
        });
    }
    // 排序保证扫描结果稳定（前端展示与 diff 均受益）
    out.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    Ok(out)
}

// ---------- P0 DX：路径查询 + 脚手架落盘 ----------

/// 插件目录的真实绝对路径（设置页展示用——此前前端写死 "~/.pylume/extensions"，
/// Windows 实际是 %LOCALAPPDATA%\Pylume\extensions，提示与事实不符）。
#[tauri::command]
pub fn get_plugins_dir() -> String {
    extensions_dir().to_string_lossy().to_string()
}

/// 数据根 docs/ 下的文档路径（「作者指南」落盘点——写此目录 + openFile 触发 .md 预览）。
/// 只允许文件名（禁路径分隔符，防越界写）。
#[tauri::command]
pub fn get_data_doc_path(name: &str) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("文档名不合法：{name}"));
    }
    let dir = pylume_home().join("docs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name).to_string_lossy().to_string())
}

/// 插件 id 合法性（与前端 manifest 校验器同口径：字母数字开头，可含点/下划线/连字符）。
/// pub(crate)：plugin_pkg 的导入校验复用同一口径。
pub(crate) fn valid_plugin_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// 脚手架模板类型（P1 DX：三模板，前端单选）
#[derive(Clone, Copy, PartialEq)]
pub enum ScaffoldTemplate {
    /// 面板工具（kit 全演示）
    Panel,
    /// 纯 inline 变换（无 mount）
    Inline,
    /// 空白起步
    Blank,
}

impl ScaffoldTemplate {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "panel" => Some(Self::Panel),
            "inline" => Some(Self::Inline),
            "blank" => Some(Self::Blank),
            _ => None,
        }
    }

    /// 模板 entry 内容（编译期内嵌，运行时零资源依赖）
    fn entry_src(self) -> &'static str {
        match self {
            Self::Panel => include_str!("../templates/entry-panel.js"),
            Self::Inline => include_str!("../templates/entry-inline.js"),
            Self::Blank => include_str!("../templates/entry-blank.js"),
        }
    }

    /// entry 文件名（manifest entry 字段引用）
    fn entry_name(self) -> &'static str {
        "./hello.js"
    }
}

/// 脚手架 manifest（P1：按模板生成——inline 模板不声明 mount 需求，blank 禁用 inline 占位）。
/// name 经 serde_json 转义防注入（id 已由 valid_plugin_id 保证安全）。
fn manifest_template(id: &str, name: &str, tpl: ScaffoldTemplate) -> Result<String, String> {
    let name_json = serde_json::to_string(name).map_err(|e| e.to_string())?;
    // inline 声明：inline 模板启用；panel 模板也带（演示双模式）；blank 占位禁用
    let inline_decl = match tpl {
        ScaffoldTemplate::Blank => String::new(),
        _ => r#",
        "inline": { "label": "问候选区", "handler": "helloSelection" }"#.to_string(),
    };
    let title = match tpl {
        ScaffoldTemplate::Panel => "我的第一个工具",
        ScaffoldTemplate::Inline => "问候选区",
        ScaffoldTemplate::Blank => "我的工具",
    };
    let description = match tpl {
        ScaffoldTemplate::Panel => "脚手架生成的模板——改这个文件试试热重载",
        ScaffoldTemplate::Inline => "选中文本 → 命令面板「问候选区」→ 原地替换",
        ScaffoldTemplate::Blank => "空白模板——从这里开始",
    };
    let entry_field = ScaffoldTemplate::entry_name(tpl);
    Ok(format!(
        r#"{{"schemaVersion": 1,
  "id": "{id}",
  "name": {name_json},
  "version": "0.1.0",
  "engines": {{ "pylume": ">=0.1.0" }},
  "contributes": {{
    "tools": [
      {{
        "id": "hello",
        "title": "{title}",
        "description": "{description}",
        "category": "文本",
        "icon": "rocket",
        "entry": "{entry_field}"{inline_decl}
      }}
    ]
  }},
  "permissions": ["clipboard", "selection"]
}}
"#
    ))
}

/// 脚手架：在插件目录下创建模板插件（manifest + entry + 类型声明落盘，P1 三模板）。
/// 幂等保护：目标目录已存在时报错（不覆盖用户代码）；id 合法性双端校验（前端 + 此处）。
#[tauri::command]
pub fn scaffold_plugin(id: &str, name: &str, template: &str) -> Result<String, String> {
    if !valid_plugin_id(id) {
        return Err(format!("插件 id 不合法：{id}（须字母数字开头，可含点/下划线/连字符）"));
    }
    if name.trim().is_empty() {
        return Err("插件名称不能为空".into());
    }
    let Some(tpl) = ScaffoldTemplate::from_str(template) else {
        return Err(format!("未知模板：{template}（panel / inline / blank）"));
    };
    let root = extensions_dir().join(id);
    if root.exists() {
        return Err(format!("目录已存在：{}（不覆盖已有插件）", root.display()));
    }
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    let manifest = manifest_template(id, name, tpl)?;
    let entry = tpl.entry_src();
    let entry_file = ScaffoldTemplate::entry_name(tpl).trim_start_matches("./");

    std::fs::write(root.join("pylume.plugin.json"), manifest).map_err(|e| e.to_string())?;
    std::fs::write(root.join(entry_file), entry).map_err(|e| e.to_string())?;
    // P1：类型声明随脚手架落盘——entry 首行 // @ts-check 即获得 VS Code 补全
    std::fs::write(
        root.join("pylume-plugin.d.ts"),
        include_str!("../templates/pylume-plugin.d.ts"),
    )
    .map_err(|e| e.to_string())?;
    Ok(root.to_string_lossy().to_string())
}

/// 插件内文件绝对路径拼接（入口/资源读取的唯一通道；禁止前端拼接后直读，
/// 以便 v2 沙箱化时在这一层收口路径逃逸——entry 必须落在插件目录内）。
#[tauri::command]
pub fn read_plugin_file(plugin_dir: &str, rel: &str) -> Result<String, String> {
    let base = Path::new(plugin_dir);
    let rel_path = Path::new(rel);
    // 只允许相对路径；规范分隔符后必须仍落在 base 下（防 ../ 逃逸）
    if rel_path.is_absolute() {
        return Err("插件文件路径必须是相对路径".into());
    }
    // P2-5（2026-09-29 review）：显式拒绝 ParentDir 组件——原 `full.starts_with(base)`
    // 检查无效：`Path::new("/a/b").join("../evil")` 的组件序列 [/, a, b, .., evil]
    // 前缀仍匹配 base（starts_with 按组件逐段比较，`..` 作为普通组件参与比较），
    // 放行后经文件系统解析逃出 base。既有测试误通过只因目标文件不存在走了其他分支。
    if rel_path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("插件文件路径不允许包含 `..`".into());
    }
    let full = base.join(rel_path);
    if !full.starts_with(base) {
        return Err("插件文件路径越界".into());
    }
    if !full.is_file() {
        return Err(format!("插件文件不存在: {rel}"));
    }
    std::fs::read_to_string(&full).map_err(|e| e.to_string())
}

/// manifest 约定文件名（前端读 manifest 也走 read_plugin_file，保持单通道）
#[allow(dead_code)]
pub(crate) const MANIFEST_FILE: &str = "pylume.plugin.json";

// ---------- 目录监听（去抖由前端做，这里只发「目录变了」信号） ----------

/// 插件目录 watcher（进程内单实例；重扫时先停旧实例）
static PLUGIN_WATCHER: Mutex<Option<notify_debouncer_mini::Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>>> =
    Mutex::new(None);

/// 应用退出清理（P2-6）：释放插件目录 watcher（Drop 即 unwatch；进程退出虽会回收
/// OS 资源，但显式停掉避免退出瞬间还派发无接收方的事件回调）。
pub(crate) fn plugins_stop_watcher_for_exit() {
    let mut guard = crate::util::unpoison(PLUGIN_WATCHER.lock());
    *guard = None;
}

/// 开始监听插件目录变化：任何变更（增删改、递归）都向前端发 `plugins-dir-changed` 事件。
/// 目录不存在时先创建（用户手动建目录放插件是预期用法）；重复调用先停旧 watcher。
#[tauri::command]
pub fn watch_plugins_dir(app: AppHandle) -> Result<(), String> {
    use tauri::Emitter;

    let root = extensions_dir();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    let mut guard = crate::util::unpoison(PLUGIN_WATCHER.lock());
    *guard = None; // 停旧实例（Drop 即 unwatch）

    let mut debouncer = notify_debouncer_mini::new_debouncer(
        std::time::Duration::from_millis(500),
        move |_res: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify_debouncer_mini::notify::Error>| {
            // 只发「变了」信号；事件种类不可靠（Windows 原子写/删除语义），
            // 由前端全量 diff 决定重载哪些插件（§9.15）
            let _ = app.emit("plugins-dir-changed", ());
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&root, notify_debouncer_mini::notify::RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *guard = Some(debouncer);
    Ok(())
}

/// 停止监听（应用退出 / 测试清理用）
#[tauri::command]
pub fn unwatch_plugins_dir() -> Result<(), String> {
    let mut guard = crate::util::unpoison(PLUGIN_WATCHER.lock());
    *guard = None;
    Ok(())
}

/// 在系统文件管理器中打开插件目录（设置页「打开目录」按钮；复用 file_ops 的跨平台实现）
#[tauri::command]
pub fn reveal_plugins_dir() -> Result<(), String> {
    let root = extensions_dir();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    crate::file_ops::reveal_in_explorer(root.to_string_lossy().to_string())
}

// ---------- 插件日志落盘（§9.14 v1.1：跨重启诊断） ----------
//
// 设计：日志面板仍是内存环形 50 条（现状不变），落盘是**旁路**追加写——
// host.log 每条同步写 `<data_root>/logs/plugins/<plugin_id>.log`（一行一条）。
// 失败静默（诊断日志不得反噬主流程）；文件超上限时从头截断保尾部（环形语义的文件版）。

/// 单插件日志文件上限（字节；超限截掉头部保尾部——对齐内存环形 50 条的「保最近」语义）
const PLUGIN_LOG_MAX_BYTES: u64 = 64 * 1024;

/// 插件日志目录：<data_root>/logs/plugins
fn plugin_logs_dir() -> PathBuf {
    pylume_home().join("logs").join("plugins")
}

/// 追加一行插件日志（时间戳前缀由前端格式化后传入，这里只做纯追加）。
/// id 合法性走 valid_plugin_id（防路径逃逸：id 即文件名，白名单字符集最可靠的收口）。
#[tauri::command]
pub fn append_plugin_log(plugin_id: &str, line: &str) -> Result<(), String> {
    append_plugin_log_in(&plugin_logs_dir(), plugin_id, line)
}

/// append_plugin_log 的可测试实现（测试注入目录；P2-5 教训：helper 直接调真实逻辑）
fn append_plugin_log_in(root: &Path, plugin_id: &str, line: &str) -> Result<(), String> {
    if !valid_plugin_id(plugin_id) {
        return Err(format!("插件 id 不合法：{plugin_id}"));
    }
    // 行内容剥离换行（单行一条；多行 msg 由前端先 join）；纯空白不落盘
    let sanitized: String = line.chars().filter(|c| *c != '\n' && *c != '\r').collect();
    if sanitized.trim().is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let file = root.join(format!("{plugin_id}.log"));
    // 超限截断：保留尾部约一半，给后续追加留余量（避免每条都触发截断）
    if let Ok(meta) = std::fs::metadata(&file) {
        if meta.len() > PLUGIN_LOG_MAX_BYTES {
            truncate_keep_tail(&file, PLUGIN_LOG_MAX_BYTES / 2)?;
        }
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&file).map_err(|e| e.to_string())?;
    writeln!(f, "{sanitized}").map_err(|e| e.to_string())
}

/// 文件截断保尾部：读全文 → 从目标字节处对齐到行首（防半行）→ tmp 写回 → rename 覆盖。
fn truncate_keep_tail(path: &Path, keep_bytes: u64) -> Result<(), String> {
    let content = std::fs::read(path).map_err(|e| e.to_string())?;
    if content.len() as u64 <= keep_bytes {
        return Ok(());
    }
    let cut = (content.len() as u64 - keep_bytes) as usize;
    // 对齐到行首（找不到换行则从 cut 整段保留——宁可多留不可半行）
    let start = content[cut..]
        .iter()
        .position(|b| *b == b'\n')
        .map(|i| cut + i + 1)
        .unwrap_or(cut);
    let tmp = path.with_extension("log.tmp");
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&content[start..]).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_plugin_dirs_empty_when_missing() {
        // extensions 目录不存在 → 空列表（正常态，不是错误）
        // 注：用临时数据根隔离本机真实目录
        let dir = std::env::temp_dir().join("pylume-plugin-test-noexist");
        let _ = std::fs::remove_dir_all(&dir);
        let entries = list_plugin_dirs_in(&dir).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn list_plugin_dirs_finds_manifest_dirs_only() {
        let dir = std::env::temp_dir().join("pylume-plugin-test-scan");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("com.a.good").join("tools")).unwrap();
        std::fs::write(dir.join("com.a.good").join("pylume.plugin.json"), "{}").unwrap();
        std::fs::create_dir_all(dir.join("com.b.no-manifest")).unwrap();
        std::fs::create_dir_all(dir.join("com.c.good")).unwrap();
        std::fs::write(dir.join("com.c.good").join("pylume.plugin.json"), "{}").unwrap();
        std::fs::write(dir.join("stray-file.txt"), "x").unwrap(); // 非目录跳过

        let entries = list_plugin_dirs_in(&dir).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.dir_name.as_str()).collect();
        assert_eq!(names, vec!["com.a.good", "com.c.good"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn read_plugin_file_blocks_escape() {
        let dir = std::env::temp_dir().join("pylume-plugin-test-escape");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ok.js"), "export const x = 1;").unwrap();

        // 相对路径正常读
        let content = read_plugin_file_in(dir.to_str().unwrap(), "ok.js").unwrap();
        assert_eq!(content, "export const x = 1;");
        // 绝对路径拒绝
        assert!(read_plugin_file_in(dir.to_str().unwrap(), "C:/Windows/system32/config").is_err());
        // ../ 逃逸拒绝
        assert!(read_plugin_file_in(dir.to_str().unwrap(), "../evil.js").is_err());
        // P2-5 回归：逃逸目标真实存在时也必须拒绝——原 starts_with 检查放行该形态
        //（目标文件不存在时走「插件文件不存在」分支，掩盖了检查失效）。
        let parent = dir.parent().unwrap().to_path_buf();
        std::fs::write(parent.join("pylume-plugin-test-escape-secret.txt"), "secret").unwrap();
        let r = read_plugin_file_in(dir.to_str().unwrap(), "../pylume-plugin-test-escape-secret.txt");
        assert!(r.is_err(), "逃逸到真实存在的文件必须被拒绝");
        // 不存在报错
        assert!(read_plugin_file_in(dir.to_str().unwrap(), "nope.js").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_file(parent.join("pylume-plugin-test-escape-secret.txt")).unwrap();
    }

    #[test]
    fn valid_plugin_id_rules() {
        assert!(valid_plugin_id("com.example.my-tools"));
        assert!(valid_plugin_id("a"));
        assert!(valid_plugin_id("my_plugin-2"));
        // 首字符必须字母数字
        assert!(!valid_plugin_id(".hidden"));
        assert!(!valid_plugin_id("-x"));
        assert!(!valid_plugin_id(""));
        // 非法字符（空格 / 中文 / 路径分隔符）
        assert!(!valid_plugin_id("my plugin"));
        assert!(!valid_plugin_id("插件"));
        assert!(!valid_plugin_id("a/b"));
    }

    #[test]
    fn scaffold_manifest_is_valid_json_with_escaping() {
        // 核心不变量：manifest 是合法 JSON、id/name 正确回填、引号被转义
        let out = manifest_template("com.test.scaffold", "测试\"引号\"", ScaffoldTemplate::Panel).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["schemaVersion"], 1);
        assert_eq!(v["id"], "com.test.scaffold");
        assert_eq!(v["name"], "测试\"引号\"");
        assert_eq!(v["contributes"]["tools"][0]["entry"], "./hello.js");
        assert_eq!(v["contributes"]["tools"][0]["inline"]["handler"], "helloSelection");
    }

    #[test]
    fn scaffold_manifest_per_template() {
        // inline 模板：标题/描述不同，同样声明 inline
        let v: serde_json::Value =
            serde_json::from_str(&manifest_template("t.i", "n", ScaffoldTemplate::Inline).unwrap()).unwrap();
        assert_eq!(v["contributes"]["tools"][0]["title"], "问候选区");
        assert_eq!(v["contributes"]["tools"][0]["inline"]["label"], "问候选区");
        // blank 模板：无 inline 声明（占位禁用）
        let v2: serde_json::Value =
            serde_json::from_str(&manifest_template("t.b", "n", ScaffoldTemplate::Blank).unwrap()).unwrap();
        assert!(v2["contributes"]["tools"][0].get("inline").is_none());
        assert_eq!(v2["contributes"]["tools"][0]["description"], "空白模板——从这里开始");
    }

    #[test]
    fn scaffold_entry_sources_are_typed_and_exported() {
        // entry 模板不变量：@ts-check 头 + inline handler 导出（panel/inline 模板）
        assert!(ScaffoldTemplate::Panel.entry_src().starts_with("// @ts-check"));
        assert!(ScaffoldTemplate::Inline.entry_src().contains("export function helloSelection"));
        assert!(ScaffoldTemplate::Inline.entry_src().contains("host.log"));
        assert!(ScaffoldTemplate::Blank.entry_src().len() < 300); // 空白模板保持精简
    }

    // ---- 测试辅助：绕过固定 extensions_dir()，向指定目录发同样逻辑 ----

    fn list_plugin_dirs_in(root: &Path) -> Result<Vec<PluginDirEntry>, String> {
        if !root.is_dir() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for e in std::fs::read_dir(root).map_err(|e| e.to_string())?.flatten() {
            let p = e.path();
            if !p.is_dir() || !p.join("pylume.plugin.json").is_file() {
                continue;
            }
            let dir_name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if dir_name.is_empty() {
                continue;
            }
            out.push(PluginDirEntry { dir_name, dir_path: p.to_string_lossy().to_string() });
        }
        out.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
        Ok(out)
    }

    /// 直接调用真实实现（P2-5 教训：测试 helper 复刻实现会漂移——原 escape 测试
    /// 走的正是复刻版，与命令实现不同步导致防护失效未被察觉）。
    fn read_plugin_file_in(base: &str, rel: &str) -> Result<String, String> {
        read_plugin_file(base, rel)
    }

    // ---- 插件日志落盘（v1.1 §9.14） ----

    fn logs_root() -> PathBuf {
        std::env::temp_dir().join("pylume-plugin-log-test")
    }

    #[test]
    fn append_plugin_log_appends_lines() {
        let root = logs_root().join("append");
        let _ = std::fs::remove_dir_all(&root);
        append_plugin_log_in(&root, "com.example.tool", "12:00:01 激活").unwrap();
        append_plugin_log_in(&root, "com.example.tool", "12:00:02 权限拒绝: x").unwrap();
        let content = std::fs::read_to_string(root.join("com.example.tool.log")).unwrap();
        assert_eq!(content, "12:00:01 激活\n12:00:02 权限拒绝: x\n");
    }

    #[test]
    fn append_plugin_log_rejects_bad_id_and_strips_newlines() {
        let root = logs_root().join("reject");
        let _ = std::fs::remove_dir_all(&root);
        // 非法 id（路径逃逸载体）拒绝
        assert!(append_plugin_log_in(&root, "../evil", "x").is_err());
        assert!(append_plugin_log_in(&root, "a/b", "x").is_err());
        assert!(append_plugin_log_in(&root, "", "x").is_err());
        // 换行剥离（单行一条；防日志注入）
        append_plugin_log_in(&root, "ok.plugin", "line1\nline2\r\nline3").unwrap();
        let content = std::fs::read_to_string(root.join("ok.plugin.log")).unwrap();
        assert_eq!(content, "line1line2line3\n");
        // 空行不落盘
        append_plugin_log_in(&root, "ok.plugin", "  \n ").unwrap();
        let after = std::fs::read_to_string(root.join("ok.plugin.log")).unwrap();
        assert_eq!(after, "line1line2line3\n");
    }

    #[test]
    fn append_plugin_log_truncates_keeping_tail() {
        let root = logs_root().join("truncate");
        let _ = std::fs::remove_dir_all(&root);
        // 预置超限文件（模拟历史日志）：100 行 × 8 字节 ≈ 800 字节 > 上限一半场景
        let big: String = (0..100).map(|i| format!("L{:03}xxxx\n", i)).collect();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("big.plugin.log"), &big).unwrap();
        // 直接测截断函数：保尾部 256 字节 → 首行必须是完整行（非半行）
        truncate_keep_tail(&root.join("big.plugin.log"), 256).unwrap();
        let after = std::fs::read_to_string(root.join("big.plugin.log")).unwrap();
        assert!(after.starts_with("L"), "截断后首行须完整（以行首对齐），实际：{}", &after[..8.min(after.len())]);
        // 尾部保留（最后一行仍在）
        assert!(after.ends_with("L099xxxx\n"), "尾部最新行须保留");
        assert!(after.len() <= 260, "截断后不超过目标+一行余量，实际 {}", after.len());
        // tmp 残留清理（rename 覆盖后不留 .tmp）
        assert!(!root.join("big.plugin.log.tmp").exists());
    }
}
