// 工具链引导（Phase 4 · 第 4 步）：首次启动探测 + 一键安装 uv / 静态引擎（pyrefly / basedpyright）。
//
// 全新 Windows 系统缺 uv / pyrefly 时，shell 的补全、跳转、运行均无法工作。
// 本模块补上「随包分发」外的最后一块：探测缺失项，并引导用户一键把外部工具
// 安装到**用户自有位置**（uv 官方默认 ~/.local/bin；工具本体落用户 uv 工具目录）。
// 工具归用户所有、跨项目可复用，Pylume 不托管、不重定向（见
// docs/data-directory-layout-v2.md §4.2 工具所有权原则）。
//
// 设计边界：只做「探测」与「引导安装」，不做版本锁定与升级；版本锁定仍走 ci/versions.toml。

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::tool_paths::{is_available, resolve_tool, ENV_RUFF, ENV_UV};
use crate::util::no_window;

/// 安装类命令超时（含网络下载）。
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);

/// 引擎 → uv/pip 包名。
fn engine_package(engine: &str) -> &'static str {
    match engine {
        "basedpyright" => "basedpyright",
        _ => "pyrefly",
    }
}

/// 引擎 → LSP 可执行命令名（与前端 client.ts 的 command 一致）。
fn engine_command(engine: &str) -> &'static str {
    match engine {
        "basedpyright" => "basedpyright-langserver",
        _ => "pyrefly",
    }
}

/// 探测工具链状态（uv / 当前静态引擎 / ruff），返回缺失清单供前端引导。
#[tauri::command]
pub fn detect_toolchain(engine: String) -> Result<Value, String> {
    let cmd = engine_command(&engine);
    let uv_ok = is_available("uv", ENV_UV);
    let engine_ok = is_available(cmd, "");
    let ruff_ok = is_available("ruff", ENV_RUFF);
    Ok(json!({
        "uv": uv_ok,
        "engine": { "name": engine, "command": cmd, "ok": engine_ok },
        "ruff": ruff_ok,
        "allOk": uv_ok && engine_ok,
    }))
}

/// 一键安装缺失工具（uv → 静态引擎），进度经 toolchain-stdout / toolchain-stderr 流式推送。
#[tauri::command]
pub async fn install_toolchain(app: AppHandle, window: tauri::WebviewWindow, engine: String) -> Result<bool, String> {
    let wid = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || install_toolchain_impl(app, &engine, &wid))
        .await
        .map_err(|e| format!("安装任务异常：{e}"))?
}

fn install_toolchain_impl(app: AppHandle, engine: &str, wid: &str) -> Result<bool, String> {
    let pkg = engine_package(engine);
    let cmd = engine_command(engine);

    // 1. 确保 uv 就绪（缺失则走官方安装脚本，装到官方默认位置 ~/.local/bin，不重定向）
    if !is_available("uv", ENV_UV) {
        emit(&app, "toolchain-stdout", "安装 uv（官方脚本，默认位置 ~/.local/bin，需联网）…\n", wid)?;
        if cfg!(windows) {
            // 不设置 UV_INSTALL_DIR——uv 归用户所有，落官方默认位置，与其他项目共享。
            run_streaming(
                &app,
                "powershell.exe",
                &[
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    "irm https://astral.sh/uv/install.ps1 | iex",
                ],
                INSTALL_TIMEOUT,
                wid,
            )?;
        } else {
            run_streaming(
                &app,
                "sh",
                &["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"],
                INSTALL_TIMEOUT,
                wid,
            )?;
        }
    }

    // 2. 定位 uv 绝对路径（~/.local/bin 命中，无需新 shell 刷新 PATH）
    let uv = resolve_tool("uv", ENV_UV)
        .ok_or_else(|| "uv 安装后仍未找到，请重启 Pylume 或手动把 uv 加入 PATH".to_string())?;
    emit(&app, "toolchain-stdout", &format!("uv 位置：{}\n", uv.display()), wid)?;

    // 3. 安装静态引擎（uv tool install，走用户 uv 默认工具目录，入口脚本落 ~/.local/bin）
    if !is_available(cmd, "") {
        emit(&app, "toolchain-stdout", &format!("安装静态引擎 `{pkg}`（uv tool install）…\n"), wid)?;
        // 不设 UV_TOOL_BIN_DIR / UV_TOOL_DIR——工具落用户 uv 默认目录，跨项目可复用；
        // tool_command 仅注入 UV_DEFAULT_INDEX（PyPI 包源设置）。
        let mut cmd = crate::tool_paths::tool_command("uv", ENV_UV);
        cmd.args(["tool", "install", pkg]);
        run_streaming_cmd(&app, cmd, INSTALL_TIMEOUT, wid)?;
    }

    // 4. 复核
    let ok = is_available(cmd, "");
    emit(
        &app,
        "toolchain-stdout",
        if ok { "环境就绪。\n" } else { "安装结束，但引擎仍不可见；请重启 Pylume 后再试。\n" },
        wid,
    )?;
    Ok(ok)
}

/// 向 WebView 推送一行安装日志。
fn emit(app: &AppHandle, event: &str, data: &str, wid: &str) -> Result<(), String> {
    app.emit_to(wid, event, json!({ "data": data })).map_err(|e| e.to_string())
}

/// 后台线程逐行读取子进程输出并转发事件。
fn stream_lines<R: Read + Send + 'static>(
    r: R,
    app: AppHandle,
    event: &'static str,
    wid: String,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(r);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf).replace("\r\n", "\n").replace('\r', "\n");
                    let _ = app.emit_to(&wid, event, json!({ "data": text }));
                }
                Err(_) => break,
            }
        }
    })
}

/// 运行外部命令，流式转发 stdout/stderr，带超时；返回退出码。
fn run_streaming(app: &AppHandle, program: &str, args: &[&str], timeout: Duration, wid: &str) -> Result<i32, String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    run_streaming_cmd(app, cmd, timeout, wid)
}

/// 同 [`run_streaming`]，但接收已配置好（含环境变量注入）的 `Command`。
fn run_streaming_cmd(app: &AppHandle, mut cmd: Command, timeout: Duration, wid: &str) -> Result<i32, String> {
    let program = cmd.get_program().to_string_lossy().to_string();
    let mut child = no_window(&mut cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 `{program}`：{e}"))?;

    let out_thread = stream_lines(child.stdout.take().expect("stdout 已设为 piped"), app.clone(), "toolchain-stdout", wid.to_string());
    let err_thread = stream_lines(child.stderr.take().unwrap(), app.clone(), "toolchain-stderr", wid.to_string());

    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.code(),
            Ok(None) => {
                if start.elapsed() > timeout {
                    // P1-4（2026-09-29 review，铁律 1）：uv 安装脚本（powershell irm | iex）
                    // 会链式拉起下载/安装子进程——裸 kill 后这些子进程孤儿化继续写
                    // ~/.local/bin。改杀整棵进程树再 join 读线程。
                    crate::util::kill_process_tree(&mut child);
                    let _ = out_thread.join();
                    let _ = err_thread.join();
                    return Err(format!("命令执行超时（{} 秒）", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = out_thread.join();
                let _ = err_thread.join();
                return Err(format!("等待进程失败：{e}"));
            }
        }
    };
    let _ = out_thread.join();
    let _ = err_thread.join();
    Ok(code.unwrap_or(-1))
}