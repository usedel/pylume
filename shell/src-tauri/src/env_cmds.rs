// Python 环境管理（P25-T04）：uv 驱动 + 工作区配置存储。
// 设计要点：
// - 解释器选择存 <data_root>/workspaces/<project-hash>.json（不侵入用户项目，粒度与 probe 的 trace 库一致）；
// - 优先级：工作区配置 > 工作区 .venv 自动检测 > 无（uv run 兜底）；
// - uv 命令 120s 超时保护（创建环境/装包）；列表 15s 超时。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::collections::{HashMap, HashSet};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};

use crate::file_ops::project_hash;
use crate::logging::{log_line, Level};
use crate::tool_paths::{tool_command, ENV_UV};
use crate::util::{kill_process_tree, no_window, pylume_home, unpoison};

const UV_TIMEOUT: Duration = Duration::from_secs(120);
/// 创建 venv 时若指定未安装的 Python 版本，uv 会联网下载 CPython（数十 MB、慢网可达数分钟），
/// 120s 远远不够——超时会被 kill 致「下载完也重建失败」。单独给 10 分钟宽松超时。
const UV_VENV_TIMEOUT: Duration = Duration::from_secs(600);
const UV_LIST_TIMEOUT: Duration = Duration::from_secs(15);
/// outdated 查询需联网，单独给更短超时，避免环境面板被网络拖住
const UV_OUTDATED_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize)]
pub struct PythonInfo {
    pub path: String,
    pub version: String,
    /// workspace-venv | system | manual
    pub kind: String,
    pub is_selected: bool,
}

#[derive(Serialize)]
pub struct PackageInfo {
    pub name: String,
    pub version: String,
}

/// 可选的 Python 版本（uv python list 完整解析：已装 + 可下载），供 venv 版本下拉使用
#[derive(Serialize)]
pub struct PythonVersionOption {
    /// 展示版本，如 "3.13.7"
    pub version: String,
    /// uv --python 接受的标识，如 "cpython-3.13.7-windows-x86_64-none"
    pub spec: String,
    /// 已安装时的解释器路径
    pub path: Option<String>,
    /// 是否已安装
    pub installed: bool,
}

/// 过时包（uv pip list --outdated --format=json）
#[derive(Serialize, Deserialize)]
pub struct OutdatedInfo {
    pub name: String,
    pub version: String,
    #[serde(rename = "latest_version")]
    pub latest: String,
    #[serde(rename = "latest_filetype")]
    pub filetype: String,
}

/// 创建 venv 的返回：命令输出 + 创建后的解释器路径（前端直接持久化选中）
#[derive(Serialize)]
pub struct CreateVenvResult {
    pub output: String,
    pub python: String,
}

// ---------- 工作区配置存储 ----------

fn workspaces_dir() -> PathBuf {
    pylume_home().join("workspaces")
}

fn workspace_config_path(root: &str) -> PathBuf {
    workspaces_dir().join(format!("{}.json", project_hash(root)))
}

/// 读取整份工作区配置（缺失/损坏时返回空对象，绝不 panic）
pub(crate) fn load_config(root: &str) -> Value {
    let p = workspace_config_path(root);
    fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

/// 写回整份工作区配置（保留未涉及字段，如 interpreter 与 run_configs 互不覆盖）
pub(crate) fn save_config(root: &str, v: &Value) -> Result<(), String> {
    let p = workspace_config_path(root);
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let payload = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    fs::write(&p, payload).map_err(|e| e.to_string())
}

fn read_config(root: &str) -> Option<String> {
    load_config(root)
        .get("interpreter")
        .and_then(|x| x.as_str())
        .map(String::from)
}

fn write_config(root: &str, interpreter: Option<&str>) -> Result<(), String> {
    let mut v = load_config(root);
    let obj = v.as_object_mut().ok_or("工作区配置格式非法")?;
    match interpreter {
        Some(i) => {
            obj.insert("interpreter".into(), json!(i));
        }
        None => {
            // 显式写 null（= uv run 兜底）而非删键——get_interpreter 据「键是否存在」区分
            // 「显式选 uv run」与「从未设置（自动检测 .venv）」；删键会让自动检测覆盖用户选择
            obj.insert("interpreter".into(), json!(null));
        }
    }
    save_config(root, &v)
}

// ---------- 运行配置（v3.4：脚本配置（每文件）+ 项目配置（每项目））----------
//
// python_run_dev_plan.md §4：
// - 脚本配置：每文件一份（可选），存 run_configs map，键 = 脚本相对工作区根路径
//   （正斜杠，run_config_key 归一）；entry 恒为文件本身（系统填充，不参与存取语义）；
// - 项目配置：每项目一份，固定键 project_run，entry 为 module | script 二选一；
// - 旧 run_profiles 数组（v2 命名配置列表）直接忽略废弃：不读取、不转换、不回写（§4.3）。

/// 单个环境变量键值对
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

/// 运行入口（P0-C）：`Script path` / `Module name` 二选一（对齐 PyCharm）。
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
pub struct RunEntry {
    /// "script" | "module"
    #[serde(default = "default_entry_kind")]
    pub kind: String,
    /// script：脚本路径（相对工作区根、正斜杠；或绝对路径）；module：模块名（如 uvicorn）
    #[serde(default)]
    pub target: String,
}

fn default_entry_kind() -> String {
    "script".to_string()
}

impl Default for RunEntry {
    fn default() -> Self {
        Self { kind: default_entry_kind(), target: String::new() }
    }
}

impl RunEntry {
    /// 是否按模块入口执行：kind == "module" 且模块名非空（空模块名不允许跑 `-m`）。
    pub fn is_module(&self) -> bool {
        self.kind == "module" && !self.target.trim().is_empty()
    }

    /// 归一化后的目标（trim）
    pub fn target_trimmed(&self) -> &str {
        self.target.trim()
    }
}

/// 一份运行配置（v3.4 §4.2 字段表）：脚本配置与项目配置共用同一结构。
/// 脚本配置的 entry 由系统填充（= 文件本身），不参与用户编辑。
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct RunProfile {
    /// 运行入口：脚本 / 模块（项目配置二选一；脚本配置恒为 script 且 target 由系统填充）
    #[serde(default)]
    pub entry: RunEntry,
    /// 脚本参数（原始字符串，运行时用 shell-words 拆分）
    #[serde(default)]
    pub args: String,
    /// 工作目录（P0-D）：支持 ${workspaceRoot} / $PROJECT_DIR$ 宏；空 = 默认
    /// （script → 脚本所在目录，module → 工作区根）
    #[serde(default)]
    pub cwd: String,
    /// 自定义环境变量（用户值优先，见调研报告 §9 合并约定）
    #[serde(default)]
    pub env: Vec<EnvVar>,
    /// `.env` 文件列表（P1-G）：有序加载，注入位置 =「默认注入之后、用户显式 env 之前」。
    /// 相对路径以工作区根为基准；文件缺失仅告警不中断运行。
    #[serde(default)]
    pub env_files: Vec<String>,
    /// 配置级解释器覆盖（P1-I）：空 = 沿用工作区级解释器（历史行为）
    #[serde(default)]
    pub interpreter: String,
}

impl RunProfile {
    /// 是否为「等于没配置」（v3.4 字段表裁剪后）：args / env / cwd / env_files / interpreter
    /// 全缺省时，`set_run_config` 会移除该配置保持文件精简。
    /// 注意：脚本配置的 entry 由系统填充（= 文件本身），不参与判定。
    fn is_effectively_empty(&self) -> bool {
        self.args.trim().is_empty()
            && self.env.is_empty()
            && self.env_files.iter().all(|p| p.trim().is_empty())
            && self.cwd.trim().is_empty()
            && self.interpreter.trim().is_empty()
    }
}

/// 运行配置存储键：相对工作区根、统一正斜杠（跨平台稳定，避免绝对路径漂移）
fn run_config_key(workspace_root: &str, script_path: &str) -> String {
    let norm_root = workspace_root.replace('\\', "/");
    let norm_script = script_path.replace('\\', "/");
    let r = norm_root.trim_end_matches('/');
    if !r.is_empty() && norm_script.starts_with(r) {
        let mut rel = norm_script[r.len()..].to_string();
        if rel.starts_with('/') {
            rel.remove(0);
        }
        if !rel.is_empty() {
            return rel;
        }
    }
    // 不在工作区根下：退化为文件名，保证仍有一个稳定键
    norm_script
        .rsplit('/')
        .next()
        .unwrap_or(&norm_script)
        .to_string()
}

/// 项目配置的存储键（v3.4 §4.1：工作区配置固定键）
const PROJECT_RUN_KEY: &str = "project_run";

/// 读取脚本运行配置（v3.4 §4.1：存 run_configs map，键 = run_config_key）。
/// 无匹配返回缺省——读不到配置绝不阻断运行（§4.3）。
pub fn read_run_config(workspace_root: &str, script_path: &str) -> RunProfile {
    let key = run_config_key(workspace_root, script_path);
    load_config(workspace_root)
        .get("run_configs")
        .and_then(Value::as_object)
        .and_then(|m| m.get(&key))
        .and_then(|v| serde_json::from_value::<RunProfile>(v.clone()).ok())
        .map(|mut p| {
            // entry 恒为文件本身（系统填充，§4.2）：存量脏值一律纠正
            p.entry = RunEntry { kind: "script".into(), target: key.clone() };
            p
        })
        .unwrap_or_else(|| RunProfile {
            entry: RunEntry { kind: "script".into(), target: key },
            ..Default::default()
        })
}

/// 读取项目运行配置（v3.4 §4.1：固定键 project_run）；未配置返回 None。
pub(crate) fn read_project_run(workspace_root: &str) -> Option<RunProfile> {
    load_config(workspace_root)
        .get(PROJECT_RUN_KEY)
        .and_then(|v| serde_json::from_value::<RunProfile>(v.clone()).ok())
}

/// 读取项目运行配置（前端配置面板加载用）
#[tauri::command]
pub fn get_project_run(workspace_root: String) -> Option<RunProfile> {
    read_project_run(&workspace_root)
}

/// 保存项目运行配置（entry 为空 = 未配置，移除该键保持文件精简）
#[tauri::command]
pub fn set_project_run(workspace_root: String, config: RunProfile) -> Result<(), String> {
    write_project_run(&workspace_root, &config)
}

/// 项目配置写入（命令与 §9 探测共用）：固定键 `project_run`，entry 为空即移除。
fn write_project_run(workspace_root: &str, config: &RunProfile) -> Result<(), String> {
    let mut v = load_config(workspace_root);
    let obj = v.as_object_mut().ok_or("工作区配置格式非法")?;
    if config.entry.target.trim().is_empty() {
        obj.remove(PROJECT_RUN_KEY);
    } else {
        let value = serde_json::to_value(config).map_err(|e| e.to_string())?;
        obj.insert(PROJECT_RUN_KEY.into(), value);
    }
    save_config(workspace_root, &v)
}

/// 获取「当前文件」运行配置（前端编辑面板加载用，P3 时代命令签名不变）
#[tauri::command]
pub fn get_run_config(workspace_root: String, script_path: String) -> RunProfile {
    read_run_config(&workspace_root, &script_path)
}

/// 保存「当前文件」运行配置（全缺省则移除该配置，保持文件精简；脚本入口的 target 以系统解析为准）
#[tauri::command]
pub fn set_run_config(workspace_root: String, script_path: String, config: RunProfile) -> Result<(), String> {
    let key = run_config_key(&workspace_root, &script_path);
    let mut v = load_config(&workspace_root);
    let obj = v.as_object_mut().ok_or("工作区配置格式非法")?;
    let store = obj
        .entry("run_configs".to_string())
        .or_insert_with(|| json!({}));
    let map = store.as_object_mut().ok_or("工作区配置格式非法")?;
    if config.is_effectively_empty() {
        map.remove(&key);
    } else {
        let mut cfg = config;
        cfg.entry = RunEntry { kind: "script".into(), target: key.clone() };
        map.insert(key, serde_json::to_value(&cfg).map_err(|e| e.to_string())?);
    }
    if map.is_empty() {
        obj.remove("run_configs");
    }
    save_config(&workspace_root, &v)?;
    // tech-debt #9：保存时顺带清扫孤儿运行配置（脚本已删/改名留下的旧键）
    let _ = sweep_run_configs_impl(&workspace_root);
    Ok(())
}

/// 清扫孤儿运行配置：`run_configs` 中键对应文件不存在（脚本已删/改名）即移除（tech-debt #9）。
/// 返回移除的条目数；无 `run_configs` 时直接返回 0，绝不 panic。
fn sweep_run_configs_impl(workspace_root: &str) -> Result<usize, String> {
    let root = Path::new(workspace_root);
    let mut v = load_config(workspace_root);
    let obj = v.as_object_mut().ok_or("工作区配置格式非法")?;
    let Some(store) = obj.get_mut("run_configs") else {
        return Ok(0);
    };
    let Some(map) = store.as_object_mut() else {
        return Ok(0);
    };
    let keys = map.keys().cloned().collect::<Vec<_>>();
    let mut removed = 0usize;
    for key in keys {
        // 键为相对工作区根路径（正斜杠，run_config_key 口径）；存在性以根下拼接为准。
        // 纯文件名键（无 '/'）可能是工作区根目录文件，也可能是 run_config_key 对工作区外文件
        // 的退化键——二者无法靠键本身区分，保守跳过，避免误删工作区外文件的运行配置
        // （review 发现的边界：误删用户配置比残留无害键更不可接受）。
        if !key.contains('/') {
            continue;
        }
        let rel = key.replace('/', std::path::MAIN_SEPARATOR_STR);
        if !root.join(rel).is_file() {
            map.remove(&key);
            removed += 1;
        }
    }
    if map.is_empty() {
        obj.remove("run_configs");
    }
    if removed > 0 {
        save_config(workspace_root, &v)?;
    }
    Ok(removed)
}

/// 手动清扫孤儿运行配置（打开工作区时由前端调用；正常保存已自动清扫）。
#[tauri::command]
pub fn sweep_run_configs(workspace_root: String) -> Result<usize, String> {
    sweep_run_configs_impl(&workspace_root)
}

// ---------- venv 解释器定位 ----------

/// 指定虚拟环境目录下的解释器路径（Windows Scripts/python.exe，Unix bin/python）
fn venv_python_at(dir: &Path) -> Option<String> {
    let candidates: Vec<PathBuf> = if cfg!(windows) {
        vec![dir.join("Scripts").join("python.exe")]
    } else {
        vec![dir.join("bin").join("python")]
    };
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().to_string())
}

/// 工作区 .venv 解释器路径
fn venv_python(root: &str) -> Option<String> {
    venv_python_at(&Path::new(root).join(".venv"))
}

// ---------- 命令执行（带超时） ----------

/// 字节级通用执行：可选 stdin 数据 + 字节输出 + 超时。
/// 供 py_eval（lib_cmds）这类需要 stdin 传参、且要求按 UTF-8 字节显式解码输出的调用方使用；
/// 普通调用方走 `run_with_timeout`（本函数的 String 包装，保持既有语义：无效 UTF-8 → 空串）。
pub(crate) fn run_with_timeout_bytes(
    cmd: &mut Command,
    timeout: Duration,
    stdin_data: Option<&[u8]>,
) -> Result<(Vec<u8>, Vec<u8>, Option<i32>), String> {
    let mut child = no_window(cmd)
        .stdin(if stdin_data.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    // P1-7（2026-09-29 review）：stdin 写入移到独立线程——原实现在超时监督循环启动
    // **之前**同步 write_all，若子进程 hang 且不读 stdin（数据量超管道缓冲 ~64KB 时），
    // 写入永久阻塞，超时保护尚未生效，spawn_blocking 线程与命令 Promise 永久挂起。
    // 独立线程与下方两个读线程对称；写完 drop 关闭 stdin（脚本侧 read() 拿到 EOF）。
    let stdin_writer = stdin_data.map(|data| {
        let mut stdin = child.stdin.take().unwrap();
        let data = data.to_vec();
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = stdin.write_all(&data);
            let _ = stdin.flush();
        })
    });
    let stdout = child.stdout.take().expect("stdout 已设为 piped");
    let stderr = child.stderr.take().expect("stderr 已设为 piped");
    let out_reader = std::thread::spawn(move || read_all_bytes(stdout));
    let err_reader = std::thread::spawn(move || read_all_bytes(stderr));

    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {
                if start.elapsed() > timeout {
                    kill_process_tree(&mut child); // uv 可能已拉起子进程，须连树一起终止
                    // 杀树后管道关闭，写/读线程自然退出；join 收尸（不阻塞——进程已死）
                    if let Some(t) = stdin_writer {
                        let _ = t.join();
                    }
                    let _ = out_reader.join();
                    let _ = err_reader.join();
                    return Err(format!("命令执行超时（{}s）", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    if let Some(t) = stdin_writer {
        // 正常退出：子进程已终止，写线程不会再阻塞（管道对端关闭后写失败即返回）
        let _ = t.join();
    }
    let out = out_reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();
    Ok((out, err, code))
}

/// String 包装：与历史行为一致——stdout/stderr 按字符串读取，无效 UTF-8 时整体降级为空串。
/// pub(crate)：lib_cmds 的 `uv python find` 与测试复用（R-4：改可见性，禁止复制一份）。
pub(crate) fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<(String, String, Option<i32>), String> {
    run_with_timeout_bytes(cmd, timeout, None).map(|(o, e, c)| {
        (
            String::from_utf8(o).unwrap_or_default(),
            String::from_utf8(e).unwrap_or_default(),
            c,
        )
    })
}

fn read_all_bytes(r: impl Read) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut reader = BufReader::new(r);
    let _ = reader.read_to_end(&mut buf);
    buf
}

/// 运行 uv 命令并返回「成功输出」或「错误信息」（供 pip 安装/卸载等）。
fn run_uv_output(cmd: &mut Command) -> Result<String, String> {
    let (out, err, code) = run_with_timeout(cmd, UV_TIMEOUT)?;
    let combined = format!("{out}{err}").trim().to_string();
    if code != Some(0) {
        return Err(if combined.is_empty() { format!("命令失败（exit {code:?}）") } else { combined });
    }
    Ok(combined)
}

/// 逐行读取流并 emit 到前端（uv 进度条的 `\r` 统一转成 `\n`，适配前端按行滚动输出）。
fn stream_lines(
    r: impl Read + Send + 'static,
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
                    let cleaned = String::from_utf8_lossy(&buf).replace("\r\n", "\n").replace('\r', "\n");
                    let _ = app.emit_to(&wid, event, json!({ "data": cleaned }));
                }
                Err(_) => break,
            }
        }
    })
}

/// 流式运行 uv 命令：stdout/stderr 逐行推送到前端（pip-stdout / pip-stderr），返回 exit code。
fn run_uv_streaming(app: &AppHandle, cmd: &mut Command, timeout: Duration, wid: &str) -> Result<i32, String> {
    let mut child = no_window(cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 uv：{e}"))?;

    let stdout = child.stdout.take().expect("stdout 已设为 piped");
    let stderr = child.stderr.take().unwrap();

    let out_thread = stream_lines(stdout, app.clone(), "pip-stdout", wid.to_string());
    let err_thread = stream_lines(stderr, app.clone(), "pip-stderr", wid.to_string());

    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {
                if start.elapsed() > timeout {
                    kill_process_tree(&mut child);
                    let _ = out_thread.join();
                    let _ = err_thread.join();
                    return Err(format!("命令执行超时（{}s）", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                kill_process_tree(&mut child);
                let _ = out_thread.join();
                let _ = err_thread.join();
                return Err(e.to_string());
            }
        }
    };
    let _ = out_thread.join();
    let _ = err_thread.join();
    Ok(code.unwrap_or(-1))
}

// ---------- 环境信息 ----------

/// 读取解释器版本（python --version → 3.13.7）
fn version_of(python: &str) -> String {
    let mut cmd = Command::new(python);
    cmd.arg("--version");
    let (out, err, _) = run_with_timeout(&mut cmd, Duration::from_secs(5)).unwrap_or_default();
    let raw = format!("{out}{err}");
    raw.trim().trim_start_matches("Python ").to_string()
}

/// 从 spec（如 cpython-3.13.7-windows-x86_64-none）提取展示版本号 "3.13.7"
fn display_version(spec: &str) -> String {
    spec.split('-')
        .find(|seg| seg.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(|s| s.to_string())
        .unwrap_or_else(|| spec.to_string())
}

/// 版本号解析为可比较三元组（"3.13.7" → (3,13,7)）；非数字段按 0 处理
fn version_triple(v: &str) -> (u64, u64, u64) {
    let mut nums = [0u64; 3];
    for (i, part) in v.split(['.', '-', '+']).take(3).enumerate() {
        let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
        nums[i] = digits.parse().unwrap_or(0);
    }
    (nums[0], nums[1], nums[2])
}

/// 是否为 freethreaded（无 GIL）变体，默认不提供
fn is_freethreaded(spec: &str) -> bool {
    spec.contains("freethreaded")
}

/// uv python list 解析 → Vec<(spec, 已装路径)>。
/// 行格式：<spec> <path>（已安装）或 <spec> <download available>（可下载）。
/// spec 为第一段；末段是真实文件路径则视为已安装。
fn uv_python_list_full() -> Result<Vec<(String, Option<String>)>, String> {
    let mut cmd = tool_command("uv", ENV_UV);
    cmd.args(["python", "list"]);
    let (out, err, _) = run_with_timeout(&mut cmd, UV_LIST_TIMEOUT)?;
    let stdout = if out.is_empty() { err } else { out };
    let mut list = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut tokens = line.split_whitespace();
        let spec = match tokens.next() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let rest: Vec<&str> = tokens.collect();
        let path = rest
            .last()
            .map(|p| p.to_string())
            .filter(|p| Path::new(p).is_file());
        if !list.iter().any(|(s, _)| *s == spec) {
            list.push((spec, path));
        }
    }
    Ok(list)
}

/// uv python list 解析（仅已安装）→ Vec<(version, path)>
fn uv_python_list() -> Result<Vec<(String, String)>, String> {
    Ok(uv_python_list_full()?
        .into_iter()
        .filter_map(|(spec, path)| path.map(|p| (spec, p)))
        .collect())
}

// ---------- Tauri 命令 ----------
//
// 注意：本文件所有命令都会阻塞式等待 uv/python 子进程（最长 60s）。
// Tauri 2 的同步 command 在主线程执行，会直接卡死 UI，因此统一声明为 async
// 并放进 spawn_blocking 阻塞线程池（官方推荐做法，见 v2.tauri.app/develop/calling-rust）。

/// 环境列表：工作区 .venv + uv python list + （已选但不在列表的）手动解释器
#[tauri::command]
pub async fn list_pythons(workspace_root: String) -> Result<Vec<PythonInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || list_pythons_impl(workspace_root))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn list_pythons_impl(workspace_root: String) -> Result<Vec<PythonInfo>, String> {
    let selected = read_config(&workspace_root);
    let mut out: Vec<PythonInfo> = Vec::new();

    if let Some(p) = venv_python(&workspace_root) {
        let is_sel = selected.as_deref() == Some(p.as_str());
        out.push(PythonInfo {
            version: version_of(&p),
            path: p.clone(),
            kind: "workspace-venv".into(),
            is_selected: is_sel,
        });
    }

    if let Ok(list) = uv_python_list() {
        for (version, path) in list {
            if out.iter().any(|x| x.path == path) {
                continue;
            }
            let is_sel = selected.as_deref() == Some(path.as_str());
            out.push(PythonInfo { path: path.clone(), version, kind: "system".into(), is_selected: is_sel });
        }
    }

    // 手动添加的解释器：已选但既不来自 .venv 也不在 uv 列表
    if let Some(sel) = &selected {
        if !out.iter().any(|x| &x.path == sel) {
            out.push(PythonInfo {
                version: version_of(sel),
                path: sel.clone(),
                kind: "manual".into(),
                is_selected: true,
            });
        }
    }
    Ok(out)
}

/// 可选的 Python 版本列表（含可下载）：已装在前，版本号降序。
#[tauri::command]
pub async fn list_python_versions() -> Result<Vec<PythonVersionOption>, String> {
    tauri::async_runtime::spawn_blocking(list_python_versions_impl)
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn list_python_versions_impl() -> Result<Vec<PythonVersionOption>, String> {
    let full = uv_python_list_full()?;
    let mut out: Vec<PythonVersionOption> = full
        .into_iter()
        .filter(|(spec, _)| !is_freethreaded(spec))
        .map(|(spec, path)| PythonVersionOption {
            installed: path.is_some(),
            version: display_version(&spec),
            spec,
            path,
        })
        .collect();
    out.sort_by(|a, b| {
        b.installed
            .cmp(&a.installed)
            .then_with(|| version_triple(&b.version).cmp(&version_triple(&a.version)))
    });
    Ok(out)
}

/// 自动选用一个已安装的系统解释器：稳定版且 ≥3.12 优先，其次稳定版，最后任意解释器
#[tauri::command]
pub async fn pick_default_system_interpreter() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(pick_default_system_interpreter_impl)
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn pick_default_system_interpreter_impl() -> Result<Option<String>, String> {
    let installed = uv_python_list()?;
    if installed.is_empty() {
        return Ok(None);
    }
    let stable = |v: &str| !v.contains('a') && !v.contains('b') && !v.contains("rc");
    let eligible = |spec: &str| !is_freethreaded(spec) && stable(&display_version(spec));
    // 优先：稳定且 ≥3.12
    let mut cands: Vec<&(String, String)> = installed
        .iter()
        .filter(|(spec, _)| eligible(spec))
        .filter(|(spec, _)| {
            let (maj, min, _) = version_triple(&display_version(spec));
            maj > 3 || (maj == 3 && min >= 12)
        })
        .collect();
    if cands.is_empty() {
        cands = installed.iter().filter(|(s, _)| eligible(s)).collect();
    }
    if cands.is_empty() {
        cands = installed.iter().collect();
    }
    cands.sort_by(|a, b| {
        version_triple(&display_version(&b.0)).cmp(&version_triple(&display_version(&a.0)))
    });
    Ok(cands.first().map(|(_, p)| p.clone()))
}

/// 创建 venv：uv venv <workspace_root>/.venv [--python <version>]。
/// 环境一律独立于项目目录内（项目环境隔离原则，不提供跨项目共享的全局环境）。
/// 返回命令输出 + 创建后的解释器路径，供前端直接持久化选中。
#[tauri::command]
pub async fn create_venv(app: AppHandle, window: tauri::WebviewWindow, workspace_root: String, version: String) -> Result<CreateVenvResult, String> {
    let wid = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || create_venv_impl(app, workspace_root, version, wid))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn create_venv_impl(app: AppHandle, workspace_root: String, version: String, wid: String) -> Result<CreateVenvResult, String> {
    let target = Path::new(&workspace_root).join(".venv");
    let mut cmd = tool_command("uv", ENV_UV);
    cmd.arg("venv").arg(&target);
    // 重建语义：.venv 已存在时 uv venv 默认报错「A virtual environment already exists … Use --clear
    // to replace it」，导致态B 重建必然失败（exit 2）。重建本就要清空现有环境（态B danger 确认已
    // 明示「将清空 N 个已装包」），故恒带 --clear（删除目标已存在内容后重建，含非 venv 目录）。
    // 注：不加 --force——uv venv 无此参数（会报 unexpected argument '--force'），--clear 已足够。
    cmd.arg("--clear");
    if !version.trim().is_empty() {
        cmd.arg("--python").arg(version.trim());
    }
    cmd.current_dir(&workspace_root);
    // 流式输出（pip-stdout/pip-stderr）+ 宽松超时：--python 指定未安装版本时 uv 会联网下载
    // CPython，下载进度经流式实时可见（问题1），且不再被 120s 超时杀死（问题2）。
    // output 字段留空——内容已流式推送，前端不再二次 append。
    let code = run_uv_streaming(&app, &mut cmd, UV_VENV_TIMEOUT, &wid)?;
    if code != 0 {
        // 错误文案不含「详见输出面板」——本 Err 会被前端 appendOutputLine 写进输出面板，
        // 含指引会变成「输出面板里说详见输出面板」的自我指涉；uv 的逐行详情已由流式推送在上方。
        return Err(format!("uv venv 异常退出（exit {code}）"));
    }
    let python = venv_python_at(&target).unwrap_or_default();
    Ok(CreateVenvResult { output: String::new(), python })
}

/// 获取当前解释器：
/// - 配置里**存在** interpreter 键 → 尊重用户显式选择（string=指定解释器；null=显式 uv run，不自动检测）；
/// - **无**该键（从未设置）→ .venv 自动检测兜底。
/// 区分二者是关键：否则用户选「（默认）uv run」后，.venv 自动检测会把选择覆盖回去（选等于没选）。
#[tauri::command]
pub fn get_interpreter(workspace_root: String) -> Result<Option<String>, String> {
    match load_config(&workspace_root).get("interpreter") {
        Some(v) => Ok(v.as_str().map(String::from)), // 显式设置过：null → None（uv run）
        None => Ok(venv_python(&workspace_root)),     // 从未设置：自动检测 .venv
    }
}

/// 设置/清除工作区解释器（path 为 None 或空清除）
#[tauri::command]
pub fn set_interpreter(workspace_root: String, path: Option<String>) -> Result<(), String> {
    let cleaned = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    write_config(&workspace_root, cleaned.as_deref())
}

/// 解释器路径 → 版本号进程内缓存（tech-debt #11）：状态栏刷新 / 开工作区 / 换解释器都会读到版本，
/// 避免每次 `refreshInterpreterStatus` 都 spawn 一次 `<path> --version`。键为完整路径，换解释器自然失效。
static VERSION_CACHE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 查询指定解释器版本号（`<path> --version`），供状态栏“解释器来源 + 版本”展示（P1 建议 2）。
/// 失败（路径无效/超时）返回空串，前端降级为仅显示来源，不阻断运行。
#[tauri::command]
pub async fn interpreter_version(path: String) -> Result<String, String> {
    // 命中缓存直接返回；miss 才 spawn 子进程，空串不缓存（查询失败下次仍重试）
    if let Some(v) = VERSION_CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&path)
        .cloned()
    {
        return Ok(v);
    }
    let p = path.clone();
    let version = tauri::async_runtime::spawn_blocking(move || version_of(&p))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?;
    if !version.is_empty() {
        VERSION_CACHE
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(path, version.clone());
    }
    Ok(version)
}

/// 工作区根是否已有 pyproject.toml（驱动环境面板“建议生成 pyproject.toml”横幅，P2 建议 5）。
/// 纯文件判断、无子进程，复用 pip_install 的同一口径。
#[tauri::command]
pub fn has_pyproject(workspace_root: String) -> bool {
    Path::new(&workspace_root).join("pyproject.toml").is_file()
}

/// 在既有工作区根幂等生成最小 pyproject.toml（方案 B，纯文件写入，不依赖 uv 子进程）。
/// 已存在时不覆盖，直接返回说明；解决“裸目录 uv run 语义不明”（§5 建议 5、§9 幂等要求）。
#[tauri::command]
pub async fn init_pyproject(workspace_root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || init_pyproject_impl(workspace_root))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn init_pyproject_impl(workspace_root: String) -> Result<String, String> {
    let root = Path::new(&workspace_root);
    // 幂等：已存在则不再触发任何生成动作，避免覆盖用户文件（§5 建议 5）
    if root.join("pyproject.toml").is_file() {
        return Ok("pyproject.toml 已存在，未作改动".to_string());
    }
    if !root.is_dir() {
        return Err(format!("工作区不存在：{workspace_root}"));
    }
    let name = root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "app".to_string());
    // 存量裸目录：把工作区「当前解释器」交给 uv --python，让 requires-python 贴合真实环境；
    // 未选解释器时交由 uv 自行决定（None），回退模板统一用 >=3.12。
    let python_arg = get_interpreter(workspace_root.clone()).ok().flatten();
    let (_used_uv, note) = crate::fs_cmds::ensure_pyproject(root, &name, python_arg, ">=3.12", &[]);
    Ok(note)
}

// ---------- 运行前依赖预检 ----------
//
// 用「当前解释器」执行内联脚本：ast 收集文件顶层 import → importlib.util.find_spec
// 逐个探测是否可解析（标准库 / 本地模块 / 已装第三方都能正确命中，只有真缺失才返回）。
// 相比解析 LSP 诊断消息，find_spec 跑在真实解释器里，能正确处理 PIL→Pillow 这类映射。

const MISSING_IMPORT_SCRIPT: &str = r#"import ast, importlib.util, sys, os, json

def main(path):
    d = os.path.dirname(os.path.abspath(path))
    sys.path.insert(0, d)
    root = os.environ.get("PYLUME_WORKSPACE_ROOT")
    if root:
        sys.path.insert(0, root)
    with open(path, encoding="utf-8") as f:
        tree = ast.parse(f.read())
    seen = {}
    stdlib = sys.stdlib_module_names
    stack = [tree]
    while stack:
        n = stack.pop()
        if isinstance(n, ast.Import):
            for a in n.names:
                top = a.name.split(".")[0]
                seen.setdefault(top, (n.lineno, "import " + a.name))
            continue
        if isinstance(n, ast.ImportFrom):
            if n.level == 0 and n.module:
                top = n.module.split(".")[0]
                seen.setdefault(top, (n.lineno, "from " + n.module + " import ..."))
            continue
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        stack.extend(ast.iter_child_nodes(n))
    missing = []
    for name, (lineno, stmt) in seen.items():
        if name in stdlib:
            continue
        if importlib.util.find_spec(name) is not None:
            continue
        missing.append({"name": name, "line": lineno, "stmt": stmt})
    missing.sort(key=lambda m: m["line"])
    print(json.dumps(missing, ensure_ascii=False))

main(sys.argv[1])
"#;

#[derive(Serialize, Deserialize)]
pub struct MissingImport {
    pub name: String,
    pub line: u32,
    pub stmt: String,
}

/// 运行前依赖预检：解析文件顶层 import 的第三方模块，用当前解释器探测是否可解析。
/// 无解释器（uv run 兜底）时返回空列表——跳过预检，保持现状行为。
#[tauri::command]
pub async fn check_missing_imports(
    path: String,
    workspace_root: Option<String>,
) -> Result<Vec<MissingImport>, String> {
    tauri::async_runtime::spawn_blocking(move || check_missing_imports_impl(path, workspace_root))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn check_missing_imports_impl(
    path: String,
    workspace_root: Option<String>,
) -> Result<Vec<MissingImport>, String> {
    let Some(interpreter) = workspace_root
        .as_deref()
        .and_then(|r| get_interpreter(r.to_string()).ok().flatten())
    else {
        return Ok(Vec::new());
    };

    let file = Path::new(&path);
    let dir = file.parent().unwrap_or(Path::new(".")).to_path_buf();

    let mut cmd = Command::new(&interpreter);
    cmd.arg("-c")
        .arg(MISSING_IMPORT_SCRIPT)
        .arg(&path)
        .current_dir(&dir);
    if let Some(root) = &workspace_root {
        cmd.env("PYLUME_WORKSPACE_ROOT", root);
    }

    let (out, err, code) = run_with_timeout(&mut cmd, Duration::from_secs(10))?;
    if code != Some(0) {
        let msg = format!("{out}{err}");
        let msg = msg.trim();
        return Err(if msg.is_empty() { format!("依赖检测失败（exit {code:?}）") } else { msg.to_string() });
    }
    serde_json::from_str::<Vec<MissingImport>>(out.trim())
        .map_err(|e| format!("解析依赖检测结果失败：{e}"))
}

/// 列出已装包：uv pip list --python <解释器> --format=freeze
#[tauri::command]
pub async fn list_packages(interpreter: String) -> Result<Vec<PackageInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || list_packages_impl(interpreter))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn list_packages_impl(interpreter: String) -> Result<Vec<PackageInfo>, String> {
    let mut cmd = tool_command("uv", ENV_UV);
    cmd.args(["pip", "list", "--python", &interpreter, "--format=freeze"]);
    let (out, err, code) = run_with_timeout(&mut cmd, UV_TIMEOUT)?;
    if code != Some(0) {
        let raw = if out.is_empty() { err } else { out };
        return Err(if raw.trim().is_empty() { format!("uv pip list 失败（exit {code:?}）") } else { raw.trim().to_string() });
    }
    // 成功只解析 stdout：--format=freeze 的包列表恒在 stdout；stderr 是 uv 的「Using Python …
    // environment at: …」提示——空环境（virtualenv 建的 .venv 无包）时 stdout 为空，回退用 stderr
    // 会把该提示误解析成一个「包」（wangzi 实测：误报「1 个包已安装但未声明」）。
    Ok(parse_pip_list(&out))
}

/// 安装包：
/// - 工作区根目录存在 pyproject.toml 时用 `uv add`（写入项目依赖并更新 uv.lock，项目用 uv 管理）
///   —— 此分支不需要解释器（interpreter 可为 None，F9 新建 FastAPI 项目安装依赖即如此）；
/// - 否则回退 `uv pip install --python <解释器>`（仅装环境、不记录依赖）——此分支需要解释器，
///   None 时返回可读错误（而非拼出空 --python 参数）。
/// 输出经 pip-stdout / pip-stderr 事件流式推送前端；返回 exit code（0 成功）。
#[tauri::command]
pub async fn pip_install(app: AppHandle, window: tauri::WebviewWindow, workspace_root: String, interpreter: Option<String>, spec: String) -> Result<i32, String> {
    let wid = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || pip_install_impl(app, workspace_root, interpreter, spec, wid))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn pip_install_impl(app: AppHandle, workspace_root: String, interpreter: Option<String>, spec: String, wid: String) -> Result<i32, String> {
    let has_pyproject = Path::new(&workspace_root).join("pyproject.toml").is_file();
    let mut cmd = tool_command("uv", ENV_UV);
    if has_pyproject {
        cmd.arg("add");
        cmd.current_dir(&workspace_root);
        let _ = app.emit_to(&wid, "pip-stdout", json!({ "data": "检测到 pyproject.toml，使用 uv add 写入项目依赖并更新 uv.lock\n" }));
    } else {
        // uv pip install 分支必须有解释器：None 时给可读错误（调用方应已保证，防御分支）
        let Some(interpreter) = interpreter.as_deref() else {
            return Err("未选择解释器，无法安装（无 pyproject.toml 时走 uv pip install 需要解释器；可先生成 pyproject.toml 改走 uv add）".to_string());
        };
        cmd.args(["pip", "install", "--python", interpreter]);
        // §6.2 uv 建议的持续存在感（M3 文案升级）：明示「不写声明属正常现象 + 收敛建议」，
        // 防用户误判编辑器有 bug（R10：pip/裸装不写声明是 E3 的正常输入）
        let _ = app.emit_to(&wid, "pip-stdout", json!({ "data": "未检测到 pyproject.toml，仅安装到解释器环境（不记录依赖）——建议改用 uv add，或在终端使用 uv pip install，保持声明同步\n" }));
    }
    for part in spec.split_whitespace() {
        cmd.arg(part);
    }
    run_uv_streaming(&app, &mut cmd, UV_TIMEOUT, &wid)
}

/// 卸载包：uv pip uninstall --python <解释器> <name…>
#[tauri::command]
pub async fn pip_uninstall(interpreter: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || pip_uninstall_impl(interpreter, name))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn pip_uninstall_impl(interpreter: String, name: String) -> Result<String, String> {
    let mut cmd = tool_command("uv", ENV_UV);
    cmd.args(["pip", "uninstall", "--python", &interpreter]);
    for part in name.split_whitespace() {
        cmd.arg(part);
    }
    run_uv_output(&mut cmd)
}

/// 列出过时包：uv pip list --outdated --format=json --python <解释器>。
/// 解析失败（如 uv 版本不支持、查询网络异常）时降级为空列表，不阻断前端渲染。
#[tauri::command]
pub async fn list_outdated(interpreter: String) -> Result<Vec<OutdatedInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || list_outdated_impl(interpreter))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn list_outdated_impl(interpreter: String) -> Result<Vec<OutdatedInfo>, String> {
    let mut cmd = tool_command("uv", ENV_UV);
    cmd.args(["pip", "list", "--outdated", "--format=json", "--python", &interpreter]);
    let (out, err, code) = run_with_timeout(&mut cmd, UV_OUTDATED_TIMEOUT)?;
    if code != Some(0) {
        return Ok(Vec::new());
    }
    let raw = if out.trim().is_empty() { err } else { out };
    Ok(serde_json::from_str::<Vec<OutdatedInfo>>(raw.trim()).unwrap_or_default())
}

/// 升级包：uv pip install --python <解释器> --upgrade <names…>（流式输出，返回 exit code）
#[tauri::command]
pub async fn pip_upgrade(app: AppHandle, window: tauri::WebviewWindow, interpreter: String, names: Vec<String>) -> Result<i32, String> {
    let wid = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || pip_upgrade_impl(app, interpreter, names, wid))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn pip_upgrade_impl(app: AppHandle, interpreter: String, names: Vec<String>, wid: String) -> Result<i32, String> {
    let mut cmd = tool_command("uv", ENV_UV);
    cmd.args(["pip", "install", "--python", &interpreter, "--upgrade"]);
    for n in &names {
        cmd.arg(n);
    }
    run_uv_streaming(&app, &mut cmd, UV_TIMEOUT, &wid)
}

// ---------- 解析 ----------

/// freeze 格式：name==version（每行）
fn parse_pip_list(s: &str) -> Vec<PackageInfo> {
    s.lines()
        .filter_map(|l| {
            let l = l.trim();
            if l.is_empty() {
                return None;
            }
            match l.split_once("==") {
                Some((n, v)) => Some(PackageInfo { name: n.trim().to_string(), version: v.trim().to_string() }),
                // 无 == 的裸名行：仅当像包名（无空格、不以 - 开头、不含 ://）才保留；否则跳过——
                // 纵深防御：uv 诊断行（如「Using Python … at: …」）或 editable 行（-e …）不得被误当包
                None => {
                    if l.contains(' ') || l.starts_with('-') || l.contains("://") {
                        None
                    } else {
                        Some(PackageInfo { name: l.to_string(), version: String::new() })
                    }
                }
            }
        })
        .collect()
}

// ---------- v3.4 §9：项目入口自动探测（首次运行项目时） ----------
//
// 按优先级探测，命中即写入项目配置（用户可改），不命中返回未命中（前端提示「请先配置项目入口」
// 并打开配置面板，§7.4）。探测口径与 FastAPI 探测一致：纯文件读取，无子进程。
//
// 优先级（§9）：
// 1. pyproject.toml 的 [project.scripts] / [tool.uv] 入口声明；
// 2. 依赖声明含 fastapi 且源码有 `app = FastAPI()` → FastAPI 预设（uvicorn <module>:<app> --reload，
//    起服务后自动开浏览器，机制见前端监听 `Uvicorn running on` 行，M3-3.9 落地）；
// 3. 根目录存在 main.py → 入口脚本 main.py；
// 4. 存在含 __main__.py 的包 → python -m <pkg>；
// 5. 都没有 → 未命中。

/// 探测结果（命中来源 + 写入的配置，供前端回显「已自动配置：<来源>」）
#[derive(Serialize)]
pub struct ProjectEntryDetection {
    /// 命中来源标识："scripts" | "fastapi" | "main-py" | "package"
    pub source: String,
    /// 写入项目配置后的入口描述（回显用，如 "uvicorn main:app --reload" / "main.py" / "-m myapp"）
    pub summary: String,
    /// 探测并写入的项目配置（前端可进一步展示 / 用户可在配置面板修改）
    pub config: RunProfile,
}

/// 解析 pyproject.toml 的 `[project.scripts]` 段：收集 `name = "module:func"` 行。
/// 行扫描口径（与 dap.rs 的 pyproject 依赖扫描一致，不引入 toml crate）：
/// 进入 `[project.scripts]` 表头后持续收集 `x = "y"` 键值，直到下一个表头。
fn pyproject_scripts_entries(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut in_scripts = false;
    for raw in text.lines() {
        let l = raw.trim();
        if l.starts_with('[') {
            in_scripts = l == "[project.scripts]";
            continue;
        }
        if !in_scripts {
            continue;
        }
        let Some(eq) = l.find('=') else { continue };
        let key = l[..eq].trim().trim_matches('"');
        let val = l[eq + 1..].trim().trim_matches('"');
        if !key.is_empty() && val.contains(':') {
            out.push((key.to_string(), val.to_string()));
        }
    }
    out
}

/// `[project.scripts]` 条目 `name = "module:func"` → 模块名（取 `:` 前段）
fn script_entry_module(val: &str) -> String {
    val.split(':').next().unwrap_or(val).trim().to_string()
}

/// 深度受限地找「根下第一层含 `__main__.py` 的包」（§9-4：`python -m <pkg>`）。
/// 仅扫根目录第一层子目录（包入口惯例在浅层）。
fn find_main_package(root: &Path) -> Option<String> {
    let rd = fs::read_dir(root).ok()?;
    let mut names: Vec<String> = rd
        .flatten()
        .filter(|e| e.path().join("__main__.py").is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort(); // 确定性：多个候选时按字母序取首个
    names.into_iter().next()
}

/// §9 探测主体（纯函数化：目录传入，便于单测直接锁定优先级）
fn detect_project_entry_impl(root: &Path) -> Option<ProjectEntryDetection> {
    // 1. pyproject.toml [project.scripts]（[tool.uv] 无入口声明语义，仅 project.scripts 有效）
    if let Ok(text) = fs::read_to_string(root.join("pyproject.toml")) {
        let entries = pyproject_scripts_entries(&text);
        if let Some((name, val)) = entries.into_iter().next() {
            let module = script_entry_module(&val);
            if !module.is_empty() {
                return Some(ProjectEntryDetection {
                    source: "scripts".into(),
                    summary: format!("-m {module}（scripts.{name}）"),
                    config: RunProfile {
                        entry: RunEntry { kind: "module".into(), target: module },
                        ..Default::default()
                    },
                });
            }
        }
        // 2. FastAPI 预设：依赖声明含 fastapi 且源码有 `app = FastAPI()`
        if deps_mention(&text, "fastapi") {
            if let Some((file, app_var)) = scan_app_decl(root, "FastAPI") {
                let module = py_module_target(&file);
                let args = format!("{module}:{app_var} --reload");
                return Some(ProjectEntryDetection {
                    source: "fastapi".into(),
                    summary: format!("-m uvicorn {args}"),
                    config: RunProfile {
                        entry: RunEntry { kind: "module".into(), target: "uvicorn".into() },
                        args,
                        cwd: "${workspaceRoot}".into(),
                        ..Default::default()
                    },
                });
            }
        }
    }

    // 3. 根目录 main.py → 入口脚本
    let main_py = root.join("main.py");
    if main_py.is_file() {
        return Some(ProjectEntryDetection {
            source: "main-py".into(),
            summary: "main.py".into(),
            config: RunProfile {
                entry: RunEntry { kind: "script".into(), target: "main.py".into() },
                ..Default::default()
            },
        });
    }

    // 4. 含 __main__.py 的包 → python -m <pkg>
    if let Some(pkg) = find_main_package(root) {
        return Some(ProjectEntryDetection {
            source: "package".into(),
            summary: format!("-m {pkg}"),
            config: RunProfile {
                entry: RunEntry { kind: "module".into(), target: pkg },
                ..Default::default()
            },
        });
    }

    // 5. 都没有 → 未命中
    None
}

/// 首次运行项目时的入口自动探测（§9）：命中即写入项目配置（用户可改），返回探测结果。
#[tauri::command]
pub async fn detect_project_entry(workspace_root: String) -> Result<Option<ProjectEntryDetection>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&workspace_root);
        if !root.is_dir() {
            return Err(format!("工作区不存在：{workspace_root}"));
        }
        // 已配置则不覆盖（§9：探测服务于「首次运行」；已有配置 = 用户已表达意图）
        if read_project_run(&workspace_root).is_some() {
            return Ok(None);
        }
        let Some(hit) = detect_project_entry_impl(root) else { return Ok(None) };
        write_project_run(&workspace_root, &hit.config)?;
        Ok(Some(hit))
    })
    .await
    .map_err(|e| format!("任务执行异常：{e}"))?
}

// ---------- 框架探针表（P1：Django / Flask / FastAPI 三规则） ----------
//
// 来源：`docs/pycharm_framework_support_report.md` §8.2 P1——把原 P0-E 的 FastAPI 单点探测
// 泛化为「框架 → 运行配置预设」的规则表。设计纪律：
// - **纯文件读取、零子进程**（一次调用 < 数十 ms），命中与否只决定前端是否出「一键生成配置」
//   提示，**绝不静默改配置 / 装包**（沿用 P0-E 的「提示 + 用户点击」形态）；
// - 规则只认**稳定的公开约定**（根目录 manage.py / `X = FastAPI(` / `X = Flask(`），不解析框架
//   源码结构——避免「跟随框架版本演进」的长期维护成本（报告 §8.3）；
// - 优先级 = 强约定优先：django（manage.py）→ fastapi → flask；
// - 每个框架可在**工作区级**关闭提示（config 的 `framework_hints`），对齐 PyCharm
//   `Languages & Frameworks | Flask` 的抑制开关（报告 §8.2 P1-②）。

/// 框架预设探测结果（三框架共用；file 为相对工作区根、正斜杠）
#[derive(Serialize, Clone)]
pub struct FrameworkPreset {
    /// "django" | "flask" | "fastapi"
    pub framework: String,
    /// 展示名："Django" | "Flask" | "FastAPI"
    pub label: String,
    /// 命中的声明文件（如 "manage.py" / "app/main.py"）
    pub file: String,
    /// 生成的运行入口（script = manage.py；module = uvicorn / flask）
    pub entry: RunEntry,
    /// 入口参数（如 "runserver" / "main:app --reload"）
    pub args: String,
    /// 工作目录（统一 ${workspaceRoot}：模块导入以工作区根为基准）
    pub cwd: String,
    /// 回显摘要（如 "-m uvicorn main:app --reload"）
    pub summary: String,
    /// 依赖声明中未见的服务依赖（如 uvicorn / django）：仅提示缺失，不代装
    pub missing: Vec<String>,
}

/// 规则表顺序 = 命中优先级（强约定优先）
const FRAMEWORK_ORDER: [&str; 3] = ["django", "fastapi", "flask"];

/// 工作区级「不再提示」开关的存储键（workspace config：`framework_hints`）
const FRAMEWORK_HINTS_KEY: &str = "framework_hints";

const FRAMEWORK_SCAN_SKIP_DIRS: &[&str] = &[
    "venv", "__pycache__", "node_modules", "dist", "build", ".ruff_cache", ".pytest_cache", ".mypy_cache",
];
const FRAMEWORK_SCAN_MAX_DEPTH: usize = 4;
const FRAMEWORK_SCAN_MAX_FILES: usize = 500;
const FRAMEWORK_SCAN_MAX_BYTES: u64 = 512 * 1024;

/// 收集依赖声明文本（pyproject.toml + 根目录 requirements*.txt）；两者皆无 → None（跳过探测）
fn collect_dep_text(root: &Path) -> Option<String> {
    let mut buf = String::new();
    let mut any = false;
    if let Ok(s) = fs::read_to_string(root.join("pyproject.toml")) {
        buf.push_str(&s);
        buf.push('\n');
        any = true;
    }
    if let Ok(rd) = fs::read_dir(root) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("requirements") && name.ends_with(".txt") {
                if let Ok(s) = fs::read_to_string(e.path()) {
                    buf.push_str(&s);
                    buf.push('\n');
                    any = true;
                }
            }
        }
    }
    if any { Some(buf) } else { None }
}

/// 依赖文本是否逐行提及某包名（忽略 # 注释行；子串匹配——fastapi-utils 命中 fastapi 属可接受过报）
fn deps_mention(text: &str, pkg: &str) -> bool {
    text.lines().any(|l| {
        let l = l.trim();
        !l.starts_with('#') && l.to_ascii_lowercase().contains(pkg)
    })
}

/// 深度/数量受限的工作区 .py 扫描，找首个 `<var> = <ctor>(` 声明 → (相对路径, 变量名)
/// （FastAPI：`app = FastAPI(`；Flask：`app = Flask(`）
fn scan_app_decl(root: &Path, ctor: &str) -> Option<(String, String)> {
    fn walk(dir: &Path, depth: usize, files: &mut Vec<PathBuf>) {
        if depth > FRAMEWORK_SCAN_MAX_DEPTH || files.len() >= FRAMEWORK_SCAN_MAX_FILES {
            return;
        }
        let mut entries: Vec<_> = match fs::read_dir(dir) {
            Ok(rd) => rd.flatten().collect(),
            Err(_) => return,
        };
        entries.sort_by_key(|e| e.path()); // 排序保证确定性（main.py 先于其他同名候选）
        for e in entries {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if p.is_dir() {
                if !name.starts_with('.') && !FRAMEWORK_SCAN_SKIP_DIRS.contains(&name.as_str()) {
                    walk(&p, depth + 1, files);
                }
            } else if name.ends_with(".py") && files.len() < FRAMEWORK_SCAN_MAX_FILES {
                files.push(p);
            }
        }
    }
    let mut files: Vec<PathBuf> = Vec::new();
    walk(root, 0, &mut files);
    for f in &files {
        let Ok(meta) = f.metadata() else { continue };
        if meta.len() > FRAMEWORK_SCAN_MAX_BYTES {
            continue;
        }
        let Ok(text) = fs::read_to_string(f) else { continue };
        for line in text.lines() {
            let t = line.trim_start();
            if t.starts_with('#') {
                continue;
            }
            let Some(eq) = t.find('=') else { continue };
            let lhs = t[..eq].trim();
            let rhs = t[eq + 1..].trim_start();
            let Some(rest) = rhs.strip_prefix(ctor) else { continue };
            if !rest.trim_start().starts_with('(') {
                continue;
            }
            // lhs 须是合法 Python 标识符（排除 `x.attr = FastAPI(` / `d["app"] = ...` 等左值）
            let valid = !lhs.is_empty()
                && lhs.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && lhs.chars().next().is_some_and(|c| !c.is_ascii_digit());
            if valid {
                let rel = f.strip_prefix(root).unwrap_or(f).to_string_lossy().replace('\\', "/");
                return Some((rel, lhs.to_string()));
            }
        }
    }
    None
}

/// 相对脚本路径 → uvicorn 模块目标："app/main.py" → "app.main"
fn py_module_target(rel_file: &str) -> String {
    rel_file.strip_suffix(".py").unwrap_or(rel_file).replace('/', ".")
}

/// 依赖声明中未见的服务依赖（deps 缺失 = 无声明文件 → 视为未知，**不报缺失**：
/// 没有声明文件不该凭空刷「尚未安装」提示）
fn missing_server_deps(deps: Option<&str>, pkgs: &[&str]) -> Vec<String> {
    let Some(text) = deps else { return Vec::new() };
    pkgs.iter()
        .filter(|p| !deps_mention(text, p))
        .map(|p| p.to_string())
        .collect()
}

/// Django 规则：根目录 `manage.py`（项目根唯一强约定）→ `python manage.py runserver`
fn detect_django_preset(root: &Path, deps: Option<&str>) -> Option<FrameworkPreset> {
    if !root.join("manage.py").is_file() {
        return None;
    }
    Some(FrameworkPreset {
        framework: "django".into(),
        label: "Django".into(),
        file: "manage.py".into(),
        entry: RunEntry { kind: "script".into(), target: "manage.py".into() },
        args: "runserver".into(),
        cwd: "${workspaceRoot}".into(),
        summary: "manage.py runserver".into(),
        missing: missing_server_deps(deps, &["django"]),
    })
}

/// FastAPI 规则：依赖声明含 fastapi + 源码 `X = FastAPI(` → `-m <server> <module>:<var> --reload`。
/// 服务器选择（F3，对标 PyCharm `Run using`）：依赖含 uvicorn → uvicorn；仅 hypercorn → hypercorn
/// （`--reload` 两者均支持）；皆无 → uvicorn 缺省 + 提示缺失（不代装）。
fn detect_fastapi_preset(root: &Path, deps: Option<&str>) -> Option<FrameworkPreset> {
    let deps = deps?;
    if !deps_mention(deps, "fastapi") {
        return None;
    }
    let (file, app_var) = scan_app_decl(root, "FastAPI")?;
    let module = py_module_target(&file);
    let server = if deps_mention(deps, "uvicorn") {
        "uvicorn"
    } else if deps_mention(deps, "hypercorn") {
        "hypercorn"
    } else {
        "uvicorn"
    };
    let missing = if deps_mention(deps, "uvicorn") || deps_mention(deps, "hypercorn") {
        Vec::new()
    } else {
        vec!["uvicorn".to_string()]
    };
    Some(FrameworkPreset {
        framework: "fastapi".into(),
        label: "FastAPI".into(),
        file,
        entry: RunEntry { kind: "module".into(), target: server.into() },
        args: format!("{module}:{app_var} --reload"),
        cwd: "${workspaceRoot}".into(),
        summary: format!("-m {server} {module}:{app_var} --reload"),
        missing,
    })
}

/// Flask 规则：依赖声明含 flask + 源码 `X = Flask(` → `-m flask --app <module>:<var> run --debug`。
/// `--debug`（F3，对标 PyCharm「支持内置 Flask debugger」）= Werkzeug 交互式调试器 + reloader。
fn detect_flask_preset(root: &Path, deps: Option<&str>) -> Option<FrameworkPreset> {
    let deps = deps?;
    if !deps_mention(deps, "flask") {
        return None;
    }
    let (file, app_var) = scan_app_decl(root, "Flask")?;
    let module = py_module_target(&file);
    Some(FrameworkPreset {
        framework: "flask".into(),
        label: "Flask".into(),
        file,
        entry: RunEntry { kind: "module".into(), target: "flask".into() },
        args: format!("--app {module}:{app_var} run --debug"),
        cwd: "${workspaceRoot}".into(),
        summary: format!("-m flask --app {module}:{app_var} run --debug"),
        // flask 本身是规则命中前提（deps_mention），不会再缺失；无其他服务依赖
        missing: vec![],
    })
}

/// 读取工作区级「不再提示」集合（config 的 `framework_hints`：{ "<framework>": true }）。
/// 非对象 / 非布尔值一律忽略（配置损坏不得影响探测）。
fn framework_hints_disabled(cfg: &Value) -> HashSet<String> {
    cfg.get(FRAMEWORK_HINTS_KEY)
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter(|(_, v)| v.as_bool() == Some(true))
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// 探针表主体（纯函数化：目录 + 配置传入，便于单测直接锁定优先级与开关语义）
fn detect_framework_impl(workspace_root: &str, cfg: &Value) -> Result<Option<FrameworkPreset>, String> {
    let root = Path::new(workspace_root);
    if !root.is_dir() {
        return Err(format!("工作区不存在：{workspace_root}"));
    }
    let deps = collect_dep_text(root);
    let disabled = framework_hints_disabled(cfg);
    for kind in FRAMEWORK_ORDER {
        if disabled.contains(kind) {
            continue;
        }
        let hit = match kind {
            "django" => detect_django_preset(root, deps.as_deref()),
            "fastapi" => detect_fastapi_preset(root, deps.as_deref()),
            "flask" => detect_flask_preset(root, deps.as_deref()),
            _ => None,
        };
        if hit.is_some() {
            return Ok(hit);
        }
    }
    Ok(None)
}

/// 框架预设探测（P1 探针表）：返回首个**未被本工作区关闭**的命中；无命中 / 全部关闭 → null。
/// 前端据此给「一键生成运行配置」提示（绝不静默改配置/装包）。
#[tauri::command]
pub async fn detect_framework(workspace_root: String) -> Result<Option<FrameworkPreset>, String> {
    let cfg = load_config(&workspace_root);
    tauri::async_runtime::spawn_blocking(move || detect_framework_impl(&workspace_root, &cfg))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

/// 工作区级开关：某框架的「生成运行配置」提示不再出现（写 workspace config 的
/// `framework_hints`；disabled=false 即恢复提示，空map 直接移除键保持文件精简）。
#[tauri::command]
pub fn set_framework_hint_disabled(
    workspace_root: String,
    framework: String,
    disabled: bool,
) -> Result<(), String> {
    let mut v = load_config(&workspace_root);
    let obj = v.as_object_mut().ok_or("工作区配置格式非法")?;
    let mut drop_key = false;
    {
        let hints = obj.entry(FRAMEWORK_HINTS_KEY).or_insert_with(|| json!({}));
        let map = hints.as_object_mut().ok_or("工作区配置 framework_hints 格式非法")?;
        if disabled {
            map.insert(framework, json!(true));
        } else {
            map.remove(&framework);
            drop_key = map.is_empty();
        }
    }
    if drop_key {
        obj.remove(FRAMEWORK_HINTS_KEY);
    }
    save_config(&workspace_root, &v)
}

/// 读取工作区级提示开关（research §11.1-5 首次命中引导的「只提示一次」标志读取侧；
/// 与 set_framework_hint_disabled 同一存储：config 的 `framework_hints`）。
#[tauri::command]
pub fn is_framework_hint_disabled(workspace_root: String, framework: String) -> Result<bool, String> {
    Ok(framework_hints_disabled(&load_config(&workspace_root)).contains(&framework))
}

// ---------- Pydantic 栈检测（F0 裁决 B：推荐切换静态引擎） ----------
//
// 来源：`bench/reports/pydantic-engine-probe.md`——pyrefly 对 Pydantic/dataclass 缺
// 「构造参数校验 + 字段改名传播」（对照组 dataclass 同样缺失，根因是 __init__ 校验整块缺席），
// basedpyright 覆盖 4/6。依赖声明含 pydantic / fastapi 的工作区由前端**提示推荐**切换
// （提示 + 用户点击，绝不静默改设置）；`framework_hints["pydantic_engine"]` = true 表示
// 本工作区已选择不再提示（与框架探针表共用同一存储与语义：框架相关提示的工作区级开关）。

/// 依赖声明是否命中 Pydantic 栈（pydantic / fastapi 任一）且未被本工作区关闭提示
pub fn detect_pydantic_stack_impl(workspace_root: &str, cfg: &Value) -> bool {
    if framework_hints_disabled(cfg).contains("pydantic_engine") {
        return false;
    }
    let Some(deps) = collect_dep_text(Path::new(workspace_root)) else { return false };
    deps_mention(&deps, "pydantic") || deps_mention(&deps, "fastapi")
}

/// Pydantic 栈检测（F0 裁决 B）：命中且未关闭 → true，前端据此给「推荐切换引擎」提示。
#[tauri::command]
pub async fn detect_pydantic_stack(workspace_root: String) -> Result<bool, String> {
    let cfg = load_config(&workspace_root);
    Ok(
        tauri::async_runtime::spawn_blocking(move || detect_pydantic_stack_impl(&workspace_root, &cfg))
            .await
            .map_err(|e| format!("任务执行异常：{e}"))?,
    )
}

// ---------- 依赖健康（Dep Health M1，docs/dep_health_dev_plan.md） ----------
//
// 三层事实（代码/声明/环境）的一致性 diff 唯一真值：所有症状（红线不消、ImportError、
// pyproject 不同步…）都是 DepDiff 的投影（决策 R1）。检测层只读不写——任何收敛动作
// 都源于用户显式操作（决策 R5），本模块不含任何写环境的代码路径。
//
// 命令分层（§4.5 耗时级）：
// - `dep_style`：L0 同步（纯文件存在性，零子进程），打开工作区 t0 即出 style；
// - `dep_scan`：L1+L2 异步全量（环境快照 + 代码层探针 + diff 计算），单层失败降级不中断。
//
// style 判定唯一序（v1.3 修订，2026-09-16 实施反馈）：**external → pyproject → requirements → bare**。
// 原计划字面序 pyproject 优先，但 poetry/pdm 项目必有 pyproject.toml，按字面序会被误判为
// pyproject（[project] dependencies 解析为空 → 全部已装包被报 E3 漂移，§9.1 poetry 验收场景
// 不成立）。锁文件是「谁拥有声明层」的强信号，与 §4.2.1「附带 requirements.txt 也按 external」
// 同理推广到 pyproject.toml。代价：uv 迁移后残留旧锁文件的项目被误判 external——边界横幅
// 正好提示清理锁文件完成迁移。

const DEP_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// E3 漂移排除清单：前三项为 Pylume 工具链自装的开发工具（§3.3 字段语义）；
/// 后四项为 Python 环境基础设施包——老 venv（python -m venv）常自带 pip/setuptools/wheel，
/// 它们不是项目依赖，报漂移纯属噪声（对计划的小幅扩展，已记 §11 v1.3 修订）。
const DRIFT_EXCLUDED: [&str; 7] = ["pyrefly", "ruff", "debugpy", "pip", "setuptools", "wheel", "uv"];

/// 缺失模块的 dist 兜底别名表：`packages_distributions()` 只覆盖**已安装**发行版，
/// 对缺失模块（E1 的主要消费者）天然反查不到，须内置常见「import 名 ≠ 发行版名」映射。
/// 与 envPanel.ts 的 PACKAGE_ALIASES 同源——M3 灯泡切 diff 数据源后该表退役，此处为唯一兜底。
/// 反查仍失败 → dist=null（正常占比而非罕见兜底，§3.3），修复动作降级为按模块名安装。
const DIST_ALIAS_FALLBACK: [(&str, &str); 7] = [
    ("PIL", "Pillow"),
    ("cv2", "opencv-python"),
    ("sklearn", "scikit-learn"),
    ("yaml", "PyYAML"),
    ("dotenv", "python-dotenv"),
    ("bs4", "beautifulsoup4"),
    ("Crypto", "pycryptodome"),
];

/// 外部管理器锁文件 → 管理器名（判定序 = 数组序，固定）。conda 仅靠 environment.yml
/// 存在性识别，多数 conda 项目不放此文件会 fallthrough 到 bare——已知边界非识别 bug（§4.2.1）。
const EXTERNAL_LOCKS: [(&str, &str); 4] = [
    ("poetry.lock", "poetry"),
    ("Pipfile", "pipenv"),
    ("pdm.lock", "pdm"),
    ("environment.yml", "conda"),
];

/// L0 style 判定结果（§3.3 契约的轻量子集；camelCase 对齐 TS 消费端）
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DepStyle {
    /// "pyproject" | "requirements" | "bare" | "external"
    pub style: String,
    /// style=external 时的管理器名（poetry/pipenv/pdm/conda），其余为 null
    pub external_manager: Option<String>,
    /// style=requirements 时命中的主 requirements 文件（相对工作区根；多文件时
    /// requirements.txt 优先，否则字母序首个——声明集解析时全部纳入）
    pub requirements_file: Option<String>,
}

/// E1 条目：代码 ⊄ 环境（缺失模块的一个 import 位点，按 module+file 聚合）
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissingModule {
    pub module: String,
    /// 发行版名（packages_distributions 反查 → 别名表兜底 → null）
    pub dist: Option<String>,
    /// 全部候选发行版名（M4-4 dist 歧义：同 module 多 dist 时安装动作弹候选选择；
    /// len ≤ 1 时与 dist 字段等价或为空。字段只增不删，§3.3 契约演进）
    #[serde(default)]
    pub dist_candidates: Vec<String>,
    /// 相对工作区根、正斜杠
    pub file: String,
    pub line: u32,
    /// 全部位点都位于函数/方法体内（惰性导入）——仅提示不阻塞运行预检（M4 精度项）
    pub lazy: bool,
}

/// E2 条目：声明 ⊄ 环境
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredMissing {
    /// PEP 503 归一化名
    pub dist: String,
    /// 原始版本约束串（如 ">=1.0,<2"；含 extras/marker remainder），修复时原样交给 uv
    pub spec: String,
}

/// v1.7 A：已声明未安装的**代码引用**（E1 分流产物）——模块写入声明全集（extras/groups）
/// 但环境未装且代码 import 了它。按 module 聚合（跨文件一处汇总，fika-admin pytest ×5
/// 的降噪形态）；与 declaredMissing（core 同步范围逐条）分节呈现。
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredMissingModule {
    /// 顶层模块名（Python import 名，原样）
    pub module: String,
    /// 命中的声明 dist（归一化名；模块名→dist 经反查/别名/同名匹配链）
    pub dist: String,
    /// 所属声明组（"dev" / extras 名 / dependency-group 名；requirements 项目 = "requirements"）
    pub group: String,
    /// 受影响文件数（聚合呈现：模块跨 N 个文件）
    pub files: u32,
    /// 首个位点（跳转锚点）
    pub file: String,
    pub line: u32,
    /// 全部位点皆惰性导入（与 E1 的 lazy 语义一致，仅提示）
    pub lazy: bool,
}

/// E3 条目：环境 ⊄ 声明（裸装漂移）
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvDriftPkg {
    pub dist: String,
    pub version: String,
}

/// E4 条目：代码 ⊄ 声明（pyproject 项目专用）
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UndeclaredModule {
    pub module: String,
    pub dist: Option<String>,
    /// 同 module 多 dist 候选（M4-4；字段只增不删，§3.3）
    #[serde(default)]
    pub dist_candidates: Vec<String>,
    pub file: String,
    pub line: u32,
}

/// DepDiff v1 契约（§3.3）：字段只增不删，消费方须容忍未知字段。camelCase 序列化。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DepDiff {
    pub style: String,
    pub external_manager: Option<String>,
    /// E1 代码 ⊄ 环境（interpreter=null 时置空，§3.3 字段语义）
    pub missing_in_env: Vec<MissingModule>,
    /// E2 声明 ⊄ 环境（external 禁用；interpreter=null 或快照失败时置空）
    pub declared_missing: Vec<DeclaredMissing>,
    /// v1.7 A：已声明未安装的代码引用（E1 分流；external 禁用。字段只增不删，§3.3）
    #[serde(default)]
    pub declared_missing_modules: Vec<DeclaredMissingModule>,
    /// E3 环境 ⊄ 声明（external 禁用；解释器 null 时置空）
    pub env_drift: Vec<EnvDriftPkg>,
    /// E4 代码 ⊄ 声明（仅 style=pyproject 计算）
    pub undeclared: Vec<UndeclaredModule>,
    /// E5 pyproject ↔ uv.lock 不一致（仅文件比对 + uv lock --check，不依赖解释器——
    /// interpreter=null 的 uv run 兜底路径照常计算，v1.2 修订）
    pub lock_out_of_date: bool,
    /// style=requirements 且整个 requirements 文件未安装（E2 特例，横幅优先级 3 直接消费）
    pub requirements_uninstalled: bool,
    /// null = uv run 兜底（E1/E2/E3 环境侧置空；E4/E5 照常）
    pub interpreter: Option<String>,
    pub requirements_file: Option<String>,
    /// epoch millis
    pub scanned_at: u64,
}

/// 探针输出：import 位点 + 模块解析分类
#[derive(Deserialize, Clone, Debug, Default)]
pub struct ProbeOutput {
    #[serde(default)]
    pub imports: Vec<ProbeImport>,
    #[serde(default)]
    pub resolution: HashMap<String, ProbeResolution>,
}

/// 单个 import 位点（file 为相对工作区根、正斜杠）
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct ProbeImport {
    pub file: String,
    pub module: String,
    pub line: u32,
    #[serde(default)]
    pub lazy: bool,
}

/// 模块解析分类：stdlib / local（工作区内一方代码）/ site（三方已装）/ missing
#[derive(Deserialize, Clone, Debug)]
pub struct ProbeResolution {
    pub status: String,
    /// 候选发行版名（M4-4 dist 歧义：packages_distributions 反查保留全部候选，不再只取 v[0]；
    /// 旧字段名 dist 保留——serde 兼容测试构造，值 = 首候选（无则 null））
    #[serde(default)]
    pub dist: Option<String>,
    /// 全部候选（去重保序）；len ≤ 1 时与 dist 一致或为空
    #[serde(default)]
    pub dist_candidates: Vec<String>,
}

impl ProbeResolution {
    /// 首候选便捷取用（与旧单 dist 字段同义）
    #[cfg(test)]
    fn first_dist(&self) -> Option<&str> {
        self.dist_candidates.first().map(String::as_str).or(self.dist.as_deref())
    }

    /// 全部候选（兼容无 dist_candidates 的旧构造：单 dist 视为唯一候选）
    fn all_candidates(&self) -> Vec<String> {
        if !self.dist_candidates.is_empty() {
            self.dist_candidates.clone()
        } else {
            self.dist.clone().into_iter().collect()
        }
    }
}

/// 代码层探针（§4.1，内联形态沿用 MISSING_IMPORT_SCRIPT 先例）：
/// - 输入：payload 临时文件路径（argv[1]，JSON：workspace_root / files 待解析 / modules 待解析集）；
/// - AST 收集**全部** import——含函数体内（标 lazy），相对导入（level>0）视为一方代码跳过。
///   行为变更（§4.1）：旧 MISSING_IMPORT_SCRIPT 对函数体整棵 continue，此处进入函数体收集；
/// - 解析落点分类：stdlib_module_names → find_spec → origin/搜索路径是否在工作区根下
///   （local）或文件系统他处（site）；find_spec 失败 = missing；
/// - dist 反查：packages_distributions() 一次建全表（<3.10 缺失时 try 降级为空表，风险 #2）；
/// - 输出单行 JSON（ensure_ascii 缺省 True：Windows 管道 locale 编码下中文路径不炸）。
const DEP_PROBE_SCRIPT: &str = r#"import ast, importlib.metadata, importlib.util, json, os, sys

# 版本下限显式降级（v1.3 修订 ⑬）：stdlib_module_names / packages_distributions 均为 3.10+。
# 缺失时 site/stdlib 分类不可信——会把 os/sys 也判成 site（E4 误报标准库为未声明依赖），
# 错误结果比降级更糟。显式退出 → Rust 侧降级为空代码层 + warn 日志（风险 #2），
# 与既有 check_missing_imports 对 <3.10 的隐性下限口径一致。
if sys.version_info < (3, 10):
    raise SystemExit("dep probe requires Python >= 3.10, got " + sys.version.split()[0])

_MAX_BYTES = 2000000
_STDLIB = sys.stdlib_module_names

def _collect(path):
    """单文件 AST → [(顶层模块, 行号, lazy)]；解析失败/超大文件返回空（不中断全量扫描）。"""
    out = []
    try:
        if os.path.getsize(path) > _MAX_BYTES:
            return out
        with open(path, encoding="utf-8", errors="replace") as f:
            tree = ast.parse(f.read(), filename=path)
        def walk(node, lazy):
            for child in ast.iter_child_nodes(node):
                if isinstance(child, ast.Import):
                    for a in child.names:
                        out.append((a.name.split(".")[0], child.lineno, lazy))
                elif isinstance(child, ast.ImportFrom):
                    if child.level == 0 and child.module:
                        out.append((child.module.split(".")[0], child.lineno, lazy))
                elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                    walk(child, True)
                else:
                    walk(child, lazy)
        walk(tree, False)
    except (OSError, SyntaxError, ValueError, RecursionError):
        return []
    return out

def _is_local_path(ap, root_norm):
    """一方代码判定：解析落点在工作区根下 **且不在虚拟环境/site-packages 内**。
    修复 #2：venv 建在工作区内时（.venv 惯例位置），site-packages 的 origin 以根为
    前缀，旧判定会把三方包误吞成 local（E1 漏报）。排除组件 = .venv* / venv /
    site-packages / dist-packages（不用裸 env——会误伤名为 env 的本地目录）。"""
    if ap != root_norm and not ap.startswith(root_norm + os.sep):
        return False
    parts = ap[len(root_norm):].split(os.sep) if ap != root_norm else []
    for p in parts:
        if p.startswith(".venv") or p == "venv" or p == "site-packages" or p == "dist-packages":
            return False
    return True

def _classify(module, root_norm, dist_map, search_dirs=None):
    """解析落点：stdlib / local（工作区内一方）/ site（三方）/ missing。
    - search_dirs（用户实测 bug 修复）：该模块**全部 import 位点所属文件的所在目录**。
      脚本式布局（cbond/cb_daily.py `from field_map import ...`）的运行语义是
      「脚本目录进 sys.path[0]」，只插工作区根会把同目录模块误判 missing（E1 误报）。
      多目录逐一尝试，优先级 local > site > missing（任一目录能解析为一方代码即 local
      ——同名模块跨目录只有一边存在的漏报是已知边界，严格优于只按根解析的旧行为）。
    - M4-4 dist 歧义：dist_map 值为完整候选列表（不再只取 v[0]），一并输出。"""
    if module in _STDLIB:
        return {"status": "stdlib", "dist": None, "distCandidates": []}
    best = None  # None < "missing" < "site" < "local"
    rank = {"missing": 1, "site": 2, "local": 3}
    dirs = list(search_dirs or []) + [None]  # None = 仅现有 sys.path（含根）
    for search_dir in dirs:
        inserted = False
        if search_dir is not None and search_dir not in sys.path:
            sys.path.insert(0, search_dir)
            inserted = True
        try:
            try:
                spec = importlib.util.find_spec(module)
            except (ImportError, ValueError):
                spec = None
        finally:
            if inserted:
                try:
                    sys.path.remove(search_dir)
                except ValueError:
                    pass
        if spec is None:
            status = "missing"
        else:
            paths = []
            origin = spec.origin or ""
            if origin not in ("", "built-in", "frozen", "namespace"):
                paths.append(origin)
            try:
                paths.extend(spec.submodule_search_locations or [])
            except TypeError:
                pass
            status = "site"
            for p in paths:
                ap = os.path.normcase(os.path.abspath(p))
                if _is_local_path(ap, root_norm):
                    status = "local"
                    break
            if not paths:
                status = "stdlib"
        if best is None or rank[status] > rank[best]:
            best = status
        if best == "local":
            break  # 已是最优，无需再试
    cands = dist_map.get(module) or []
    if best == "stdlib":
        return {"status": "stdlib", "dist": None, "distCandidates": []}
    if best == "local":
        return {"status": "local", "dist": None, "distCandidates": []}
    if best == "site":
        return {"status": "site", "dist": cands[0] if cands else None, "distCandidates": cands}
    return {"status": "missing", "dist": cands[0] if cands else None, "distCandidates": cands}

def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        payload = json.load(f)
    root = payload["workspace_root"]
    root_norm = os.path.normcase(os.path.abspath(root))
    if root not in sys.path:
        sys.path.insert(0, root)
    try:
        # M4-4：值保留完整候选列表（同 module 多 dist），首候选即旧行为 v[0]
        dist_map = {k: sorted(set(v)) for k, v in importlib.metadata.packages_distributions().items() if v}
    except Exception:
        dist_map = {}
    imports = []
    # 模块 → 全部位点所属文件的所在目录集合（脚本语义的解析目录，去重保序）
    known_dirs = {}
    for rel in payload.get("files", []):
        file_dir = os.path.dirname(os.path.join(root, rel))
        for mod, line, lazy in _collect(os.path.join(root, rel)):
            imports.append({"file": rel, "module": mod, "line": line, "lazy": lazy})
            known_dirs.setdefault(mod, [])
            if file_dir not in known_dirs[mod]:
                known_dirs[mod].append(file_dir)
    # payload.modules（Rust 侧传入的待重解析模块，缓存 miss 的）：优先用 payload.module_dirs
    #（Rust 从 AST 缓存导出的 模块 → 位点目录 集合，脚本语义同上）；无映射的按现有
    # sys.path（含根）解析——files 路径的目录结果不劣于它。
    extra_dirs = payload.get("module_dirs") or {}
    for m in payload.get("modules", []):
        dirs = extra_dirs.get(m) or []
        known_dirs.setdefault(m, [d for d in dirs])
    resolution = {m: _classify(m, root_norm, dist_map, known_dirs[m]) for m in sorted(known_dirs)}
    sys.stdout.write(json.dumps({"imports": imports, "resolution": resolution}))

main()
"#;

// ---------- dep：L0 style 判定 ----------

/// style 判定（纯 fs 存在性，判定序见文件头 v1.3 修订说明）
fn detect_style(root: &Path) -> DepStyle {
    // ① external 锁文件优先（谁拥有声明层的强信号）
    for (file, mgr) in EXTERNAL_LOCKS {
        if root.join(file).is_file() {
            return DepStyle {
                style: "external".into(),
                external_manager: Some(mgr.to_string()),
                requirements_file: None,
            };
        }
    }
    // ② pyproject（读 [project] dependencies / [tool.uv]；uv workspace 成员不解析，M4 评估）
    if root.join("pyproject.toml").is_file() {
        return DepStyle { style: "pyproject".into(), external_manager: None, requirements_file: None };
    }
    // ③ requirements*.txt（多文件全部纳入声明集，见 parse_requirements_declared）
    if let Some(primary) = primary_requirements_file(root) {
        return DepStyle {
            style: "requirements".into(),
            external_manager: None,
            requirements_file: Some(primary),
        };
    }
    // ④ bare（现有 has_pyproject 横幅即此逻辑的 UI 投影）
    DepStyle { style: "bare".into(), external_manager: None, requirements_file: None }
}

/// L0 同步 style 判定命令（零子进程，§4.7 打开工作区 t0 时刻调用，bare/external 横幅
/// 不依赖后续 L1/L2）。工作区不存在时返回 bare（纯存在性检查的自然结果，调用方保证 root 有效）。
#[tauri::command]
pub fn dep_style(workspace_root: String) -> DepStyle {
    detect_style(Path::new(&workspace_root))
}

/// 根目录 requirements*.txt 文件名列表（字母序，确定性）
fn list_requirements_files(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(root)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_file())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.starts_with("requirements") && n.ends_with(".txt"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// 主 requirements 文件：requirements.txt 优先，否则字母序首个
fn primary_requirements_file(root: &Path) -> Option<String> {
    let names = list_requirements_files(root);
    if names.iter().any(|n| n == "requirements.txt") {
        Some("requirements.txt".to_string())
    } else {
        names.into_iter().next()
    }
}

// ---------- dep：声明层解析（行扫描，无 toml crate，与 dap.rs / pyproject_scripts_entries 同口径） ----------

/// 单条声明依赖（dist 为 PEP 503 归一化名；spec 为原始约束串，修复时原样交给 uv）
#[derive(Clone, Debug, PartialEq)]
struct DeclaredDep {
    dist: String,
    spec: String,
}

/// 声明层解析结果，三个口径：
/// - `core`：同步范围（uv sync / pip install -r 默认会装的）= [project].dependencies
///   + [tool.uv].dev-dependencies + [dependency-groups].dev；requirements 项目 = 全部行。
///   **E2 只查 core**——extras/非 dev groups 是 opt-in 安装，缺了不该报「声明未安装」；
/// - `all`：全部声明归一化名（含 optional-dependencies 与所有 groups）——E3/E4 的排除集
///   （装了 extras 里的包是合法声明，不算漂移/未声明）；
/// - `group_of`：归一化 dist → 所属组名（v1.7 A：E1 分流到 E2 小节时的「已声明未装」
///   归组信息，如 "dev"；core 依赖映射为 null——它们缺装时走 declaredMissing 常规路径）。
#[derive(Default, Clone, Debug)]
struct DeclaredDeps {
    core: Vec<DeclaredDep>,
    all: HashSet<String>,
    group_of: HashMap<String, String>,
}

/// PEP 503 包名归一化：`re.sub(r"[-_.]+", "-", name).lower()` 等价实现
/// （zope.interface / Zope-Interface / zope_interface → zope-interface）。
fn normalize_dist(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut pending_sep = false;
    for c in name.chars() {
        if c == '-' || c == '_' || c == '.' {
            if !out.is_empty() {
                pending_sep = true;
            }
        } else {
            if pending_sep {
                out.push('-');
                pending_sep = false;
            }
            out.extend(c.to_lowercase());
        }
    }
    out
}

/// PEP 508 需求串 → (包名, 约束 remainder)。名为前导字母数字/._- run；
/// 裸 URL 行（scheme:// 前缀，requirements 允许的 direct wheel URL）无包名可取 → None；
/// `foo @ https://…`（direct reference）→ ("foo", "@ https://…") 保留声明语义。
fn split_requirement(s: &str) -> Option<(String, String)> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    if let Some(i) = t.find("://") {
        let scheme = &t[..i];
        // scheme 无空白且为合法 scheme 字符集 → 整行是裸 URL
        if !scheme.is_empty()
            && !scheme.contains(' ')
            && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
        {
            return None;
        }
    }
    let end = t
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_'))
        .unwrap_or(t.len());
    let name = &t[..end];
    if name.is_empty() {
        return None;
    }
    Some((name.to_string(), t[end..].trim().to_string()))
}

/// requirements 单行 → (包名, 约束串)。跳过：空行 / 注释 / 选项行（-r、--index-url、-e…）/
/// 裸 URL。行内注释按 pip 口径须空白 + #。行延续反斜杠（`foo \`）不支持——罕见形态，M1 边界。
fn parse_requirements_line(line: &str) -> Option<(String, String)> {
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') || t.starts_with('-') {
        return None;
    }
    let t = match t.find(" #").or_else(|| t.find("\t#")) {
        Some(i) => t[..i].trim(),
        None => t,
    };
    split_requirement(t)
}

/// 解析根目录全部 requirements*.txt（§4.2：多文件时全部纳入声明集）→ 声明层。
/// requirements 项目无 core/all 之分（无 extras 概念），全部行进 core。
fn parse_requirements_declared(root: &Path) -> DeclaredDeps {
    let mut d = DeclaredDeps::default();
    for name in list_requirements_files(root) {
        let Ok(text) = fs::read_to_string(root.join(&name)) else { continue };
        for line in text.lines() {
            let Some((raw, spec)) = parse_requirements_line(line) else { continue };
            let dist = normalize_dist(&raw);
            d.all.insert(dist.clone());
            d.core.push(DeclaredDep { dist, spec });
        }
    }
    d
}

/// TOML 数组文本是否已闭合（引号/转义感知，防字符串里的 [ ] 误计数）
fn array_closed(s: &str) -> bool {
    let mut depth = 0i32;
    let mut in_str: Option<char> = None;
    let mut esc = false;
    for c in s.chars() {
        if let Some(q) = in_str {
            if esc {
                esc = false;
            } else if c == '\\' && q == '"' {
                esc = true;
            } else if c == q {
                in_str = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => in_str = Some(c),
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth <= 0 {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

/// 从数组文本提取顶层引号字符串。跳过 {} 内嵌串（dependency-groups 的
/// `{include-group = "x"}` 的 "x" 不是包名）与更深层 [] 嵌套。
/// TOML literal 串（'…'）无转义语义，反斜杠按字面保留。
fn extract_quoted_strings(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32; // [] 深度
    let mut braces = 0i32; // {} 深度
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            '[' => depth += 1,
            ']' => depth -= 1,
            '{' => braces += 1,
            '}' => braces -= 1,
            '"' | '\'' => {
                let quote = c;
                let mut item = String::new();
                let mut esc = false;
                let mut closed = false;
                for c2 in chars.by_ref() {
                    if esc {
                        item.push(c2);
                        esc = false;
                        continue;
                    }
                    if c2 == '\\' && quote == '"' {
                        esc = true;
                        continue;
                    }
                    if c2 == quote {
                        closed = true;
                        break;
                    }
                    item.push(c2);
                }
                if closed && depth == 1 && braces == 0 {
                    out.push(item);
                }
            }
            _ => {}
        }
    }
    out
}

/// pyproject.toml 行扫描：收集各 section 下 `key = [ … ]` 数组的字符串项
/// → (section, key, items)。数组可跨行（PEP 621 多行 dependencies 是常态），闭合即停。
fn pyproject_dep_strings(text: &str) -> Vec<(String, String, Vec<String>)> {
    let mut out = Vec::new();
    let mut section = String::new();
    let mut lines = text.lines();
    while let Some(raw) = lines.next() {
        let t = raw.trim();
        if t.starts_with('#') {
            continue;
        }
        if t.starts_with('[') && t.ends_with(']') {
            section = t[1..t.len() - 1].trim().to_string();
            continue;
        }
        let Some(eq) = t.find('=') else { continue };
        let key = t[..eq].trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        let val = t[eq + 1..].trim();
        if !val.starts_with('[') {
            continue;
        }
        let mut buf = val.to_string();
        while !array_closed(&buf) {
            match lines.next() {
                Some(n) => {
                    buf.push(' ');
                    buf.push_str(n.trim());
                }
                None => break,
            }
        }
        let items = extract_quoted_strings(&buf);
        if !items.is_empty() {
            out.push((section.clone(), key, items));
        }
    }
    out
}

/// pyproject 声明层解析 → (声明集, [project] name)。
/// name 供 E4/E3 排除项目自身（uv sync 会把项目本体 editable 装进 venv，不排除则
/// 项目自己的包名恒被报漂移/未声明）。
/// 已知边界：`dynamic = ["dependencies"]`（setuptools 动态声明）不解析——声明集偏空
/// 会导致 E3 过报，M1 接受（此类项目占比小，且横幅文案可解释）。
fn parse_pyproject_deps(text: &str) -> (DeclaredDeps, Option<String>) {
    let mut deps = DeclaredDeps::default();
    for (section, key, items) in pyproject_dep_strings(text) {
        // 同步范围（E2）：uv sync 默认安装 = 主依赖 + 两套 dev 声明
        let core = matches!(
            (section.as_str(), key.as_str()),
            ("project", "dependencies")
                | ("tool.uv", "dev-dependencies")
                | ("dependency-groups", "dev")
        );
        // 全集（E3/E4 排除）：core + 全部 extras + 全部 dependency-groups
        let declared = core
            || section == "project.optional-dependencies"
            || section == "dependency-groups";
        if !declared {
            continue;
        }
        // v1.7 A：组归属（E1 分流呈现用）——extras 键名 / dependency-groups 组名；
        // core 依赖不进映射（缺装走 declaredMissing 常规 E2 路径）。段名为 TOML 全限定
        // （"project.optional-dependencies" 不是 "project"——fika-admin 实测踩坑修正）
        let group: Option<String> = match section.as_str() {
            "project.optional-dependencies" => Some(key.clone()),
            "dependency-groups" if key != "dev" => Some(key.clone()),
            _ => None,
        };
        for req in items {
            let Some((name, spec)) = split_requirement(&req) else { continue };
            let dist = normalize_dist(&name);
            deps.all.insert(dist.clone());
            if let Some(g) = &group {
                deps.group_of.entry(dist.clone()).or_insert_with(|| g.clone());
            }
            if core {
                deps.core.push(DeclaredDep { dist, spec });
            }
        }
    }
    (deps, pyproject_project_name(text))
}

/// uv.lock 的 `[[package]]` name 名单（fika-admin 实测 bug 修复）：lock 锁定闭包含全部
/// 传递依赖——`uv sync` 装的环境里 pydantic-core/starlette/typing-extensions 等按 lock
/// 合法存在，E3 若只按 pyproject 排除会报几十项「漂移」噪声（实测 63 项全是 lock 内包）。
/// 行扫描 `name = "xxx"` 且须位于 [[package]] 段内（排除 [manifest] 等）；解析失败 →
/// 空（E3 退回旧行为，过报可解释——比错报漏报方向安全）。
fn parse_uv_lock_names(root: &Path) -> HashSet<String> {
    let Ok(text) = fs::read_to_string(root.join("uv.lock")) else {
        return HashSet::new();
    };
    let mut out = HashSet::new();
    let mut in_package = false;
    for raw in text.lines() {
        let t = raw.trim();
        if t == "[[package]]" {
            in_package = true;
            continue;
        }
        if t.starts_with('[') {
            in_package = false; // 进入其他段（[manifest]/[package.dev-dependencies] 等）
            continue;
        }
        if !in_package {
            continue;
        }
        if let Some(rest) = t.strip_prefix("name = ") {
            let name = rest.trim().trim_matches('"');
            if !name.is_empty() {
                out.insert(normalize_dist(name));
            }
        }
    }
    out
}

/// [project] 段的 name 键（行扫描首个命中）
fn pyproject_project_name(text: &str) -> Option<String> {
    let mut in_project = false;
    for raw in text.lines() {
        let t = raw.trim();
        if t.starts_with('[') && t.ends_with(']') {
            in_project = t == "[project]";
            continue;
        }
        if !in_project {
            continue;
        }
        let Some(eq) = t.find('=') else { continue };
        if t[..eq].trim() == "name" {
            let v = t[eq + 1..].trim().trim_matches(|c| c == '"' || c == '\'').to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

// ---------- dep：环境层快照 ----------

/// freeze 输出的 dep 域宽容解析：`name==version` / `name @ url`（direct/editable，版本置空）
/// / `-e`、`#` 行跳过。与 parse_pip_list（环境面板展示口径）分开维护——那边把整行当名字，
/// 这边要把 direct URL 归一出包名（uv sync 的项目本体 editable 装就是 `name @ file+…` 形态）。
fn parse_freeze_for_diff(s: &str) -> Vec<(String, String)> {
    s.lines()
        .filter_map(|l| {
            let l = l.trim();
            if l.is_empty() || l.starts_with('-') || l.starts_with('#') {
                return None;
            }
            if let Some((n, v)) = l.split_once("==") {
                return Some((n.trim().to_string(), v.trim().to_string()));
            }
            if let Some((n, _)) = l.split_once('@') {
                let n = n.trim();
                if !n.is_empty() {
                    return Some((n.to_string(), String::new()));
                }
            }
            // 无版本裸名行：仅当像包名（无空格）才保留——含空格的是诊断/杂质行（如 uv 的
            // 「Using Python … environment at: …」），跳过防误当包（纵深防御，与 parse_pip_list 同口径）
            if l.contains(' ') {
                return None;
            }
            Some((l.to_string(), String::new()))
        })
        .collect()
}

/// dep 域环境快照：uv pip list --format=freeze（UV_LIST_TIMEOUT 而非 UV_TIMEOUT——
/// 体检是后台顾问，不该被 120s 级的宽松超时拖住）。
fn scan_list_packages(interpreter: &str) -> Result<Vec<(String, String)>, String> {
    let mut cmd = tool_command("uv", ENV_UV);
    cmd.args(["pip", "list", "--python", interpreter, "--format=freeze"]);
    let (out, err, code) = run_with_timeout(&mut cmd, UV_LIST_TIMEOUT)?;
    if code != Some(0) {
        let raw = if out.is_empty() { err } else { out };
        return Err(if raw.trim().is_empty() {
            format!("uv pip list 失败（exit {code:?}）")
        } else {
            raw.trim().to_string()
        });
    }
    // 成功只解析 stdout（同 list_packages_impl）：stderr 的「Using Python … environment at: …」提示
    // 不得回退当包列表——空环境（virtualenv 建的 .venv）stdout 为空，回退会把提示误解析成「包」（wangzi 实测）
    Ok(parse_freeze_for_diff(&out))
}

// ---------- dep：E5 lock 一致性 ----------

/// E5：`uv lock --check`（uv ≥ 0.4.x 支持；0.10.11 实测——过期 exit=1 且输出含
/// "needs to be updated"，最新 exit=0）。仅认 uv 的明确过期文案为 true；其余非零
/// （网络/索引/uv 版本问题）降级为不检测（§10 风险 1：失败不阻断）。
fn check_lock_out_of_date(root: &Path) -> bool {
    let mut cmd = tool_command("uv", ENV_UV);
    cmd.args(["lock", "--check"]).current_dir(root);
    let Ok((out, err, code)) = run_with_timeout(&mut cmd, UV_OUTDATED_TIMEOUT) else {
        return false;
    };
    if code == Some(0) {
        return false;
    }
    format!("{out}{err}").contains("needs to be updated")
}

// ---------- dep：代码层探针执行 + mtime 增量缓存 ----------

/// 缓存条目：文件 mtime + 该文件的 AST import 结果。只缓存 AST（环境无关）；
/// 模块解析（find_spec/packages_distributions）经 resolution 缓存按解释器复用（M4-2）。
#[derive(Clone, Debug)]
struct CachedFile {
    mtime: (u64, u32),
    imports: Vec<ProbeImport>,
}

/// mtime 增量缓存（§4.1，M1 骨架）：进程级、仅保留最近一个工作区（换工作区自然失效）。
/// 全量 AST 重扫只发生在文件变化时；未变文件复用上次结果。
static DEP_CACHE: LazyLock<Mutex<Option<(PathBuf, HashMap<String, CachedFile>)>>> =
    LazyLock::new(|| Mutex::new(None));

/// resolution 缓存（M4-2）：模块解析结果（find_spec + packages_distributions）缓存。
/// 复核修复：find_spec 的输入不止解释器——探针把**工作区根**插入 sys.path[0]（local
/// 分类依赖 root），故缓存键 = 解释器 + 工作区根（复合键；单解释器键会在切工作区后
/// 复用旧工作区的 local/missing 分类，产生跨工作区脏数据）。
/// 代次（generation）：full 扫描作废时 ++；在途 code 扫描完成后若代次已变，其回写的
/// 解析结果属作废前旧环境——直接丢弃（防竞态覆盖新鲜结果，复核修复 #2）。
static RESOLUTION_CACHE: LazyLock<Mutex<ResolutionCacheState>> =
    LazyLock::new(|| Mutex::new(ResolutionCacheState::default()));

#[derive(Default)]
struct ResolutionCacheState {
    /// 复合缓存键（"{python}\u{0}{root}"），空 = 无有效缓存
    key: String,
    generation: u64,
    map: HashMap<String, ProbeResolution>,
}

/// resolution 缓存的复合键：解释器 + 工作区根（两者任一变化即失效）
fn resolution_cache_key(python: &str, root: &Path) -> String {
    format!("{python}\u{0}{}", root.to_string_lossy())
}

/// 环境快照缓存（M4-2 code 范围复用）：最近一次成功 `uv pip list` 的结果。
/// 复核修复：键增补工作区根——切工作区后 code 范围不得复用旧工作区的包列表
/// （E2/E3 的声明比对对象已换）。
static ENV_SNAPSHOT_CACHE: LazyLock<Mutex<Option<(String, Vec<(String, String)>)>>> =
    LazyLock::new(|| Mutex::new(None));

fn env_snapshot_cache_key(interp: &str, root: &Path) -> String {
    format!("{interp}\u{0}{}", root.to_string_lossy())
}

fn store_env_snapshot_cache(interp: &str, root: &Path, snap: &[(String, String)]) {
    let mut guard = unpoison(ENV_SNAPSHOT_CACHE.lock());
    *guard = Some((env_snapshot_cache_key(interp, root), snap.to_vec()));
}

fn load_env_snapshot_cache() -> Option<(String, Vec<(String, String)>)> {
    unpoison(ENV_SNAPSHOT_CACHE.lock()).clone()
}

/// resolution 缓存取用：**始终返回当前代次**（键不匹配时命中集为空）——回写方以此
/// 代次校验。若 miss 时返回 0，invalidate 后的首个 store 会因 0≠N 被永久丢弃
/// （full 自己 invalidate → load miss → store 被丢——自毁，复核修复 #2 的补丁缺陷）。
fn load_resolution_cache(python: &str, root: &Path) -> (u64, HashMap<String, ProbeResolution>) {
    let guard = unpoison(RESOLUTION_CACHE.lock());
    if guard.key != resolution_cache_key(python, root) {
        return (guard.generation, HashMap::new());
    }
    (guard.generation, guard.map.clone())
}

/// resolution 缓存写入（探针成功后调用）：写入前校验代次——load 与 store 之间缓存被
/// full 作废（generation 变化）则丢弃本次结果（旧环境的解析不该覆盖新代次）。
fn store_resolution_cache(python: &str, root: &Path, loaded_gen: u64, new_map: &HashMap<String, ProbeResolution>) {
    let mut guard = unpoison(RESOLUTION_CACHE.lock());
    let key = resolution_cache_key(python, root);
    if guard.key != key {
        guard.map.clear();
        guard.key = key;
    }
    if guard.generation != loaded_gen {
        return; // 在途扫描撞上作废：结果属旧环境，丢弃（复核修复 #2）
    }
    for (k, v) in new_map {
        guard.map.insert(k.clone(), v.clone());
    }
    // 缓存无界增长防御：模块数远超工作区合理规模时清空重来（正常项目 < 10k 模块）
    if guard.map.len() > 20_000 {
        guard.map.clear();
    }
}

/// resolution 缓存作废（full 扫描前调用：环境内容可能已变，missing/site 分类不可信）。
/// ++generation 使在途 code 扫描的回写自然失效。
fn invalidate_resolution_cache() {
    let mut guard = unpoison(RESOLUTION_CACHE.lock());
    guard.key = String::new();
    guard.map.clear();
    guard.generation = guard.generation.wrapping_add(1);
}

fn file_mtime(p: &Path) -> Option<(u64, u32)> {
    let m = fs::metadata(p).ok()?.modified().ok()?;
    let d = m.duration_since(UNIX_EPOCH).ok()?;
    Some((d.as_secs(), d.subsec_nanos()))
}

fn store_dep_cache(root: &Path, map: HashMap<String, CachedFile>) {
    let mut guard = unpoison(DEP_CACHE.lock());
    *guard = Some((root.to_path_buf(), map));
}

/// 遍历工作区全部 .py/.pyw（复用 watcher::WATCH_IGNORED 口径剔除 .venv/.git 等，
/// 跳过选区运行临时文件与其他点目录；不跟进符号链接目录防环；路径排序保证确定性）。
fn collect_py_files(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.path());
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if !name.starts_with('.') && !crate::watcher::is_ignored_dir_name(&name) {
                    walk(&e.path(), out);
                }
            } else if (name.ends_with(".py") || name.ends_with(".pyw"))
                && !crate::watcher::is_ignored_file_prefix(&name)
            {
                out.push(e.path());
            }
        }
    }
    let mut out = Vec::new();
    walk(root, &mut out);
    out
}

/// 执行探针子进程：payload 写临时文件经 argv 传入（复用 run_with_timeout 的
/// stdout/stderr 并发读取 + 超时杀进程树，避免 stdin 管道死锁）。
/// extra_env 仅测试注入 PYTHONPATH 用，生产传空。
fn run_probe_env(
    python: &str,
    root: &Path,
    payload: &Value,
    timeout: Duration,
    extra_env: &[(&str, &str)],
) -> Result<ProbeOutput, String> {
    let payload_path = std::env::temp_dir().join(format!(
        "pylume-dep-probe-{}-{}.json",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    ));
    let body = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    fs::write(&payload_path, body).map_err(|e| format!("写探针 payload 失败：{e}"))?;
    let mut cmd = Command::new(python);
    cmd.arg("-c").arg(DEP_PROBE_SCRIPT).arg(&payload_path).current_dir(root);
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let result = run_with_timeout(&mut cmd, timeout);
    let _ = fs::remove_file(&payload_path);
    let (out, err, code) = result?;
    if code != Some(0) {
        let msg = format!("{out}{err}").trim().to_string();
        return Err(if msg.is_empty() {
            format!("依赖探针失败（exit {code:?}）")
        } else {
            msg
        });
    }
    serde_json::from_str::<ProbeOutput>(out.trim()).map_err(|e| format!("解析依赖探针输出失败：{e}"))
}

/// 无选定解释器（uv run 兜底）时借用系统 python 跑探针：AST 解析与 local/stdlib 分类
/// 不依赖目标环境，E4 在兜底路径仍可算（§3.3 字段语义）。找不到 → 代码层整体降级为空。
fn borrow_python() -> Option<String> {
    for cand in ["python", "python3"] {
        let mut cmd = Command::new(cand);
        cmd.arg("--version");
        if let Ok((_, _, Some(0))) = run_with_timeout(&mut cmd, Duration::from_secs(5)) {
            return Some(cand.to_string());
        }
    }
    None
}

/// 代码层全量扫描：遍历 + mtime 增量缓存 + 探针（10s 超时红线，§4.1）。
/// 探针任何失败 → None（调用方降级为空代码层），缓存回滚原样——dirty 文件下轮仍 dirty。
fn scan_code_layer(root: &Path, python: &str) -> Option<ProbeOutput> {
    let t0 = Instant::now();
    let files = collect_py_files(root);

    // 取出本 root 的缓存（单工作区模型：不同 root 直接丢弃旧缓存）
    let cached: HashMap<String, CachedFile> = {
        let mut guard = unpoison(DEP_CACHE.lock());
        match guard.take() {
            Some((r, map)) if r == root => map,
            other => {
                // root 不匹配时不写回（换工作区即失效）；None 保持 None
                let _ = other;
                HashMap::new()
            }
        }
    };

    let mut reused_imports: Vec<ProbeImport> = Vec::new();
    let mut all_modules: HashSet<String> = HashSet::new();
    // 模块 → 位点所在目录集合（用户实测 bug 修复：脚本式布局的同目录导入，探针
    // 须按「import 位点所属文件目录」解析——module_dirs 随 payload 传给探针，
    // 覆盖缓存复用模块的目录上下文；dirty 文件的目录由探针从 files 路径自行推导）
    let mut module_dirs: HashMap<String, Vec<String>> = HashMap::new();
    let mut dirty: Vec<(String, (u64, u32))> = Vec::new();
    for f in &files {
        let Ok(rel) = f.strip_prefix(root) else { continue };
        let rel_s = rel.to_string_lossy().replace('\\', "/");
        let file_dir = rel
            .parent()
            .map(|p| root.join(p).to_string_lossy().to_string())
            .unwrap_or_else(|| root.to_string_lossy().to_string());
        let Some(mtime) = file_mtime(f) else { continue };
        match cached.get(&rel_s) {
            Some(c) if c.mtime == mtime => {
                for imp in &c.imports {
                    all_modules.insert(imp.module.clone());
                    reused_imports.push(imp.clone());
                    let dirs = module_dirs.entry(imp.module.clone()).or_default();
                    if !dirs.contains(&file_dir) {
                        dirs.push(file_dir.clone());
                    }
                }
            }
            // mtime 先于解析取：扫描期间文件再变 → 缓存 mtime 偏旧 → 下轮仍判 dirty（保守正确）
            _ => dirty.push((rel_s, mtime)),
        }
    }

    // resolution 缓存命中集（M4-2）：未变模块的解析结果直接复用，探针只解析「新增模块」。
    // 复核修复：load 始终返回当前代次（miss 也有），回写时校验防作废后覆盖。
    let (res_gen, res_map) = load_resolution_cache(python, root);
    let res_hit: HashMap<String, ProbeResolution> = all_modules
        .iter()
        .filter_map(|m| res_map.get(m).map(|r| (m.clone(), r.clone())))
        .collect();
    let mut probe_modules: Vec<String> = all_modules.iter().cloned().collect();
    probe_modules.retain(|m| !res_hit.contains_key(m));
    probe_modules.sort();

    if dirty.is_empty() && probe_modules.is_empty() {
        // 无 Python 文件 / 全部文件无 import / 全部模块解析已缓存：不 spawn 探针
        store_dep_cache(root, cached);
        return Some(ProbeOutput { imports: reused_imports, resolution: res_hit });
    }

    let payload = json!({
        "workspace_root": root.to_string_lossy(),
        "files": dirty.iter().map(|(r, _)| r.clone()).collect::<Vec<_>>(),
        "modules": probe_modules,
        // 缓存复用模块的位点目录（脚本语义解析上下文）；dirty 文件的目录由探针
        // 从 files 路径推导，这里只传缓存侧（未变文件不重跑 AST）
        "module_dirs": module_dirs,
    });
    let out = match run_probe_env(python, root, &payload, DEP_PROBE_TIMEOUT, &[]) {
        Ok(o) => o,
        Err(e) => {
            log_line(Level::Warn, &format!("dep_scan：代码层探针失败，降级为空代码层：{e}"));
            store_dep_cache(root, cached); // 回滚原缓存（本次未获得新 AST 结果）
            return None;
        }
    };

    // 合并缓存：未变文件沿用 + 变化文件用探针新结果；已删除文件从缓存剔除
    let mut new_cache = cached;
    let mut by_file: HashMap<&str, Vec<ProbeImport>> = HashMap::new();
    for imp in &out.imports {
        by_file.entry(imp.file.as_str()).or_default().push(imp.clone());
    }
    for (rel, mtime) in &dirty {
        new_cache.insert(
            rel.clone(),
            CachedFile { mtime: *mtime, imports: by_file.remove(rel.as_str()).unwrap_or_default() },
        );
    }
    let alive: HashSet<String> = files
        .iter()
        .filter_map(|f| f.strip_prefix(root).ok())
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .collect();
    new_cache.retain(|k, _| alive.contains(k));
    store_dep_cache(root, new_cache);

    // resolution 缓存合并（M4-2）：新解析结果入缓存（探针返回的 resolution 只含本次
    // 解析的模块），完整集 = 命中集 + 新集。代次校验在 store 内（作废后丢弃回写）。
    store_resolution_cache(python, root, res_gen, &out.resolution);
    let mut resolution = res_hit;
    resolution.extend(out.resolution);

    log_line(
        Level::Info,
        &format!(
            "dep_scan 代码层：files={} dirty={} imports={} resolutionMiss={} took={}ms",
            files.len(),
            dirty.len(),
            reused_imports.len() + out.imports.len(),
            probe_modules.len(),
            t0.elapsed().as_millis()
        ),
    );
    let mut imports = reused_imports;
    imports.extend(out.imports);
    Some(ProbeOutput { imports, resolution })
}

/// 代码层零探针复用（M4-2 declaration 范围）：声明文件变更不涉及代码层——AST 缓存 +
/// resolution 缓存直接组装 ProbeOutput，不 spawn 探针。任一缓存缺失（首次扫描 /
/// 换工作区后）返回 None（调用方降级为空代码层，语义与探针失败一致——保守不误报）。
fn reuse_code_layer(root: &Path, python: &str) -> Option<ProbeOutput> {
    let files = collect_py_files(root);
    let cached: HashMap<String, CachedFile> = {
        let mut guard = unpoison(DEP_CACHE.lock());
        match guard.take() {
            Some((r, map)) if r == root => {
                *guard = Some((r, map.clone()));
                map
            }
            other => {
                let _ = other;
                HashMap::new()
            }
        }
    };
    if cached.is_empty() {
        return None;
    }
    let res_cache = load_resolution_cache(python, root).1;
    let mut imports: Vec<ProbeImport> = Vec::new();
    let mut modules: HashSet<String> = HashSet::new();
    let mut all_hit = true;
    for f in &files {
        let Ok(rel) = f.strip_prefix(root) else { continue };
        let rel_s = rel.to_string_lossy().replace('\\', "/");
        let Some(c) = cached.get(&rel_s) else { continue };
        let Some(mtime) = file_mtime(f) else { continue };
        if c.mtime != mtime {
            // 文件在声明变更与本次扫描之间又被改过：缓存不可信，整体放弃复用（保守）
            return None;
        }
        for imp in &c.imports {
            modules.insert(imp.module.clone());
            imports.push(imp.clone());
        }
    }
    let mut resolution = HashMap::new();
    for m in modules {
        let Some(r) = res_cache.get(&m) else {
            all_hit = false;
            break;
        };
        resolution.insert(m, r.clone());
    }
    if !all_hit {
        return None;
    }
    imports.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
    Some(ProbeOutput { imports, resolution })
}

// ---------- dep：diff 纯计算（无子进程，单测友好） ----------

/// 缺失模块的 dist：探针反查（packages_distributions）→ 内置别名表 → None（正常占比，§3.3）。
/// M4-4 后生产路径改走 effective_dist_candidates；保留给单测锁定别名表语义。
#[cfg(test)]
fn effective_dist(module: &str, probe_dist: Option<&str>) -> Option<String> {
    probe_dist
        .map(String::from)
        .or_else(|| DIST_ALIAS_FALLBACK.iter().find(|(m, _)| *m == module).map(|(_, d)| d.to_string()))
}

/// dist 候选全集（M4-4）：探针候选列表 + 别名表兜底（去重保序）。
/// 返回 (首候选, 全部候选)——首候选兼容旧 dist 字段语义，全部候选供安装时弹选择。
fn effective_dist_candidates(module: &str, res: &ProbeResolution) -> (Option<String>, Vec<String>) {
    let mut cands: Vec<String> = res.all_candidates();
    if cands.is_empty() {
        if let Some((_, d)) = DIST_ALIAS_FALLBACK.iter().find(|(m, _)| *m == module) {
            cands.push(d.to_string());
        }
    }
    let first = cands.first().cloned();
    (first, cands)
}

/// 按 (file, line) 排序探针 import 位点（缓存复用 + 增量合并后顺序不保证）
fn sorted_imports(probe: &ProbeOutput) -> Vec<&ProbeImport> {
    let mut v: Vec<&ProbeImport> = probe.imports.iter().collect();
    v.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
    v
}

/// v1.7 A 匹配链：模块是否命中声明全集。模块名 → 探针候选 dist → 别名表 → 模块名本身，
/// 全部候选归一化逐一比对 declared.all（dotenv→python-dotenv 这类反查不到且别名表没有的
/// 返回 None——仍进 E1，宁可多报不漏）。命中时返回 (声明 dist 归一化名, 所属组)。
fn declared_hit(
    module: &str,
    probe_res: &ProbeResolution,
    declared: &DeclaredDeps,
) -> Option<(String, Option<String>)> {
    // 候选集：探针 distCandidates（packages_distributions 反查，未装时通常空）+ 别名表 + 模块名
    let mut cands: Vec<String> = probe_res.all_candidates();
    if let Some((_, d)) = DIST_ALIAS_FALLBACK.iter().find(|(m, _)| *m == module) {
        cands.push(d.to_string());
    }
    cands.push(module.to_string());
    for c in &cands {
        let n = normalize_dist(c);
        if declared.all.contains(&n) {
            // 归一化名即声明 dist（比对口径一致）；组映射缺失时由调用方给默认组
            let group = declared.group_of.get(&n).cloned();
            return Some((n, group));
        }
    }
    None
}

/// E1：resolution=missing 的模块 → 按 (module, file) 聚合；命中声明全集的分流到
/// declared_missing_modules（v1.7 A：E1 只留「未声明的缺失」，已声明未装归 E2 小节）。
/// line = 首位点行号；lazy = 全部位点皆惰性（任一顶层 import 在模块加载时执行，即非惰性）。
fn compute_missing_in_env(
    probe: &ProbeOutput,
    declared: &DeclaredDeps,
    declared_group_default: &str,
) -> (Vec<MissingModule>, Vec<DeclaredMissingModule>) {
    let mut order: Vec<(String, String)> = Vec::new();
    let mut acc: HashMap<(String, String), (u32, bool, Option<String>, Vec<String>)> = HashMap::new();
    let mut decl_order: Vec<String> = Vec::new();
    let mut decl_acc: HashMap<String, (String, String, u32, String, u32, bool)> = HashMap::new();
    for imp in sorted_imports(probe) {
        let Some(res) = probe.resolution.get(&imp.module) else { continue };
        if res.status != "missing" {
            continue;
        }
        // v1.7 A：声明全集命中 → 分流（按 module 聚合：files 计数、首位点、lazy 全体与）
        if let Some((dist, group)) = declared_hit(&imp.module, res, declared) {
            match decl_acc.get_mut(&imp.module) {
                Some((_, _, files, _, _, lazy)) => {
                    *files += 1;
                    *lazy = *lazy && imp.lazy;
                }
                None => {
                    let group = group.unwrap_or_else(|| declared_group_default.to_string());
                    decl_acc.insert(
                        imp.module.clone(),
                        (dist, group, 1, imp.file.clone(), imp.line, imp.lazy),
                    );
                    decl_order.push(imp.module.clone());
                }
            }
            continue;
        }
        let key = (imp.module.clone(), imp.file.clone());
        match acc.get_mut(&key) {
            Some((_, lazy, _, _)) => *lazy = *lazy && imp.lazy,
            None => {
                let (dist, cands) = effective_dist_candidates(&imp.module, res);
                acc.insert(key.clone(), (imp.line, imp.lazy, dist, cands));
                order.push(key);
            }
        }
    }
    let missing = order
        .into_iter()
        .filter_map(|key| {
            let (line, lazy, dist, dist_candidates) = acc.remove(&key)?;
            Some(MissingModule { module: key.0, dist, dist_candidates, file: key.1, line, lazy })
        })
        .collect();
    let declared_modules = decl_order
        .into_iter()
        .filter_map(|m| {
            let (dist, group, files, file, line, lazy) = decl_acc.remove(&m)?;
            Some(DeclaredMissingModule { module: m, dist, group, files, file, line, lazy })
        })
        .collect();
    (missing, declared_modules)
}

/// E4（仅 style=pyproject）：resolution=site（三方已装）且不在声明全集 → 未声明。
/// missing 模块不进 E4——已在 E1，装完若仍未声明会自然浮出；避免把「拼错的模块名」
/// 误报成未声明依赖。排除：声明全集（含 extras/groups）、工具链自装、项目自身
/// （uv sync 把项目本体 editable 装进 venv，packages_distributions 会反查到项目名）。
fn compute_undeclared(
    probe: &ProbeOutput,
    declared: &DeclaredDeps,
    project_name: Option<&str>,
) -> Vec<UndeclaredModule> {
    let proj = project_name.map(normalize_dist);
    let mut order: Vec<(String, String)> = Vec::new();
    let mut acc: HashMap<(String, String), (u32, Option<String>, Vec<String>)> = HashMap::new();
    for imp in sorted_imports(probe) {
        let Some(res) = probe.resolution.get(&imp.module) else { continue };
        if res.status != "site" {
            continue;
        }
        let (dist, dist_candidates) = effective_dist_candidates(&imp.module, res);
        let norm = normalize_dist(dist.as_deref().unwrap_or(&imp.module));
        if declared.all.contains(&norm) || DRIFT_EXCLUDED.contains(&norm.as_str()) {
            continue;
        }
        if proj.as_deref() == Some(norm.as_str()) {
            continue;
        }
        let key = (imp.module.clone(), imp.file.clone());
        match acc.get_mut(&key) {
            Some((line, _, _)) => *line = (*line).min(imp.line),
            None => {
                acc.insert(key.clone(), (imp.line, dist, dist_candidates));
                order.push(key);
            }
        }
    }
    order
        .into_iter()
        .filter_map(|key| {
            let (line, dist, dist_candidates) = acc.remove(&key)?;
            Some(UndeclaredModule { module: key.0, dist, dist_candidates, file: key.1, line })
        })
        .collect()
}

/// E2：同步范围声明中环境快照缺失的 dist（PEP 503 归一化比对；去重保序）。
fn compute_declared_missing(declared: &DeclaredDeps, installed: &[(String, String)]) -> Vec<DeclaredMissing> {
    let installed_norm: HashSet<String> = installed.iter().map(|(n, _)| normalize_dist(n)).collect();
    let mut seen: HashSet<&str> = HashSet::new();
    declared
        .core
        .iter()
        .filter(|d| !installed_norm.contains(&d.dist) && seen.insert(d.dist.as_str()))
        .map(|d| DeclaredMissing { dist: d.dist.clone(), spec: d.spec.clone() })
        .collect()
}

/// E3：环境中已装但不在声明全集的 dist（归一化比对），排除工具链自装/基础设施包/项目自身。
fn compute_env_drift(
    installed: &[(String, String)],
    declared: &DeclaredDeps,
    project_name: Option<&str>,
) -> Vec<EnvDriftPkg> {
    let proj = project_name.map(|p| normalize_dist(p));
    installed
        .iter()
        .filter(|(n, _)| {
            let norm = normalize_dist(n);
            !DRIFT_EXCLUDED.contains(&norm.as_str())
                && !declared.all.contains(&norm)
                && proj.as_deref() != Some(norm.as_str())
        })
        .map(|(n, v)| EnvDriftPkg { dist: n.clone(), version: v.clone() })
        .collect()
}

/// E2 特例（§3.3）：style=requirements 且整个 requirements 声明集与环境快照零交集
/// = 「老项目建了 .venv 没装依赖」（用户反馈 1）。声明集为空恒 false（无从谈起未安装）。
fn compute_requirements_uninstalled(declared: &DeclaredDeps, installed: &[(String, String)]) -> bool {
    if declared.core.is_empty() {
        return false;
    }
    let installed_norm: HashSet<String> = installed.iter().map(|(n, _)| normalize_dist(n)).collect();
    !declared.core.iter().any(|d| installed_norm.contains(&d.dist))
}

// ---------- dep：dep_scan 编排 ----------

/// 扫描范围（M4-2 增量路由，§4.4 失效矩阵的信号分流）：
/// - `full`：L0+L1+L2+E5 全量（打开工作区 / 手动刷新 / 环境信号 / 修复收尾）；
/// - `code`：L0+L2（.py 变更信号——不改环境事实与声明内容，跳过 uv pip list / uv lock --check）；
/// - `declaration`：L0+L1（声明文件变更——声明集变了要重比环境快照，但代码层 imports 未变）。
/// E5 仅 full 跑（lock 一致性与 .py/环境无关；declaration 信号实际是 pyproject 变更，
/// 声明重解析后 lock 检查的输入 pyproject 未变语义不变——避免每个声明事件多一个子进程）。
#[derive(Clone, Copy, PartialEq, Debug)]
enum ScanScope {
    Full,
    Code,
    Declaration,
}

impl ScanScope {
    fn from_str(s: &str) -> ScanScope {
        match s {
            "code" => ScanScope::Code,
            "declaration" => ScanScope::Declaration,
            _ => ScanScope::Full, // 缺省/未知值 → 全量（保守：宁可多算不漏报）
        }
    }

    fn runs_code(&self) -> bool {
        matches!(self, ScanScope::Full | ScanScope::Code)
    }

    fn runs_env(&self) -> bool {
        matches!(self, ScanScope::Full | ScanScope::Declaration)
    }

    fn runs_lock_check(&self) -> bool {
        *self == ScanScope::Full
    }
}

/// 全量依赖体检（§4.5 L1+L2）：L0 style 判定 → 声明层解析 → 环境快照 → 代码层探针
/// → E1~E5 diff 纯计算。async + spawn_blocking（阻塞型命令纪律）；任何单层失败只降级
/// 对应字段、不中断整体（检测是顾问不是路障，§4.5 通用红线）。
/// scope（M4-2）：失效信号分流后的扫描范围（full/code/declaration，缺省 full）。
#[tauri::command]
pub async fn dep_scan(workspace_root: String, scope: Option<String>) -> Result<DepDiff, String> {
    let scope = scope.as_deref().map(ScanScope::from_str).unwrap_or(ScanScope::Full);
    tauri::async_runtime::spawn_blocking(move || dep_scan_impl(&workspace_root, scope))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn dep_scan_impl(workspace_root: &str, scope: ScanScope) -> Result<DepDiff, String> {
    let t_start = Instant::now();
    let root = Path::new(workspace_root);
    if !root.is_dir() {
        return Err(format!("工作区不存在：{workspace_root}"));
    }

    // L0：style 判定（与 dep_style 命令同一函数，杜绝两端判定逻辑漂移，§3.3）
    let style = detect_style(root);
    let external = style.style == "external";

    // 解释器：工作区配置 > .venv 自动检测 > None（uv run 兜底）
    let interpreter = get_interpreter(workspace_root.to_string()).ok().flatten();

    // 声明层（external 不解析——锁文件格式我们不认，E2~E5 主动禁用而非给错误结果，§4.2.1；
    // bare 无声明可解析）。
    // fika-admin 实测修复：uv.lock 的锁定闭包并入 E3/E4 排除集（不进 core——E2 同步范围
    // 仍按 pyproject 声明，lock 是「合法存在的传递依赖」而非「应装未声明」）
    let (declared, project_name) = if external {
        (DeclaredDeps::default(), None)
    } else {
        match style.style.as_str() {
            "pyproject" => {
                let (mut deps, name) = fs::read_to_string(root.join("pyproject.toml"))
                    .ok()
                    .map(|t| parse_pyproject_deps(&t))
                    .unwrap_or_default();
                let lock_names = parse_uv_lock_names(root);
                if !lock_names.is_empty() {
                    deps.all.extend(lock_names);
                }
                (deps, name)
            }
            "requirements" => (parse_requirements_declared(root), None),
            _ => (DeclaredDeps::default(), None),
        }
    };

    // L1：环境快照（仅在有解释器时；失败 → E2/E3 降级为空，E1 不受影响——探针 find_spec 是真值）
    // M4-2 scope：declaration 信号也跑 L1（声明集变了要重比环境）；code 信号跳过——
    // 环境事实未变，复用「上次环境快照」而非再 spawn uv pip list。
    let mut installed: Vec<(String, String)> = Vec::new();
    let mut installed_ok = false;
    if let Some(interp) = &interpreter {
        if scope.runs_env() {
            match scan_list_packages(interp) {
                Ok(list) => {
                    installed = list;
                    installed_ok = true;
                    store_env_snapshot_cache(interp, root, &installed);
                }
                Err(e) => log_line(Level::Warn, &format!("dep_scan：环境快照失败（E2/E3 降级为空）：{e}")),
            }
        } else {
            // code 范围：复用进程级缓存的上次快照（无缓存/键不匹配 → E2/E3 降级为空，保守）。
            // 复核修复：键 = 解释器+工作区根——切工作区后不得复用旧工作区的包列表。
            let want_key = env_snapshot_cache_key(interp, root);
            if let Some((k, snap)) = load_env_snapshot_cache() {
                if k == want_key {
                    installed = snap;
                    installed_ok = true;
                }
            }
        }
    }

    // L2：代码层探针（解释器缺失 → 借用系统 python，E4 仍可算；两者皆无 → 代码层为空）
    // M4-2 scope：code 信号跑探针（AST mtime 缓存 + resolution 解释器缓存吸收增量成本）；
    // declaration 信号跳过探针——代码层 imports 未变，直接复用缓存的 ProbeOutput。
    // full 信号先作废 resolution 缓存：环境内容可能已变（装/卸包），缓存的
    // missing/site 分类会过期（正确性优先——full 本就是「重算真值」的时机）。
    let probe_python = interpreter.clone().or_else(borrow_python);
    let probe = if scope.runs_code() {
        if scope == ScanScope::Full {
            invalidate_resolution_cache();
        }
        probe_python.as_deref().and_then(|py| scan_code_layer(root, py))
    } else {
        probe_python.as_deref().and_then(|py| reuse_code_layer(root, py))
    };

    // E5：pyproject 且已有 uv.lock 才检查（无 lock 文件 = 用户未采用 lock 工作流，不报过期）
    let lock_out_of_date = scope.runs_lock_check()
        && style.style == "pyproject"
        && root.join("uv.lock").is_file()
        && check_lock_out_of_date(root);

    // diff 投影（interpreter=null 时环境侧 E1/E2/E3 置空、E4/E5 照常，§3.3 字段语义）
    let env_side = interpreter.is_some();
    // v1.7 A：E1 分流的已声明未装；external 声明层不解析 → 分流恒空（E1 照旧全量）
    let (missing_in_env, declared_missing_modules) = match (&probe, env_side, external) {
        (Some(p), true, false) => {
            let default_group =
                if style.style == "requirements" { "requirements".to_string() } else { "declared".to_string() };
            compute_missing_in_env(p, &declared, &default_group)
        }
        _ => (Vec::new(), Vec::new()),
    };
    let undeclared = match (&probe, style.style.as_str()) {
        (Some(p), "pyproject") => compute_undeclared(p, &declared, project_name.as_deref()),
        _ => Vec::new(),
    };
    let declared_missing = if env_side && installed_ok && !external {
        compute_declared_missing(&declared, &installed)
    } else {
        Vec::new()
    };
    let env_drift = if env_side && installed_ok && !external {
        compute_env_drift(&installed, &declared, project_name.as_deref())
    } else {
        Vec::new()
    };
    let requirements_uninstalled =
        style.style == "requirements" && installed_ok && compute_requirements_uninstalled(&declared, &installed);

    let scanned_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let mut diff = DepDiff {
        style: style.style.clone(),
        external_manager: style.external_manager.clone(),
        missing_in_env,
        declared_missing,
        declared_missing_modules,
        env_drift,
        undeclared,
        lock_out_of_date,
        requirements_uninstalled,
        interpreter: interpreter.clone(),
        requirements_file: style.requirements_file.clone(),
        scanned_at,
    };
    // 忽略清单过滤（M3，§5.3「忽略项在 diff 计算后过滤」的后端统一落点）：
    // 预检/灯泡/面板所有消费者拿到的是同一份已过滤真值；日志计数即用户可见口径
    apply_dep_ignores(&mut diff, &load_dep_ignores(workspace_root));
    log_line(
        Level::Info,
        &format!(
            "dep_scan：style={} interpreter={} E1={} E2={} E2decl={} E3={} E4={} lockStale={} reqUninstalled={} took={}ms",
            diff.style,
            interpreter.is_some(),
            diff.missing_in_env.len(),
            diff.declared_missing.len(),
            diff.declared_missing_modules.len(),
            diff.env_drift.len(),
            diff.undeclared.len(),
            diff.lock_out_of_date,
            diff.requirements_uninstalled,
            t_start.elapsed().as_millis()
        ),
    );
    Ok(diff)
}

/// dep 域轻量环境快照命令（§5.5 L1 真值判定，M2 失效矩阵）：`uv pip list --format=freeze`。
/// 环境信号（终端完成摘要嗅探 / site-packages 监听）到达后先调此命令拿当前环境快照，
/// 与前端缓存的上次快照对比——**有差异才**触发 L2 全量 `dep_scan` + 引擎重启（误报代价封顶
/// 为一次快照对比，§4.4/§5.5）。解释器解析与 `dep_scan` 同源（`get_interpreter`），保证对比的
/// 是同一环境；无解释器（uv run 兜底）返回空——环境侧本就不参与 diff（§3.3 字段语义）。
#[tauri::command]
pub async fn dep_env_snapshot(workspace_root: String) -> Result<Vec<PackageInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || dep_env_snapshot_impl(&workspace_root))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn dep_env_snapshot_impl(workspace_root: &str) -> Result<Vec<PackageInfo>, String> {
    let Some(interp) = get_interpreter(workspace_root.to_string()).ok().flatten() else {
        return Ok(Vec::new());
    };
    let list = scan_list_packages(&interp)?;
    store_env_snapshot_cache(&interp, Path::new(workspace_root), &list);
    Ok(list.into_iter().map(|(name, version)| PackageInfo { name, version }).collect())
}

// ---------- dep：忽略清单（M3，§5.3/R9） ----------
//
// 行级「忽略此包」持久化到工作区配置 `dep_ignored` 字段（复用解释器配置的
// load_config/save_config 先例，不侵入用户项目）。过滤在**后端统一**执行
// （dep_scan 计算 diff 后、返回前）——prepareRun / 灯泡 / 面板所有消费者自动
// 跳过忽略项，单一真值口径干净；「已忽略」视图单独读 dep_ignore_list 展示。

/// 忽略清单条目（camelCase 对齐 TS 消费端）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DepIgnoreEntry {
    /// 断边组："e1" | "e2" | "e3" | "e4"（E5 是项目级布尔，无行级忽略语义）
    pub edge: String,
    /// E1/E4 = 模块名（大小写敏感原样）；E2/E3 = dist 名（PEP 503 归一化后存储）
    pub key: String,
}

/// 条目归一化与合法性校验：edge 限 e1~e4；E2/E3 的 key 经 normalize_dist 归一
/// （比对时大小写/分隔符异形也命中），E1/E4 模块名原样（Python 模块大小写敏感）。
fn normalized_ignore_entry(edge: &str, key: &str) -> Result<DepIgnoreEntry, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("忽略条目不能为空".to_string());
    }
    match edge {
        "e1" | "e4" => Ok(DepIgnoreEntry { edge: edge.to_string(), key: key.to_string() }),
        "e2" | "e3" => Ok(DepIgnoreEntry { edge: edge.to_string(), key: normalize_dist(key) }),
        _ => Err(format!("未知断边组：{edge}（合法值 e1~e4）")),
    }
}

/// 从工作区配置提取忽略清单（字段缺失/损坏 → 空清单，绝不 panic——同 load_config 口径）
fn dep_ignores_from_config(v: &Value) -> Vec<DepIgnoreEntry> {
    v.get("dep_ignored")
        .and_then(|x| serde_json::from_value::<Vec<DepIgnoreEntry>>(x.clone()).ok())
        .unwrap_or_default()
}

fn load_dep_ignores(root: &str) -> Vec<DepIgnoreEntry> {
    dep_ignores_from_config(&load_config(root))
}

/// 写回忽略清单（edge+key 去重保序；空清单移除字段，不留空数组）→ 返回清理后的清单
fn save_dep_ignores(root: &str, list: Vec<DepIgnoreEntry>) -> Result<Vec<DepIgnoreEntry>, String> {
    let mut seen = HashSet::new();
    let cleaned: Vec<DepIgnoreEntry> = list
        .into_iter()
        .filter(|e| seen.insert((e.edge.clone(), e.key.clone())))
        .collect();
    let mut v = load_config(root);
    let obj = v.as_object_mut().ok_or("工作区配置格式非法")?;
    if cleaned.is_empty() {
        obj.remove("dep_ignored");
    } else {
        obj.insert("dep_ignored".into(), serde_json::to_value(&cleaned).map_err(|e| e.to_string())?);
    }
    save_config(root, &v)?;
    Ok(cleaned)
}

/// 读忽略清单（「已忽略」视图数据源；同步纯 fs，零子进程）
#[tauri::command]
pub fn dep_ignore_list(workspace_root: String) -> Vec<DepIgnoreEntry> {
    load_dep_ignores(&workspace_root)
}

/// 添加忽略条目（面板行级「忽略此包」）→ 返回更新后的完整清单（前端就地刷新视图）
#[tauri::command]
pub fn dep_ignore_add(workspace_root: String, edge: String, key: String) -> Result<Vec<DepIgnoreEntry>, String> {
    let entry = normalized_ignore_entry(&edge, &key)?;
    let mut list = load_dep_ignores(&workspace_root);
    list.push(entry);
    save_dep_ignores(&workspace_root, list)
}

/// 移除忽略条目（「已忽略」视图的恢复检测）→ 返回更新后的完整清单
#[tauri::command]
pub fn dep_ignore_remove(workspace_root: String, edge: String, key: String) -> Result<Vec<DepIgnoreEntry>, String> {
    let entry = normalized_ignore_entry(&edge, &key)?;
    let list = load_dep_ignores(&workspace_root)
        .into_iter()
        .filter(|e| {
            // E2/E3 两侧归一比对（M3 自查修复：手改配置存了异形键时，按归一后的 entry.key
            // 精确匹配会删不掉——与 apply_dep_ignores 的防御口径一致）；E1/E4 模块名原样匹配
            let same = e.edge == entry.edge
                && match e.edge.as_str() {
                    "e2" | "e3" => normalize_dist(&e.key) == entry.key,
                    _ => e.key == entry.key,
                };
            !same
        })
        .collect();
    save_dep_ignores(&workspace_root, list)
}

/// 忽略清单过滤（dep_scan 返回前统一执行）：E1/E4 按模块名精确匹配（大小写敏感），
/// E2/E3 按 dist 归一化匹配——两侧都归一（存储侧经 normalized_ignore_entry 已归一，
/// 配置文件被手改成异形写法时同样命中，防御绕过 add 路径的场景）。
fn apply_dep_ignores(diff: &mut DepDiff, ignores: &[DepIgnoreEntry]) {
    if ignores.is_empty() {
        return;
    }
    let ignored = |edge: &str, key: &str| ignores.iter().any(|e| e.edge == edge && e.key == key);
    let ignored_dist = |edge: &str, dist: &str| {
        let n = normalize_dist(dist);
        ignores.iter().any(|e| e.edge == edge && normalize_dist(&e.key) == n)
    };
    diff.missing_in_env.retain(|m| !ignored("e1", &m.module));
    diff.declared_missing.retain(|d| !ignored_dist("e2", &d.dist));
    // v1.7 A：E2 小节条目沿用 e2 忽略（模块名与声明 dist 归一化双口径比对——
    // 存储侧可能按模块名或按 dist 名添加，两侧都归一防御）
    diff.declared_missing_modules
        .retain(|m| !ignored_dist("e2", &m.dist) && !ignored_dist("e2", &m.module));
    diff.env_drift.retain(|d| !ignored_dist("e3", &d.dist));
    diff.undeclared.retain(|u| !ignored("e4", &u.module));
}

// ---------- dep：修复动作（M3，§5.1 动作矩阵 + §5.6 L3 交互） ----------
//
// 检测层只读不写的边界到此为止：dep_fix 是 dep 域**唯一**写环境/写声明的入口，
// 且只源于用户显式动作（面板/灯泡/横幅确认，R5）。收尾协议（重算 diff →
// restartEngine → toast）由前端编排（§5.2），本层只负责执行并返回 exit code。

/// dep_fix 会话互斥（§5.6 防重入）：同一时刻仅一个 dep_fix 在跑。
/// uv 自身对 uv.lock 有文件锁，并发 `uv add` 必然报错——提前挡住而不是让用户看到 uv 的报错。
static DEP_FIX_BUSY: AtomicBool = AtomicBool::new(false);

/// action × style → uv 参数（纯函数，构建单点——测试与执行共用，杜绝两处漂移）。
/// - `install`（E1 装缺失包）：pyproject → `uv add <dists>`；requirements/bare/external →
///   `uv pip install --python <interp> <dists>`（external 的声明层归外部管理器所有，
///   只动环境侧不写声明，§4.2.1/R11：E1 对 external 仍生效）；
/// - `sync`（E2 同步环境）：pyproject → `uv sync`；requirements → `uv pip install -r <file>`；
/// - `declare`（E3 漂移收敛 / E4 补声明）：仅 pyproject → `uv add <dists>`；
/// - `lock`（E5 刷新锁）：仅 pyproject → `uv lock`；
/// - `migrate`（requirements 迁移引导，R4）：→ `uv add -r <file>`（只读原文件、写 pyproject，
///   不改写不删除 requirements.txt，R4.1；pyproject 缺失由调用方先 ensure）。
fn plan_dep_fix(
    action: &str,
    style: &DepStyle,
    dists: &[String],
    interpreter: Option<&str>,
) -> Result<Vec<String>, String> {
    fn pip_install_args(interp: Option<&str>, tail: &[String]) -> Result<Vec<String>, String> {
        let interp = interp.ok_or("未选择解释器，无法安装（请先在环境面板选择解释器）")?;
        let mut args =
            vec!["pip".to_string(), "install".to_string(), "--python".to_string(), interp.to_string()];
        args.extend(tail.iter().cloned());
        Ok(args)
    }
    fn add_args(dists: &[String]) -> Result<Vec<String>, String> {
        if dists.is_empty() {
            return Err("修复动作缺少包名".to_string());
        }
        let mut args = vec!["add".to_string()];
        args.extend(dists.iter().cloned());
        Ok(args)
    }
    match action {
        "install" => {
            if style.style == "pyproject" {
                add_args(dists)
            } else {
                pip_install_args(interpreter, dists)
            }
        }
        "sync" => match style.style.as_str() {
            "pyproject" => Ok(vec!["sync".to_string()]),
            "requirements" => {
                let f = style.requirements_file.as_deref().ok_or("未找到 requirements 文件")?;
                pip_install_args(interpreter, &["-r".to_string(), f.to_string()])
            }
            "external" => Err("外部管理器项目：声明层同步已禁用（仅缺失包安装可用）".to_string()),
            _ => Err("项目无声明文件，无可同步".to_string()),
        },
        "declare" => match style.style.as_str() {
            "pyproject" => add_args(dists),
            "external" => Err("外部管理器项目：声明写入已禁用（建议迁移到 uv）".to_string()),
            _ => Err("项目无 pyproject.toml，无法写入声明——请先迁移到 pyproject".to_string()),
        },
        "lock" => match style.style.as_str() {
            "pyproject" => Ok(vec!["lock".to_string()]),
            _ => Err("仅 pyproject 项目需要刷新 uv.lock".to_string()),
        },
        "migrate" => {
            if style.style == "external" {
                return Err("外部管理器项目：不适用 requirements 迁移引导".to_string());
            }
            let f = style.requirements_file.as_deref().ok_or("未找到 requirements 文件，无需迁移")?;
            Ok(vec!["add".to_string(), "-r".to_string(), f.to_string()])
        }
        other => Err(format!("未知修复动作：{other}")),
    }
}

/// 修复动作统一入口（§5.6 L3）：输出经 pip-stdout / pip-stderr 事件流式推送
/// （复用前端输出面板既有监听——这是唯一的进度指示，不做进度条）；返回 exit code（0 成功）。
/// 失败即停语义由前端批量编排承担（§5.6 第 5 条）：本命令一次只执行一个动作。
#[tauri::command]
pub async fn dep_fix(
    app: AppHandle,
    window: tauri::WebviewWindow,
    workspace_root: String,
    action: String,
    dists: Vec<String>,
) -> Result<i32, String> {
    let wid = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || dep_fix_impl(app, workspace_root, action, dists, wid))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn dep_fix_impl(
    app: AppHandle,
    workspace_root: String,
    action: String,
    dists: Vec<String>,
    wid: String,
) -> Result<i32, String> {
    if DEP_FIX_BUSY
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("另一个依赖修复动作正在执行，请等待其完成".to_string());
    }
    // panic 安全（M3 自查修复）：spawn_blocking 线程内 panic 会跳过手动 store(false)，
    // 互斥标志将永久卡死（此后所有修复动作被拒且无从恢复）。Drop 守卫保证任何退出
    // 路径（含 panic unwind）都释放标志。
    struct BusyGuard;
    impl Drop for BusyGuard {
        fn drop(&mut self) {
            DEP_FIX_BUSY.store(false, Ordering::Release);
        }
    }
    let _guard = BusyGuard;
    dep_fix_inner(&app, &workspace_root, &action, &dists, &wid)
}

fn dep_fix_inner(
    app: &AppHandle,
    workspace_root: &str,
    action: &str,
    dists: &[String],
    wid: &str,
) -> Result<i32, String> {
    let root = Path::new(workspace_root);
    if !root.is_dir() {
        return Err(format!("工作区不存在：{workspace_root}"));
    }
    // style 判定必须在 ensure pyproject **之前**：migrate 若先生成 pyproject，
    // style 会翻转为 pyproject 且丢失 requirements_file
    let style = detect_style(root);
    if action == "migrate" && !root.join("pyproject.toml").is_file() {
        // uv add 需要项目：先幂等生成最小 pyproject（复用 init_pyproject；
        // 原 requirements.txt 只读不改，R4.1）
        init_pyproject_impl(workspace_root.to_string())?;
    }
    let interpreter = get_interpreter(workspace_root.to_string()).ok().flatten();
    let args = plan_dep_fix(action, &style, dists, interpreter.as_deref())?;
    // 命令回显由前端 runDepFix 负责（"cmd" 样式，与 pip_install 等既有流一致，M3 自查修复：
    // 此前后端再 emit 一次 "> uv …" 会在输出面板重复两行）——本层只流式转发 uv 自身输出
    let mut cmd = tool_command("uv", ENV_UV);
    cmd.args(&args).current_dir(root);
    run_uv_streaming(app, &mut cmd, UV_TIMEOUT, wid)
}

// ---------- 单元测试 ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_pip_list() {
        let s = "requests==2.31.0\nidna==3.7\nsome-local-pkg==1.0\n\nfoo==1.2\n";
        let pkgs = parse_pip_list(s);
        assert_eq!(pkgs.len(), 4);
        assert_eq!(pkgs[0].name, "requests");
        assert_eq!(pkgs[0].version, "2.31.0");
        assert_eq!(pkgs[3].name, "foo");
        assert_eq!(pkgs[3].version, "1.2");
    }

    /// wangzi 回归：uv pip list 对空环境（virtualenv 建的 .venv 无包）stdout 为空、stderr 输出
    /// 「Using Python … environment at: …」。修复前成功路径回退用 stderr，该提示被误解析成一个
    /// 「包」→ E3 误报「1 个包已安装但未声明」、已安装列表显示一个非 python 包。两个解析器都须跳过它。
    #[test]
    fn freeze_parsers_skip_uv_diagnostic_line() {
        let diag = "Using Python 3.14.3 environment at: D:\\ws\\.venv";
        assert!(parse_pip_list(diag).is_empty(), "诊断行不得被 parse_pip_list 当包");
        assert!(parse_freeze_for_diff(diag).is_empty(), "诊断行不得被 parse_freeze_for_diff 当包");
        // 正常 freeze 行仍解析；裸名（无空格）保留
        assert_eq!(parse_pip_list("requests==2.31.0").len(), 1);
        assert_eq!(parse_freeze_for_diff("requests==2.31.0"), vec![("requests".to_string(), "2.31.0".to_string())]);
        assert_eq!(parse_freeze_for_diff("somepkg").len(), 1);
        // direct URL（name @ file://…）归一出包名
        assert_eq!(parse_freeze_for_diff("demo @ file:///ws/demo"), vec![("demo".to_string(), String::new())]);
    }

    #[test]
    fn test_workspace_config_roundtrip() {
        // 用一个临时 root（不触碰真实 home），通过环境变量不可行，但 project_hash 是确定性纯函数；
        // 这里验证 read/write 配对：写入临时 workspaces 目录路径不可注入，直接测 hash 稳定性。
        let h1 = project_hash(".");
        let h2 = project_hash(".");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 12);
    }

    /// P1：调试复用运行配置——`dap::debug_start` 走的是 `read_run_config(root, 脚本绝对路径)`，
    /// 与「运行」路径（`get_run_config` / `build_run_env`）是**同一个函数、同一个键**。
    /// 此测试锁定键口径（相对工作区根 + 统一正斜杠）：任一侧改了口径，调试都会**静默**
    /// 读不到配置（不报错，只是参数与环境变量全丢），属最难排查的一类故障。
    #[test]
    fn run_config_key_is_relative_and_stable() {
        if cfg!(windows) {
            assert_eq!(run_config_key("F:\\ws", "F:\\ws\\pkg\\mod.py"), "pkg/mod.py");
            assert_eq!(run_config_key("F:/ws", "F:/ws/pkg/mod.py"), "pkg/mod.py");
            assert_eq!(run_config_key("F:\\ws\\", "F:\\ws\\mod.py"), "mod.py");
            // 工作区外的文件：退化为文件名，仍有一个稳定键（不因绝对路径漂移失效）
            assert_eq!(run_config_key("F:\\ws", "G:\\other\\mod.py"), "mod.py");
        } else {
            assert_eq!(run_config_key("/ws", "/ws/pkg/mod.py"), "pkg/mod.py");
            assert_eq!(run_config_key("/ws/", "/ws/mod.py"), "mod.py");
            assert_eq!(run_config_key("/ws", "/other/mod.py"), "mod.py");
        }
    }

    #[test]
    fn test_venv_python_missing() {
        // 不存在的 root 无 .venv → None
        assert_eq!(venv_python("Z:\\__no_such_dir__"), None);
    }

    #[test]
    fn test_display_version() {
        assert_eq!(display_version("cpython-3.13.7-windows-x86_64-none"), "3.13.7");
        assert_eq!(display_version("pypy-3.11.13-windows-x86_64-none"), "3.11.13");
        assert_eq!(display_version("graalpy-3.12.0-windows-x86_64-none"), "3.12.0");
        assert_eq!(display_version("weird-spec"), "weird-spec");
    }

    #[test]
    fn test_version_triple() {
        assert_eq!(version_triple("3.13.7"), (3, 13, 7));
        assert_eq!(version_triple("3.9"), (3, 9, 0));
        assert_eq!(version_triple("3.10.20"), (3, 10, 20));
        assert!(version_triple("3.13.7") > version_triple("3.10.20"));
        assert!(version_triple("3.9.25") > version_triple("3.9.0"));
    }

    #[test]
    fn test_is_freethreaded() {
        assert!(is_freethreaded("cpython-3.15.0a7+freethreaded-windows-x86_64-none"));
        assert!(!is_freethreaded("cpython-3.13.7-windows-x86_64-none"));
    }

    #[test]
    fn test_run_config_key() {
        // 相对工作区根、正斜杠规范化
        assert_eq!(run_config_key("F:/proj", "F:/proj/main.py"), "main.py");
        assert_eq!(run_config_key("F:\\proj", "F:\\proj\\sub\\a.py"), "sub/a.py");
        assert_eq!(run_config_key("F:/proj/", "F:/proj/main.py"), "main.py");
        // 不在根下 → 退化为文件名（仍有稳定键）
        assert_eq!(run_config_key("F:/proj", "E:/other/b.py"), "b.py");
    }

    #[test]
    fn test_run_profile_is_effectively_empty() {
        assert!(RunProfile::default().is_effectively_empty());
        assert!(rc("  ", vec![]).is_effectively_empty());
        assert!(!rc("--flag", vec![]).is_effectively_empty());
        assert!(!rc("", vec![EnvVar { key: "K".into(), value: "V".into() }]).is_effectively_empty());
        // v3.4 §4.2：cwd 属于保留字段，算「有配置」；entry 由系统填充，不参与判定
        assert!(!RunProfile { cwd: "${workspaceRoot}".into(), ..Default::default() }.is_effectively_empty());
        // .env 文件、解释器覆盖都算「有配置」；空白 env_files 视为缺省
        assert!(!RunProfile { env_files: vec![".env".into()], ..Default::default() }.is_effectively_empty());
        assert!(RunProfile { env_files: vec!["  ".into()], ..Default::default() }.is_effectively_empty());
        assert!(!RunProfile { interpreter: "D:/py/python.exe".into(), ..Default::default() }.is_effectively_empty());
    }

    #[test]
    fn test_run_entry_is_module() {
        assert!(!RunEntry::default().is_module());
        assert!(RunEntry { kind: "module".into(), target: "uvicorn".into() }.is_module());
        // 空模块名不允许跑 `-m`（归一化为脚本入口语义，由调用方报错兜底）
        assert!(!RunEntry { kind: "module".into(), target: "  ".into() }.is_module());
        assert!(RunEntry { kind: "module".into(), target: " uvicorn ".into() }.is_module());
        assert_eq!(RunEntry { kind: "module".into(), target: " uvicorn ".into() }.target_trimmed(), "uvicorn");
    }

    #[test]
    fn test_module_target_helpers() {
        assert_eq!(py_module_target("app/main.py"), "app.main");
        assert_eq!(py_module_target("main.py"), "main");
        assert!(deps_mention("fastapi==0.1\n", "fastapi"));
        assert!(!deps_mention("# fastapi\n", "fastapi"));
        assert!(!deps_mention("requests\n", "fastapi"));
    }

    /// 构造 RunProfile 的小工具（避免每处都写全字段）
    fn rc(args: &str, env: Vec<EnvVar>) -> RunProfile {
        RunProfile {
            args: args.into(),
            env,
            ..Default::default()
        }
    }

    #[test]
    fn test_run_profile_backward_compat() {
        // 存量配置（P3 时代写入，无 entry / cwd 字段）反序列化为新默认，无需迁移
        let legacy = r#"{"args":"--x","env":[{"key":"K","value":"V"}]}"#;
        let cfg: RunProfile = serde_json::from_str(legacy).unwrap();
        assert_eq!(cfg.args, "--x");
        assert_eq!(cfg.env.len(), 1);
        assert_eq!(cfg.entry.kind, "script");
        assert!(cfg.cwd.is_empty());

        // 完全空的配置对象同样落到缺省，且仍视为空配置
        let empty: RunProfile = serde_json::from_str("{}").unwrap();
        assert!(empty.is_effectively_empty());

        // 序列化往返一致
        let full = rc("--flag", vec![EnvVar { key: "K".into(), value: "V".into() }]);
        let json = serde_json::to_string(&full).unwrap();
        let back: RunProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.args, "--flag");
        assert_eq!(back.env.len(), 1);
    }

    /// v3.4 §4.3：存量工作区配置里的 v2 遗留字段（name / temporary / allow_multiple / stdin 等）
    /// 反序列化时静默丢弃，不报错、不迁移；保留字段照常读取。
    #[test]
    fn test_legacy_v2_fields_are_ignored_on_deserialize() {
        let legacy = r#"{"name":"main.py","temporary":true,"allow_multiple":true,"pre_run_profile":"db","open_browser_url":"http://x","auto_rerun":true,"python_console":true,"stdin":{"mode":"file","path":"in.txt"},"args":"--x"}"#;
        let cfg: RunProfile = serde_json::from_str(legacy).unwrap();
        assert_eq!(cfg.args, "--x");
        assert!(!cfg.is_effectively_empty()); // args 非空即「有配置」
    }

    #[test]
    fn test_outdated_json_parse() {
        let s = r#"[{"name":"pip","version":"26.0.1","latest_version":"26.2.1","latest_filetype":"wheel"}]"#;
        let v: Vec<OutdatedInfo> = serde_json::from_str(s).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].name, "pip");
        assert_eq!(v[0].version, "26.0.1");
        assert_eq!(v[0].latest, "26.2.1");
        assert_eq!(v[0].filetype, "wheel");
    }

    // ---------- v3.4 §9：项目入口探测单测（优先级锁定） ----------

    fn detect_tmpdir(tag: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("pylume-detect-{tag}-{nanos}"));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// §9-1：pyproject.toml [project.scripts] 优先级最高，命中即 module 入口
    #[test]
    fn detect_prefers_project_scripts() {
        let d = detect_tmpdir("scripts");
        std::fs::write(d.join("pyproject.toml"), r#"
[project]
name = "demo"

[project.scripts]
demo = "demo.cli:main"
"#).unwrap();
        // 同时放置 main.py / 包，验证 scripts 优先
        std::fs::write(d.join("main.py"), "print(1)").unwrap();
        let hit = detect_project_entry_impl(&d).expect("scripts 应命中");
        assert_eq!(hit.source, "scripts");
        assert_eq!(hit.config.entry.kind, "module");
        assert_eq!(hit.config.entry.target, "demo.cli"); // `demo = "demo.cli:main"` 的模块段
        assert!(hit.summary.contains("scripts.demo"));
    }

    /// §9-2：无 scripts 时，依赖含 fastapi + 源码有 `app = FastAPI()` → uvicorn 预设
    #[test]
    fn detect_fastapi_preset_when_no_scripts() {
        let d = detect_tmpdir("fastapi");
        std::fs::write(d.join("pyproject.toml"), r#"
[project]
dependencies = ["fastapi", "uvicorn"]
"#).unwrap();
        std::fs::write(d.join("main.py"), "from fastapi import FastAPI\napp = FastAPI()\n").unwrap();
        let hit = detect_project_entry_impl(&d).expect("fastapi 应命中");
        assert_eq!(hit.source, "fastapi");
        assert_eq!(hit.config.entry.kind, "module");
        assert_eq!(hit.config.entry.target, "uvicorn");
        assert_eq!(hit.config.args, "main:app --reload");
        assert_eq!(hit.config.cwd, "${workspaceRoot}");
    }

    /// §9-3：无 scripts / 非 fastapi，根目录 main.py → 入口脚本
    #[test]
    fn detect_falls_back_to_main_py() {
        let d = detect_tmpdir("mainpy");
        std::fs::write(d.join("main.py"), "print(1)").unwrap();
        let hit = detect_project_entry_impl(&d).expect("main.py 应命中");
        assert_eq!(hit.source, "main-py");
        assert_eq!(hit.config.entry.kind, "script");
        assert_eq!(hit.config.entry.target, "main.py");
    }

    /// §9-4：无 main.py，存在含 __main__.py 的包 → python -m <pkg>
    #[test]
    fn detect_falls_back_to_main_package() {
        let d = detect_tmpdir("pkg");
        std::fs::create_dir_all(d.join("myapp")).unwrap();
        std::fs::write(d.join("myapp").join("__main__.py"), "print(1)").unwrap();
        std::fs::write(d.join("myapp").join("__init__.py"), "").unwrap();
        let hit = detect_project_entry_impl(&d).expect("包入口应命中");
        assert_eq!(hit.source, "package");
        assert_eq!(hit.config.entry.kind, "module");
        assert_eq!(hit.config.entry.target, "myapp");
    }

    /// §9-5：全都没有 → 未命中（前端提示「请先配置项目入口」）
    #[test]
    fn detect_misses_on_empty_project() {
        let d = detect_tmpdir("empty");
        std::fs::write(d.join("utils.py"), "print(1)").unwrap(); // 散文件不算入口
        assert!(detect_project_entry_impl(&d).is_none());
    }

    /// [project.scripts] 行扫描：表头切换 / 无冒号条目 / 空键的容错
    #[test]
    fn pyproject_scripts_scan_rules() {
        let text = r#"
[project]
name = "x"

[project.scripts]
demo = "demo.cli:main"
bad-no-colon = "justmodule"

[tool.uv]
dev-dependencies = []
"#;
        let entries = pyproject_scripts_entries(text);
        assert_eq!(entries, vec![("demo".to_string(), "demo.cli:main".to_string())]);
        assert_eq!(script_entry_module("demo.cli:main"), "demo.cli");
        assert_eq!(script_entry_module("nocolon"), "nocolon");
    }

    // ---------- 框架探针表（P1：Django / Flask / FastAPI）单测 ----------

    /// Django 规则：根目录 manage.py → `manage.py runserver`；声明里没 django → 报缺失
    #[test]
    fn framework_django_preset_reports_missing_dep() {
        let d = detect_tmpdir("fw-django-missing");
        fs::write(d.join("manage.py"), "#!/usr/bin/env python\n").unwrap();
        fs::write(d.join("pyproject.toml"), "[project]\nname = \"x\"\n").unwrap();
        let hit = detect_framework_impl(&d.to_string_lossy(), &json!({}))
            .unwrap()
            .expect("manage.py 应命中 Django");
        assert_eq!(hit.framework, "django");
        assert_eq!(hit.label, "Django");
        assert_eq!(hit.entry.kind, "script");
        assert_eq!(hit.entry.target, "manage.py");
        assert_eq!(hit.args, "runserver");
        assert_eq!(hit.cwd, "${workspaceRoot}");
        assert_eq!(hit.missing, vec!["django".to_string()]);
    }

    /// Django 规则：声明已含 django → 不报缺失
    #[test]
    fn framework_django_preset_with_dep() {
        let d = detect_tmpdir("fw-django");
        fs::write(d.join("manage.py"), "#!/usr/bin/env python\n").unwrap();
        fs::write(d.join("pyproject.toml"), "[project]\ndependencies = [\"django>=5\"]\n").unwrap();
        let hit = detect_framework_impl(&d.to_string_lossy(), &json!({})).unwrap().unwrap();
        assert_eq!(hit.framework, "django");
        assert!(hit.missing.is_empty());
    }

    /// FastAPI 规则（沿用 P0-E 口径）：依赖含 fastapi + 源码 `app = FastAPI(` → uvicorn 预设
    #[test]
    fn framework_fastapi_preset() {
        let d = detect_tmpdir("fw-fastapi");
        fs::write(d.join("pyproject.toml"), "[project]\ndependencies = [\"fastapi\"]\n").unwrap();
        fs::write(d.join("main.py"), "from fastapi import FastAPI\napp = FastAPI()\n").unwrap();
        let hit = detect_framework_impl(&d.to_string_lossy(), &json!({})).unwrap().unwrap();
        assert_eq!(hit.framework, "fastapi");
        assert_eq!(hit.entry.kind, "module");
        assert_eq!(hit.entry.target, "uvicorn");
        assert_eq!(hit.args, "main:app --reload");
        assert_eq!(hit.missing, vec!["uvicorn".to_string()]); // 声明无 uvicorn → 提示
    }

    /// F3 服务器选择：依赖仅含 hypercorn → entry 切到 hypercorn（--reload 两者均支持）
    #[test]
    fn framework_fastapi_preset_hypercorn() {
        let d = detect_tmpdir("fw-hypercorn");
        fs::write(d.join("pyproject.toml"), "[project]\ndependencies = [\"fastapi\", \"hypercorn\"]\n").unwrap();
        fs::write(d.join("main.py"), "from fastapi import FastAPI\napp = FastAPI()\n").unwrap();
        let hit = detect_framework_impl(&d.to_string_lossy(), &json!({})).unwrap().unwrap();
        assert_eq!(hit.entry.target, "hypercorn");
        assert_eq!(hit.summary, "-m hypercorn main:app --reload");
        assert!(hit.missing.is_empty()); // hypercorn 也在服务依赖白名单
    }

    /// Flask 规则：依赖含 flask + 源码 `app = Flask(` → `-m flask --app main:app run --debug`（F3）
    #[test]
    fn framework_flask_preset() {
        let d = detect_tmpdir("fw-flask");
        fs::write(d.join("pyproject.toml"), "[project]\ndependencies = [\"flask>=3\"]\n").unwrap();
        fs::write(d.join("app.py"), "from flask import Flask\napp = Flask(__name__)\n").unwrap();
        let hit = detect_framework_impl(&d.to_string_lossy(), &json!({})).unwrap().unwrap();
        assert_eq!(hit.framework, "flask");
        assert_eq!(hit.label, "Flask");
        assert_eq!(hit.entry.kind, "module");
        assert_eq!(hit.entry.target, "flask");
        assert_eq!(hit.args, "--app app:app run --debug");
        assert_eq!(hit.summary, "-m flask --app app:app run --debug");
    }

    /// 优先级：django（manage.py 强约定）先于 fastapi
    #[test]
    fn framework_priority_django_before_fastapi() {
        let d = detect_tmpdir("fw-priority");
        fs::write(d.join("manage.py"), "#!/usr/bin/env python\n").unwrap();
        fs::write(d.join("pyproject.toml"), "[project]\ndependencies = [\"django\", \"fastapi\", \"uvicorn\"]\n").unwrap();
        fs::write(d.join("main.py"), "from fastapi import FastAPI\napp = FastAPI()\n").unwrap();
        let hit = detect_framework_impl(&d.to_string_lossy(), &json!({})).unwrap().unwrap();
        assert_eq!(hit.framework, "django");
    }

    /// 无命中：普通脚本项目（无 manage.py / 无 FastAPI( / 无 Flask(）→ null
    #[test]
    fn framework_misses_on_plain_project() {
        let d = detect_tmpdir("fw-plain");
        fs::write(d.join("pyproject.toml"), "[project]\ndependencies = [\"requests\"]\n").unwrap();
        fs::write(d.join("main.py"), "print(1)\n").unwrap();
        assert!(detect_framework_impl(&d.to_string_lossy(), &json!({})).unwrap().is_none());
    }

    /// 工作区级开关：`framework_hints` 中 true 的框架被跳过（跳过 django → 落到 fastapi）
    #[test]
    fn framework_skips_disabled_framework() {
        let d = detect_tmpdir("fw-disabled");
        fs::write(d.join("manage.py"), "#!/usr/bin/env python\n").unwrap();
        fs::write(d.join("pyproject.toml"), "[project]\ndependencies = [\"django\", \"fastapi\", \"uvicorn\"]\n").unwrap();
        fs::write(d.join("main.py"), "from fastapi import FastAPI\napp = FastAPI()\n").unwrap();
        let key = d.to_string_lossy().to_string();
        // 关掉 django → 落到 fastapi
        let hit = detect_framework_impl(&key, &json!({ "framework_hints": { "django": true } }))
            .unwrap()
            .unwrap();
        assert_eq!(hit.framework, "fastapi");
        // 两个都关掉 → 全部跳过，返回 null
        let none = detect_framework_impl(
            &key,
            &json!({ "framework_hints": { "django": true, "fastapi": true, "flask": true } }),
        )
        .unwrap();
        assert!(none.is_none());
    }

    /// 开关解析容错：非对象 / 非布尔值 / false 一律不当作关闭
    #[test]
    fn framework_hints_parse_rules() {
        assert!(framework_hints_disabled(&json!({})).is_empty());
        assert!(framework_hints_disabled(&json!({ "framework_hints": "x" })).is_empty());
        let cfg = json!({ "framework_hints": { "flask": true, "django": false, "fastapi": "yes" } });
        let off = framework_hints_disabled(&cfg);
        assert_eq!(off.len(), 1);
        assert!(off.contains("flask"));
    }

    // ---------- Pydantic 栈检测（F0 裁决 B）单测 ----------

    /// 依赖含 fastapi / pydantic 任一 → 命中
    #[test]
    fn pydantic_stack_hit_on_either_dep() {
        let d = detect_tmpdir("pyd-stack");
        fs::write(d.join("pyproject.toml"), "[project]\ndependencies = [\"fastapi\", \"uvicorn\"]\n").unwrap();
        assert!(detect_pydantic_stack_impl(&d.to_string_lossy(), &json!({})));
        fs::write(d.join("pyproject.toml"), "[project]\ndependencies = [\"pydantic>=2\"]\n").unwrap();
        assert!(detect_pydantic_stack_impl(&d.to_string_lossy(), &json!({})));
    }

    /// 无声明文件 / 无关依赖 → 不命中
    #[test]
    fn pydantic_stack_miss_on_unrelated() {
        let d = detect_tmpdir("pyd-miss");
        fs::write(d.join("pyproject.toml"), "[project]\ndependencies = [\"requests\"]\n").unwrap();
        assert!(!detect_pydantic_stack_impl(&d.to_string_lossy(), &json!({})));
        let d2 = detect_tmpdir("pyd-nodeps");
        fs::write(d2.join("main.py"), "print(1)\n").unwrap();
        assert!(!detect_pydantic_stack_impl(&d2.to_string_lossy(), &json!({})));
    }

    /// 工作区级关闭（framework_hints["pydantic_engine"]）→ 恒不命中
    #[test]
    fn pydantic_stack_respects_hint_switch() {
        let d = detect_tmpdir("pyd-off");
        fs::write(d.join("pyproject.toml"), "[project]\ndependencies = [\"pydantic\"]\n").unwrap();
        let cfg = json!({ "framework_hints": { "pydantic_engine": true } });
        assert!(!detect_pydantic_stack_impl(&d.to_string_lossy(), &cfg));
    }

    // ---------- 依赖健康（dep health M1）单测 ----------

    fn dep_tmpdir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("pylume-dep-{tag}-{nanos}"));
        fs::create_dir_all(&d).unwrap();
        d
    }

    // ----- L0 style 判定（v1.3 判定序：external → pyproject → requirements → bare） -----

    #[test]
    fn style_bare_when_nothing_declared() {
        let d = dep_tmpdir("style-bare");
        fs::write(d.join("main.py"), "print(1)").unwrap();
        let s = detect_style(&d);
        assert_eq!(s.style, "bare");
        assert_eq!(s.external_manager, None);
        assert_eq!(s.requirements_file, None);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn style_pyproject() {
        let d = dep_tmpdir("style-pyproj");
        fs::write(d.join("pyproject.toml"), "[project]\nname=\"x\"\n").unwrap();
        // pyproject 与 requirements 并存 → pyproject 优先（判定序）
        fs::write(d.join("requirements.txt"), "requests\n").unwrap();
        let s = detect_style(&d);
        assert_eq!(s.style, "pyproject");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn style_requirements_primary_prefers_canonical() {
        let d = dep_tmpdir("style-req");
        fs::write(d.join("requirements-dev.txt"), "pytest\n").unwrap();
        fs::write(d.join("requirements.txt"), "requests\n").unwrap();
        let s = detect_style(&d);
        assert_eq!(s.style, "requirements");
        // 多文件时主文件 = requirements.txt（声明集解析仍全部纳入）
        assert_eq!(s.requirements_file.as_deref(), Some("requirements.txt"));
        fs::remove_dir_all(&d).unwrap();

        let d2 = dep_tmpdir("style-req2");
        fs::write(d2.join("requirements-dev.txt"), "pytest\n").unwrap();
        let s2 = detect_style(&d2);
        assert_eq!(s2.requirements_file.as_deref(), Some("requirements-dev.txt"));
        fs::remove_dir_all(&d2).unwrap();
    }

    /// v1.3 判定序核心用例：poetry/pdm 项目必有 pyproject.toml，锁文件强信号优先——
    /// 否则 [project] dependencies 解析为空 → 全部已装包被误报 E3 漂移（§9.1 验收场景）。
    #[test]
    fn style_external_lock_wins_over_pyproject_and_requirements() {
        let d = dep_tmpdir("style-ext");
        fs::write(d.join("pyproject.toml"), "[tool.poetry]\nname=\"x\"\n").unwrap();
        fs::write(d.join("poetry.lock"), "# lock").unwrap();
        fs::write(d.join("requirements.txt"), "requests\n").unwrap();
        let s = detect_style(&d);
        assert_eq!(s.style, "external");
        assert_eq!(s.external_manager.as_deref(), Some("poetry"));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn style_external_all_managers() {
        for (file, mgr) in EXTERNAL_LOCKS {
            let d = dep_tmpdir("style-ext-each");
            fs::write(d.join(file), "x").unwrap();
            let s = detect_style(&d);
            assert_eq!(s.style, "external", "{file} 应判 external");
            assert_eq!(s.external_manager.as_deref(), Some(mgr));
            fs::remove_dir_all(&d).unwrap();
        }
    }

    // ----- 包名归一化 / 需求串拆分 -----

    #[test]
    fn normalize_dist_is_pep503() {
        assert_eq!(normalize_dist("Zope.Interface"), "zope-interface");
        assert_eq!(normalize_dist("zope_interface"), "zope-interface");
        assert_eq!(normalize_dist("Zope-Interface"), "zope-interface");
        assert_eq!(normalize_dist("PyYAML"), "pyyaml");
        assert_eq!(normalize_dist("ruamel.yaml.clib"), "ruamel-yaml-clib");
        assert_eq!(normalize_dist("a__b..c--d"), "a-b-c-d");
    }

    #[test]
    fn split_requirement_forms() {
        assert_eq!(split_requirement("requests"), Some(("requests".into(), "".into())));
        assert_eq!(split_requirement("requests>=2.0,<3"), Some(("requests".into(), ">=2.0,<3".into())));
        assert_eq!(
            split_requirement("requests[socks]>=2 ; python_version>='3.8'"),
            Some(("requests".into(), "[socks]>=2 ; python_version>='3.8'".into()))
        );
        // direct reference：包名可取，@ url 保留在 spec
        assert_eq!(split_requirement("foo @ https://x/foo.whl"), Some(("foo".into(), "@ https://x/foo.whl".into())));
        // 裸 URL 行：无包名可取
        assert_eq!(split_requirement("https://x/foo.whl"), None);
        assert_eq!(split_requirement(""), None);
    }

    #[test]
    fn parse_requirements_line_skips_noise() {
        assert_eq!(parse_requirements_line("# comment"), None);
        assert_eq!(parse_requirements_line("  "), None);
        assert_eq!(parse_requirements_line("-r other.txt"), None);
        assert_eq!(parse_requirements_line("--index-url https://x"), None);
        assert_eq!(parse_requirements_line("-e ."), None);
        // 行内注释（pip 口径：空白 + #）
        assert_eq!(parse_requirements_line("requests>=2  # http lib"), Some(("requests".into(), ">=2".into())));
        assert_eq!(parse_requirements_line("flask"), Some(("flask".into(), "".into())));
    }

    // ----- pyproject 声明层解析 -----

    #[test]
    fn pyproject_deps_sections_and_buckets() {
        let text = r#"
[project]
name = "demo"
dependencies = [
    "requests>=2.0",
    "flask",
]

[project.optional-dependencies]
web = ["fastapi>=0.100"]

[dependency-groups]
dev = ["pytest>=8"]
docs = [{include-group = "dev"}, "sphinx"]

[tool.uv]
dev-dependencies = ["ruff>=0.5"]
"#;
        let (deps, name) = parse_pyproject_deps(text);
        assert_eq!(name.as_deref(), Some("demo"));
        // core（E2 同步范围）：主依赖 + dev group + tool.uv dev-deps；extras/docs 组不进 core
        let core: Vec<&str> = deps.core.iter().map(|d| d.dist.as_str()).collect();
        assert!(core.contains(&"requests"));
        assert!(core.contains(&"flask"));
        assert!(core.contains(&"pytest"));
        assert!(core.contains(&"ruff"));
        assert!(!core.contains(&"fastapi"), "extras 是 opt-in，缺了不该报 E2");
        assert!(!core.contains(&"sphinx"));
        // all（E3/E4 排除全集）：extras 与非 dev groups 也算已声明
        assert!(deps.all.contains("fastapi"));
        assert!(deps.all.contains("sphinx"));
        // {include-group = "dev"} 的 "dev" 不得被当包名
        assert!(!deps.all.contains("include-group"));
        // spec 保留原始约束（修复时原样交给 uv）
        let req = deps.core.iter().find(|d| d.dist == "requests").unwrap();
        assert_eq!(req.spec, ">=2.0");
    }

    #[test]
    fn pyproject_deps_single_line_array() {
        let text = "[project]\nname=\"x\"\ndependencies = [\"a>=1\", 'b']\n";
        let (deps, _) = parse_pyproject_deps(text);
        assert!(deps.all.contains("a") && deps.all.contains("b"));
        assert_eq!(deps.core.len(), 2);
    }

    #[test]
    fn pyproject_project_name_only_from_project_section() {
        let text = "[tool.poetry]\nname = \"wrong\"\n\n[project]\nname = \"right\"\n";
        assert_eq!(pyproject_project_name(text).as_deref(), Some("right"));
        assert_eq!(pyproject_project_name("[tool.x]\nname=\"y\"\n"), None);
    }

    // ----- 环境快照解析 -----

    #[test]
    fn parse_freeze_for_diff_forms() {
        let s = "requests==2.31.0\ndemo @ file+file:///F:/ws\n# comment\n-e file:///x\nbare-no-version\n";
        let v = parse_freeze_for_diff(s);
        assert_eq!(v[0], ("requests".to_string(), "2.31.0".to_string()));
        // direct/editable 装：归一出包名、版本置空（项目自身排除靠名字匹配）
        assert_eq!(v[1], ("demo".to_string(), String::new()));
        assert_eq!(v.len(), 3); // -e 与注释行跳过；bare-no-version 保留（名有值空）
        assert_eq!(v[2].0, "bare-no-version");
    }

    // ----- diff 纯计算（构造 ProbeOutput，无子进程） -----

    fn probe(imports: Vec<(&str, &str, u32, bool)>, resolution: Vec<(&str, &str, Option<&str>)>) -> ProbeOutput {
        probe_with_candidates(imports, resolution, vec![])
    }

    /// M4-4：resolution 构造扩展——extra_cands 为 (module, [候选…])，注入 distCandidates
    fn probe_with_candidates(
        imports: Vec<(&str, &str, u32, bool)>,
        resolution: Vec<(&str, &str, Option<&str>)>,
        extra_cands: Vec<(&str, Vec<&str>)>,
    ) -> ProbeOutput {
        let mut out = ProbeOutput {
            imports: imports
                .into_iter()
                .map(|(file, module, line, lazy)| ProbeImport {
                    file: file.to_string(),
                    module: module.to_string(),
                    line,
                    lazy,
                })
                .collect(),
            resolution: resolution
                .into_iter()
                .map(|(m, status, dist)| {
                    (
                        m.to_string(),
                        ProbeResolution {
                            status: status.to_string(),
                            dist: dist.map(String::from),
                            dist_candidates: vec![],
                        },
                    )
                })
                .collect(),
        };
        for (m, cands) in extra_cands {
            if let Some(r) = out.resolution.get_mut(m) {
                r.dist_candidates = cands.iter().map(|s| s.to_string()).collect();
                if r.dist.is_none() {
                    r.dist = cands.first().map(|s| s.to_string());
                }
            }
        }
        out
    }

    /// v1.7 A：E1 声明全集感知分流（fika-admin pytest ×5 降噪场景复刻）
    #[test]
    fn e1_splits_declared_missing_to_e2_section() {
        // dev 组声明了 pytest；代码 5 个文件 import pytest（fika-admin 实测形态）
        let mut declared = DeclaredDeps::default();
        declared.all.insert("pytest".into());
        declared.all.insert("pyyaml".into());
        declared.group_of.insert("pytest".into(), "dev".into());
        let p = probe(
            vec![
                ("tests/a.py", "pytest", 1, false),
                ("tests/b.py", "pytest", 2, false),
                ("tests/c.py", "pytest", 3, false),
                ("tests/d.py", "pytest", 4, false),
                ("tests/e.py", "pytest", 5, true),    // 混入一个惰性位点 → 聚合后非全惰性
                ("app/x.py", "yaml", 1, false),        // 别名表匹配 pyyaml 声明
                ("app/x.py", "ghost", 2, false),       // 未声明 → 留在 E1
                ("app/x.py", "os", 3, false),          // stdlib 不进
            ],
            vec![
                ("pytest", "missing", None),
                ("yaml", "missing", None),             // 反查不到（未装）→ 别名表兜底
                ("ghost", "missing", None),
                ("os", "stdlib", None),
            ],
        );
        let (e1, decl_mods) = compute_missing_in_env(&p, &declared, "declared");
        // E1 只剩未声明的 ghost
        assert_eq!(e1.len(), 1, "已声明缺失分流后 E1 仅剩未声明项：{e1:?}");
        assert_eq!(e1[0].module, "ghost");
        // 分流产物：pytest（dev 组，5 文件聚合，任一非惰性 → lazy=false）+ yaml（别名命中，无组 → 默认组）
        assert_eq!(decl_mods.len(), 2, "{decl_mods:?}");
        let pytest = decl_mods.iter().find(|m| m.module == "pytest").unwrap();
        assert_eq!(pytest.group, "dev");
        assert_eq!(pytest.files, 5);
        assert_eq!(pytest.file, "tests/a.py"); // 首位点
        assert!(!pytest.lazy);                 // 混入顶层位点 → 非惰性
        let yaml = decl_mods.iter().find(|m| m.module == "yaml").unwrap();
        assert_eq!(yaml.dist, "pyyaml");       // 别名表归一化命中
        assert_eq!(yaml.group, "declared");    // 无组映射 → 默认组
        // 边界：模块名与声明 dist 完全无关联（反查空 + 别名表无 + 名字不同）→ 仍进 E1
        // （dotenv→python-dotenv 由别名表覆盖命中——正确分流；此处的 somelib 验证全 miss 路径）
        let mut declared2 = DeclaredDeps::default();
        declared2.all.insert("totally-other-pkg".into());
        let p2 = probe(
            vec![("m.py", "somelib", 1, false)],
            vec![("somelib", "missing", None)],
        );
        let (e1b, decl_b) = compute_missing_in_env(&p2, &declared2, "declared");
        assert_eq!(e1b.len(), 1, "匹配链全 miss → 留 E1（宁可多报不漏）");
        assert!(decl_b.is_empty());
    }

    #[test]
    fn e1_missing_aggregates_by_module_file_with_lazy_and_alias() {
        let p = probe(
            vec![
                ("a.py", "nope", 5, false),
                ("a.py", "nope", 9, true),   // 同模块同文件第二位点：顶层在先 → lazy=false
                ("b.py", "yaml", 3, true),   // 别名表兜底：yaml → PyYAML
                ("b.py", "os", 1, false),    // stdlib 不进 E1
            ],
            vec![
                ("nope", "missing", None),
                ("yaml", "missing", None),
                ("os", "stdlib", None),
            ],
        );
        // 声明全集为空（空 DeclaredDeps）→ 分流不触发，E1 行为与旧口径一致
        let (e1, decl_mods) = compute_missing_in_env(&p, &DeclaredDeps::default(), "declared");
        assert!(decl_mods.is_empty());
        assert_eq!(e1.len(), 2);
        let nope = e1.iter().find(|m| m.module == "nope").unwrap();
        assert_eq!(nope.file, "a.py");
        assert_eq!(nope.line, 5);   // 首位点行号
        assert!(!nope.lazy);        // 任一顶层位点 → 非惰性
        assert_eq!(nope.dist, None);
        let yaml = e1.iter().find(|m| m.module == "yaml").unwrap();
        assert!(yaml.lazy);
        assert_eq!(yaml.dist.as_deref(), Some("PyYAML"));
        assert_eq!(yaml.dist_candidates, vec!["PyYAML".to_string()]); // M4-4：别名兜底也进候选
    }

    #[test]
    fn e4_undeclared_excludes_declared_devtools_and_self() {
        let p = probe(
            vec![
                ("main.py", "requests", 1, false),  // 已声明 → 排除
                ("main.py", "numpy", 2, false),     // site 且未声明 → E4
                ("main.py", "ruff", 3, false),      // 工具链自装 → 排除
                ("main.py", "demo", 4, false),      // 项目自身（uv sync editable）→ 排除
                ("main.py", "os", 5, false),        // stdlib → 排除
                ("main.py", "gone", 6, false),      // missing → 归 E1 不进 E4
                ("main.py", "yaml", 7, false),      // site 无 dist（缺 top_level.txt）→ 别名归一 PyYAML 已声明 → 排除
            ],
            vec![
                ("requests", "site", Some("requests")),
                ("numpy", "site", Some("numpy")),
                ("ruff", "site", Some("ruff")),
                ("demo", "site", Some("demo")),
                ("os", "stdlib", None),
                ("gone", "missing", None),
                ("yaml", "site", None),
            ],
        );
        let mut declared = DeclaredDeps::default();
        declared.all.insert("requests".into());
        declared.all.insert("pyyaml".into());
        let e4 = compute_undeclared(&p, &declared, Some("demo"));
        assert_eq!(e4.len(), 1);
        assert_eq!(e4[0].module, "numpy");
        assert_eq!(e4[0].dist.as_deref(), Some("numpy"));
        assert_eq!(e4[0].file, "main.py");
        assert_eq!(e4[0].line, 2);
    }

    #[test]
    fn e2_declared_missing_normalized_match() {
        let mut declared = DeclaredDeps::default();
        declared.core = vec![
            DeclaredDep { dist: "requests".into(), spec: ">=2".into() },
            DeclaredDep { dist: "zope-interface".into(), spec: "".into() },
            DeclaredDep { dist: "flask".into(), spec: ">=3".into() },
        ];
        // 环境装了 Zope.Interface（大小写/分隔符异形）→ 归一化后视为已装
        let installed = vec![("requests".to_string(), "2.31".to_string()), ("Zope.Interface".to_string(), "7.2".to_string())];
        let e2 = compute_declared_missing(&declared, &installed);
        assert_eq!(e2, vec![DeclaredMissing { dist: "flask".into(), spec: ">=3".into() }]);
    }

    #[test]
    fn e3_drift_excludes_infra_devtools_and_self() {
        let installed = vec![
            ("numpy".to_string(), "2.0".to_string()),
            ("pip".to_string(), "26.0".to_string()),
            ("setuptools".to_string(), "80.0".to_string()),
            ("wheel".to_string(), "0.45".to_string()),
            ("pyrefly".to_string(), "1.3".to_string()),
            ("ruff".to_string(), "0.16".to_string()),
            ("debugpy".to_string(), "1.8".to_string()),
            ("uv".to_string(), "0.10".to_string()),
            ("demo".to_string(), "0.1".to_string()),   // 项目自身（editable 装）
            ("Flask".to_string(), "3.0".to_string()),  // 已声明（异形大小写）
        ];
        let mut declared = DeclaredDeps::default();
        declared.all.insert("flask".into());
        let e3 = compute_env_drift(&installed, &declared, Some("demo"));
        assert_eq!(e3, vec![EnvDriftPkg { dist: "numpy".into(), version: "2.0".into() }]);
    }

    #[test]
    fn e2_requirements_uninstalled_special_case() {
        let mut declared = DeclaredDeps::default();
        declared.core = vec![DeclaredDep { dist: "requests".into(), spec: "".into() }];
        declared.all.insert("requests".into());
        // 全新 venv（只有基础设施包）→ 整个 requirements 未安装（反馈 1 场景）
        assert!(compute_requirements_uninstalled(&declared, &[("pip".into(), "26".into())]));
        // 部分安装 → false（剩余缺口由 E2 逐条表达）
        assert!(!compute_requirements_uninstalled(&declared, &[("requests".into(), "2.31".into())]));
        // 声明集为空 → 恒 false
        assert!(!compute_requirements_uninstalled(&DeclaredDeps::default(), &[]));
    }

    #[test]
    fn dist_alias_fallback_table() {
        assert_eq!(effective_dist("yaml", None).as_deref(), Some("PyYAML"));
        assert_eq!(effective_dist("cv2", None).as_deref(), Some("opencv-python"));
        // 探针反查优先于别名表
        assert_eq!(effective_dist("yaml", Some("pyyaml-ng")).as_deref(), Some("pyyaml-ng"));
        assert_eq!(effective_dist("totally_unknown", None), None);
    }

    // ----- M3：plan_dep_fix（§5.1 动作矩阵：action × style → uv 参数，纯函数单点构建） -----

    fn dep_style_of(style: &str, mgr: Option<&str>, req: Option<&str>) -> DepStyle {
        DepStyle {
            style: style.to_string(),
            external_manager: mgr.map(String::from),
            requirements_file: req.map(String::from),
        }
    }

    fn dists(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn fix_install_pyproject_uses_uv_add() {
        let args = plan_dep_fix(
            "install",
            &dep_style_of("pyproject", None, None),
            &dists(&["requests", "flask"]),
            None,
        )
        .unwrap();
        assert_eq!(args, vec!["add", "requests", "flask"]);
    }

    #[test]
    fn fix_install_non_pyproject_uses_pip_install() {
        // requirements / bare / external：只装解释器环境不写声明
        //（external 的声明层归外部管理器所有，E1 仍生效，§4.2.1/R11）
        for style in ["requirements", "bare", "external"] {
            let args = plan_dep_fix(
                "install",
                &dep_style_of(style, None, Some("requirements.txt")),
                &dists(&["numpy"]),
                Some("C:/venv/python.exe"),
            )
            .unwrap();
            assert_eq!(
                args,
                vec!["pip", "install", "--python", "C:/venv/python.exe", "numpy"],
                "style={style}"
            );
        }
    }

    #[test]
    fn fix_install_requires_dists_and_interpreter() {
        // pyproject：无包名 → Err（uv add 空参数没有意义）
        assert!(plan_dep_fix("install", &dep_style_of("pyproject", None, None), &[], None).is_err());
        // 非 pyproject：无解释器 → Err（文案引导先选解释器）
        let e = plan_dep_fix("install", &dep_style_of("bare", None, None), &dists(&["x"]), None).unwrap_err();
        assert!(e.contains("解释器"), "{e}");
    }

    #[test]
    fn fix_sync_by_style() {
        assert_eq!(
            plan_dep_fix("sync", &dep_style_of("pyproject", None, None), &[], None).unwrap(),
            vec!["sync"]
        );
        let args = plan_dep_fix(
            "sync",
            &dep_style_of("requirements", None, Some("requirements.txt")),
            &[],
            Some("P"),
        )
        .unwrap();
        assert_eq!(args, vec!["pip", "install", "--python", "P", "-r", "requirements.txt"]);
        // external：E2 禁用（不给错误结果，R11）；bare：无声明可同步
        assert!(plan_dep_fix("sync", &dep_style_of("external", Some("poetry"), None), &[], Some("P")).is_err());
        assert!(plan_dep_fix("sync", &dep_style_of("bare", None, None), &[], Some("P")).is_err());
    }

    #[test]
    fn fix_declare_only_pyproject() {
        assert_eq!(
            plan_dep_fix("declare", &dep_style_of("pyproject", None, None), &dists(&["numpy"]), None).unwrap(),
            vec!["add", "numpy"]
        );
        // requirements/bare：无 pyproject 可写 → Err（文案引导先迁移）；external：声明写入禁用
        let e = plan_dep_fix("declare", &dep_style_of("requirements", None, Some("requirements.txt")), &dists(&["numpy"]), None).unwrap_err();
        assert!(e.contains("迁移"), "{e}");
        assert!(plan_dep_fix("declare", &dep_style_of("bare", None, None), &dists(&["numpy"]), None).is_err());
        assert!(plan_dep_fix("declare", &dep_style_of("external", Some("pdm"), None), &dists(&["numpy"]), None).is_err());
    }

    #[test]
    fn fix_lock_only_pyproject() {
        assert_eq!(
            plan_dep_fix("lock", &dep_style_of("pyproject", None, None), &[], None).unwrap(),
            vec!["lock"]
        );
        assert!(plan_dep_fix("lock", &dep_style_of("requirements", None, Some("requirements.txt")), &[], None).is_err());
    }

    #[test]
    fn fix_migrate_reads_requirements_only() {
        // R4/R4.1：uv add -r 只读原文件、写 pyproject（不改写不删除 requirements.txt）
        let args = plan_dep_fix(
            "migrate",
            &dep_style_of("requirements", None, Some("requirements.txt")),
            &[],
            None,
        )
        .unwrap();
        assert_eq!(args, vec!["add", "-r", "requirements.txt"]);
        // bare（无 requirements 文件）→ 无从迁移；external → 不适用
        assert!(plan_dep_fix("migrate", &dep_style_of("bare", None, None), &[], None).is_err());
        assert!(plan_dep_fix("migrate", &dep_style_of("external", Some("poetry"), None), &[], None).is_err());
    }

    #[test]
    fn fix_unknown_action_rejected() {
        assert!(plan_dep_fix("reboot", &dep_style_of("pyproject", None, None), &[], None).is_err());
    }

    // ----- M3：忽略清单（§5.3/R9：归一化 / 容错解析 / diff 过滤） -----

    #[test]
    fn ignore_entry_normalization() {
        // E2/E3 dist 键经 PEP 503 归一（存储与比对同口径）
        assert_eq!(
            normalized_ignore_entry("e3", " Zope.Interface ").unwrap(),
            DepIgnoreEntry { edge: "e3".into(), key: "zope-interface".into() }
        );
        // E1/E4 模块名原样保留（Python 模块大小写敏感）
        assert_eq!(
            normalized_ignore_entry("e1", "MyMod").unwrap(),
            DepIgnoreEntry { edge: "e1".into(), key: "MyMod".into() }
        );
        // 非法 edge（E5 是项目级布尔无行级忽略语义）/ 空 key → Err
        assert!(normalized_ignore_entry("e5", "x").is_err());
        assert!(normalized_ignore_entry("e9", "x").is_err());
        assert!(normalized_ignore_entry("e1", "   ").is_err());
    }

    #[test]
    fn ignore_list_from_config_tolerates_garbage() {
        // 字段缺失 / 类型错误 / 条目损坏 → 一律空清单（绝不 panic，同 load_config 口径）
        assert_eq!(dep_ignores_from_config(&json!({})), vec![]);
        assert_eq!(dep_ignores_from_config(&json!({"dep_ignored": "not-an-array"})), vec![]);
        assert_eq!(dep_ignores_from_config(&json!({"dep_ignored": [{"bogus": 1}]})), vec![]);
        let v = json!({"dep_ignored": [{"edge": "e1", "key": "foo"}]});
        assert_eq!(
            dep_ignores_from_config(&v),
            vec![DepIgnoreEntry { edge: "e1".into(), key: "foo".into() }]
        );
    }

    fn ignore_test_diff() -> DepDiff {
        DepDiff {
            style: "pyproject".into(),
            external_manager: None,
            missing_in_env: vec![
                MissingModule { module: "foo".into(), dist: None, dist_candidates: vec![], file: "a.py".into(), line: 1, lazy: false },
                MissingModule { module: "bar".into(), dist: None, dist_candidates: vec![], file: "a.py".into(), line: 2, lazy: false },
            ],
            declared_missing: vec![DeclaredMissing { dist: "zope-interface".into(), spec: "".into() }],
            declared_missing_modules: vec![DeclaredMissingModule {
                module: "pytest".into(), dist: "pytest".into(), group: "dev".into(),
                files: 2, file: "t1.py".into(), line: 1, lazy: false,
            }],
            env_drift: vec![EnvDriftPkg { dist: "numpy".into(), version: "2.0".into() }],
            undeclared: vec![UndeclaredModule { module: "pandas".into(), dist: Some("pandas".into()), dist_candidates: vec![], file: "b.py".into(), line: 3 }],
            lock_out_of_date: true,
            requirements_uninstalled: false,
            interpreter: Some("P".into()),
            requirements_file: None,
            scanned_at: 1,
        }
    }

    #[test]
    fn apply_dep_ignores_filters_all_edges() {
        let mut diff = ignore_test_diff();
        let ignores = vec![
            DepIgnoreEntry { edge: "e1".into(), key: "foo".into() },
            // E3 键为异形大写（手改配置绕过 add 归一）——过滤侧归一化防御仍命中
            DepIgnoreEntry { edge: "e3".into(), key: "Numpy".into() },
            DepIgnoreEntry { edge: "e4".into(), key: "pandas".into() },
            // v1.7 A：E2 小节条目（按模块名忽略）——归一化比对命中
            DepIgnoreEntry { edge: "e2".into(), key: "pytest".into() },
        ];
        apply_dep_ignores(&mut diff, &ignores);
        // E1：foo 被忽略、bar 保留
        assert_eq!(diff.missing_in_env.len(), 1);
        assert_eq!(diff.missing_in_env[0].module, "bar");
        // E2 未被忽略 → 保留；E2 小节（declared_missing_modules）被忽略 → 清空
        assert_eq!(diff.declared_missing.len(), 1);
        assert!(diff.declared_missing_modules.is_empty());
        assert!(diff.env_drift.is_empty());
        assert!(diff.undeclared.is_empty());
        // E5 项目级布尔无行级忽略语义 → 不受影响
        assert!(diff.lock_out_of_date);
    }

    #[test]
    fn apply_dep_ignores_e2_normalized_match() {
        let mut diff = ignore_test_diff();
        // 存储键为点分异形：归一化后与 diff 的 zope-interface 命中
        let ignores = vec![DepIgnoreEntry { edge: "e2".into(), key: "Zope.Interface".into() }];
        apply_dep_ignores(&mut diff, &ignores);
        assert!(diff.declared_missing.is_empty());
        // 其余断边不受影响
        assert_eq!(diff.missing_in_env.len(), 2);
    }

    #[test]
    fn apply_dep_ignores_empty_noop() {
        let mut diff = ignore_test_diff();
        apply_dep_ignores(&mut diff, &[]);
        assert_eq!(diff.missing_in_env.len(), 2);
        assert_eq!(diff.declared_missing.len(), 1);
        assert_eq!(diff.env_drift.len(), 1);
        assert_eq!(diff.undeclared.len(), 1);
    }

    #[test]
    fn save_dep_ignores_dedup_preserves_order() {
        // 去重保序是 save_dep_ignores 的纯逻辑前段；fs 写回依赖 pylume_home 不可注入，
        // 此处用与 save_dep_ignores 相同的去重表达式锁定语义（重复条目以首次出现为准）
        let list = vec![
            DepIgnoreEntry { edge: "e1".into(), key: "a".into() },
            DepIgnoreEntry { edge: "e1".into(), key: "a".into() },
            DepIgnoreEntry { edge: "e3".into(), key: "b".into() },
        ];
        let mut seen = HashSet::new();
        let cleaned: Vec<_> = list
            .into_iter()
            .filter(|e| seen.insert((e.edge.clone(), e.key.clone())))
            .collect();
        assert_eq!(cleaned.len(), 2);
        assert_eq!(cleaned[0].key, "a");
        assert_eq!(cleaned[1].key, "b");
    }

    // ----- M4-4：dist 歧义（同 module 多 dist 候选） -----

    #[test]
    fn e1_e4_carry_multi_dist_candidates() {
        let p = probe_with_candidates(
            vec![
                ("a.py", "ambiguous", 1, false),  // missing 且多候选
                ("b.py", "clean", 2, false),      // site 单候选 → E4 多候选字段 = 单元素
                ("b.py", "noinfo", 3, false),     // site 无候选（无 top_level.txt）→ 候选空、dist null
            ],
            vec![
                ("ambiguous", "missing", None),
                ("clean", "site", Some("clean-dist")),
                ("noinfo", "site", None),
            ],
            vec![
                ("ambiguous", vec!["pkg-a", "pkg-b"]),
                ("clean", vec!["clean-dist"]),
            ],
        );

        let (e1, _) = compute_missing_in_env(&p, &DeclaredDeps::default(), "declared");
        let amb = e1.iter().find(|m| m.module == "ambiguous").unwrap();
        // 首候选兼容旧 dist 语义；候选全集透传
        assert_eq!(amb.dist.as_deref(), Some("pkg-a"));
        assert_eq!(amb.dist_candidates, vec!["pkg-a".to_string(), "pkg-b".to_string()]);

        let declared = DeclaredDeps::default();
        let e4 = compute_undeclared(&p, &declared, None);
        let clean = e4.iter().find(|u| u.module == "clean").unwrap();
        assert_eq!(clean.dist.as_deref(), Some("clean-dist"));
        assert_eq!(clean.dist_candidates, vec!["clean-dist".to_string()]);
        let noinfo = e4.iter().find(|u| u.module == "noinfo").unwrap();
        assert_eq!(noinfo.dist, None);
        assert!(noinfo.dist_candidates.is_empty());
    }

    #[test]
    fn probe_resolution_candidate_fallbacks() {
        // 旧形态构造（仅 dist 单值，无 distCandidates）→ all_candidates 视为唯一候选
        let legacy = ProbeResolution { status: "missing".into(), dist: Some("legacy".into()), dist_candidates: vec![] };
        assert_eq!(legacy.all_candidates(), vec!["legacy".to_string()]);
        assert_eq!(legacy.first_dist(), Some("legacy"));
        // 新形态：候选列表优先，dist 字段为首候选镜像
        let full = ProbeResolution {
            status: "missing".into(),
            dist: Some("first".into()),
            dist_candidates: vec!["first".into(), "second".into()],
        };
        assert_eq!(full.all_candidates(), vec!["first".to_string(), "second".to_string()]);
        // 空候选 → 别名表兜底路径（effective_dist_candidates）
        let empty = ProbeResolution { status: "missing".into(), dist: None, dist_candidates: vec![] };
        let (first, cands) = effective_dist_candidates("yaml", &empty);
        assert_eq!(first.as_deref(), Some("PyYAML"));
        assert_eq!(cands, vec!["PyYAML".to_string()]);
        // 别名表无此模块 → dist null、候选空（正常占比，§3.3）
        let (first2, cands2) = effective_dist_candidates("mystery", &empty);
        assert_eq!(first2, None);
        assert!(cands2.is_empty());
    }

    // ----- M4-2：scope 分流与缓存 -----

    #[test]
    fn scan_scope_routing() {
        use super::ScanScope;
        // from_str：缺省/未知 → full（保守）
        assert_eq!(ScanScope::from_str("full"), ScanScope::Full);
        assert_eq!(ScanScope::from_str("code"), ScanScope::Code);
        assert_eq!(ScanScope::from_str("declaration"), ScanScope::Declaration);
        assert_eq!(ScanScope::from_str("bogus"), ScanScope::Full);
        assert_eq!(ScanScope::from_str(""), ScanScope::Full);
        // 分层开关
        assert!(ScanScope::Full.runs_code() && ScanScope::Full.runs_env() && ScanScope::Full.runs_lock_check());
        assert!(ScanScope::Code.runs_code() && !ScanScope::Code.runs_env() && !ScanScope::Code.runs_lock_check());
        assert!(!ScanScope::Declaration.runs_code() && ScanScope::Declaration.runs_env() && !ScanScope::Declaration.runs_lock_check());
    }

    #[test]
    fn resolution_and_env_snapshot_cache_semantics() {
        let ws_a = Path::new("F:/ws-a");
        let ws_b = Path::new("F:/ws-b");

        // ---- resolution：键 = 解释器+工作区根（复核修复 #1）；代次守卫（复核修复 #2）----
        let mut m = HashMap::new();
        m.insert("os".to_string(), ProbeResolution { status: "stdlib".into(), dist: None, dist_candidates: vec![] });
        let (gen0, miss0) = load_resolution_cache("py-A", ws_a);
        assert!(miss0.is_empty()); // 无缓存 → 命中集空（但代次有效，见 load 注释）
        store_resolution_cache("py-A", ws_a, gen0, &m);
        let (_, hit_a) = load_resolution_cache("py-A", ws_a);
        assert!(hit_a.contains_key("os"));
        // 换解释器 / 换工作区 → 命中集空（键不匹配，复核修复 #1：local 分类依赖 root）
        assert!(load_resolution_cache("py-B", ws_a).1.is_empty());
        assert!(load_resolution_cache("py-A", ws_b).1.is_empty());
        // 换键写入会清空重建
        let mut m2 = HashMap::new();
        m2.insert("x".to_string(), ProbeResolution { status: "missing".into(), dist: None, dist_candidates: vec![] });
        let (gen_b, _) = load_resolution_cache("py-B", ws_b);
        store_resolution_cache("py-B", ws_b, gen_b, &m2);
        assert!(load_resolution_cache("py-B", ws_b).1.contains_key("x"));
        assert!(!load_resolution_cache("py-B", ws_b).1.contains_key("os"));
        // 作废后（generation++）：在途扫描按旧代次回写被丢弃；新代次回写正常
        invalidate_resolution_cache();
        let mut m3 = HashMap::new();
        m3.insert("stale".to_string(), ProbeResolution { status: "missing".into(), dist: None, dist_candidates: vec![] });
        store_resolution_cache("py-B", ws_b, gen_b, &m3); // 旧代次回写 → 丢弃
        assert!(load_resolution_cache("py-B", ws_b).1.is_empty());
        let (gen_new, _) = load_resolution_cache("py-B", ws_b);
        assert_ne!(gen_new, gen_b); // 代次已前进
        store_resolution_cache("py-B", ws_b, gen_new, &m3); // 新代次回写 → 生效
        assert!(load_resolution_cache("py-B", ws_b).1.contains_key("stale"));

        // ---- 环境快照：键 = 解释器+工作区根（复核修复 #1）----
        store_env_snapshot_cache("py-A", ws_a, &[("requests".to_string(), "2.0".to_string())]);
        let hit = load_env_snapshot_cache().unwrap();
        assert_eq!(hit.0, env_snapshot_cache_key("py-A", ws_a));
        assert_eq!(hit.1.len(), 1);
        // 切工作区后键不匹配（dep_scan_impl 的 code 复用分支会因此降级为空）
        assert_ne!(hit.0, env_snapshot_cache_key("py-A", ws_b));
        store_env_snapshot_cache("py-B", ws_b, &[]);
        let hit2 = load_env_snapshot_cache().unwrap();
        assert_eq!(hit2.0, env_snapshot_cache_key("py-B", ws_b));
        assert!(hit2.1.is_empty());
        // 收尾：清空静态缓存，避免与其他并行测试互踩（dep_scan 端到端测试共用此静态）
        let _ = std::mem::take::<Option<(String, Vec<(String, String)>)>>(&mut *unpoison(ENV_SNAPSHOT_CACHE.lock()));
        invalidate_resolution_cache();
    }

    // ----- 探针集成测试（spawn 系统 python；不可用时跳过不失败——CI 环境可移植性） -----

    #[test]
    fn probe_classifies_stdlib_local_site_missing() {
        let Some(py) = borrow_python() else {
            eprintln!("跳过探针集成测试：系统无可用 python");
            return;
        };
        let d = dep_tmpdir("probe-ws");
        fs::create_dir_all(d.join("mypkg")).unwrap();
        fs::write(d.join("mypkg/__init__.py"), "").unwrap();
        // 相对导入（level>0）应被探针跳过：sub.py 不产生任何 import 位点
        fs::write(d.join("mypkg/sub.py"), "from . import other\nfrom ..mypkg import x\n").unwrap();
        fs::write(
            d.join("main.py"),
            "import os\nimport mypkg\nimport totally_missing_xyz\n\ndef f():\n    import json\n",
        )
        .unwrap();

        // 工作区外的模块目录经 PYTHONPATH 注入 → 解析落点应为 site（模拟三方已装）
        let site = dep_tmpdir("probe-site");
        fs::write(site.join("fakelib.py"), "X = 1\n").unwrap();

        let payload = json!({
            "workspace_root": d.to_string_lossy(),
            "files": ["main.py", "mypkg/sub.py"],
            "modules": ["fakelib"],
        });
        let out = run_probe_env(
            &py,
            &d,
            &payload,
            Duration::from_secs(30),
            &[("PYTHONPATH", site.to_str().unwrap())],
        )
        .expect("探针应成功");

        // imports：main.py 四个位点（sub.py 的相对导入全部跳过）
        assert!(out.imports.iter().all(|i| i.file == "main.py"), "相对导入不应产生位点");
        let find = |m: &str| out.imports.iter().find(|i| i.module == m).expect(m);
        assert_eq!(find("os").line, 1);
        assert!(!find("os").lazy);
        assert_eq!(find("mypkg").line, 2);
        assert_eq!(find("totally_missing_xyz").line, 3);
        // §4.1 行为变更：函数体内 import 进入收集且标 lazy
        let json_imp = find("json");
        assert!(json_imp.lazy);
        assert_eq!(json_imp.line, 6);

        // resolution 分类
        let res = |m: &str| out.resolution.get(m).unwrap_or_else(|| panic!("{m} 无解析结果"));
        assert_eq!(res("os").status, "stdlib");
        assert_eq!(res("json").status, "stdlib");
        assert_eq!(res("mypkg").status, "local");
        assert_eq!(res("totally_missing_xyz").status, "missing");
        assert_eq!(res("fakelib").status, "site");

        fs::remove_dir_all(&d).unwrap();
        fs::remove_dir_all(&site).unwrap();
    }

    /// 用户实测 bug 锁定（2026-09-16，D:\PycharmProjects\handsome cbond/cb_daily.py）：
    /// 脚本式布局（子目录裸导入 `from field_map import ...`，同目录无 __init__.py）——
    /// Python 运行语义是「脚本所在目录进 sys.path[0]」，探针旧口径只插工作区根，
    /// 同目录模块被误判 missing（E1 误报「field_map/settings 缺失」）。
    #[test]
    fn probe_resolves_sibling_imports_by_script_dir() {
        let Some(py) = borrow_python() else {
            eprintln!("跳过探针集成测试：系统无可用 python");
            return;
        };
        let d = dep_tmpdir("probe-sibling");
        // 脚本式布局：sub/ 下 cb.py 裸导入同目录 field_map（无 __init__.py）
        fs::create_dir_all(d.join("sub")).unwrap();
        fs::write(d.join("sub/field_map.py"), "X = 1\n").unwrap();
        fs::write(d.join("sub/cb.py"), "from field_map import X\nimport os\n").unwrap();

        let payload = json!({
            "workspace_root": d.to_string_lossy(),
            "files": ["sub/cb.py"],
            "modules": [],
            "module_dirs": {},
        });
        let out = run_probe_env(&py, &d, &payload, Duration::from_secs(30), &[]).expect("探针应成功");
        let res = |m: &str| out.resolution.get(m).unwrap_or_else(|| panic!("{m} 无解析结果"));
        assert_eq!(res("field_map").status, "local", "同目录模块须按脚本目录解析为 local（不得误报 missing）");
        assert_eq!(res("os").status, "stdlib");

        // module_dirs 路径（缓存复用模块）：Rust 侧传入的位点目录同样生效
        let payload2 = json!({
            "workspace_root": d.to_string_lossy(),
            "files": [],
            "modules": ["field_map"],
            "module_dirs": { "field_map": [d.join("sub").to_string_lossy().to_string()] },
        });
        let out2 = run_probe_env(&py, &d, &payload2, Duration::from_secs(30), &[]).expect("探针应成功");
        assert_eq!(out2.resolution.get("field_map").unwrap().status, "local");

        fs::remove_dir_all(&d).unwrap();
    }

    /// fika-admin 实测 bug 锁定（2026-09-16）：uv.lock 锁定闭包（传递依赖）不报 E3 漂移。
    /// uv sync 装的环境里 pydantic-core/starlette/typing-extensions 按 lock 合法存在，
    /// 旧口径只按 pyproject 排除 → 63 项全是噪声「漂移」。
    #[test]
    fn uv_lock_closure_excluded_from_drift_and_undeclared() {
        let d = dep_tmpdir("lock-closure");
        fs::write(
            d.join("pyproject.toml"),
            "[project]\nname = \"demo\"\ndependencies = [\"fastapi>=0.110\"]\n",
        )
        .unwrap();
        // uv.lock：锁定闭包含传递依赖 starlette / pydantic-core
        fs::write(
            d.join("uv.lock"),
            "version = 1\n\n[[package]]\nname = \"demo\"\nversion = \"1.0.0\"\n\n[[package]]\nname = \"fastapi\"\nversion = \"0.136\"\n\n[[package]]\nname = \"starlette\"\nversion = \"1.2\"\n\n[[package]]\nname = \"pydantic-core\"\nversion = \"2.46\"\n\n[manifest]\nname = \"manifest-should-not-count\"\n",
        )
        .unwrap();
        // 环境装了 fastapi + 传递依赖 starlette/pydantic-core + 真漂移 pkga
        let installed = vec![
            ("fastapi".to_string(), "0.136".to_string()),
            ("starlette".to_string(), "1.2".to_string()),
            ("pydantic-core".to_string(), "2.46".to_string()),
            ("pkga".to_string(), "0.1".to_string()),
        ];
        let (mut declared, name) = parse_pyproject_deps(&fs::read_to_string(d.join("pyproject.toml")).unwrap());
        let lock_names = parse_uv_lock_names(&d);
        assert!(lock_names.contains("starlette") && lock_names.contains("pydantic-core"), "lock 名单解析");
        assert!(!lock_names.contains("manifest-should-not-count"), "[manifest] 段不得计入");
        declared.all.extend(lock_names);

        let e3 = compute_env_drift(&installed, &declared, name.as_deref());
        assert_eq!(e3.len(), 1, "lock 闭包内的传递依赖不报漂移：{e3:?}");
        assert_eq!(e3[0].dist, "pkga");

        // E4：lock 闭包内的 import（starlette）不报未声明
        let p = probe(
            vec![("main.py", "starlette", 1, false), ("main.py", "fastapi", 2, false)],
            vec![
                ("starlette", "site", Some("starlette")),
                ("fastapi", "site", Some("fastapi")),
            ],
        );
        let e4 = compute_undeclared(&p, &declared, name.as_deref());
        assert!(e4.is_empty(), "lock 闭包与已声明包都不进 E4：{e4:?}");

        // E2（core 同步范围）不受 lock 并入影响：lock 里有的包没装时，只要不在
        // pyproject core 声明中就不报「声明未安装」（lock 是结果不是要求）
        let e2 = compute_declared_missing(&declared, &installed);
        assert!(e2.is_empty(), "fastapi 已装 → E2 无缺失：{e2:?}");

        fs::remove_dir_all(&d).unwrap();
    }

    // ----- dep_scan 端到端（无解释器路径：确定性——不触发 uv/venv 子进程；python 缺失则跳过） -----

    #[test]
    fn dep_scan_bare_no_interpreter() {
        if borrow_python().is_none() {
            eprintln!("跳过 dep_scan 端到端：系统无可用 python");
            return;
        }
        let d = dep_tmpdir("scan-bare");
        fs::write(d.join("main.py"), "import os\nimport missing_thing\n").unwrap();
        let diff = dep_scan_impl(d.to_str().unwrap(), ScanScope::Full).unwrap();
        assert_eq!(diff.style, "bare");
        assert!(diff.interpreter.is_none());
        // §3.3：interpreter=null → 环境侧 E1/E2/E3 置空
        assert!(diff.missing_in_env.is_empty());
        assert!(diff.declared_missing.is_empty());
        assert!(diff.env_drift.is_empty());
        // E4 仅 pyproject 项目
        assert!(diff.undeclared.is_empty());
        assert!(!diff.lock_out_of_date);
        assert!(!diff.requirements_uninstalled);
        assert!(diff.scanned_at > 0);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn dep_scan_pyproject_no_interpreter_computes_e4_only() {
        if borrow_python().is_none() {
            eprintln!("跳过 dep_scan 端到端：系统无可用 python");
            return;
        }
        let d = dep_tmpdir("scan-pyproj");
        fs::write(
            d.join("pyproject.toml"),
            "[project]\nname = \"demo\"\ndependencies = [\"requests>=2\"]\n",
        )
        .unwrap();
        fs::write(
            d.join("main.py"),
            "import os\nimport requests\nimport demo_helper\nimport mystery_mod\n",
        )
        .unwrap();
        fs::write(d.join("demo_helper.py"), "").unwrap();
        // 无 .venv、无 uv.lock：解释器 null → 环境侧全空；无 lock 文件 → 不报过期
        let diff = dep_scan_impl(d.to_str().unwrap(), ScanScope::Full).unwrap();
        assert_eq!(diff.style, "pyproject");
        assert!(diff.interpreter.is_none());
        assert!(diff.missing_in_env.is_empty());
        assert!(diff.declared_missing.is_empty());
        assert!(diff.env_drift.is_empty());
        assert!(!diff.lock_out_of_date);
        // E4：requests 已声明、os stdlib、demo_helper 一方、mystery_mod missing（归 E1 不进 E4）
        assert!(diff.undeclared.is_empty(), "E4 不应误报：{:?}", diff.undeclared);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn dep_scan_external_disables_declaration_sides() {
        let d = dep_tmpdir("scan-ext");
        fs::write(d.join("pyproject.toml"), "[tool.poetry]\nname=\"x\"\n").unwrap();
        fs::write(d.join("poetry.lock"), "# lock").unwrap();
        fs::write(d.join("main.py"), "import os\n").unwrap();
        let diff = dep_scan_impl(d.to_str().unwrap(), ScanScope::Full).unwrap();
        assert_eq!(diff.style, "external");
        assert_eq!(diff.external_manager.as_deref(), Some("poetry"));
        // §4.2.1/R11：external 时 E2~E5 主动禁用（不给错误结果）
        assert!(diff.declared_missing.is_empty());
        assert!(diff.env_drift.is_empty());
        assert!(diff.undeclared.is_empty());
        assert!(!diff.lock_out_of_date);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn dep_scan_requirements_style_no_interpreter() {
        let d = dep_tmpdir("scan-req");
        fs::write(d.join("requirements.txt"), "requests>=2\nflask\n# comment\n-r other.txt\n").unwrap();
        let diff = dep_scan_impl(d.to_str().unwrap(), ScanScope::Full).unwrap();
        assert_eq!(diff.style, "requirements");
        assert_eq!(diff.requirements_file.as_deref(), Some("requirements.txt"));
        // interpreter=null → E2 特例不可判（环境快照缺失），恒 false
        assert!(!diff.requirements_uninstalled);
        assert!(diff.declared_missing.is_empty());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn dep_scan_rejects_missing_workspace() {
        let e = dep_scan_impl("Z:\\__pylume_no_such_ws__", ScanScope::Full).unwrap_err();
        assert!(e.contains("工作区不存在"));
    }

    /// bench 摸底（§4.1 性能红线 ≤2s 的计时 harness，M1 落地）：对 bench/sample 下每个
    /// 样例项目跑一遍 dep_scan_impl 打印耗时。样例体量小（个位数文件），本用例验证的是
    /// 「全链路可跑通 + 计时可见」；大仓库红线待 bench 集扩充后在 M4 复验（`--ignored` 手动跑：
    /// `cargo test --release bench_dep_scan -- --ignored --nocapture`）。
    #[test]
    #[ignore = "需要本机 uv/python 环境，手动跑（bench 摸底）"]
    fn bench_dep_scan_timing() {
        let samples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../bench/sample");
        let Ok(rd) = fs::read_dir(&samples) else {
            eprintln!("bench/sample 不存在：{}", samples.display());
            return;
        };
        let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        for d in dirs {
            let t0 = Instant::now();
            match dep_scan_impl(d.to_str().unwrap(), ScanScope::Full) {
                Ok(diff) => println!(
                    "{:<24} style={:<12} E1={} E2={} E3={} E4={} lock={} took={}ms",
                    d.file_name().unwrap().to_string_lossy(),
                    diff.style,
                    diff.missing_in_env.len(),
                    diff.declared_missing.len(),
                    diff.env_drift.len(),
                    diff.undeclared.len(),
                    diff.lock_out_of_date,
                    t0.elapsed().as_millis()
                ),
                Err(e) => println!("{:<24} ERROR {e}", d.file_name().unwrap().to_string_lossy()),
            }
        }
    }
}