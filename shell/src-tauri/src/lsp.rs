// LSP 桥 Rust 侧（ADR-0003）：spawn 引擎进程（stdio）+ Content-Length 帧解析 + 事件转发。
// 引擎无关：pyrefly / basedpyright / pylume-intel 只是前端传入的命令不同。
//
// P3-T06'：多引擎支持——`engine` 键区分实例（"static" / "intel"），事件 payload 带 engine
// 供前端按引擎分发；intel 缺席不拖垮静态引擎（两实例独立 stdio/线程）。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

use crate::file_ops::project_hash;
use crate::tool_paths::resolve_lsp_command;
use crate::logging::{log_line, Level};
use crate::util::{kill_process_tree, kill_process_tree_async, no_window, pylume_home, unpoison};

use std::sync::atomic::{AtomicU64, Ordering};

struct LspInstance {
    child: Option<Child>,
    /// CR-03：stdin 独立加锁持有——send_message 取 Arc 克隆后**释放全局锁再写**。
    /// 持全局锁做阻塞写（大文件 didOpen >64KB 管道满 / 引擎假死）时，
    /// lsp_stop 与退出监视线程均拿不到锁 → 无法 kill，子系统死锁。
    stdin: Option<Arc<Mutex<std::process::ChildStdin>>>,
    /// 实例序号（单调递增）：退出监视线程据此判断所监视实例是否已被重启替换。
    seq: u64,
}

static LSP: LazyLock<Mutex<HashMap<String, LspInstance>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static LSP_SEQ: AtomicU64 = AtomicU64::new(0);

/// LSP 实例的复合键：窗口 + 引擎（多窗口计划阶段 1：按窗口隔离）。
fn lsp_key(wid: &str, engine: &str) -> String {
    format!("{wid}:{engine}")
}

/// 启动 LSP 引擎进程（stdio），spawn stdout 帧 / stderr / 退出监视三个线程。
/// `engine` 为实例键（如 "static" / "intel"）；同名重启先杀旧实例。
/// `cwd`：引擎进程工作目录（= 用户工作区根）。pyrefly 等引擎从 **cwd** 发现
/// pyproject.toml / pyrefly.toml 并启动工作区索引——不设 cwd 时引擎继承本应用
/// 的进程目录，永远找不到用户项目的 config，references/rename 只覆盖已 open 的文件。
#[tauri::command]
pub fn lsp_start(app: AppHandle, window: tauri::WebviewWindow, engine: String, command: String, args: Vec<String>, cwd: Option<String>) -> Result<(), String> {
    let wid = window.label().to_string();
    let key = lsp_key(&wid, &engine);
    {
        let inst = unpoison(LSP.lock()).remove(&key);
        if let Some(mut inst) = inst {
            if let Some(child) = inst.child.take() {
                // CR-10：异步终止——同步 taskkill 对庞杂进程树可耗时数秒，会卡住启动调用方（UI）
                kill_process_tree_async(child); // 连同可能的子进程一并终止
            }
        }
    }

    let mut start_cmd = resolve_lsp_command(&command);
    start_cmd.args(&args);
    if let Some(dir) = cwd.as_deref() {
        start_cmd.current_dir(dir);
    }
    start_cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = no_window(&mut start_cmd)
        .spawn()
        .map_err(|e| format!("无法启动 `{command}`: {e}（请确认已安装并在 PATH 中）"))?;

    let stdin = child.stdin.take().ok_or("无法获取 stdin")?;
    let stdout = child.stdout.take().ok_or("无法获取 stdout")?;
    let stderr = child.stderr.take().ok_or("无法获取 stderr")?;

    let seq = LSP_SEQ.fetch_add(1, Ordering::Relaxed);
    {
        let mut map = unpoison(LSP.lock());
        map.insert(key, LspInstance { child: Some(child), stdin: Some(Arc::new(Mutex::new(stdin))), seq });
    }

    // stdout 读线程：Content-Length 帧解析 → lsp-message 事件（payload 带 engine）
    let app_out = app.clone();
    let engine_out = engine.clone();
    let wid_out = wid.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_frame(&mut reader) {
                Ok(Some(mut payload)) => {
                    if let Value::Object(map) = &mut payload {
                        map.insert("engine".to_string(), json!(engine_out));
                    }
                    let _ = app_out.emit_to(&wid_out, "lsp-message", payload);
                }
                Ok(None) => break,
                Err(e) => {
                    eprintln!("[lsp-bridge] 帧解析错误: {e}");
                    break;
                }
            }
        }
    });

    // stderr 读线程 → lsp-stderr 事件
    let app_err = app.clone();
    let engine_err = engine.clone();
    let wid_err = wid.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break,
                Ok(_) => {
                    let _ = app_err.emit_to(&wid_err, "lsp-stderr", json!({ "engine": engine_err, "data": String::from_utf8_lossy(&buf) }));
                }
                Err(_) => break,
            }
        }
    });

    // 退出监视线程：以实例序号 seq 锁定监视对象。若同名引擎被重启（seq 变化），
    // 旧线程立即退出，避免误读新实例产生重复 lsp-exit / 线程累积。
    let app_exit = app.clone();
    let engine_exit = engine.clone();
    let wid_exit = wid.clone();
    let key_exit = lsp_key(&wid_exit, &engine_exit);
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let code = {
            let mut map = unpoison(LSP.lock());
            match map.get_mut(&key_exit) {
                Some(inst) => {
                    if inst.seq != seq {
                        return; // 实例已被重启替换
                    }
                    match inst.child.as_mut() {
                        Some(child) => match child.try_wait() {
                            Ok(Some(status)) => {
                                inst.child = None;
                                inst.stdin = None;
                                status.code()
                            }
                            Ok(None) => continue,
                            Err(_) => {
                                inst.child = None;
                                inst.stdin = None;
                                None
                            }
                        },
                        None => return,
                    }
                }
                None => return,
            }
        };
        let _ = app_exit.emit_to(&wid_exit, "lsp-exit", json!({ "engine": engine_exit, "code": code }));
        return;
    });

    Ok(())
}

/// 单帧 payload 上限（CR-09）：正常 LSP 消息（补全/诊断/hover）远小于此；
/// `Content-Length` 完全来自对端，异常/被攻陷引擎发超大值会触发巨额分配，超限即断开。
const MAX_FRAME_LEN: usize = 64 * 1024 * 1024;

/// 读取一个 LSP 帧（Content-Length 头 + JSON payload）
fn read_frame(reader: &mut impl BufRead) -> Result<Option<Value>, String> {
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
    if len > MAX_FRAME_LEN {
        return Err(format!("Content-Length 超上限（{len} > {MAX_FRAME_LEN}）"));
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).map_err(|e| e.to_string())?;
    serde_json::from_slice(&buf).map(Some).map_err(|e| e.to_string())
}

/// 发送请求（前端组装 id/method/params，这里只做帧封装写 stdin）
#[tauri::command]
pub fn lsp_send_request(window: tauri::WebviewWindow, engine: String, id: i64, method: String, params: Value) -> Result<(), String> {
    let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    send_message(&lsp_key(window.label(), &engine), &msg)
}

#[tauri::command]
pub fn lsp_send_notification(window: tauri::WebviewWindow, engine: String, method: String, params: Value) -> Result<(), String> {
    let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
    send_message(&lsp_key(window.label(), &engine), &msg)
}

/// 响应服务端→客户端请求（如 workspace/configuration；不响应会导致引擎挂起，见 P1-BUG-001）
#[tauri::command]
pub fn lsp_send_response(window: tauri::WebviewWindow, engine: String, id: i64, result: Value) -> Result<(), String> {
    let msg = json!({ "jsonrpc": "2.0", "id": id, "result": result });
    send_message(&lsp_key(window.label(), &engine), &msg)
}

fn send_message(engine: &str, msg: &Value) -> Result<(), String> {
    // CR-03：全局锁只保护 map 增删查——取出 Arc 克隆后立即释放再写。
    // 写阻塞不再持全局锁，lsp_stop / 退出监视线程始终可以拿到 map 完成清理。
    let stdin = {
        let map = unpoison(LSP.lock());
        map.get(engine)
            .and_then(|i| i.stdin.clone())
            .ok_or("LSP 未启动")?
    };
    let payload = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    let mut stdin = unpoison(stdin.lock());
    write!(stdin, "Content-Length: {}\r\n\r\n{}", payload.len(), payload).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

/// 停止 LSP 引擎进程；`engine` 为 "*" / "all" 时停止全部实例。
#[tauri::command]
pub fn lsp_stop(window: tauri::WebviewWindow, engine: String) -> Result<(), String> {
    let start = std::time::Instant::now();
    log_line(Level::Info, &format!("[lsp_stop] begin engine={engine}"));
    let wid = window.label().to_string();
    let key = lsp_key(&wid, &engine);
    let mut map = unpoison(LSP.lock());
    if engine == "*" || engine == "all" {
        // 只停本窗口的全部实例（按复合键前缀过滤），不误杀其他窗口的 LSP
        let prefix = format!("{wid}:");
        let keys: Vec<String> = map.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        for k in keys {
            if let Some(mut inst) = map.remove(&k) {
                if let Some(c) = inst.child.take() {
                    log_line(Level::Debug, &format!("[lsp_stop] kill_process_tree_async: pid={}", c.id()));
                    kill_process_tree_async(c); // 异步终止，避免关闭工作区时阻塞数秒
                }
            }
        }
    } else if let Some(mut inst) = map.remove(&key) {
        if let Some(c) = inst.child.take() {
            log_line(Level::Debug, &format!("[lsp_stop] kill_process_tree_async: pid={}", c.id()));
            kill_process_tree_async(c);
        }
    }
    log_line(Level::Info, &format!("[lsp_stop] done, took={:?}", start.elapsed()));
    Ok(())
}

/// 定位 pylume-intel 二进制，优先顺序：
/// 1) 环境变量 PYLUME_INTEL_BIN；
/// 2) 托管目录 <data_root>/runtime/；
/// 3) Tauri 资源目录（打包分发，第 3 步 bundle.resources 落地）；
/// 4) dev 相对 exe 上溯仓库布局（intel/target/<profile>/）。
fn locate_intel_binary(app: &AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("PYLUME_INTEL_BIN") {
        let p = std::path::PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let exe_name = if cfg!(windows) { "pylume-intel.exe" } else { "pylume-intel" };

    let runtime = crate::tool_paths::runtime_dir().join(exe_name);
    if runtime.is_file() {
        return Some(runtime);
    }
    for dir in crate::util::resource_candidates(app) {
        let cand = dir.join(exe_name);
        if cand.is_file() {
            return Some(cand);
        }
    }

    let mut dir = std::env::current_exe().ok()?;
    for _ in 0..6 {
        dir.pop();
        for profile in ["release", "debug"] {
            let cand = dir.join("intel").join("target").join(profile).join(exe_name);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// 供前端启动 intel：返回 { command, traceDbPath }（command 为 null 表示二进制未构建）。
#[tauri::command]
pub fn get_intel_info(app: AppHandle, workspace_root: String) -> Result<Value, String> {
    let dir = pylume_home().join("traces");
    let trace_db_path = dir
        .join(format!("{}.db", project_hash(&workspace_root)))
        .to_string_lossy()
        .to_string();
    let command = locate_intel_binary(&app).map(|p| p.to_string_lossy().to_string());
    Ok(json!({ "command": command, "traceDbPath": trace_db_path }))
}

/// CR-14：应用退出（RunEvent::Exit）清理——同步终止全部 LSP 引擎进程树。
/// 退出路径不能用 `kill_process_tree_async`：后台线程会被进程退出截断，taskkill 半途而废、
/// 子进程照样成孤儿；退出时短暂同步阻塞可接受。
/// （v3.4 §17-16：piped 运行路径的 `stop_script_for_exit` 已随运行域下线，运行进程的退出
/// 清理统一由 `terminal::term_kill_all_for_exit` 承担——运行全部走 PTY 会话。）
pub(crate) fn lsp_stop_all_for_exit() {
    let insts: Vec<LspInstance> = unpoison(LSP.lock()).drain().map(|(_, i)| i).collect();
    for mut inst in insts {
        if let Some(mut child) = inst.child.take() {
            kill_process_tree(&mut child);
        }
    }
}

/// 窗口销毁清理：停止该窗口的全部引擎实例（按复合键前缀 `{wid}:` 匹配）。
pub(crate) fn lsp_stop_for_window(wid: &str) {
    let prefix = format!("{wid}:");
    let insts: Vec<LspInstance> = {
        let mut map = unpoison(LSP.lock());
        let keys: Vec<String> = map.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        keys.into_iter().filter_map(|k| map.remove(&k)).collect()
    };
    for mut inst in insts {
        if let Some(c) = inst.child.take() {
            kill_process_tree_async(c);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn frame(payload: &str) -> Vec<u8> {
        format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload).into_bytes()
    }

    #[test]
    fn reads_content_length_frame() {
        let payload = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let second = r#"{"jsonrpc":"2.0","method":"exit"}"#;
        let mut buf = frame(payload);
        buf.extend_from_slice(&frame(second));

        let mut cursor = Cursor::new(buf);
        // 第一帧解析正确
        let got = read_frame(&mut cursor).unwrap().expect("应读出一帧");
        assert_eq!(got["id"].as_i64(), Some(1));
        assert_eq!(got["result"], json!({}));
        // 连续第二帧仍可读（流式帧边界正确）
        let got2 = read_frame(&mut cursor).unwrap().expect("应读出第二帧");
        assert_eq!(got2["method"].as_str(), Some("exit"));
    }

    #[test]
    fn returns_none_on_empty_input() {
        let mut cursor = Cursor::new(Vec::<u8>::new());
        assert!(read_frame(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn errors_without_content_length() {
        // 头部无 Content-Length 行 → 缺头错误
        let mut cursor = Cursor::new(b"Header: 1\r\n\r\n{}".to_vec());
        assert!(read_frame(&mut cursor).is_err());
    }

    #[test]
    fn rejects_oversized_content_length() {
        // CR-09：超大 Content-Length 帧必须被拒（防异常/被攻陷引擎触发巨额分配 OOM）
        let header = format!("Content-Length: {}\r\n\r\n", MAX_FRAME_LEN + 1);
        let mut cursor = Cursor::new(header.into_bytes());
        assert!(read_frame(&mut cursor).is_err());
    }
}
