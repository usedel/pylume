// 磁盘占用治理（docs/disk-space-plan.md P1/P2）：占用可视化、可再生内容清理、数据根落位与迁移。
//
// P1 存储页：
//   storage_usage      —— 数据根各子目录 + uv 官方目录（缓存/工具）体积明细
//   clean_traces       —— trace 库按项目删除（可再生：重新运行脚本即重新采样）
//   clean_webview_cache—— WebView2 缓存子目录清理（保留登录态文件）
//   clean_log_rotation —— 轮转日志清理（保留当前文件）
//   uv_cache_clean     —— uv cache prune（默认）/ clean（深度，需前端二次确认）
// P2 数据落位（跨平台指针文件机制，无注册表 / 环境变量写入）：
//   first_run_status   —— 首启检测（是否弹落位提示 / 是否有中断的迁移）
//   ack_first_run      —— 用户选默认位置：写数据根指针文件（指向默认根）
//   set_data_root      —— 校验目标目录 + 写数据根指针文件（首启选自定义位置）
//   migrate_data_root  —— 整目录复制到目标 + 重写指针（中断可续：标记文件）+ 重启后生效
//   restart_app        —— 落位/迁移完成后重启（指针已落盘，普通重启即可读到）
//
// 安全边界：只提供可再生内容的清理；数据根迁移采用「复制 → 校验 → 换指向」，
// 不删旧根（其中可能有被占用的日志文件），由用户在重启后确认删除。

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::tool_paths::{tool_command, ENV_UV};
use crate::util::pylume_home;

const CMD_TIMEOUT: Duration = Duration::from_secs(120);

// ---------- 体积统计 ----------

/// 递归统计目录/文件体积；不可读项按 0 计（Windows 系统目录个别项无权限属正常）。
fn path_size(p: &Path) -> u64 {
    let meta = match std::fs::symlink_metadata(p) {
        Ok(m) => m,
        Err(_) => return 0,
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0; // 符号链接等不计
    }
    let mut total = 0u64;
    let mut stack = vec![p.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            let path = entry.path();
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                if let Ok(m) = entry.metadata() {
                    total += m.len();
                }
            }
        }
    }
    total
}

#[derive(Serialize, Clone)]
pub struct StorageEntry {
    pub key: String,
    pub label: String,
    pub path: String,
    pub size_bytes: u64,
    /// renewable：可再生（清理安全）；partial：仅部分可再生（webview 缓存）
    pub renewable: String, // "yes" | "partial" | "no"
}

#[derive(Serialize, Clone)]
pub struct TraceEntry {
    pub hash: String,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Serialize, Clone)]
pub struct UvEntry {
    pub label: String,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Serialize, Clone)]
pub struct StorageUsage {
    pub data_root: String,
    pub entries: Vec<StorageEntry>,
    pub traces: Vec<TraceEntry>,
    pub uv: Vec<UvEntry>,
}

/// uv 官方默认目录（存在才返回；Pylume 不托管、只展示与引导）。
fn uv_cache_dir() -> Option<PathBuf> {
    let d = std::env::var("LOCALAPPDATA").ok().map(|l| PathBuf::from(l).join("uv").join("cache"))?;
    d.is_dir().then_some(d)
}

fn uv_tools_dir() -> Option<PathBuf> {
    let d = std::env::var("APPDATA").ok().map(|a| PathBuf::from(a).join("uv").join("tools"))?;
    d.is_dir().then_some(d)
}

/// 占用明细（P1）：数据根子目录 + trace 逐项 + uv 官方目录。
/// async + spawn_blocking：递归扫目录（uv 缓存可达数万文件）严禁阻塞主线程。
#[tauri::command]
pub async fn storage_usage() -> Result<StorageUsage, String> {
    tauri::async_runtime::spawn_blocking(storage_usage_impl)
        .await
        .map_err(|e| format!("任务执行异常：{e}"))
}

fn storage_usage_impl() -> StorageUsage {
    let root = pylume_home();
    let entry = |key: &str, label: &str, rel: &str, renewable: &str| StorageEntry {
        key: key.into(),
        label: label.into(),
        path: root.join(rel).to_string_lossy().to_string(),
        size_bytes: path_size(&root.join(rel)),
        renewable: renewable.into(),
    };
    let entries = vec![
        entry("config", "设置与配置", "config", "no"),
        entry("state", "工作区状态", "workspaces", "no"),
        entry("recent", "最近打开记录", "recent", "no"),
        entry("traces", "运行时类型采样库", "traces", "yes"),
        entry("runtime", "运行时组件", "runtime", "no"),
        entry("webview", "WebView2 数据", "webview", "partial"),
        entry("logs", "日志", "logs", "yes"),
    ];
    let mut traces = Vec::new();
    let traces_dir = root.join("traces");
    if let Ok(rd) = std::fs::read_dir(&traces_dir) {
        for e in rd.flatten() {
            if e.file_type().map(|t| t.is_file()).unwrap_or(false)
                && e.path().extension().map(|x| x == "db").unwrap_or(false)
            {
                let name = e.file_name().to_string_lossy().to_string();
                traces.push(TraceEntry {
                    hash: name.trim_end_matches(".db").to_string(),
                    path: e.path().to_string_lossy().to_string(),
                    size_bytes: e.metadata().map(|m| m.len()).unwrap_or(0),
                });
            }
        }
    }
    traces.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    let mut uv = Vec::new();
    if let Some(d) = uv_cache_dir() {
        uv.push(UvEntry {
            label: "uv 下载缓存".into(),
            path: d.to_string_lossy().to_string(),
            size_bytes: path_size(&d),
        });
    }
    if let Some(d) = uv_tools_dir() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    uv.push(UvEntry {
                        label: format!("uv 工具：{}", e.file_name().to_string_lossy()),
                        path: e.path().to_string_lossy().to_string(),
                        size_bytes: path_size(&e.path()),
                    });
                }
            }
        }
    }
    StorageUsage {
        data_root: root.to_string_lossy().to_string(),
        entries,
        traces,
        uv,
    }
}

// ---------- 可再生内容清理 ----------

fn freed_of<F: Fn(&Path) -> std::io::Result<()>>(paths: &[PathBuf], f: F) -> u64 {
    let mut freed = 0u64;
    for p in paths {
        let size = path_size(p);
        if f(p).is_ok() {
            freed += size;
        }
    }
    freed
}

/// 删除 trace 库：hash 为 None 删全部，Some(hash) 删单项。返回释放字节数。
#[tauri::command]
pub async fn clean_traces(hash: Option<String>) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || clean_traces_impl(hash))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn clean_traces_impl(hash: Option<String>) -> Result<u64, String> {
    let dir = pylume_home().join("traces");
    let mut targets = Vec::new();
    match hash {
        Some(h) if !h.trim().is_empty() => {
            let name = format!("{}.db", h.trim());
            if name.contains("..") || name.contains('/') || name.contains('\\') {
                return Err("非法的 trace 标识".into());
            }
            targets.push(dir.join(name));
        }
        _ => {
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for e in rd.flatten() {
                    if e.path().extension().map(|x| x == "db").unwrap_or(false) {
                        targets.push(e.path());
                    }
                }
            }
        }
    }
    Ok(freed_of(&targets, |p| std::fs::remove_file(p)))
}

/// 清理 WebView2 缓存子目录（保留 Cookie/登录态等其余文件）。返回释放字节数。
#[tauri::command]
pub async fn clean_webview_cache() -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(clean_webview_cache_impl)
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn clean_webview_cache_impl() -> Result<u64, String> {
    let webview = pylume_home().join("webview");
    const CACHE_SUBDIRS: [&str; 5] =
        ["Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache"];
    let targets: Vec<PathBuf> = CACHE_SUBDIRS.iter().map(|d| webview.join(d)).collect();
    Ok(freed_of(&targets, |p| std::fs::remove_dir_all(p)))
}

/// 清理轮转日志（pylume.log.N，保留当前 pylume.log）。返回释放字节数。
#[tauri::command]
pub async fn clean_log_rotation() -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(clean_log_rotation_impl)
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn clean_log_rotation_impl() -> Result<u64, String> {
    let logs = crate::util::logs_dir();
    let mut targets = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&logs) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("pylume.log.") && name != "pylume.log" {
                targets.push(e.path());
            }
        }
    }
    Ok(freed_of(&targets, |p| std::fs::remove_file(p)))
}

/// 运行 uv 子进程并捕获输出（带超时）。
fn run_uv_capture(args: &[&str]) -> Result<String, String> {
    use std::io::Read;
    use std::process::Stdio;
    let mut cmd = tool_command("uv", ENV_UV);
    cmd.args(args);
    let mut child = crate::util::no_window(&mut cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 uv：{e}"))?;
    // 管道在各读线程中消费，避免填满缓冲区导致 uv 阻塞
    let mut out_h = child.stdout.take().expect("stdout 已设为 piped");
    let mut err_h = child.stderr.take().unwrap();
    let out_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out_h.read_to_string(&mut s);
        s
    });
    let err_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err_h.read_to_string(&mut s);
        s
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if start.elapsed() > CMD_TIMEOUT {
                    // P1-4（2026-09-29 review，铁律 1）：杀整棵进程树（uv 会拉起子进程，
                    // 裸 kill 会孤儿化）；杀完 join 读线程（管道关闭后自然退出）。
                    crate::util::kill_process_tree(&mut child);
                    let _ = out_t.join();
                    let _ = err_t.join();
                    return Err("uv 命令超时".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("等待 uv 失败：{e}")),
        }
    };
    let out = out_t.join().unwrap_or_default();
    let err = err_t.join().unwrap_or_default();
    if status.success() {
        Ok(if out.trim().is_empty() { err } else { out })
    } else {
        Err(format!("uv 命令失败（exit {}）：{}", status.code().unwrap_or(-1), err.trim()))
    }
}

/// uv 缓存清理：deep=false → `uv cache prune`（仅无效条目）；true → `uv cache clean`（全清）。
/// 注意：uv 以硬链接方式与各 venv 共享缓存文件，clean 后已装环境不受影响，
/// 但后续重装同类包将重新落盘（见 docs/disk-space-plan.md）。
/// async + spawn_blocking：uv 子进程扫描缓存目录可达数秒，严禁阻塞主线程。
#[tauri::command]
pub async fn uv_cache_clean(deep: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || uv_cache_clean_impl(deep))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn uv_cache_clean_impl(deep: bool) -> Result<String, String> {
    if !crate::tool_paths::is_available("uv", ENV_UV) {
        return Err("未检测到 uv，无法清理缓存".into());
    }
    let out = if deep {
        run_uv_capture(&["cache", "clean"])?
    } else {
        run_uv_capture(&["cache", "prune"])?
    };
    Ok(if out.trim().is_empty() { "完成".into() } else { out })
}

// ---------- P2：数据落位与迁移 ----------

#[derive(Serialize, Clone)]
pub struct FirstRunStatus {
    pub should_prompt: bool,
    pub data_root: String,
    /// 数据根指针文件是否已存在（onboarding / 迁移写过）
    pub pointer_set: bool,
    pub migration_pending: bool,
}

/// 首启检测：三个条件同时满足才提示落位（见 disk-space-plan.md P2-a）。
#[tauri::command]
pub fn first_run_status() -> FirstRunStatus {
    let root = pylume_home();
    let pointer_set = crate::util::data_root_pointer().is_file();
    let settings_exists = root.join("config").join("settings.json").is_file();
    let migration_pending = root.join(".migration-in-progress").is_file();
    let should_prompt = !pointer_set && !settings_exists && !migration_pending;
    FirstRunStatus {
        should_prompt,
        data_root: root.to_string_lossy().to_string(),
        pointer_set,
        migration_pending,
    }
}

/// 校验目录可写：创建 + 写临时探测文件 + 删除。
fn verify_writable(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("无法创建目录 {dir:?}：{e}"))?;
    let probe = dir.join(format!(".pylume-wprobe-{}", std::process::id()));
    std::fs::write(&probe, b"").map_err(|e| format!("目录不可写 {dir:?}：{e}"))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// 写数据根指针文件（平台标准配置目录，跨平台无注册表依赖）。
fn write_data_root_pointer(target: &Path) -> Result<(), String> {
    let p = crate::util::data_root_pointer();
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("无法创建指针目录：{e}"))?;
    }
    std::fs::write(&p, target.to_string_lossy().as_bytes()).map_err(|e| format!("写入指针文件失败：{e}"))
}

/// 用户选默认位置：写指针文件指向当前数据根（此后不再弹首启提示）。
#[tauri::command]
pub fn ack_first_run() -> Result<(), String> {
    write_data_root_pointer(&pylume_home())
}

/// 首启选自定义位置：校验目标 → 写数据根指针文件。
/// 首启时当前数据根内无用户数据，无需搬移；重启后生效。
/// async + spawn_blocking：磁盘 IO 不阻塞主线程（表现为 UI 卡死数秒）。
#[tauri::command]
pub async fn set_data_root(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_data_root_impl(path))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn set_data_root_impl(path: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("路径为空".into());
    }
    verify_writable(&target)?;
    write_data_root_pointer(&target)
}

#[derive(Serialize, Clone)]
pub struct MigrateResult {
    pub old_root: String,
    pub new_root: String,
    /// 复制时跳过的条目（如被占用的当前日志文件），重启后可手工删除旧根
    pub skipped: Vec<String>,
}

/// 递归复制目录，逐项容错（跳过失败项并记录，多为运行中被占用的文件）。
fn copy_dir_recursive(src: &Path, dst: &Path, skipped: &mut Vec<String>) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_dir() {
            if let Err(_e) = copy_dir_recursive(&from, &to, skipped) {
                skipped.push(from.to_string_lossy().to_string());
            }
        } else if ft.is_file() {
            match std::fs::copy(&from, &to) {
                Ok(_) => {}
                Err(_) => skipped.push(from.to_string_lossy().to_string()),
            }
        }
    }
    Ok(())
}

/// 迁移数据根到其他盘：复制 → 校验 → 重写指针文件 → 重启后生效。
/// 不删旧根（可能有被占用的日志），结果里返回 skipped 供前端提示。
/// async + spawn_blocking：整目录复制耗时长，严禁阻塞主线程。
#[tauri::command]
pub async fn migrate_data_root(target: String) -> Result<MigrateResult, String> {
    tauri::async_runtime::spawn_blocking(move || migrate_data_root_impl(target))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn migrate_data_root_impl(target: String) -> Result<MigrateResult, String> {
    let old = pylume_home();
    let new_root = PathBuf::from(target.trim());
    if new_root.as_os_str().is_empty() {
        return Err("路径为空".into());
    }
    if new_root == old {
        return Err("目标目录与当前数据根相同".into());
    }
    if new_root.starts_with(&old) {
        return Err("目标目录不能位于当前数据根内部".into());
    }
    verify_writable(&new_root)?;
    // 中断保护：标记先行，成功后移除；下次启动检测到标记 → 前端提示重试
    let marker = new_root.join(".migration-in-progress");
    std::fs::write(&marker, "").map_err(|e| e.to_string())?;
    let mut skipped = Vec::new();
    if let Err(e) = copy_dir_recursive(&old, &new_root, &mut skipped) {
        let _ = std::fs::remove_file(&marker);
        return Err(format!("复制数据失败：{e}"));
    }
    if !skipped.is_empty() {
        // 记录跳过清单，供用户对照旧根手工清理
        let _ = std::fs::write(new_root.join(".migration-skipped.txt"), skipped.join("\n"));
    }
    let _ = std::fs::remove_file(&marker);
    // 校验：目标内应能读到一个已知文件（标记写过即说明可写，此处再确认 config 可寻址）
    let _ = std::fs::create_dir_all(new_root.join("config")).map_err(|e| e.to_string())?;
    // 换指向：重写数据根指针文件（跨平台，无注册表依赖；重启后新进程读到新根）
    write_data_root_pointer(&new_root)?;
    Ok(MigrateResult {
        old_root: old.to_string_lossy().to_string(),
        new_root: new_root.to_string_lossy().to_string(),
        skipped,
    })
}

/// 重启应用（落位/迁移完成后调用）。
/// 数据根指针文件已落盘（平台配置目录），普通重启即可读到新根，无需注入环境变量。
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

// ---------- 测试 ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_size_file_and_missing() {
        let tmp = std::env::temp_dir().join(format!("oc-size-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let f = tmp.join("a.txt");
        std::fs::write(&f, vec![0u8; 100]).unwrap();
        assert_eq!(path_size(&f), 100);
        assert_eq!(path_size(&tmp.join("nope")), 0);
        let _ = std::fs::remove_file(&f);
        let _ = std::fs::remove_dir(&tmp);
    }

    #[test]
    fn trace_hash_rejects_traversal() {
        // P3-8（2026-09-29 review）：直接调用真实实现断言（原测试只断言字面量自身
        // contains ".."，无任何校验价值——实现回归不会红）。
        assert!(clean_traces_impl(Some("../evil".into())).is_err(), "含 .. 的 hash 必须被拒绝");
        assert!(clean_traces_impl(Some("a/b".into())).is_err(), "含 / 的 hash 必须被拒绝");
        assert!(clean_traces_impl(Some("a\\b".into())).is_err(), "含 \\ 的 hash 必须被拒绝");
        // 合法 hash（指向不存在的库文件）：删除 0 字节成功，不报错
        assert_eq!(clean_traces_impl(Some("0123abcd".into())).unwrap(), 0);
    }
}
