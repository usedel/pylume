// 项目统一日志（TD-007 扩展）：级别过滤 + 大小轮转 + 落盘 & stdout 双写。
// 配置项经 Settings 下发（settings.json），前端设置面板可调：
//   - log_enabled  是否启用（关闭后仅 error 级仍写文件，防止彻底黑盒）
//   - log_level    阈值："error" | "warn" | "info" | "debug"
//   - log_keep     保留的轮转文件份数（1-10）
//   - log_stdout   是否同时打印 stdout（dev 终端可见，release 无控制台时可关）
//
// 日志文件：<data_root>/logs/pylume.log，超过 LOG_MAX_BYTES 轮转为 .1/.2/...
// （保留 log_keep 份）。窗口期不重建，进程内始终追加当前文件。

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::settings;
use crate::util::logs_dir;

/// 单文件超过此字节数即轮转（1 MiB）。
const LOG_MAX_BYTES: u64 = 1024 * 1024;

static WRITER: Mutex<Option<std::fs::File>> = Mutex::new(None);

/// 日志级别（按数值升序，写入级别 >= 阈值才输出）。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Error = 0,
    Warn = 1,
    Info = 2,
    Debug = 3,
}

impl Level {
    pub fn as_str(&self) -> &'static str {
        match self {
            Level::Error => "ERROR",
            Level::Warn => "WARN",
            Level::Info => "INFO",
            Level::Debug => "DEBUG",
        }
    }

    fn from_str(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "error" => Level::Error,
            "warn" | "warning" => Level::Warn,
            "debug" => Level::Debug,
            _ => Level::Info,
        }
    }
}

/// 日志目录：<data_root>/logs
pub(crate) fn log_dir() -> PathBuf {
    logs_dir()
}

/// 当前日志文件：<data_root>/logs/pylume.log
fn current_log() -> PathBuf {
    log_dir().join("pylume.log")
}

/// 写一行日志（调用方已通过 `log_line` 过滤级别）。
fn write_line(level: Level, msg: &str) {
    // 打开文件（懒初始化）；路径父目录不存在时创建。
    let mut guard = unpoison(&WRITER);
    if guard.is_none() {
        let dir = log_dir();
        if std::fs::create_dir_all(&dir).is_err() {
            eprintln!("[pylume-log] create_dir_all({dir:?}) failed");
            return;
        }
        *guard = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(current_log())
            .ok();
    }
    let Some(f) = guard.as_mut() else {
        eprintln!("[pylume-log] open({:?}) failed", current_log());
        return;
    };

    // 轮转：当前文件超限则切 .1/.2/...（保留 keep 份）
    if let Ok(meta) = f.metadata() {
        if meta.len() > LOG_MAX_BYTES {
            rotate();
            // 重开新文件
            if let Ok(nf) = std::fs::OpenOptions::new().create(true).append(true).open(current_log()) {
                *f = nf;
            }
        }
    }

    let line = format!(
        "[{}] [{}] {}\n",
        chrono_local_now(),
        level.as_str(),
        msg
    );
    let _ = f.write_all(line.as_bytes());
    let _ = f.flush();
}

/// 轮转：pylume.log.N 依次后移，超保留份数即删除。
fn rotate() {
    let keep = settings::load().log_keep.clamp(1, 10); // 低频路径（轮转时一次）
    let dir = log_dir();
    // 从最老开始：keep-1 → keep 存在则删；再依次后移
    let oldest = dir.join(format!("pylume.log.{keep}"));
    if oldest.is_file() {
        let _ = std::fs::remove_file(&oldest);
    }
    for i in (1..keep).rev() {
        let src = dir.join(format!("pylume.log.{i}"));
        let dst = dir.join(format!("pylume.log.{}", i + 1));
        if src.is_file() {
            let _ = std::fs::rename(&src, &dst);
        }
    }
    let cur = dir.join("pylume.log");
    if cur.is_file() {
        let _ = std::fs::rename(&cur, dir.join("pylume.log.1"));
    }
}

/// 日志入口：级别过滤 + 落盘 + stdout。
/// 调用约定：`log_line(Level::Info, "msg")`。
/// P2-1（2026-09-29 review）：一次 `settings::load()` 取全部字段（内部有 mtime
/// 缓存）——原实现每条日志独立调用 4 次 load（各自读盘 + 反序列化）。
pub(crate) fn log_line(level: Level, msg: &str) {
    let s = settings::load();
    // 关闭日志时仅保留 error（防止彻底黑盒）；打开时按阈值过滤。
    let pass = if s.log_enabled { level >= Level::from_str(&s.log_level) } else { level == Level::Error };
    if pass {
        write_line(level, msg);
    }
    // stdout 受设置控制（dev 终端方便；release 无控制台，默认不开）
    if s.log_stdout {
        println!("[{}] {msg}", level.as_str());
    }
}

/// 本地时间字符串（HH:MM:SS.mmm），不引入外部时间依赖。
fn chrono_local_now() -> String {
    // std 无本地时区换算，用 unix 秒 + 秒内毫秒的粗略可读格式（跨时区仅偏移，不误读先后）。
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() % 86_400;
    let millis = now.subsec_millis();
    format!("{:02}:{:02}:{:02}.{:03}", secs / 3600, (secs % 3600) / 60, secs % 60, millis)
}

/// 解锁 Mutex（异常时 recover 清锁，避免一次 panic 污染全局锁）。
fn unpoison<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 在系统资源管理器中打开目录（跨平台）。
fn reveal_dir(dir: PathBuf, what: &str) -> Result<(), String> {
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        crate::util::no_window(std::process::Command::new("explorer").arg(dir))
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("无法打开{what}：{e}"))
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(dir)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("无法打开{what}：{e}"))
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("无法打开{what}：{e}"))
    }
}

/// 在系统资源管理器中打开日志目录（设置面板「日志」分类的入口按钮）。
#[tauri::command]
pub fn open_log_dir() -> Result<(), String> {
    reveal_dir(log_dir(), "日志目录")
}

/// 在系统资源管理器中打开数据根目录（设置面板入口；含 config/traces/envs 等子目录）。
#[tauri::command]
pub fn open_data_dir() -> Result<(), String> {
    reveal_dir(crate::util::pylume_home(), "数据目录")
}
