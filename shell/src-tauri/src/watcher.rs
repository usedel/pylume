// 文件系统监听（File Watcher）：notify crate 监听工作区变更，推送事件到前端增量刷新。
// 设计要点：
// - 使用 notify-debouncer-mini 做 300ms 防抖，避免批量操作（如 git checkout）触发风暴；
// - 过滤 .git/.venv/node_modules 等噪声目录；
// - 前端收到事件后只刷新受影响的目录（增量），不整树重载。

use notify_debouncer_mini::notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebouncedEvent, Debouncer};
use serde::Serialize;
use std::path::Path;
use std::sync::LazyLock;
use tauri::{AppHandle, Emitter};

use crate::per_window::PerWindow;
use crate::util::pylume_home;

/// dep 域失效信号（M2，docs/dep_health_dev_plan.md §4.4）：变更文件的相对路径 + 分层分类。
/// 与 `fs-changed`（只发父目录，服务树/git 增量刷新）分开——depHealth 需要**文件级**信息
/// 才能区分「代码层 .py」与「声明层 pyproject/requirements/uv.lock」，进而决定重算范围。
#[derive(Clone, Serialize)]
pub struct DepFileEvent {
    /// 相对工作区根的路径（正斜杠）
    pub path: String,
    /// "py"（代码层）/ "declaration"（声明层）；"other" 不发（无 dep 意义，减噪）
    pub kind: String,
}

/// 忽略的目录名（与 fs_cmds::read_dir 的 IGNORED 保持一致）
const WATCH_IGNORED: [&str; 6] = [".git", ".venv", "node_modules", "__pycache__", ".idea", ".vscode"];

/// 忽略的文件名前缀（CR-05：选区运行临时文件，写删都不触发树刷新/Git 幽灵变更）
const WATCH_IGNORED_PREFIXES: [&str; 1] = ["__pylume_selection__"];

/// 全局 watcher 实例（同一时刻只监听一个工作区）
static WATCHER: LazyLock<PerWindow<Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>>> = LazyLock::new(PerWindow::new);

/// 目录名是否在监听忽略清单（dep_health_dev_plan §4.1：依赖探针的 .py 遍历复用同一口径，
/// 剔除 .venv/.git 等，避免把虚拟环境内容扫进代码层）
pub(crate) fn is_ignored_dir_name(name: &str) -> bool {
    WATCH_IGNORED.contains(&name)
}

/// 文件名是否命中忽略前缀（选区运行临时文件，依赖探针同样跳过）
pub(crate) fn is_ignored_file_prefix(name: &str) -> bool {
    WATCH_IGNORED_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// 判断路径是否应被忽略（任一层级命中忽略目录或忽略文件名前缀即跳过）
fn should_ignore(path: &Path) -> bool {
    if path.components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        WATCH_IGNORED.contains(&name.as_ref())
    }) {
        return true;
    }
    path.file_name()
        .map(|n| {
            let name = n.to_string_lossy();
            WATCH_IGNORED_PREFIXES.iter().any(|p| name.starts_with(p))
        })
        .unwrap_or(false)
}

/// 变更文件相对工作区根的路径（正斜杠，dep 域 file 键口径）；不在根下或为空返回 None
fn relative_to_root(path: &Path, root: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let s = rel.to_string_lossy().replace('\\', "/");
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// dep 域文件分类（§4.4 失效矩阵）：py = 代码层 / declaration = 声明层 / other = 无关。
/// 声明层判据与 detect_style 同源：pyproject.toml / uv.lock / requirements*.txt。
fn classify_dep_file(rel: &str) -> &'static str {
    let lower = rel.to_lowercase();
    if lower.ends_with(".py") {
        return "py";
    }
    let name = lower.rsplit('/').next().unwrap_or(lower.as_str());
    if name == "pyproject.toml"
        || name == "uv.lock"
        || (name.starts_with("requirements") && name.ends_with(".txt"))
    {
        return "declaration";
    }
    "other"
}

/// site-packages 环境信号判定（§4.4：`.venv` 例外放行，仅 `RECORD` / `*.dist-info` 触发，
/// 滤掉 `.pyc` 等噪声写——.pyc 落在包目录的 `__pycache__` 下，不含 dist-info 组件也非 RECORD）。
/// 判据：路径含 `site-packages` 组件，且其后存在 `*.dist-info` 组件或文件名为 `RECORD`。
fn is_site_packages_signal(path: &Path) -> bool {
    let comps: Vec<String> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    let Some(sp_idx) = comps.iter().position(|c| c.as_str() == "site-packages") else {
        return false;
    };
    let has_dist_info = comps[sp_idx + 1..].iter().any(|c| c.ends_with(".dist-info"));
    let is_record = path.file_name().and_then(|n| n.to_str()).map(|n| n == "RECORD").unwrap_or(false);
    has_dist_info || is_record
}

/// 启动文件监听（停止旧监听 → 新建 debouncer → 监听工作区根目录）
#[tauri::command]
pub fn watch_start(app: AppHandle, window: tauri::WebviewWindow, root: String) -> Result<(), String> {
    let wid = window.label().to_string();
    // 先停止本窗口旧监听
    watch_stop_impl(&wid);

    let root_path = Path::new(&root).to_path_buf();
    let app_handle = app.clone();
    let wid_cb = wid.clone();
    let root_for_cb = root_path.clone();

    let mut debouncer = new_debouncer(
        std::time::Duration::from_millis(300),
        move |res: Result<Vec<DebouncedEvent>, notify_debouncer_mini::notify::Error>| {
            let events = match res {
                Ok(evts) => evts,
                Err(_) => return,
            };
            // 收集受影响的目录（去重）
            let mut dirs: Vec<String> = Vec::new();
            // dep 域失效信号（M2 §4.4）：文件级分类 + site-packages 环境信号
            let mut dep_files: Vec<DepFileEvent> = Vec::new();
            let mut env_changed = false;
            for ev in &events {
                // site-packages 例外（`.venv` 其余维持忽略）：仅 RECORD / *.dist-info 触发环境信号，
                // 必须先于 should_ignore（.venv 整棵被忽略，否则 site-packages 事件永不可见）
                if is_site_packages_signal(&ev.path) {
                    env_changed = true;
                    continue;
                }
                if should_ignore(&ev.path) {
                    continue;
                }
                // 取变更路径的父目录（文件变更 → 刷新其所在目录）
                let dir = if ev.path.is_dir() {
                    ev.path.clone()
                } else {
                    ev.path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| ev.path.clone())
                };
                let dir_str = dir.to_string_lossy().to_string();
                if !dirs.contains(&dir_str) {
                    dirs.push(dir_str);
                }
                // dep-fs-changed：仅对 .py / 声明文件发（other 无 dep 意义，减噪；按 path 去重）
                if let Some(rel) = relative_to_root(&ev.path, &root_for_cb) {
                    let kind = classify_dep_file(&rel);
                    if kind != "other" && !dep_files.iter().any(|f| f.path == rel) {
                        dep_files.push(DepFileEvent { path: rel, kind: kind.to_string() });
                    }
                }
            }
            if !dirs.is_empty() {
                let _ = app_handle.emit_to(&wid_cb, "fs-changed", dirs);
            }
            if !dep_files.is_empty() {
                let _ = app_handle.emit_to(&wid_cb, "dep-fs-changed", dep_files);
            }
            if env_changed {
                let _ = app_handle.emit_to(&wid_cb, "dep-env-changed", true);
            }
        },
    )
    .map_err(|e| format!("创建文件监听器失败：{e}"))?;

    debouncer
        .watcher()
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| format!("监听目录失败：{e}"))?;

    // 附加监听用户级 Live Templates 目录（M2 热重载）；目录不存在时静默跳过
    let lt_dir = pylume_home().join("config");
    if lt_dir.is_dir() {
        let _ = debouncer.watcher().watch(&lt_dir, RecursiveMode::NonRecursive);
    }

    WATCHER.insert(&wid, debouncer);
    Ok(())
}

/// 停止本窗口文件监听
#[tauri::command]
pub fn watch_stop(window: tauri::WebviewWindow) -> Result<(), String> {
    let wid = window.label().to_string();
    watch_stop_impl(&wid);
    Ok(())
}

pub(crate) fn watch_stop_impl(wid: &str) {
    WATCHER.remove(wid); // drop debouncer → 自动停止监听
}

/// CR-14：应用退出清理——停止全部窗口的文件监听。
pub(crate) fn watch_stop_all_for_exit() {
    WATCHER.drain_all(); // drop 全部 debouncer → 自动停止监听
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CR-05：选区运行临时文件（随机后缀）与忽略目录都不得触发树刷新。
    #[test]
    fn test_should_ignore_selection_temp_and_noise_dirs() {
        // 选区临时文件：任意随机后缀都被前缀规则忽略
        assert!(should_ignore(Path::new(
            r"C:\ws\proj\__pylume_selection__lx2k-a1b2c3.py"
        )));
        assert!(should_ignore(Path::new(
            r"C:\ws\proj\pkg\__pylume_selection__9f8e7d-x0y9.py"
        )));
        // 噪声目录：任一层级命中即忽略
        assert!(should_ignore(Path::new(r"C:\ws\proj\.git\HEAD")));
        assert!(should_ignore(Path::new(r"C:\ws\proj\.venv\Scripts\python.exe")));
        assert!(should_ignore(Path::new(r"C:\ws\proj\sub\node_modules\x.js")));
        // 正常项目文件：不忽略
        assert!(!should_ignore(Path::new(r"C:\ws\proj\main.py")));
        assert!(!should_ignore(Path::new(r"C:\ws\proj\pkg\util.py")));
        // 前缀相似但不同的文件：不忽略（避免误伤用户以 __pylume 开头的文件）
        assert!(!should_ignore(Path::new(r"C:\ws\proj\__pylume_config__.py")));
    }

    /// M2 §4.4：dep 域文件分类——py=代码层 / declaration=声明层 / other 不发。
    #[test]
    fn test_classify_dep_file() {
        assert_eq!(classify_dep_file("main.py"), "py");
        assert_eq!(classify_dep_file("src/pkg/util.py"), "py");
        assert_eq!(classify_dep_file("pyproject.toml"), "declaration");
        assert_eq!(classify_dep_file("uv.lock"), "declaration");
        assert_eq!(classify_dep_file("requirements.txt"), "declaration");
        assert_eq!(classify_dep_file("requirements-dev.txt"), "declaration");
        assert_eq!(classify_dep_file("subdir/pyproject.toml"), "declaration");
        // 无关文件：other（不发 dep-fs-changed）
        assert_eq!(classify_dep_file("README.md"), "other");
        assert_eq!(classify_dep_file("src/app.ts"), "other");
        assert_eq!(classify_dep_file(".venv/pyvenv.cfg"), "other");
        // 大小写不敏感（Windows）
        assert_eq!(classify_dep_file("Main.PY"), "py");
        assert_eq!(classify_dep_file("PyProject.Toml"), "declaration");
    }

    /// M2 §4.4：site-packages 例外——仅 RECORD / *.dist-info 触发环境信号，.pyc 等噪声不触发。
    #[test]
    fn test_site_packages_signal_filters_pyc_noise() {
        // 装/卸包写 dist-info 与 RECORD → 触发
        assert!(is_site_packages_signal(Path::new(
            "C:/ws/.venv/Lib/site-packages/foo-1.0.dist-info/RECORD"
        )));
        assert!(is_site_packages_signal(Path::new(
            "C:/ws/.venv/Lib/site-packages/foo-1.0.dist-info/METADATA"
        )));
        assert!(is_site_packages_signal(Path::new(
            "C:/ws/.venv/lib/python3.13/site-packages/bar-2.0.dist-info"
        )));
        // .pyc 生成（__pycache__）→ 不触发（误报控制，§9.2）
        assert!(!is_site_packages_signal(Path::new(
            "C:/ws/.venv/Lib/site-packages/foo/__pycache__/bar.cpython-313.pyc"
        )));
        // 包内普通 .py / 其它文件 → 不触发（dist-info 才是装/卸的强信号）
        assert!(!is_site_packages_signal(Path::new(
            "C:/ws/.venv/Lib/site-packages/foo/__init__.py"
        )));
        // 非 site-packages 路径 → 不触发
        assert!(!is_site_packages_signal(Path::new("C:/ws/src/main.py")));
        assert!(!is_site_packages_signal(Path::new("C:/ws/.venv/Scripts/python.exe")));
    }

    /// M2：变更文件相对工作区根的路径（正斜杠）；不在根下返回 None。
    #[test]
    fn test_relative_to_root() {
        let root = Path::new("C:/ws/proj");
        assert_eq!(
            relative_to_root(Path::new("C:/ws/proj/src/main.py"), root).as_deref(),
            Some("src/main.py")
        );
        assert_eq!(
            relative_to_root(Path::new("C:/ws/proj/pyproject.toml"), root).as_deref(),
            Some("pyproject.toml")
        );
        // 根自身 / 不在根下 → None
        assert_eq!(relative_to_root(Path::new("C:/ws/proj"), root), None);
        assert_eq!(relative_to_root(Path::new("C:/other/x.py"), root), None);
    }
}
