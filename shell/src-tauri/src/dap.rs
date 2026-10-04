// DAP 桥 Rust 侧（docs/python_debug_dev_plan.md v1.1 + 实施修订）：debugpy 会话管理。
//
// 架构（v1.2 实测修订，2026-09-10）：**stdio adapter 模式**。
// 原设计的「--listen + 端口预分配 + TCP」在真实环境暴露两个致命问题（全部实测复现）：
//   1. debugpy 的 --listen 是两段式：debuggee 进程内部再 spawn 一个 adapter 子进程并
//      等它回连（内部 listener 30s 超时）——在 ConPTY 下该内部 spawn 不工作（应用内
//      30s 10061；独立管道复现 12.8s 才连上，系统繁忙时更久）；
//   2. Tauri resource_dir() 返回 \\?\ verbatim 路径，作为 python 脚本参数会使 debugpy
//      自举 import 失败（ModuleNotFoundError）——已在 locate 出口剥离。
// 新架构（已全链路验证：initialize → attach{listen} → debugpyWaitingForServer →
// PTY 内 --connect debuggee → initialized → stopped → stackTrace，2.2s 完成）：
//   - Rust spawn **stdio adapter**（python <debugpy>/adapter，管道模式，不进 PTY）——
//     adapter 与 debugpy 内部 spawn 无关，不存在 ConPTY 问题；
//   - DAP 通信走 adapter 的 stdin/stdout（同 lsp.rs 对 LSP 引擎的模式）；
//   - 被调试脚本进 PTY（stdout/stderr/交互归终端），以 --connect 连 adapter 的
//     server socket（地址经 debugpyWaitingForServer 事件获得）；
//   - attach 带 {"listen":{"host","port":0}}：走「server 主动连接」路径，同时清空
//     adapter access_token（servers.py 双 None 跳过鉴权，debuggee 无需 token）。
//
// 其余设计要点不变：
// - 三态互斥（§3.2）；debug_busy() 单实例守卫；
// - debug_stop 立即返回（CR-10 纪律）：取槽后杀进程树/清 PTY/关管道全部后台化；
// - locate_debugpy_dir 四级查找 + verbatim 剥离（§3.4 零安装）。

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

use crate::logging::{log_line, Level};
use crate::per_window::PerWindow;
use crate::util::unpoison;

// ---------- 全局状态（§5.1.1） ----------

struct DebugSession {
    /// stdio adapter 子进程（DAP 对端）。
    adapter: Option<Child>,
    /// adapter stdin 写侧（CR-03 纪律：独立 Arc<Mutex>，写阻塞不持全局锁）。
    adapter_stdin: Option<Arc<Mutex<ChildStdin>>>,
    /// debuggee 进程 pid（管道模式，进程本体由退出监视线程持有）。
    debuggee_pid: Option<u32>,
    /// 会话序号（防重启串线，同 lsp.rs 先例）。
    seq: u64,
}

static DEBUG: LazyLock<PerWindow<DebugSession>> = LazyLock::new(PerWindow::new);
static DEBUG_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 调试会话是否占用（三态互斥之一，供 run_script / run_in_terminal 反向检查）。
pub(crate) fn debug_busy(wid: &str) -> bool {
    DEBUG.contains(wid)
}

// 注：v1.2 架构曾有 DEBUG_TERM_PREFIX（"debug-term-"）——debuggee 落 PTY 会话的 id 前缀。
// v1.3 改管道模式（stdout → 输出面板）后不再创建终端会话，前缀随之移除；
// 若未来恢复 PTY 交互（见 debug_acceptance_record.md §〇 遗留），按此约定重建。

// ---------- debugpy 定位（§5.1.2 四级查找 + verbatim 剥离） ----------

/// 判定「这是含 __main__.py 的 debugpy 包目录」。
fn is_debugpy_pkg(dir: &std::path::Path) -> bool {
    dir.join("__main__.py").is_file() && dir.join("__init__.py").is_file()
}

/// 定位自带 debugpy 包目录，优先顺序（同 lsp.rs::locate_intel_binary 先例）：
/// 1) 环境变量 PYLUME_DEBUGPY_DIR（指向 debugpy/ 包目录本身）；
/// 2) 托管目录 <data_root>/runtime/debugpy/debugpy；
/// 3) Tauri 资源目录（打包分发，bundle.resources "vendor/debugpy/" -> "debugpy/"）；
/// 4) dev 相对 exe 上溯仓库布局（vendor/debugpy/debugpy，需先跑 tools/fetch-debugpy.ps1）。
/// 返回含 __main__.py 的包目录；找不到返回 None（安装包损坏 / dev 未拉取，无安装分支）。
///
/// **出口统一剥 `\\?\` verbatim 前缀**（实测坑 2026-09-10）：Tauri `resource_dir()` 返回
/// verbatim 路径，`python \\?\...\debugpy\__main__.py` 会让 debugpy 自举 import 失败
/// （`ModuleNotFoundError: No module named 'debugpy'`）→ debugpy 起了不监听 → 假 10061。
fn locate_debugpy_dir(app: &AppHandle) -> Option<PathBuf> {
    locate_debugpy_dir_raw(app).map(strip_verbatim)
}

fn locate_debugpy_dir_raw(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("PYLUME_DEBUGPY_DIR") {
        let p = PathBuf::from(p);
        if is_debugpy_pkg(&p) {
            return Some(p);
        }
    }

    let runtime = crate::tool_paths::runtime_dir().join("debugpy").join("debugpy");
    if is_debugpy_pkg(&runtime) {
        return Some(runtime);
    }

    for dir in crate::util::resource_candidates(app) {
        // bundle.resources 映射 "vendor/debugpy/" -> "debugpy/"：解包后 debugpy 包位于
        // <资源根>/debugpy/debugpy（外层 debugpy/ 是映射目标目录，内层才是包本身）
        for cand in [dir.join("debugpy").join("debugpy"), dir.join("debugpy")] {
            if is_debugpy_pkg(&cand) && cand.join("__main__.py").is_file() {
                return Some(cand);
            }
        }
    }

    let mut dir = std::env::current_exe().ok()?;
    for _ in 0..6 {
        dir.pop();
        let cand = dir.join("vendor").join("debugpy").join("debugpy");
        if is_debugpy_pkg(&cand) {
            return Some(cand);
        }
    }
    None
}

/// 剥 Windows verbatim 路径前缀（`\\?\C:\...` → `C:\...`；UNC `\\?\UNC\server\...` → `\\server\...`）。
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

// ---------- 依赖声明检测（§5.1.6，提示性质） ----------

/// 扫描工作区依赖清单是否声明 debugpy（纯文件扫描，无子进程、不弹窗、不阻断）。
fn scan_debugpy_dep(workspace_root: &std::path::Path) -> (bool, Vec<String>) {
    let mut files = Vec::new();

    let pyproject = workspace_root.join("pyproject.toml");
    if pyproject.is_file() {
        let mut hit = false;
        if let Ok(text) = std::fs::read_to_string(&pyproject) {
            let mut in_dep_section = false;
            for line in text.lines() {
                let t = line.trim();
                if t.starts_with('[') {
                    in_dep_section =
                        t == "[project.dependencies]" || t == "[tool.poetry.dependencies]" || t == "dependencies";
                    continue;
                }
                if in_dep_section && pyproject_line_mentions_debugpy(t) {
                    hit = true;
                    break;
                }
            }
        }
        if hit {
            files.push("pyproject.toml".to_string());
        }
    }

    if let Ok(entries) = std::fs::read_dir(workspace_root) {
        let mut reqs: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                name.starts_with("requirements") && name.ends_with(".txt")
            })
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        reqs.sort();
        for name in reqs {
            let path = workspace_root.join(&name);
            if let Ok(text) = std::fs::read_to_string(&path) {
                let hit = text.lines().any(requirements_line_mentions_debugpy);
                if hit {
                    files.push(name);
                }
            }
        }
    }

    (!files.is_empty(), files)
}

fn pyproject_line_mentions_debugpy(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') {
        return false;
    }
    let key = t.split('=').next().unwrap_or(t);
    let key = key.split(['>', '<', '~', '!', '[', ';', ' ']).next().unwrap_or(key);
    key.trim_matches(|c: char| c == '"' || c == '\'').eq_ignore_ascii_case("debugpy")
}

fn requirements_line_mentions_debugpy(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') || t.starts_with('-') {
        return false;
    }
    let head = t.split(['>', '<', '~', '!', '=', '[', ';', ' ', '#']).next().unwrap_or(t);
    head.eq_ignore_ascii_case("debugpy")
}

// ---------- debug_detect（§7 D1-5：纯文件系统操作，无子进程） ----------

/// 调试前置检测：自带 debugpy 是否可用 + 依赖清单是否声明 debugpy（提示性质）。
#[tauri::command]
pub fn debug_detect(app: AppHandle, workspace_root: Option<String>) -> Result<Value, String> {
    let dir = locate_debugpy_dir(&app);
    let (dep_found, dep_files) = match workspace_root.as_deref() {
        Some(root) => scan_debugpy_dep(std::path::Path::new(root)),
        None => (false, Vec::new()),
    };
    Ok(json!({
        "debugpyOk": dir.is_some(),
        "debugpyDir": dir.map(|d| d.to_string_lossy().to_string()),
        "depFound": dep_found,
        "depFiles": dep_files,
    }))
}

// ---------- 帧解析（§5.1.3：复刻 lsp.rs::read_frame，不跨模块依赖） ----------

/// 单帧 payload 上限（与 lsp.rs MAX_FRAME_LEN 同量级：防异常对端触发巨额分配）。
const MAX_DAP_FRAME_LEN: usize = 64 * 1024 * 1024;

/// 读取一个 DAP 帧（Content-Length 头 + JSON payload；帧头与 LSP 相同）。
fn read_dap_frame(reader: &mut impl BufRead) -> Result<Option<Value>, String> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = Vec::new();
        let n = reader.read_until(b'\n', &mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(None);
        }
        let line_str = String::from_utf8_lossy(&line).trim().to_string();
        if line_str.is_empty() {
            break;
        }
        if let Some(v) = line_str.strip_prefix("Content-Length:") {
            content_length = v.trim().parse::<usize>().ok();
        }
    }
    let len = content_length.ok_or("缺少 Content-Length 头")?;
    if len > MAX_DAP_FRAME_LEN {
        return Err(format!("Content-Length 超上限（{len} > {MAX_DAP_FRAME_LEN}）"));
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).map_err(|e| e.to_string())?;
    serde_json::from_slice(&buf).map(Some).map_err(|e| e.to_string())
}

// ---------- 会话清理 ----------

/// 后台执行会话清理（debug_stop / 启动失败共用）：只操作已取走的载荷，不再碰 DEBUG 锁。
fn cleanup_session_payload(s: DebugSession, app: &AppHandle, wid: &str) {
    // 1. 杀 debuggee 进程树（连带脚本子树）
    if let Some(pid) = s.debuggee_pid {
        crate::util::kill_pid_tree(pid);
    }
    // 2. 杀 adapter：铁律 1——adapter 经解释器链拉起（如 venv wrapper），按 pid 杀树
    //    防止包装器场景孙进程孤儿化；先取 pid 再 kill/wait。
    if let Some(mut adapter) = s.adapter {
        let pid = adapter.id();
        let _ = adapter.kill();
        let _ = adapter.wait();
        if pid != 0 {
            crate::util::kill_pid_tree(pid);
        }
    }
    log_line(Level::Info, "[dap] cleanup_session done");
    // P1-11：事件携带会话 seq（前端比对，防 stop → 快速重启时旧事件踩新会话）
    let _ = app.emit_to(wid, "debug-exited", json!({ "reason": "stopped", "seq": s.seq }));
}

// ---------- debug_start（stdio adapter 架构） ----------

/// 启动调试会话。命令本身立即返回（async + 后台线程做全部耗时操作）；
/// 前端随后经 dap_send_request 发 initialize → attach{listen}，并在收到
/// debugpyWaitingForServer 事件后调 debug_attach_debuggee 在 PTY 里拉起被调试脚本。
#[tauri::command]
pub async fn debug_start(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    workspace_root: Option<String>,
) -> Result<(), String> {
    let wid = window.label().to_string();
    // ---- 1. 互斥检查（§3.2；v3.4 §13.2 裁决 10：收窄至脚本运行会话——piped 运行已删，
    //      只看 PTY 脚本运行会话；项目实例（长驻服务）可与调试并存）----
    // P1-1（2026-09-29 review）：`debug_start` 是 async 命令，tokio 线程池并发执行——
    // 「contains 检查」与后续（约百行文件 IO 之后的）insert 之间存在 TOCTOU：两次并发
    // 调用都通过检查、各自 spawn adapter，第二次 insert 覆盖第一次 → 第一个 adapter
    // 成孤儿（连 debug_stop_for_exit 的 drain_all 都拿不到它）。改为**同一锁临界区内
    // 原子占位**（starting 哨兵），装配失败时移除哨兵回滚。
    let seq = {
        let mut d = DEBUG.lock();
        if d.get(&wid).is_some() {
            return Err("已有调试会话在运行".into());
        }
        if crate::terminal::script_run_busy(&wid) {
            return Err("已有脚本在运行".into());
        }
        let seq = DEBUG_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        d.insert(wid.to_string(), DebugSession { adapter: None, adapter_stdin: None, debuggee_pid: None, seq });
        seq
    };
    // 装配失败回滚哨兵：把整段装配放闭包，Err 出口统一移除占位槽。
    let assembled = assemble_debug_session(&app, &wid, seq, &path, workspace_root.as_deref());
    match assembled {
        Ok(()) => Ok(()),
        Err(e) => {
            // 只回滚自己的哨兵（seq 匹配才移除，防误删并发新会话——理论上此处不可能
            // 出现其他会话，防御性保留）。
            let mut d = DEBUG.lock();
            if d.get(&wid).map(|s| s.seq) == Some(seq) {
                d.remove(&wid);
            }
            Err(e)
        }
    }
}

/// `debug_start` 的装配段（步骤 2-9）：解析配置 → spawn adapter → 填充占位槽 → 起读线程。
/// 独立成函数便于失败路径统一回滚（调用方移除哨兵）。
fn assemble_debug_session(
    app: &AppHandle,
    wid: &str,
    seq: u64,
    path: &str,
    workspace_root: Option<&str>,
) -> Result<(), String> {
    // ---- 2. 脚本路径解析（同 run_script 口径；cwd 在 debug_attach_debuggee 侧计算）----
    let p = std::path::Path::new(path);
    let script_abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    };

    // ---- 3. 解释器与运行配置 ----
    let run_config = workspace_root
        .map(|r| crate::env_cmds::read_run_config(r, path))
        .unwrap_or_default();
    // P1-I：解释器解析（配置级覆盖 > 工作区配置 > .venv 自动检测）
    let profile_interpreter = run_config.interpreter.trim().to_string();
    let interpreter = if profile_interpreter.is_empty() {
        workspace_root
            .and_then(|r| crate::env_cmds::get_interpreter(r.to_string()).ok().flatten())
    } else {
        Some(profile_interpreter)
    };

    // P0-C：module 入口必须有模块名（调试与运行同一份配置语义）
    if run_config.entry.kind == "module" && !run_config.entry.is_module() {
        return Err("运行配置选择了模块入口，但模块名为空".into());
    }
    // ---- 4. 定位自带 debugpy（含 verbatim 剥离）----
    let debugpy_dir = locate_debugpy_dir(app).ok_or_else(|| {
        "未找到自带 debugpy（应用资源目录损坏，或开发环境未运行 tools/fetch-debugpy.ps1 拉取）。\
         请重新安装应用或在仓库根目录执行：powershell -ExecutionPolicy Bypass -File tools/fetch-debugpy.ps1"
            .to_string()
    })?;

    // ---- 5. 环境装配（probe=false；§3.2 调试态 probe 恒 false，instance 亦不注入——
    //     调试不写运行 trace，§19-5 的实例归属只服务运行链路）----
    let run_env = crate::run_env::build_run_env(
        app,
        &script_abs,
        workspace_root,
        &run_config,
        /* probe= */ false,
        /* instance= */ None,
    );

    // 解释器：工作区配置 > 系统 Python 兜底（adapter 也需要一个 Python；
    // 用与 debuggee 相同的解释器，保证 debugpy 的 .pyd 加速模块版本匹配）。
    // P3-2（2026-09-29 review）：合并原「uv 检查 + uv_fallback 再检查」的双分支——
    // 两种错误文案的差异是有意的（有 uv 时引导选解释器；无 uv 时提示装 uv）。
    let python = match &interpreter {
        Some(p) => p.clone(),
        None => {
            let has_uv = crate::tool_paths::is_available("uv", crate::tool_paths::ENV_UV);
            return Err(if has_uv {
                "调试需要先选择 Python 解释器（状态栏 → 选择解释器）。uv 兜底模式暂不支持调试。".to_string()
            } else {
                "未选择解释器且未找到 uv，无法启动调试（可在状态栏选择解释器，或先安装 uv）".to_string()
            });
        }
    };

    // ---- 6. spawn stdio adapter（管道模式；DAP 对端）----
    let adapter_dir = debugpy_dir.join("adapter");
    log_line(
        Level::Info,
        &format!("[dap] spawn adapter: {python} {}", adapter_dir.to_string_lossy()),
    );

    let mut adapter_cmd = std::process::Command::new(&python);
    adapter_cmd
        .arg(&adapter_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (k, v) in &run_env.env {
        adapter_cmd.env(k, v);
    }
    // Windows 隐藏控制台窗口（同 util::no_window 语义，但 std::process 版本）
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        adapter_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut adapter = adapter_cmd
        .spawn()
        .map_err(|e| format!("无法启动 debugpy adapter: {e}"))?;

    let adapter_stdin = adapter.stdin.take().ok_or("无法获取 adapter stdin")?;
    let adapter_stdout = adapter.stdout.take().ok_or("无法获取 adapter stdout")?;

    // ---- 7. 填充占位槽（哨兵 → 真实 adapter；seq 已在 debug_start 占位时分配）----
    {
        let mut d = DEBUG.lock();
        match d.get_mut(wid) {
            Some(s) if s.seq == seq => {
                s.adapter = Some(adapter);
                s.adapter_stdin = Some(Arc::new(Mutex::new(adapter_stdin)));
            }
            // 槽被并发替换（哨兵已被清走）：杀掉刚 spawn 的 adapter 防孤儿，报错退出。
            _ => {
                let apid = adapter.id();
                let _ = adapter.kill();
                let _ = adapter.wait();
                if apid != 0 {
                    crate::util::kill_pid_tree(apid);
                }
                return Err("调试会话状态冲突，请重试".into());
            }
        }
    }

    // ---- 8. adapter stdout 读线程（帧解析 → dap-message 事件，同 lsp.rs 模式）----
    let app_read = app.clone();
    let wid_read = wid.to_string();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(adapter_stdout);
        loop {
            match read_dap_frame(&mut reader) {
                Ok(Some(payload)) => {
                    let _ = app_read.emit_to(&wid_read, "dap-message", payload);
                }
                Ok(None) => break,
                Err(e) => {
                    log_line(Level::Warn, &format!("[dap] 帧解析错误: {e}"));
                    break;
                }
            }
        }
        log_line(Level::Info, "[dap] adapter stdout closed");
    });

    // ---- 9. adapter 退出监视（adapter 死亡 = 会话终了；seq 防误报新会话）----
    let app_watch = app.clone();
    let wid_watch = wid.to_string();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let finished = {
                let mut d = DEBUG.lock();
                match d.get_mut(&wid_watch) {
                    None => return,
                    Some(s) => {
                        if s.seq != seq {
                            return;
                        }
                        // adapter 进程已退出（从槽里 try_wait；需 &mut）
                        match s.adapter.as_mut() {
                            None => true,
                            Some(a) => matches!(a.try_wait(), Ok(Some(_))),
                        }
                    }
                }
            };
            if finished {
                // 竞态修复：finished 判定阶段虽已确认 seq 匹配，但判定与 take 之间锁已释放；
                // 需在同一锁内「检查 seq + take」原子完成，避免误清 debug_start 新建立的新会话。
                let sess = {
                    let mut d = DEBUG.lock();
                    let matches = d.get(&wid_watch).map(|s| s.seq) == Some(seq);
                    if matches { d.remove(&wid_watch) } else { None }
                };
                if let Some(s) = sess {
                    // debuggee 可能还活着（adapter 死了 pydevd 会继续跑）：杀树
                    if let Some(pid) = s.debuggee_pid {
                        crate::util::kill_pid_tree(pid);
                    }
                    log_line(Level::Info, &format!("[dap] adapter exited (seq={})", s.seq));
                    let _ = app_watch.emit_to(&wid_watch, "debug-exited", json!({ "reason": "exited", "seq": s.seq }));
                }
                return;
            }
        }
    });

    log_line(Level::Info, &format!("[dap] debug_start ok: adapter spawned (seq={seq})"));
    // P1-11：携带会话 seq（前端记录本会话身份，供 debug-exited 比对）
    let _ = app.emit_to(wid, "debug-started", json!({ "port": 0, "pid": null, "seq": seq }));
    Ok(())
}

/// 在 PTY 里拉起被调试脚本（--connect 连 adapter）。
/// 由前端在收到 debugpyWaitingForServer 事件（携带 server host:port）后调用——
/// 这是 stdio adapter 架构的关键时序（attach 在前，debuggee 后连入）。
#[tauri::command]
pub async fn debug_attach_debuggee(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    workspace_root: Option<String>,
    host: String,
    port: u16,
) -> Result<(), String> {
    let wid = window.label().to_string();
    // 会话必须存在且未挂 debuggee
    let debugpy_dir = {
        let d = DEBUG.lock();
        let s = d.get(&wid).ok_or("调试会话未启动")?;
        if s.debuggee_pid.is_some() {
            return Err("被调试脚本已启动".into());
        }
        locate_debugpy_dir(&app).ok_or("debugpy 副本丢失")?
    };

    let p = std::path::Path::new(&path);
    let dir = p.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
    let script_abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    };

    let run_config = workspace_root
        .as_deref()
        .map(|r| crate::env_cmds::read_run_config(r, &path))
        .unwrap_or_default();
    // P1-I：解释器解析（配置级覆盖 > 工作区配置）
    let profile_interpreter = run_config.interpreter.trim().to_string();
    let interpreter = if profile_interpreter.is_empty() {
        workspace_root
            .as_deref()
            .and_then(|r| crate::env_cmds::get_interpreter(r.to_string()).ok().flatten())
            .ok_or("调试需要已选择的解释器（debug_start 已校验，此处不应到达）")?
    } else {
        profile_interpreter
    };
    let run_env = crate::run_env::build_run_env(
        &app,
        &script_abs,
        workspace_root.as_deref(),
        &run_config,
        false,
        None,
    );

    // debuggee 以管道模式 spawn（stdout/stderr → 输出面板，同 run_script 模式）。
    // 实测结论（2026-09-10 二分验证）：ConPTY 下 pydevd 的回连 socket 不工作
    // （--connect 30s 不回连；禁用全部注入 env 后依旧 → 与环境变量无关，
    // 是 ConPTY 本身与 pydevd 网络线程的兼容性问题；--listen 模式同理翻车）。
    // 管道模式下全链路已验证（initialize → attach{listen} → WaitingForServer →
    // debuggee --connect → initialized → stopped → stack，2.2s）。
    // 代价：调试期 stdout 走输出面板而非终端（input() 交互暂不支持）。
    let connect_addr = format!("{host}:{port}");
    let connect_addr_for_log = connect_addr.clone();

    // P0-C/D：module 入口与工作目录——调试与运行消费同一份配置（entry/cwd）。
    // debugpy CLI 支持 `-m <module>` 形式：`python -m debugpy --connect ... -m <module> [args…]`
    let is_module = run_config.entry.is_module();
    if run_config.entry.kind == "module" && !is_module {
        return Err("运行配置选择了模块入口，但模块名为空".into());
    }
    let cwd = crate::run_env::resolve_run_cwd(
        &run_config.cwd,
        workspace_root.as_deref(),
        Some(&dir),
        is_module,
    );

    let mut cmd = std::process::Command::new(&interpreter);
    cmd.arg(debugpy_dir.join("__main__.py").to_string_lossy().to_string());
    cmd.arg("--connect");
    cmd.arg(&connect_addr);
    cmd.arg("--wait-for-client");
    if is_module {
        cmd.arg("-m");
        cmd.arg(run_config.entry.target_trimmed());
    } else {
        cmd.arg(script_abs.to_string_lossy().to_string());
    }
    cmd.args(&run_env.args);
    cmd.current_dir(&cwd);
    for (k, v) in &run_env.env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::util::no_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动调试命令: {e}"))?;

    let pid = child.id();
    let stdout = child.stdout.take().ok_or("无法获取 debuggee stdout")?;
    let stderr = child.stderr.take().ok_or("无法获取 debuggee stderr")?;

    // debuggee 输出转发到前端（v3.4 §13.3/§17-16：独立事件 debug-stdout / debug-stderr → 输出面板。
    // 运行角色的 run-stdout/run-stderr 已随 piped 路径下线，调试输出不再借道运行事件——
    // 否则前端删运行监听时会误伤调试承载（§19-9 断链风险，前后端必须同步更名）。
    let app_out = app.clone();
    let wid_out = wid.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break,
                Ok(_) => {
                    let _ = app_out.emit_to(&wid_out, "debug-stdout", json!({ "data": String::from_utf8_lossy(&buf) }));
                }
                Err(_) => break,
            }
        }
    });
    let app_err = app.clone();
    let wid_err = wid.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break,
                Ok(_) => {
                    let _ = app_err.emit_to(&wid_err, "debug-stderr", json!({ "data": String::from_utf8_lossy(&buf) }));
                }
                Err(_) => break,
            }
        }
    });

    // debuggee 退出监视：清 DEBUG 槽（seq 防误报）+ 杀 adapter。
    // 竞态修复：「检查 seq + take」必须在同一锁临界区内原子完成——若先 take 再判 seq，
    // 旧 debuggee 监视线程在 debug_stop → debug_start 新会话后迟到醒来时会 take 走新会话
    // （seq 已变）→ 新会话失联（debug_busy 误判 false、debug_stop 拿不到会话、debugpy 孤儿）。
    let app_watch = app.clone();
    let wid_watch = wid.clone();
    let seq_now = {
        let d = DEBUG.lock();
        d.get(&wid).map(|s| s.seq).unwrap_or(0)
    };
    let mut child_owned = child;
    std::thread::spawn(move || {
        let _ = child_owned.wait();
        let sess = {
            let mut d = DEBUG.lock();
            let matches = d.get(&wid_watch).map(|s| s.seq) == Some(seq_now);
            if matches { d.remove(&wid_watch) } else { None }
        };
        if let Some(s) = sess {
            if let Some(mut adapter) = s.adapter {
                // 铁律 1：adapter 也按 pid 杀树（防包装器场景孙进程孤儿化）
                let apid = adapter.id();
                let _ = adapter.kill();
                let _ = adapter.wait();
                if apid != 0 {
                    crate::util::kill_pid_tree(apid);
                }
            }
            log_line(Level::Info, "[dap] debuggee exited; session finished");
            let _ = app_watch.emit_to(&wid_watch, "debug-exited", json!({ "reason": "exited", "seq": s.seq }));
        } else {
            // 槽为空（已被 debug_stop/其它线程清）或已被新会话替换：本线程迟到，不碰新会话
            log_line(Level::Warn, "[dap] stale debuggee-exit watcher fired");
        }
    });

    {
        let mut d = DEBUG.lock();
        if let Some(s) = d.get_mut(&wid) {
            s.debuggee_pid = Some(pid);
        }
    }
    log_line(Level::Info, &format!("[dap] debuggee spawned (pipes): pid={pid} connect={connect_addr_for_log}"));
    Ok(())
}

/// 停止调试会话：**立即返回**，清理在后台线程执行（CR-10 纪律：
/// 同步 taskkill / ConPTY drop 会卡主线程 → UI 无响应，实测踩坑）。
#[tauri::command]
pub fn debug_stop(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let wid = window.label().to_string();
    let sess = DEBUG.remove(&wid);
    let Some(s) = sess else { return Ok(()) };
    std::thread::spawn(move || cleanup_session_payload(s, &app, &wid));
    Ok(())
}

// ---------- DAP 请求 / 通知发送（写 adapter stdin） ----------

/// 发送 DAP 请求（前端组装 id/method/params；id 直接作为出站 seq——
/// debugpy 的响应以 request_seq 回显请求 seq，前端据此关联 Promise）。
#[tauri::command]
pub fn dap_send_request(window: tauri::WebviewWindow, id: i64, method: String, params: Value) -> Result<(), String> {
    let msg = json!({ "seq": id, "type": "request", "command": method, "arguments": params });
    send_dap(window.label(), &msg)
}

/// 发送 DAP 通知。
#[tauri::command]
pub fn dap_send_notification(window: tauri::WebviewWindow, method: String, params: Value) -> Result<(), String> {
    let msg = json!({ "seq": next_seq(), "type": "event", "event": method, "body": params });
    send_dap(window.label(), &msg)
}

/// 客户端 → debugpy 的响应（预留）。
#[tauri::command]
pub fn dap_send_response(window: tauri::WebviewWindow, request_seq: i64, body: Value) -> Result<(), String> {
    let msg = json!({ "seq": next_seq(), "type": "response", "request_seq": request_seq, "success": true, "body": body });
    send_dap(window.label(), &msg)
}

/// DAP 出站消息序号（通知/响应用；请求 seq 由前端 id 提供）。
fn next_seq() -> u64 {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(100_000);
    SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// 写一帧到 adapter stdin（CR-03：锁内只取克隆，写阻塞不持全局锁）。
fn send_dap(wid: &str, msg: &Value) -> Result<(), String> {
    let stdin = {
        let d = DEBUG.lock();
        d.get(wid)
            .and_then(|s| s.adapter_stdin.clone())
            .ok_or("调试会话未启动")?
    };
    let payload = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    let mut stdin = unpoison(stdin.lock());
    write!(stdin, "Content-Length: {}\r\n\r\n{}", payload.len(), payload).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

// ---------- 应用退出清理（CR-14：同步，不能被进程退出截断） ----------

pub(crate) fn debug_stop_for_exit() {
    for mut s in DEBUG.drain_all() {
        if let Some(pid) = s.debuggee_pid {
            crate::util::kill_pid_tree(pid);
        }
        if let Some(adapter) = s.adapter.as_mut() {
            let pid = adapter.id();
            let _ = adapter.kill();
            let _ = adapter.wait();
            if pid != 0 {
                crate::util::kill_pid_tree(pid);
            }
        }
    }
}

/// 窗口销毁清理：停止该窗口的调试会话。
/// P1-2（2026-09-29 review）：原实现同步 taskkill（debuggee 树庞大时主线程冻结数秒，
/// WindowEvent::Destroyed 回调在主线程执行）；改为取出载荷后后台线程清理，
/// 与 `debug_stop` 命令（CR-10 纪律：立即返回）同构。窗口销毁后前端已不存在，
/// 无需（也无法有效）emit debug-exited，走静默清理路径。
pub(crate) fn debug_stop_for_window(wid: &str) {
    if let Some(s) = DEBUG.remove(wid) {
        std::thread::spawn(move || cleanup_session_payload_quiet(s));
    }
}

/// [`cleanup_session_payload`] 的静默版：不发 debug-exited（窗口销毁/无前端接收方场景）。
fn cleanup_session_payload_quiet(s: DebugSession) {
    if let Some(pid) = s.debuggee_pid {
        crate::util::kill_pid_tree(pid);
    }
    if let Some(mut adapter) = s.adapter {
        let pid = adapter.id();
        let _ = adapter.kill();
        let _ = adapter.wait();
        if pid != 0 {
            crate::util::kill_pid_tree(pid);
        }
    }
    log_line(Level::Info, "[dap] cleanup_session (window) done");
}

// ---------- 单测 ----------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn dap_frame(payload: &str) -> Vec<u8> {
        format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload).into_bytes()
    }

    #[test]
    fn reads_content_length_frame() {
        let payload = r#"{"seq":1,"type":"response","request_seq":7,"success":true}"#;
        let second = r#"{"seq":2,"type":"event","event":"stopped"}"#;
        let mut buf = dap_frame(payload);
        buf.extend_from_slice(&dap_frame(second));
        let mut cursor = Cursor::new(buf);
        let got = read_dap_frame(&mut cursor).unwrap().expect("应读出一帧");
        assert_eq!(got["request_seq"].as_i64(), Some(7));
        let got2 = read_dap_frame(&mut cursor).unwrap().expect("应读出第二帧");
        assert_eq!(got2["event"].as_str(), Some("stopped"));
    }

    #[test]
    fn returns_none_on_empty_input() {
        let mut cursor = Cursor::new(Vec::<u8>::new());
        assert!(read_dap_frame(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn errors_without_content_length() {
        let mut cursor = Cursor::new(b"Header: 1\r\n\r\n{}".to_vec());
        assert!(read_dap_frame(&mut cursor).is_err());
    }

    #[test]
    fn rejects_oversized_content_length() {
        let header = format!("Content-Length: {}\r\n\r\n", MAX_DAP_FRAME_LEN + 1);
        let mut cursor = Cursor::new(header.into_bytes());
        assert!(read_dap_frame(&mut cursor).is_err());
    }

    // ---------- scan_debugpy_dep ----------

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("pylume-dap-{tag}-{nanos}"));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn scan_finds_debugpy_in_requirements() {
        let d = tmpdir("req");
        std::fs::write(d.join("requirements.txt"), "# deps\nrequests\nDEBUGPY>=1.8\n").unwrap();
        let (found, files) = scan_debugpy_dep(&d);
        assert!(found);
        assert_eq!(files, vec!["requirements.txt".to_string()]);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn scan_ignores_comments_and_similar_names() {
        let d = tmpdir("comments");
        std::fs::write(d.join("requirements.txt"), "# debugpy not needed\npydevd-pycharm\nrequests\n").unwrap();
        let (found, _) = scan_debugpy_dep(&d);
        assert!(!found);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn scan_finds_debugpy_in_pyproject_project_deps() {
        let d = tmpdir("pyproject");
        std::fs::write(
            d.join("pyproject.toml"),
            "[project]\nname = \"x\"\n\n[project.dependencies]\ndebugpy = \">=1.8\"\nrequests = \"*\"\n",
        )
        .unwrap();
        let (found, files) = scan_debugpy_dep(&d);
        assert!(found);
        assert_eq!(files, vec!["pyproject.toml".to_string()]);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn scan_no_hit_on_clean_workspace() {
        let d = tmpdir("clean");
        let (found, files) = scan_debugpy_dep(&d);
        assert!(!found);
        assert!(files.is_empty());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn requirements_line_variants() {
        for line in ["debugpy", "debugpy>=1.8", "debugpy == 1.8.0", " debugpy; python_version >= '3.10'"] {
            assert!(requirements_line_mentions_debugpy(line), "应命中: {line}");
        }
        for line in ["", "# debugpy comment", "-r requirements-base.txt", "pydevd-pycharm", "debugpy-foo"] {
            assert!(!requirements_line_mentions_debugpy(line), "不应命中: {line}");
        }
    }

    // ---------- verbatim 剥离 ----------

    #[test]
    fn strip_verbatim_prefixes() {
        use std::path::Path;
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\F:\ai-pro\open-charm\vendor\debugpy\debugpy")),
            Path::new(r"F:\ai-pro\open-charm\vendor\debugpy\debugpy"),
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\server\share\debugpy")),
            Path::new(r"\\server\share\debugpy"),
        );
        assert_eq!(strip_verbatim(PathBuf::from(r"F:\normal\path")), Path::new(r"F:\normal\path"));
        assert_eq!(strip_verbatim(PathBuf::from(r"\\server\normal")), Path::new(r"\\server\normal"));
    }
}
