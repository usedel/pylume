// 跨模块共享工具：用户目录定位 + Windows 无窗口子进程启动 + 字节流增量 UTF-8 解码。
// 消除 file_ops / env_cmds / lsp / settings 中重复的 data_root 与 no_window 实现。

use std::path::PathBuf;

/// 用户主目录（Windows 为 USERPROFILE/HOME）。
/// 固定指向系统用户目录。
/// 用于 uv 官方脚本默认安装位置 `~/.local/bin` 等用户级路径。
pub(crate) fn user_home() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// Pylume 数据根目录，进程内只探测一次（OnceLock 缓存）。
///
/// 决策顺序（三级，无便携形态，跨平台无注册表依赖）：
/// 1. `PYLUME_DATA_ROOT` 环境变量（仅开发 / 测试 / 高级用户重定向，应用自身不写入）；
/// 2. 数据根指针文件（首启落位提示 / 迁移向导写入，见 `data_root_pointer`）；
/// 3. 平台默认：Windows 为 `%LOCALAPPDATA%\Pylume`（Known Folders 惯例）。
pub(crate) fn data_root() -> &'static PathBuf {
    static ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    ROOT.get_or_init(resolve_data_root)
}

/// 数据根指针文件目录：平台标准配置目录（与数据根解耦——指针只有几十字节，
/// 落在系统盘无妨；真正的大体积数据按指针指向落盘，跨平台无注册表/环境变量依赖）。
/// Windows: `%APPDATA%\Pylume`；Linux: `$XDG_CONFIG_HOME/pylume`；
/// macOS: `~/Library/Application Support/Pylume`。
pub(crate) fn pointer_dir() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var("APPDATA")
            .map(|d| PathBuf::from(d).join("Pylume"))
            .unwrap_or_else(|_| user_home().join("AppData").join("Roaming").join("Pylume"))
    }
    #[cfg(target_os = "macos")]
    {
        user_home().join("Library").join("Application Support").join("Pylume")
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        std::env::var("XDG_CONFIG_HOME")
            .map(|d| PathBuf::from(d).join("pylume"))
            .unwrap_or_else(|_| user_home().join(".config").join("pylume"))
    }
}

/// 数据根指针文件（内容 = 数据根绝对路径；不存在 = 用平台默认）。
pub(crate) fn data_root_pointer() -> PathBuf {
    pointer_dir().join("data-root")
}

fn resolve_data_root() -> PathBuf {
    // 1. 显式环境变量覆盖（仅开发 / 测试 / 高级用户，应用自身不写入环境变量）
    if let Ok(dir) = std::env::var("PYLUME_DATA_ROOT") {
        let p = PathBuf::from(dir.trim());
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    // 2. 指针文件（首启落位提示 / 迁移向导写入）
    if let Ok(s) = std::fs::read_to_string(data_root_pointer()) {
        let p = PathBuf::from(s.trim());
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    // 3. 平台默认：Known Folders（Windows %LOCALAPPDATA%\Pylume）
    std::env::var("LOCALAPPDATA")
        .map(|d| PathBuf::from(d).join("Pylume"))
        .unwrap_or_else(|_| user_home().join("Pylume"))
}

/// Pylume 用户数据根（即 data_root）。
/// 各模块在此目录下按功能划分子目录（config/ workspaces/ recent/ traces/
/// runtime/ webview/ logs/），不要把文件平铺到根目录。
pub(crate) fn pylume_home() -> PathBuf {
    data_root().to_path_buf()
}

/// WebView2 用户数据目录（localStorage / Cookie / 缓存落盘位置，仅 Windows WebView2 使用）。
#[cfg(windows)]
pub(crate) fn webview_data_dir() -> PathBuf {
    pylume_home().join("webview")
}

/// 诊断日志目录（按天轮转，保留 14 天，见 logging.rs）。
pub(crate) fn logs_dir() -> PathBuf {
    pylume_home().join("logs")
}

/// Windows 下为子进程附加 CREATE_NO_WINDOW，避免弹出控制台窗口；其他平台原样返回。
#[cfg(windows)]
pub(crate) fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(windows))]
pub(crate) fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd
}

/// 取出被 panic 污染的锁（poisoned lock），避免一个线程 panic 后连锁导致后续请求全部 panic。
/// 临界区内无 panic 点，poison 仅在异常发生时出现——宁可继续也不让请求整体挂掉。
pub(crate) fn unpoison<T>(r: std::sync::LockResult<T>) -> T {
    r.unwrap_or_else(|poisoned| poisoned.into_inner())
}

// 注：曾有 soft_kill_pid（P1-J 温和终止，服务 piped run_script 的「stdin drop + 宽限 +
// 强杀」序列）——随 v3.4 §17-16 删净 piped 路径失去全部调用方，移除；运行链路的软杀
// 语义统一由 PTY 写 \x03（term_write）承担，见 termUi::stopRunInstanceById。

/// 终止子进程**及其全部子孙进程**并回收（同步阻塞）。
///
/// 只 `child.kill()` 会杀掉直接子进程（如 `uv run` / 解释器），但 uv 拉起的 python 脚本、
/// shell 再 spawn 的子进程会变成孤儿继续运行（停止按钮失效）。Windows 用
/// `taskkill /T /F` 杀进程树；其他平台仅杀直接子进程。
///
/// 阻塞直到进程树被终结并回收。调用方需自行确保不会被 `kill_process_tree` 阻塞数秒
/// （如关闭工作区场景应改用 [`kill_process_tree_async`]）。
pub(crate) fn kill_process_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        // 体验修复：taskkill 也须 CREATE_NO_WINDOW——编辑 .py 触发 LSP 重启/停止运行时
        // 走到这里，裸 spawn 的 taskkill 会在前台闪黑框（用户报告的「老是有黑框闪」）
        let mut kill = std::process::Command::new("taskkill");
        kill.args(["/PID", &pid, "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let _ = no_window(&mut kill).status();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// 同 [`kill_process_tree`]，但异步：阻塞性的 `taskkill` + 回收（`child.wait()`）全部移到
/// 后台线程执行并对回收加超时，函数立即返回。
///
/// 供关闭工作区 / 停止 LSP 引擎等**不应阻塞 UI** 的场景使用；需要同步确保子进程已退出的
/// 场景（如超时/出错后紧接着 join 输出线程）仍应使用 [`kill_process_tree`]。
pub(crate) fn kill_process_tree_async(child: std::process::Child) {
    // taskkill 的 PID 先取出（进程树终结后 child.id() 可能失效）。
    let pid = child.id();

    // taskkill 对庞杂进程树可能耗时数秒，必须在后台线程执行，否则仍会阻塞调用方（lsp_stop）。
    std::thread::spawn(move || {
        let t0 = std::time::Instant::now();
        #[cfg(windows)]
        {
            // 体验修复：同 kill_process_tree——taskkill 补 CREATE_NO_WINDOW（防黑框闪）
            let mut kill = std::process::Command::new("taskkill");
            kill.args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            let _ = no_window(&mut kill).status();
        }

        let mut child = child;
        #[cfg(not(windows))]
        let _ = child.kill();

        // 回收进程句柄，最多等 RETRIES 次共 ~1s，避免子进程迟迟不退出而卡住。
        const RETRIES: usize = 10;
        for _ in 0..RETRIES {
            match child.try_wait() {
                Ok(Some(_)) => {
                    crate::logging::log_line(
                        crate::logging::Level::Info,
                        &format!("[kill_async] pid={pid} reaped, took={:?}", t0.elapsed()),
                    );
                    return;
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(_) => {
                    crate::logging::log_line(
                        crate::logging::Level::Warn,
                        &format!("[kill_async] pid={pid} wait err, took={:?}", t0.elapsed()),
                    );
                    return;
                }
            }
        }
        crate::logging::log_line(
            crate::logging::Level::Warn,
            &format!("[kill_async] pid={pid} timeout(~1s), gave up"),
        );
    });
}

/// 通过 pid 终止**整棵进程树**（同步 taskkill /T /F，Windows；非 Windows 无操作）。
///
/// 与 [`kill_process_tree`] 同口径但操作 pid：PTY 会话的 child 是
/// `Box<dyn portable_pty::Child>`（无法借用 `std::process::Child`），只能取 pid 杀树。
/// 同步阻塞；「不应阻塞 UI」的场景由调用方放进后台线程（如 terminal::kill_child_tree_async）。
pub(crate) fn kill_pid_tree(pid: u32) {
    #[cfg(windows)]
    {
        if pid == 0 {
            return;
        }
        // 体验修复：taskkill 补 CREATE_NO_WINDOW（防前台黑框闪，与 kill_process_tree 同口径）
        let mut kill = std::process::Command::new("taskkill");
        kill.args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let _ = no_window(&mut kill).status();
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
    }
}

/// PTY 会话 child（`Box<dyn portable_pty::Child + Send + Sync>`）的异步杀树（铁律 1）。
///
/// 与 [`kill_process_tree_async`] 同语义但操作 portable-pty 的 child：先取 pid，
/// 阻塞性的 taskkill /T /F 与回收全部移到后台线程，函数立即返回。
/// 顺序要求：**必须先 taskkill 杀树再 kill/wait child**——直接子进程死了 taskkill 就
/// 找不到树根，孙进程会漏杀（这正是裸 `child.kill()` 的孤儿问题本身）。
pub(crate) fn kill_pty_child_tree_async(mut child: Box<dyn portable_pty::Child + Send + Sync>) {
    let pid = child.process_id().unwrap_or(0);
    std::thread::spawn(move || {
        crate::util::kill_pid_tree(pid);
        // 兜底：树杀失败（pid 复用等罕见情形）时仍终止直接子进程并回收句柄
        let _ = child.kill();
        let _ = child.wait();
    });
}

/// 打包后 Tauri 资源目录候选：`bundle.resources` 的落地位置跨平台有差异，
/// 列出多个常见位置（`resource_dir()` 本身与其 `resources/` 子目录），命中即用。
/// 供 `lsp::locate_intel_binary` / `run_env::locate_probe_src` 复用（第 2 步：资源目录支持）。
pub(crate) fn resource_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    use tauri::Manager;
    let mut dirs = Vec::new();
    if let Ok(d) = app.path().resource_dir() {
        dirs.push(d.clone());
        dirs.push(d.join("resources"));
    }
    dirs
}

/// 动态授权 asset 协议读取目录（Markdown 预览渲染本地图片用）。
///
/// 前端在打开 / 切换工作区（含启动恢复上次工作区）时调用，把 asset scope 收紧到
/// 当前工作区根（递归），而非在 tauri.conf.json 写死一个宽泛路径；越权路径仍由
/// 该 scope 拦截。asset 协议本身需在 tauri.conf.json 的 `app.security.assetProtocol`
/// 置为 `enable: true`（scope 留空，全走这里动态授权）。
#[tauri::command]
pub fn allow_asset_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri::Manager;
    app.asset_protocol_scope()
        .allow_directory(std::path::Path::new(&path), true)
        .map_err(|e| format!("asset 目录授权失败：{e}"))
}

/// 字节流增量 UTF-8 解码器（S3/S4 公共基建：按块读取子进程输出时避免多字节字符跨块乱码）。
///
/// 按块读取子进程输出时，多字节字符（中文提示符、跨块 traceback）可能正好落在块边界上；
/// 直接 `from_utf8_lossy` 会把尾部不完整序列替换成 U+FFFD 乱码。终端平时输出量大不显眼，
/// 但交互式一问一答（每块就几个字）必然暴露。
///
/// 本解码器只输出「完整字符」，把尾部 1–3 个不完整字节 carry 到下一轮；
/// 流结束时用 [`finish`](Self::finish) 冲刷（残留字节按 lossy 输出，不静默吞字节）。
/// 中间出现非法字节时替换为 U+FFFD 并继续扫描，保证 carry 恒定有界（≤3 字节）。
#[derive(Default)]
pub(crate) struct IncrementalUtf8Decoder {
    carry: Vec<u8>,
}

impl IncrementalUtf8Decoder {
    /// 送入一块字节，返回可安全输出的文本（空串 = 本块全是不完整尾巴，尚无可输出内容）。
    pub(crate) fn push(&mut self, bytes: &[u8]) -> String {
        if bytes.is_empty() && self.carry.is_empty() {
            return String::new();
        }
        self.carry.extend_from_slice(bytes);
        let mut out = String::new();
        let mut pos = 0;
        loop {
            match std::str::from_utf8(&self.carry[pos..]) {
                Ok(s) => {
                    out.push_str(s);
                    pos = self.carry.len();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    // valid_up_to 之前的字节已确认合法，直接取出（lossy 在此不会替换）
                    out.push_str(&String::from_utf8_lossy(&self.carry[pos..pos + valid]));
                    pos += valid;
                    match e.error_len() {
                        // 非法字节序列：替换为一个 U+FFFD 后继续扫描（与 from_utf8_lossy 同语义）
                        Some(len) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            pos += len;
                        }
                        // None = 尾部不完整（被块边界截断）：留给下一轮
                        None => break,
                    }
                }
            }
        }
        self.carry.drain(..pos);
        out
    }

    /// 流结束冲刷：残留的不完整字节已不可能拼成完整字符，按 lossy 输出。
    pub(crate) fn finish(&mut self) -> String {
        if self.carry.is_empty() {
            return String::new();
        }
        let out = String::from_utf8_lossy(&self.carry).into_owned();
        self.carry.clear();
        out
    }

    /// 是否仍有未输出的残留字节（仅测试用于断言 carry 状态）
    #[cfg(test)]
    pub(crate) fn pending(&self) -> usize {
        self.carry.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_passes_ascii_through() {
        let mut d = IncrementalUtf8Decoder::default();
        assert_eq!(d.push(b"hello"), "hello");
        assert_eq!(d.push(b" world\n"), " world\n");
        assert_eq!(d.pending(), 0);
        assert_eq!(d.finish(), "");
    }

    #[test]
    fn decoder_carries_multibyte_across_chunks() {
        // 「你好」= 6 字节；在第 4 字节处切开（第二个汉字只到一半）
        let bytes = "你好".as_bytes();
        let mut d = IncrementalUtf8Decoder::default();
        assert_eq!(d.push(&bytes[..4]), "你");
        assert_eq!(d.pending(), 1); // 尾部 1 字节被 carry
        assert_eq!(d.push(&bytes[4..]), "好");
        assert_eq!(d.pending(), 0);
    }

    #[test]
    fn decoder_carries_each_truncation_width() {
        // 4 字节 emoji 逐字节喂入：前 3 次无可输出，第 4 次一次性产出完整字符
        let bytes = "🐍".as_bytes();
        assert_eq!(bytes.len(), 4);
        let mut d = IncrementalUtf8Decoder::default();
        for (i, b) in bytes.iter().enumerate() {
            let out = d.push(std::slice::from_ref(b));
            if i < 3 {
                assert_eq!(out, "", "第 {i} 字节不应产出文本");
            } else {
                assert_eq!(out, "🐍");
            }
        }
        assert_eq!(d.pending(), 0);
    }

    #[test]
    fn decoder_replaces_invalid_bytes_and_keeps_scanning() {
        // 中间非法字节不得让 carry 无限增长：替换后继续解码后续合法内容
        let mut d = IncrementalUtf8Decoder::default();
        let out = d.push(&[0xff, b'a', b'b']);
        assert_eq!(out, format!("{}ab", char::REPLACEMENT_CHARACTER));
        assert_eq!(d.pending(), 0);
    }

    #[test]
    fn decoder_finish_flushes_dangling_tail() {
        let bytes = "你".as_bytes();
        let mut d = IncrementalUtf8Decoder::default();
        assert_eq!(d.push(&bytes[..1]), "");
        assert_eq!(d.pending(), 1);
        assert_eq!(d.finish(), char::REPLACEMENT_CHARACTER.to_string());
        assert_eq!(d.pending(), 0);
    }

    #[test]
    fn decoder_keeps_traceback_frame_intact_across_chunks() {
        // 坑 5 的真实场景：中文路径的 traceback 帧跨块到达，拼接后必须逐字一致
        let line = r#"  File "F:\项目\主程序.py", line 42, in <module>"#;
        let bytes = line.as_bytes();
        let cut = bytes.len() / 2;
        let mut d = IncrementalUtf8Decoder::default();
        let mut got = d.push(&bytes[..cut]);
        got.push_str(&d.push(&bytes[cut..]));
        got.push_str(&d.finish());
        assert_eq!(got, line);
    }
}