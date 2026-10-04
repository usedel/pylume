use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tauri_plugin_dialog::DialogExt;

use crate::tool_paths::{tool_command, ENV_GIT, ENV_RUFF, ENV_UV};
use crate::util::{no_window, pylume_home};

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// 读取目录（一层），过滤常见噪声目录；show_hidden 控制是否显示 dot 文件/目录
#[tauri::command]
pub fn read_dir(path: &str, show_hidden: bool) -> Result<Vec<Entry>, String> {
    // 始终过滤的噪声目录（无论是否显示隐藏文件）
    const ALWAYS_IGNORED: [&str; 2] = ["node_modules", "__pycache__"];
    // 默认模式额外过滤的目录
    const DEFAULT_IGNORED: [&str; 4] = [".git", ".venv", ".idea", ".vscode"];
    let mut out = Vec::new();
    let rd = fs::read_dir(path).map_err(|e| e.to_string())?;
    for d in rd {
        let d = d.map_err(|e| e.to_string())?;
        let name = d.file_name().to_string_lossy().to_string();
        if ALWAYS_IGNORED.contains(&name.as_str()) {
            continue;
        }
        if !show_hidden {
            // 默认模式：过滤所有 dot 项 + 常见 IDE/环境目录
            if name.starts_with('.') || DEFAULT_IGNORED.contains(&name.as_str()) {
                continue;
            }
        }
        let is_dir = d.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(Entry {
            name,
            path: d.path().to_string_lossy().to_string(),
            is_dir,
        });
    }
    out.sort_by(|a, b| (b.is_dir as u8).cmp(&(a.is_dir as u8)).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[tauri::command]
pub fn read_file(path: &str) -> Result<String, String> {
    // 大文件守卫：整读入 Monaco model 无行数上限，超大文本会整窗卡顿。
    // 超过 10 MB 直接报错（由前端 toast 呈现），而不是读入后假死。
    const MAX_READ_BYTES: u64 = 10 * 1024 * 1024;
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err(format!("路径是目录而非文件：{}", path));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "文件过大（{:.1} MB），超过 10 MB 上限，编辑器不支持打开",
            meta.len() as f64 / 1048576.0
        ));
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

/// 读取文件字节并 base64 编码（Markdown 导出 HTML 时把本地图片内联为 data URI）。
/// 图片是二进制，read_file 的 read_to_string 对非 UTF-8 会失败，故单独走字节读取。
/// P1-6（2026-09-29 review）：补大小守卫（同 read_file 范式）——此前无上限，任意大
/// 文件整读 + base64（×1.33）会撑爆内存并长时间冻结主线程；设计用途是图片内联，
/// 32 MB 足够（超出常见 RAW/视频不在导出场景）。
#[tauri::command]
pub fn read_file_base64(path: &str) -> Result<String, String> {
    const MAX_READ_BYTES: u64 = 32 * 1024 * 1024;
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err(format!("路径是目录而非文件：{}", path));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "文件过大（{:.1} MB），超过 32 MB 上限，无法内联为 data URI",
            meta.len() as f64 / 1048576.0
        ));
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn write_file(path: &str, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|e| e.to_string())
}

/// 删除文件（CR-05：选区运行临时文件清理用）。文件不存在视为成功（幂等），
/// 目录与其它 IO 错误透传字符串。
#[tauri::command]
pub fn delete_file(path: &str) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// 写入 Live Templates 配置（M2 管理面板 / 导入）
/// scope="user" → <data_root>/config/templates.json；scope="workspace" → <workspace_root>/.pylume/templates.json
#[tauri::command]
pub fn write_templates_config(
    scope: &str,
    workspace_root: Option<String>,
    content: &str,
) -> Result<(), String> {
    let path = match scope {
        "user" => pylume_home().join("config").join("templates.json"),
        "workspace" => {
            let root = workspace_root
                .ok_or_else(|| "workspace 层写入需要 workspace_root".to_string())?;
            Path::new(&root).join(".pylume").join("templates.json")
        }
        _ => return Err(format!("未知配置层：{scope}")),
    };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

/// 当前操作系统用户名（live templates 表达式引擎 user() 函数）
#[tauri::command]
pub fn get_user_name() -> Result<String, String> {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .map_err(|e| e.to_string())
}

/// 智能模板用户配置路径：<data_root>/config/templates.json（不存在返回 null）
#[tauri::command]
pub fn read_templates_config() -> Result<Option<String>, String> {
    let p = pylume_home().join("config").join("templates.json");
    if p.exists() {
        fs::read_to_string(p).map(Some).map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}

/// 最近工作区列表：<data_root>/config/recent-workspaces.json（启动自动恢复 / 「最近的工作区」菜单）
#[tauri::command]
pub fn get_recent_workspaces() -> Result<Vec<String>, String> {
    let p = pylume_home().join("config").join("recent-workspaces.json");
    if !p.exists() {
        return Ok(Vec::new());
    }
    let s = fs::read_to_string(p).map_err(|e| e.to_string())?;
    let list: Vec<String> = serde_json::from_str(&s).unwrap_or_default();
    // 过滤已删除/不存在的目录
    Ok(list.into_iter().filter(|x| Path::new(x).is_dir()).collect())
}

/// 记录最近工作区（去重 + 置顶 + 上限 10），返回更新后的列表
#[tauri::command]
pub fn add_recent_workspace(path: &str) -> Result<Vec<String>, String> {
    let dir = pylume_home().join("config");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join("recent-workspaces.json");
    let mut list: Vec<String> = if p.exists() {
        fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    list.retain(|x| x != path && Path::new(x).is_dir());
    list.insert(0, path.to_string());
    list.truncate(10);
    let payload = serde_json::to_string(&list).map_err(|e| e.to_string())?;
    fs::write(&p, payload).map_err(|e| e.to_string())?;
    Ok(list)
}

/// 清空最近工作区列表（直接删除存储文件，get_recent_workspaces 对不存在返回空）
#[tauri::command]
pub fn clear_recent_workspaces() -> Result<(), String> {
    let p = pylume_home().join("config").join("recent-workspaces.json");
    let _ = fs::remove_file(&p);
    Ok(())
}

/// 删除单条最近工作区，返回更新后的列表
#[tauri::command]
pub fn remove_recent_workspace(path: String) -> Result<Vec<String>, String> {
    let mut list = get_recent_workspaces()?;
    list.retain(|x| x != &path);
    let dir = pylume_home().join("config");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let payload = serde_json::to_string(&list).map_err(|e| e.to_string())?;
    fs::write(dir.join("recent-workspaces.json"), payload).map_err(|e| e.to_string())?;
    Ok(list)
}

/// 打开文件夹选择对话框（返回所选路径或 null）
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    app.clone().dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder.map(|p| p.to_string()));
    });
    Ok(rx.recv().map_err(|e| e.to_string())?)
}

/// 打开单文件选择对话框（返回所选路径或 null）。
/// stdin 重定向（S1）选输入文件用；与 pick_folder 同构，仅换成 pick_file。
#[tauri::command]
pub async fn pick_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    app.clone().dialog().file().pick_file(move |file| {
        let _ = tx.send(file.map(|p| p.to_string()));
    });
    Ok(rx.recv().map_err(|e| e.to_string())?)
}

// ---------- 新建项目 ----------

#[derive(Serialize)]
pub struct CreateProjectResult {
    /// 新项目根目录（绝对路径）
    pub path: String,
    /// git init 是否成功（未要求时恒为 true）
    pub git_ok: bool,
    /// git init 失败原因（成功时为空）
    pub git_message: String,
    /// pyproject.toml 生成说明（uv 官方脚手架 or 模板回退，P2 建议 1）
    pub pyproject_note: String,
}

/// 项目名校验：非空（trim 后）、非 ./..、不含路径分隔符与 Windows 保留字符、不含控制字符
fn valid_project_name(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.chars().any(|c| {
            matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()
        })
}

/// git init（best-effort：失败不阻断项目创建，仅回传原因）
fn git_init_at(root: &Path) -> Result<(), String> {
    let mut cmd = tool_command("git", ENV_GIT);
    cmd.arg("init").arg("--quiet").current_dir(root);
    let out = no_window(&mut cmd)
        .output()
        .map_err(|e| format!("无法启动 git（可能未安装）：{e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// 项目名 → 合法 PEP 508 包名：转小写、非法字符折叠为 '-'、去首尾 '-'，空则回退 "app"。
fn sanitize_pkg_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' {
            out.push(c.to_ascii_lowercase());
        } else {
            out.push('-');
        }
    }
    // PEP 508 名须以字母/数字开头结尾：去掉首尾的分隔符（-_.）
    let trimmed = out.trim_matches(|c| c == '-' || c == '_' || c == '.').to_string();
    if trimmed.is_empty() {
        "app".to_string()
    } else {
        trimmed
    }
}

/// 从版本标识（uv spec 如 "cpython-3.13.7-windows-x86_64-none" 或纯版本号 "3.12"）提取
/// 短版本 "3.MINOR"（uv `--python` 与 requires-python 共用）；无法解析返回 None。
fn python_short_from(version: &str) -> Option<String> {
    let chars: Vec<char> = version.chars().collect();
    for i in 0..chars.len().saturating_sub(1) {
        if chars[i] == '3' && chars[i + 1] == '.' {
            let mut minor = String::new();
            let mut j = i + 2;
            while j < chars.len() && chars[j].is_ascii_digit() {
                minor.push(chars[j]);
                j += 1;
            }
            if !minor.is_empty() {
                return Some(format!("3.{minor}"));
            }
        }
    }
    None
}

/// 写入最小 pyproject.toml（方案 B，回退路径）：仅 [project] 元数据 + 依赖列表，
/// 任何工具链都认、不含 IDE 私有配置。供 create_project 与 env_cmds::init_pyproject 共用。
/// deps 非空时写入 dependencies（F9 新建 FastAPI 项目：fastapi / uvicorn）。
pub(crate) fn write_min_pyproject(root: &Path, name: &str, requires_python: &str, deps: &[&str]) -> std::io::Result<()> {
    let pkg = sanitize_pkg_name(name);
    let deps_line = if deps.is_empty() {
        "dependencies = []".to_string()
    } else {
        let items: Vec<String> = deps.iter().map(|d| format!("\"{d}\"")).collect();
        format!("dependencies = [{}]", items.join(", "))
    };
    let content = format!(
        "[project]\nname = \"{pkg}\"\nversion = \"0.1.0\"\nrequires-python = \"{requires_python}\"\n{deps_line}\n"
    );
    fs::write(root.join("pyproject.toml"), content)
}

/// `name` 是否为 TOML 独立字段（`name = "..."`），而非 `names` / `name_suffix` 等同前缀键
fn is_name_field(t: &str) -> bool {
    let Some(rest) = t.strip_prefix("name") else {
        return false;
    };
    rest.starts_with('=') || rest.starts_with(' ') || rest.starts_with('\t')
}

/// tech-debt #12：uv init 生成的 `[project].name` 按其自身规则（目录名）归一，与方案 B 的
/// `sanitize_pkg_name` 口径可能不同（特殊字符 / 首尾分隔符）。生成后校验并改写为
/// `sanitize_pkg_name` 结果，使方案 A / B 的 name 口径一致。
/// 用字符串行扫描改写（不引入 TOML 解析依赖）；找不到 `[project].name` 或 IO 失败时静默不写。
fn normalize_project_name(root: &Path, expected: &str) -> std::io::Result<()> {
    let path = root.join("pyproject.toml");
    let content = fs::read_to_string(&path)?;
    let target = sanitize_pkg_name(expected);
    let mut out: Vec<String> = Vec::with_capacity(content.lines().count() + 1);
    let mut in_project = false;
    let mut replaced = false;
    for line in content.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            in_project = t == "[project]";
            out.push(line.to_string());
            continue;
        }
        if in_project && !replaced && is_name_field(t) {
            let leading = &line[..line.len() - line.trim_start().len()];
            out.push(format!("{leading}name = \"{target}\""));
            replaced = true;
            continue;
        }
        out.push(line.to_string());
    }
    if replaced {
        fs::write(&path, out.join("\n"))?;
    }
    Ok(())
}

/// F9（方案 A 路径依赖注入）：`uv init --bare` 生成的 pyproject.toml（实测 uv 0.10.11 产物
/// 为 `[project]` 段 + `dependencies = []` 单行）里写入指定依赖。行扫描实现（复刻
/// `normalize_project_name` 先例，不引 TOML 依赖）：
/// - `[project]` 段内已有 `dependencies = [...]` 行 → 原样跳过（幂等，uv 未来产物变化天然兼容）；
/// - 只有空 `dependencies = []` 行 → 替换为 `dependencies = ["fastapi", "uvicorn"]`；
/// - 无 dependencies 键 → 在 `[project]` 段末尾（下一个 `[` 段之前）插行；
/// - 无 `[project]` 段或 IO 失败 → 静默不写（调用方 best-effort，不阻断创建）。
fn inject_project_deps(root: &Path, deps: &[&str]) -> std::io::Result<()> {
    if deps.is_empty() {
        return Ok(());
    }
    let path = root.join("pyproject.toml");
    let content = fs::read_to_string(&path)?;
    let items: Vec<String> = deps.iter().map(|d| format!("\"{d}\"")).collect();
    let deps_line = format!("dependencies = [{}]", items.join(", "));
    let mut out: Vec<String> = Vec::with_capacity(content.lines().count() + 1);
    let mut in_project = false;
    let mut written = false;
    for line in content.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            // 离开 [project] 段且尚未写入 → 在段末插入（本行之前）
            if in_project && !written {
                out.push(deps_line.clone());
                written = true;
            }
            in_project = t == "[project]";
            out.push(line.to_string());
            continue;
        }
        if in_project && t.starts_with("dependencies") && t.contains('=') {
            // 已有 dependencies 键：空数组（uv init --bare 产物主路径）→ 替换为目标依赖；
            // 非空（防御分支，全新目录理论上不出现）→ 原样保留，不覆盖已有内容（uv add 兜底同步）。
            if !written {
                let val = t.split_once('=').map(|(_, v)| v.trim()).unwrap_or("");
                out.push(if val == "[]" { deps_line.clone() } else { line.to_string() });
                written = true;
            }
            continue;
        }
        out.push(line.to_string());
    }
    if in_project && !written {
        out.push(deps_line.clone());
    }
    let mut new_content = out.join("\n");
    if content.ends_with('\n') && !new_content.ends_with('\n') {
        new_content.push('\n');
    }
    fs::write(&path, new_content)
}

/// 方案 A：用 uv 官方脚手架生成 pyproject.toml。
/// `uv init --bare` 只写 pyproject.toml——实测 uv 0.10.11 在非空目录下不生成 main.py/README/.gitignore，
/// 也不触碰既有文件，因此与 create_project 的 main.py/.gitignore 写入无双写冲突（调研报告 §5 建议 1 的顾虑）。
/// `--vcs none` 让 git 初始化仍由现有 git_init 分支独占；`--no-workspace` 避免误并入父级 workspace；
/// `--no-python-downloads --offline` 确保创建项目绝不触发联网下载（§9 网络风险）。
/// python_arg 传给 `--python`（版本号如 "3.13"，或解释器路径）；None = 由 uv 自行决定。
/// Err 表示 uv 缺席或失败，调用方须回退方案 B。
fn uv_init_bare(root: &Path, python_arg: Option<&str>) -> Result<(), String> {
    let mut cmd = tool_command("uv", ENV_UV);
    cmd.arg("init")
        .arg("--bare")
        .arg("--vcs")
        .arg("none")
        .arg("--no-workspace")
        .arg("--no-python-downloads")
        .arg("--offline");
    if let Some(v) = python_arg {
        cmd.arg("--python").arg(v);
    }
    cmd.arg(root);
    let out = no_window(&mut cmd)
        .output()
        .map_err(|e| format!("无法启动 uv（可能未安装）：{e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if msg.is_empty() {
        format!("uv init 失败（exit {:?}）", out.status.code())
    } else {
        msg
    })
}

/// 生成 pyproject.toml：方案 A（`uv init --bare`）为主，uv 缺席/失败时回退方案 B（最小模板），
/// 保证「创建永不因 uv 缺席而失败」（调研报告 §9 回退约定）。
/// fallback_requires 为回退模板写入的 requires-python。返回 (是否由 uv 生成, 面向用户的说明)。
/// deps：额外写入 dependencies 的依赖（F9 新建 FastAPI 项目用；两条路径都要注入）。
pub(crate) fn ensure_pyproject(
    root: &Path,
    name: &str,
    python_arg: Option<String>,
    fallback_requires: &str,
    deps: &[&str],
) -> (bool, String) {
    let deps_note = if deps.is_empty() {
        String::new()
    } else {
        format!("，并写入 {} 依赖", deps.join(" / "))
    };
    match uv_init_bare(root, python_arg.as_deref()) {
        Ok(()) => {
            // tech-debt #12：改写 name 使与方案 B 口径一致（失败静默，不阻断生成）
            let _ = normalize_project_name(root, name);
            // F9：方案 A 产物里注入依赖（失败静默——uv add 安装时兜底同步，闭环不破）
            let _ = inject_project_deps(root, deps);
            (true, format!("已用 uv init --bare 生成 pyproject.toml{deps_note}"))
        }
        Err(e) => match write_min_pyproject(root, name, fallback_requires, deps) {
            Ok(()) => (
                false,
                format!("uv 不可用（{e}），已写入最小 pyproject.toml 模板（requires-python = \"{fallback_requires}\"{deps_note}）"),
            ),
            Err(we) => (false, format!("生成 pyproject.toml 失败：{we}")),
        },
    }
}

/// 新建项目：parent_dir/name 下创建 main.py 入口 + 最小 pyproject.toml；git_init 时附 .gitignore 并初始化仓库。
/// .venv 创建复用既有 create_venv 命令（前端在打开工作区后调用，输出流式可见）。
/// python_version：创建向导所选版本（uv spec 或版本号，可空），用于 pyproject 的 requires-python。
/// project_type：项目类型（F9）——"fastapi" 生成 FastAPI 模板 main.py 并把 fastapi/uvicorn
/// 写入 pyproject dependencies；None / 空 / "script" 为默认脚本模板（旧调用零感知）。
/// async + spawn_blocking：git init 子进程可能耗时，同步 command 会卡死主线程 UI。
#[tauri::command]
pub async fn create_project(
    parent_dir: String,
    name: String,
    git_init: bool,
    python_version: Option<String>,
    project_type: Option<String>,
) -> Result<CreateProjectResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_project_impl(parent_dir, name, git_init, python_version, project_type)
    })
    .await
    .map_err(|e| format!("任务执行异常：{e}"))?
}

/// F9：FastAPI 模板 main.py。设计依据（调研报告 §8.3.1）：
/// - `app = FastAPI(` 命中 detect_framework 探针的 scan_app_decl；
/// - 两条路由让端点视图开箱有内容（`{item_id}` 顺带演示路径参数）；
/// - 注解驱动契合静态引擎；`str | None` 需 3.10+（默认 requires-python >= 3.12 已满足）。
const FASTAPI_MAIN_PY: &str = "from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get(\"/\")\ndef root() -> str:\n    return \"Hello from Pylume FastAPI!\"\n\n\n@app.get(\"/items/{item_id}\")\ndef read_item(item_id: int, q: str | None = None) -> dict:\n    return {\"item_id\": item_id, \"q\": q}\n";

/// F9：FastAPI 项目的 pyproject dependencies（uvicorn 为 uv add 的服务依赖）。
const FASTAPI_PROJECT_DEPS: &[&str] = &["fastapi", "uvicorn"];

fn create_project_impl(
    parent_dir: String,
    name: String,
    git_init: bool,
    python_version: Option<String>,
    project_type: Option<String>,
) -> Result<CreateProjectResult, String> {
    if !valid_project_name(&name) {
        return Err(format!("项目名称非法：{name:?}（不能为空，不能包含 \\ / : * ? \" < > | 等字符）"));
    }
    let parent = Path::new(&parent_dir);
    if !parent.is_dir() {
        return Err(format!("位置不存在或不是文件夹：{parent_dir}"));
    }
    let root = parent.join(&name);
    if root.exists() {
        return Err(format!("目标已存在：{}", root.to_string_lossy()));
    }
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    // F9：按项目类型切换 main.py 模板（fastapi / 默认脚本）
    let is_fastapi = project_type.as_deref() == Some("fastapi");
    let main_py = if is_fastapi {
        FASTAPI_MAIN_PY
    } else {
        "def main() -> None:\n    print(\"Hello from Pylume!\")\n\n\nif __name__ == \"__main__\":\n    main()\n"
    };
    fs::write(root.join("main.py"), main_py).map_err(|e| e.to_string())?;

    // P2（建议 1）：默认生成 pyproject.toml，让 uv run / 依赖管理语义明确（对应痛点①）。
    // 方案 A（uv init --bare）为主、方案 B（最小模板）兜底：既用官方脚手架，又保证
    // “创建永不因 uv 缺席而失败”（§9）。requires-python 反映创建向导所选版本；未选版本时统一
    // 显式传 3.12 下限，避免 uv 依机器默认解释器产出不确定结果（两条路径产出一致）。
    let python_arg = python_short_from(python_version.as_deref().unwrap_or(""))
        .unwrap_or_else(|| "3.12".to_string());
    let requires_python = format!(">={python_arg}");
    let deps: &[&str] = if is_fastapi { FASTAPI_PROJECT_DEPS } else { &[] };
    let (_used_uv, pyproject_note) = ensure_pyproject(&root, &name, Some(python_arg), &requires_python, deps);

    let mut git_ok = true;
    let mut git_message = String::new();
    if git_init {
        let gitignore = "# Python\n__pycache__/\n*.py[cod]\n*.egg-info/\ndist/\nbuild/\n\n# 虚拟环境\n.venv/\n\n# 工具缓存\n.pytest_cache/\n.ruff_cache/\n.mypy_cache/\n\n# 环境变量\n.env\n";
        fs::write(root.join(".gitignore"), gitignore).map_err(|e| e.to_string())?;
        if let Err(e) = git_init_at(&root) {
            git_ok = false;
            git_message = e;
        }
    }

    Ok(CreateProjectResult {
        path: root.to_string_lossy().to_string(),
        git_ok,
        git_message,
        pyproject_note,
    })
}

// ---------- Scratch 文件（P2：PyCharm Scratch 对标） ----------

/// 草稿目录：`<data_root>/scratches/`——刻意放在**数据根而非工作区**里：
/// 草稿的定义就是「不入库、不污染项目」，放工作区迟早会被误提交或误删。
fn scratch_dir() -> PathBuf {
    pylume_home().join("scratches")
}

/// 在给定目录下创建下一个空闲编号的草稿文件（纯逻辑，可在单测里锁定）
fn create_scratch_in(dir: &Path, ext: &str) -> Result<PathBuf, String> {
    let ext = if ext.starts_with('.') { ext.to_string() } else { format!(".{ext}") };
    for i in 1..1000 {
        // 编号对**所有扩展名**共享（scratch-1.py 之后是 scratch-2.md 而不是又一个 1），
        // 否则同一个编号会对应多个草稿，列表里没法分辨。
        let prefix = format!("scratch-{i}.");
        let taken = fs::read_dir(dir)
            .ok()
            .map(|rd| rd.flatten().any(|e| e.file_name().to_string_lossy().starts_with(&prefix)))
            .unwrap_or(false);
        if taken {
            continue;
        }
        let p = dir.join(format!("scratch-{i}{ext}"));
        if !p.exists() {
            // Python 草稿给个可直接跑的骨架（含 __main__ 守卫，与「运行当前文件」的守卫行判定对齐）
            let body = if ext == ".py" || ext == ".pyw" {
                "# Pylume 草稿（不入库，可直接运行 / 调试）\n\n\ndef main() -> None:\n    pass\n\n\nif __name__ == \"__main__\":\n    main()\n"
            } else {
                ""
            };
            fs::write(&p, body).map_err(|e| format!("创建草稿失败：{e}"))?;
            return Ok(p);
        }
    }
    Err("草稿文件过多（已到 scratch-999），请清理草稿目录后再试".into())
}

/// 新建一个草稿文件，返回其绝对路径。ext 缺省 ".py"。
#[tauri::command]
pub fn create_scratch(ext: Option<String>) -> Result<String, String> {
    let dir = scratch_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建草稿目录失败：{e}"))?;
    let ext = ext.as_deref().unwrap_or(".py");
    let p = create_scratch_in(&dir, ext)?;
    Ok(p.to_string_lossy().into_owned())
}

// ---------- 代码格式化（ruff，独立子进程，不走 LSP 桥） ----------

#[derive(Serialize)]
pub struct FormatResult {
    /// 格式化后的全文（失败时为 None）
    pub formatted: Option<String>,
    /// ruff stderr（成功时为空）
    pub message: String,
}

/// ruff format --stdin：格式化缓冲区内容（不落盘，编辑器层负责应用与撤销）。
/// ruff 缺席不拖垮功能：返回错误信息由前端提示（与探针缺席策略一致）。
/// async + spawn_blocking：等待 ruff 子进程期间不能占用主线程。
#[tauri::command]
pub async fn format_python(path: String, content: String) -> Result<FormatResult, String> {
    tauri::async_runtime::spawn_blocking(move || format_python_impl(path, content))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn format_python_impl(path: String, content: String) -> Result<FormatResult, String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut cmd = tool_command("ruff", ENV_RUFF);
    cmd.args(["format", "--stdin-filename", &path, "-"]);
    let mut child = match no_window(&mut cmd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return Ok(FormatResult {
                formatted: None,
                message: format!("无法启动 ruff（可能未安装）：{e}"),
            })
        }
    };
    // 写 stdin（子进程可能提前退出，忽略 BrokenPipe）
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(content.as_bytes());
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("ruff 执行失败：{e}"))?;
    if out.status.success() {
        Ok(FormatResult {
            formatted: Some(String::from_utf8_lossy(&out.stdout).to_string()),
            message: String::new(),
        })
    } else {
        Ok(FormatResult {
            formatted: None,
            message: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        })
    }
}

// ---------- Optimize Imports（ruff isort 规则 + F401，PyCharm Ctrl+Alt+O 对标） ----------

/// 规则集：I = isort 兼容的导入排序/合并；F401 = 未使用的导入。
/// 二者合起来即 PyCharm「Optimize Imports」的核心语义（排序 + 去重 + 删无用）。
/// 不启用 --fix 之外的其它规则，避免把「整理导入」变成「顺手改一堆代码」。
const OPTIMIZE_IMPORT_RULES: &str = "I,F401";

/// 在缓冲区上整理导入（不落盘，编辑器层负责应用与撤销）。
/// 与 format_python 同款 stdin 管线（架构铁律：ruff 走独立子进程，不占 LSP 桥）。
/// ruff 缺席不拖垮功能：返回错误信息由前端提示。
#[tauri::command]
pub async fn optimize_imports(path: String, content: String) -> Result<FormatResult, String> {
    tauri::async_runtime::spawn_blocking(move || optimize_imports_impl(path, content))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn optimize_imports_impl(path: String, content: String) -> Result<FormatResult, String> {
    use std::io::Write;
    use std::process::Stdio;

    // `--fix` + 从 stdin 读：ruff 把整理后的全文写回 stdout（改动为空时原样回显）。
    // 退出码 0 = 无诊断，1 = 有诊断（含已修复的），>1 = 用法/内部错误；故只把 >1 判失败。
    let mut cmd = tool_command("ruff", ENV_RUFF);
    cmd.args(["check", "--fix", "--select", OPTIMIZE_IMPORT_RULES, "--stdin-filename", &path, "-"]);
    let mut child = match no_window(&mut cmd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return Ok(FormatResult {
                formatted: None,
                message: format!("无法启动 ruff（可能未安装）：{e}"),
            })
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(content.as_bytes());
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("ruff 执行失败：{e}"))?;
    let code = out.status.code().unwrap_or(1);
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if code > 1 || stdout.is_empty() {
        Ok(FormatResult {
            formatted: None,
            message: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        })
    } else {
        Ok(FormatResult {
            formatted: Some(stdout),
            message: String::new(),
        })
    }
}

// ---------- 全局搜索（工作区递归文本搜索） ----------

#[derive(Serialize, Clone)]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    /// 匹配行全文（trim 后）
    pub text: String,
    /// 匹配在行内的起始列（1 基，字符数）
    pub column: u32,
    /// 匹配长度（字符数）
    pub length: u32,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    /// 实际扫描的文件数
    pub files_scanned: u32,
    /// 跳过的二进制/超大文件数
    pub files_skipped: u32,
    /// 其中因二进制/非 UTF-8 跳过的数量（其余为超过大小上限）
    pub files_skipped_binary: u32,
    /// 匹配数达到上限被截断（防海量结果拖垮序列化与前端渲染）
    pub truncated: bool,
}

/// 匹配数上限：超过即停止收集（与 VS Code 搜索的结果上限策略一致）
const MAX_MATCHES: usize = 5000;

/// 搜索忽略目录：`ignore` 遍历的安全网过滤（隐藏目录已由 hidden 规则覆盖，
/// 此处额外兜底未被 .gitignore 收录的常见噪声目录）
const SEARCH_IGNORED_DIRS: [&str; 10] = [
    ".git", ".venv", "node_modules", "__pycache__", ".idea", ".vscode",
    "dist", "build", ".pytest_cache", ".ruff_cache",
];

/// 单文件大小上限（超过跳过，防误扫大文件卡顿）
const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;

/// 工作区全局搜索：大小写不敏感子串匹配，返回带行号/列号的匹配列表。
/// 遍历交给 ripgrep 生态的 `ignore` crate（.gitignore 感知 + 隐藏过滤），
/// 匹配阶段按文件多线程并行，单文件 ≤ 2MB。接口与返回结构不变，前端零感知。
/// async + spawn_blocking：大工作区扫描可能耗时，同步 command 会卡死主线程 UI。
///
/// PR-H（dx_features_backlog §6.6）：新增两个可选参数——
///   · `use_regex`：正则模式（编译失败即返回明确错误，不静默退回子串）；
///   · `file_glob`：文件掩码（gitignore 语义，无斜杠的 `*.py` = 任意深度）。
/// 两者都是 Option，旧调用方（含线上已缓存的旧前端）不用改。
#[tauri::command]
pub async fn search_workspace(
    root: String,
    query: String,
    case_sensitive: bool,
    use_regex: Option<bool>,
    file_glob: Option<String>,
) -> Result<SearchResult, String> {
    let opts = SearchOptions { use_regex: use_regex.unwrap_or(false), file_glob };
    tauri::async_runtime::spawn_blocking(move || search_workspace_impl(root, query, case_sensitive, opts))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

/// PR-H：搜索附加选项（结构体而非一串 bool——后续再加开关不必改函数签名）
#[derive(Default, Clone)]
pub struct SearchOptions {
    pub use_regex: bool,
    pub file_glob: Option<String>,
}

fn search_workspace_impl(
    root: String,
    query: String,
    case_sensitive: bool,
    opts: SearchOptions,
) -> Result<SearchResult, String> {
    if query.is_empty() {
        return Ok(SearchResult { matches: vec![], files_scanned: 0, files_skipped: 0, files_skipped_binary: 0, truncated: false });
    }
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("工作区目录不存在：{root}"));
    }
    // PR-H：正则要在搜索前**编译一次**（失败即返回明确错误——静默退回子串会让用户
    // 以为「正则没生效」，比直接报错更难排查）；编译结果供所有线程共享只读借用。
    let regex = if opts.use_regex {
        let mut b = regex::RegexBuilder::new(&query);
        b.case_insensitive(!case_sensitive);
        Some(b.build().map_err(|e| format!("正则表达式无效：{e}"))?)
    } else {
        None
    };
    // 小写化关键词只计算一次，供所有线程复用
    let needle = if case_sensitive { query.clone() } else { query.to_lowercase() };
    let query_char_len = query.chars().count() as u32;

    // 1. ignore 遍历：.gitignore + 隐藏过滤（PR-H：+ 文件掩码），收集候选文件
    let files = collect_files_glob(root_path, opts.file_glob.as_deref())?;

    // 2. 多线程并行搜索
    let files_scanned = AtomicUsize::new(0);
    let files_skipped = AtomicUsize::new(0);
    let skipped_binary = AtomicUsize::new(0);
    let match_count = AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);
    let num_threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, files.len().max(1));

    let mut matches: Vec<SearchMatch> = Vec::new();
    std::thread::scope(|s| {
        let chunk_size = (files.len() / num_threads).max(1);
        // 以 Copy 引用预先绑定共享数据，供 move 闭包复制（避免移动原子量与 needle 本体）
        let needle_ref = needle.as_str();
        // 同上：正则也是共享只读借用，预先绑定避免 move 闭包把 `regex` 挪走（多次迭代会 use-after-move）
        let regex_ref = regex.as_ref();
        let scanned = &files_scanned;
        let skipped = &files_skipped;
        let skip_bin = &skipped_binary;
        let counted = &match_count;
        let trunc = &truncated;
        let mut handles = Vec::new();
        for chunk in files.chunks(chunk_size) {
            handles.push(s.spawn(move || {
                let mut local: Vec<SearchMatch> = Vec::new();
                for path in chunk {
                    if trunc.load(Ordering::Relaxed) {
                        break;
                    }
                    search_one_file(path, needle_ref, query_char_len, case_sensitive, regex_ref, &mut local, scanned, skipped, skip_bin, counted, trunc);
                }
                local
            }));
        }
        for h in handles {
            if let Ok(local) = h.join() {
                matches.extend(local);
            }
        }
    });
    // 按路径 + 行号排序，结果稳定；超出上限截断
    matches.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    let was_truncated = truncated.load(Ordering::Relaxed) || matches.len() > MAX_MATCHES;
    matches.truncate(MAX_MATCHES);
    Ok(SearchResult {
        matches,
        files_scanned: files_scanned.load(Ordering::Relaxed) as u32,
        files_skipped: files_skipped.load(Ordering::Relaxed) as u32,
        files_skipped_binary: skipped_binary.load(Ordering::Relaxed) as u32,
        truncated: was_truncated,
    })
}

/// ignore 遍历收集候选文件：尊重 .gitignore/全局 git 排除，跳过隐藏项与常见噪声目录。
fn collect_files(root: &Path) -> Vec<PathBuf> {
    collect_files_glob(root, None).unwrap_or_default()
}

/// ignore 遍历 + 可选文件掩码（PR-H）。
/// 掩码走 `ignore` 自带的 overrides（.gitignore 语义：无斜杠的 `*.py` = 任意深度命中，
/// 与 PyCharm File mask 直觉一致）——不引入 globset：同族且**走查期即剪枝**，
/// 比「先收全仓再过滤」省一次全仓遍历，也不必维护第二套 glob 方言。
fn collect_files_glob(root: &Path, file_glob: Option<&str>) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|e| {
            // 根目录本身不参与过滤；其余按噪声目录名单剪枝（不再下探）
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            !SEARCH_IGNORED_DIRS.contains(&name.as_str())
        });
    // PR-H：掩码非空时加 overrides（只要存在白名单规则，未命中者即被排除）
    if let Some(mask) = file_glob {
        let mask = mask.trim();
        if !mask.is_empty() {
            let mut ov = ignore::overrides::OverrideBuilder::new(root);
            ov.add(mask).map_err(|e| format!("文件掩码无效：{e}"))?;
            builder.overrides(ov.build().map_err(|e| format!("文件掩码无效：{e}"))?);
        }
    }
    for entry in builder.build() {
        if let Ok(entry) = entry {
            if entry.file_type().map_or(false, |ft| ft.is_file()) {
                files.push(entry.into_path());
            }
        }
    }
    Ok(files)
}

/// ASCII 大小写不敏感子串查找：在 haystack[from..] 中定位已小写化的 needle，
/// 返回匹配起始字节偏移。逐字节比较、零堆分配（替代逐行 to_lowercase）。
/// 仅对 ASCII 生效；needle 含非 ASCII 时调用方应退回 to_lowercase 路径。
fn find_ascii_ignore_case(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    let nlen = needle.len();
    if nlen == 0 || haystack.len() < from + nlen {
        return None;
    }
    let end = haystack.len() - nlen;
    let first = needle[0];
    let mut i = from;
    while i <= end {
        if haystack[i].to_ascii_lowercase() == first {
            let mut matched = true;
            for k in 1..nlen {
                if haystack[i + k].to_ascii_lowercase() != needle[k] {
                    matched = false;
                    break;
                }
            }
            if matched {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// 收集一条匹配到 local；全局计数达上限时置 truncated 并返回 false（调用方应停止）。
fn try_push_match(
    local: &mut Vec<SearchMatch>,
    path_str: &str,
    line_no: u32,
    line: &str,
    col: usize,
    query_char_len: u32,
    match_count: &AtomicUsize,
    truncated: &AtomicBool,
) -> bool {
    if match_count.fetch_add(1, Ordering::Relaxed) >= MAX_MATCHES {
        truncated.store(true, Ordering::Relaxed);
        return false;
    }
    local.push(SearchMatch {
        path: path_str.to_string(),
        line: line_no,
        text: line.trim().to_string(),
        column: (col + 1) as u32,
        length: query_char_len,
    });
    true
}

/// 读取文件为文本；二进制或非 UTF-8 返回 None。
/// 先读前 8KB 探测：含 \0 即判二进制直接放弃，避免把大二进制文件整个读进内存（性能关键）。
fn read_text_file(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut file = fs::File::open(path).ok()?;
    let mut head = [0u8; 8192];
    let n = file.read(&mut head).ok()?;
    if head[..n].contains(&0) {
        return None;
    }
    let mut buf = head[..n].to_vec();
    file.read_to_end(&mut buf).ok()?;
    String::from_utf8(buf).ok()
}

/// 搜索单个文件，匹配写入 local；scanned/skipped/match_count/truncated 为跨线程共享计数。
fn search_one_file(
    path: &Path,
    needle: &str,
    query_char_len: u32,
    case_sensitive: bool,
    regex: Option<&regex::Regex>,
    local: &mut Vec<SearchMatch>,
    files_scanned: &AtomicUsize,
    files_skipped: &AtomicUsize,
    skipped_binary: &AtomicUsize,
    match_count: &AtomicUsize,
    truncated: &AtomicBool,
) {
    // 大小/元数据检查
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > MAX_FILE_SIZE {
            files_skipped.fetch_add(1, Ordering::Relaxed);
            return;
        }
    }
    // 前 8KB 探测二进制，避免把大二进制文件整个读进内存
    let content = match read_text_file(path) {
        Some(c) => c,
        None => {
            // 二进制/编码问题 → 跳过
            files_skipped.fetch_add(1, Ordering::Relaxed);
            skipped_binary.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };
    files_scanned.fetch_add(1, Ordering::Relaxed);
    // 路径字符串只构造一次，命中时复用
    let path_str = path.to_string_lossy().into_owned();
    // PR-H：正则模式——逐行 find_iter（非重叠），列/长按**字符**计（其它分支是字节偏移，
    // ASCII 下等价；正则可能匹配宽字符，字符计数才能和前端高亮切片对齐）
    if let Some(re) = regex {
        for (i, line) in content.lines().enumerate() {
            if truncated.load(Ordering::Relaxed) {
                return;
            }
            let line_no = (i + 1) as u32;
            for m in re.find_iter(line) {
                let col = line[..m.start()].chars().count();
                let len = m.as_str().chars().count() as u32;
                if !try_push_match(local, &path_str, line_no, line, col, len, match_count, truncated) {
                    return;
                }
            }
        }
        return;
    }
    // 纯 ASCII 关键词 + 不敏感 → 字节级匹配（无逐行分配）；否则退回 to_lowercase 保证 Unicode 正确
    let ascii_fast = !case_sensitive && needle.is_ascii();
    let needle_bytes = needle.as_bytes();
    for (i, line) in content.lines().enumerate() {
        if truncated.load(Ordering::Relaxed) {
            return;
        }
        let line_no = (i + 1) as u32;
        if ascii_fast {
            let hay = line.as_bytes();
            let mut start = 0usize;
            while let Some(col) = find_ascii_ignore_case(hay, needle_bytes, start) {
                if !try_push_match(local, &path_str, line_no, line, col, query_char_len, match_count, truncated) {
                    return;
                }
                start = col + needle_bytes.len();
            }
        } else if case_sensitive {
            let mut start = 0usize;
            while let Some(pos) = line[start..].find(needle) {
                let col = start + pos;
                if !try_push_match(local, &path_str, line_no, line, col, query_char_len, match_count, truncated) {
                    return;
                }
                start = col + needle.len();
            }
        } else {
            // 非 ASCII 不敏感：整行小写化（保持 Unicode 大小写折叠正确性）
            let lower = line.to_lowercase();
            let mut start = 0usize;
            while let Some(pos) = lower[start..].find(needle) {
                let col = start + pos;
                if !try_push_match(local, &path_str, line_no, line, col, query_char_len, match_count, truncated) {
                    return;
                }
                start = col + needle.len();
            }
        }
    }
}

// ---------- TODO 工具窗（PyCharm TODO tool window 对标） ----------

/// 识别的标记（顺序即「同一行多个命中时的优先级」）。
/// TODO/FIXME 大小写不敏感（PyCharm 默认模式）；XXX/HACK/BUG 要求全大写——
/// 小写形态（xxx / hack / bug）在自然语言与技术文本中过于常见，放宽会淹没结果。
const TODO_TAGS: [&str; 5] = ["TODO", "FIXME", "HACK", "BUG", "XXX"];

/// 需要全大写匹配的标记（见 TODO_TAGS 注释）
const TODO_TAGS_CASE_SENSITIVE: [&str; 3] = ["HACK", "BUG", "XXX"];

/// 结果上限（防超大仓库把序列化与前端渲染拖垮，与搜索同一思路）
const MAX_TODOS: usize = 2000;

#[derive(Serialize, Clone)]
pub struct TodoMatch {
    pub path: String,
    pub line: u32,
    /// 归一化后的标记（大写，如 "TODO"）
    pub tag: String,
    /// 标记之后的说明文字（去掉前导 `: -` 等分隔符）
    pub message: String,
    /// 整行原文（trim 后，供悬停/收起时查看上下文）
    pub text: String,
}

/// 工作区 TODO/FIXME 扫描：复用 search_workspace 的 `ignore` 走查（.gitignore 感知 +
/// 隐藏过滤 + 噪声目录剪枝），命中行按「文件 → 行号」排序。
#[tauri::command]
pub async fn scan_todos(root: String) -> Result<Vec<TodoMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_todos_impl(&root))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn scan_todos_impl(root: &str) -> Result<Vec<TodoMatch>, String> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("工作区目录不存在：{root}"));
    }
    let mut out: Vec<TodoMatch> = Vec::new();
    for path in collect_files(root_path) {
        if out.len() >= MAX_TODOS {
            break;
        }
        // 与搜索同一口径：超大 / 二进制 / 非 UTF-8 一律跳过（不计数、不报错）
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() > MAX_FILE_SIZE {
                continue;
            }
        }
        let Some(content) = read_text_file(&path) else { continue };
        let path_str = path.to_string_lossy().into_owned();
        for (i, raw) in content.lines().enumerate() {
            let Some((col, tag)) = find_todo_tag(raw) else { continue };
            let after = raw[col + tag.len()..].trim();
            let message = after
                .trim_start_matches(|c: char| c == ':' || c == '-' || c == '(' || c == '：')
                .trim()
                .to_string();
            out.push(TodoMatch {
                path: path_str.clone(),
                line: (i + 1) as u32,
                tag: tag.to_string(),
                message,
                text: raw.trim().to_string(),
            });
            if out.len() >= MAX_TODOS {
                break;
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    Ok(out)
}

/// 在行内定位最左侧的 TODO 标记，返回 (字节列, 标记)。含 ASCII 词边界判定——
/// `TODOS` / `myTODO` 之类不算命中（否则变量名里的子串会大量误报）。
fn find_todo_tag(line: &str) -> Option<(usize, &'static str)> {
    let bytes = line.as_bytes();
    let mut best: Option<(usize, &'static str)> = None;
    for tag in TODO_TAGS {
        let t = tag.as_bytes();
        let case_sensitive = TODO_TAGS_CASE_SENSITIVE.contains(&tag);
        let mut start = 0usize;
        while start + t.len() <= bytes.len() {
            let hit = if case_sensitive {
                &bytes[start..start + t.len()] == t
            } else {
                bytes[start..start + t.len()].eq_ignore_ascii_case(t)
            };
            if hit && todo_boundary_ok(bytes, start, t.len()) {
                if best.map_or(true, |(b, _)| start < b) {
                    best = Some((start, tag));
                }
                break;
            }
            start += 1;
        }
    }
    best
}

/// 词边界：前后均不得为字母/数字/下划线
fn todo_boundary_ok(bytes: &[u8], start: usize, len: usize) -> bool {
    let end = start + len;
    let before_ok = start == 0 || {
        let c = bytes[start - 1];
        !(c.is_ascii_alphanumeric() || c == b'_')
    };
    let after_ok = end >= bytes.len() || {
        let c = bytes[end];
        !(c.is_ascii_alphanumeric() || c == b'_')
    };
    before_ok && after_ok
}

// ---------- import 别名扫描（importAlias 补全的频率学习数据源） ----------
//
// 逐行扫描 .py 文件中的 `import X as Y` / `from X import A as B`，按 target 聚合
// 出现次数，供前端把工作区高频别名排在内置表之前。纪律同 scan_todos / scan_endpoints：
// 纯文本逐行解析、零子进程、零正则依赖；复用 collect_files 的 ignore 走查。

/// 结果上限（防超大仓库序列化拖垮）
const MAX_IMPORT_ALIASES: usize = 500;

/// 单条聚合结果：target = `X`（module 型）或 `X.A`（from-import 成员型）
#[derive(Serialize, Deserialize, Clone)]
pub struct ImportAliasHit {
    pub kind: String, // "module" | "member"
    pub target: String,
    pub alias: String,
    pub count: u32,
}

#[tauri::command]
pub async fn scan_import_aliases(root: String) -> Result<Vec<ImportAliasHit>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_import_aliases_impl(&root))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn scan_import_aliases_impl(root: &str) -> Result<Vec<ImportAliasHit>, String> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("工作区目录不存在：{root}"));
    }
    // 增量扫描（边界③）：上次每文件 (mtime,size) 签名 + 绑定缓存，签名一致则跳过
    // 该文件的读取与解析，只重建聚合。缓存损坏 / 版本不符 → 整体作废走全量
    // （首次扫描无缓存 = 全量，语义与旧实现一致）。
    let prev_cache: HashMap<String, AliasScanCacheFile> = crate::env_cmds::load_config(root)
        .get(ALIAS_SCAN_CACHE_KEY)
        .and_then(|x| serde_json::from_value::<AliasScanCache>(x.clone()).ok())
        .filter(|c| c.v == ALIAS_SCAN_CACHE_VERSION)
        .map(|c| c.files)
        .unwrap_or_default();
    // (kind, target, alias) → count；出口按 count 降序 + target/alias 升序稳定排序
    let mut counts: HashMap<(u8, String, String), u32> = HashMap::new();
    let mut next_cache: HashMap<String, AliasScanCacheFile> = HashMap::new();
    for path in collect_files(root_path) {
        if path.extension().map_or(true, |e| e != "py") {
            continue;
        }
        // 与搜索同一口径：超大 / 二进制 / 非 UTF-8 一律跳过（不计数、不报错）
        let sig = fs::metadata(&path).ok().and_then(|m| alias_file_signature(&m));
        if let Some((_, _, size)) = sig {
            if size > MAX_FILE_SIZE {
                continue;
            }
        }
        // 缓存键用相对路径（工作区移动 / 换盘符后仍命中）；统一 `/` 分隔
        let rel = path
            .strip_prefix(root_path)
            .unwrap_or(path.as_path())
            .to_string_lossy()
            .replace('\\', "/");
        let cached = sig.as_ref().and_then(|s| {
            prev_cache
                .get(&rel)
                .filter(|c| (c.mtime_secs, c.mtime_nanos, c.size) == *s)
        });
        let bindings = match cached {
            // 未变：跳过读取与解析（登记粒度：同 mtime 刻度内等长改写不感知，标准
            // mtime 缓存取舍，编辑器落盘必更新 mtime，实际不可达）
            Some(c) => c.bindings.clone(),
            None => {
                let Some(content) = read_text_file(&path) else { continue };
                parse_import_alias_content(&content)
            }
        };
        for b in &bindings {
            *counts.entry(b.clone()).or_insert(0) += 1;
        }
        if let Some((secs, nanos, size)) = sig {
            next_cache.insert(
                rel,
                AliasScanCacheFile {
                    mtime_secs: secs,
                    mtime_nanos: nanos,
                    size,
                    bindings,
                },
            );
        }
    }
    let mut out: Vec<ImportAliasHit> = counts
        .into_iter()
        .map(|((kind, target, alias), count)| ImportAliasHit {
            kind: if kind == 0 { "module" } else { "member" }.to_string(),
            target,
            alias,
            count,
        })
        .collect();
    out.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| a.target.cmp(&b.target))
            .then_with(|| a.alias.cmp(&b.alias))
    });
    out.truncate(MAX_IMPORT_ALIASES);
    // 学习结果 + 增量缓存基线同一次落盘（工作区 config 两个键）；落盘失败不吞
    // 扫描结果——补全数据比缓存更重要（best-effort，同 sweep 口径）
    let cache = AliasScanCache {
        v: ALIAS_SCAN_CACHE_VERSION,
        files: next_cache,
    };
    let _ = save_import_aliases(root, &out, &serde_json::to_value(&cache).unwrap_or(Value::Null));
    Ok(out)
}

/// 增量扫描缓存条目：文件签名（mtime + size）+ 该文件解析出的绑定
#[derive(serde::Serialize, serde::Deserialize)]
struct AliasScanCacheFile {
    mtime_secs: u64,
    mtime_nanos: u32,
    size: u64,
    bindings: Vec<(u8, String, String)>,
}

/// 增量扫描缓存整体（工作区 config `import_aliases_scan_cache` 键）；
/// v = 结构/解析器版本，不符即整体作废
#[derive(serde::Serialize, serde::Deserialize)]
struct AliasScanCache {
    v: u32,
    files: HashMap<String, AliasScanCacheFile>,
}

const ALIAS_SCAN_CACHE_KEY: &str = "import_aliases_scan_cache";
/// 解析器或缓存结构变更时递增，使旧缓存整体失效走全量
const ALIAS_SCAN_CACHE_VERSION: u32 = 1;

/// 文件未变判定三元组 (mtime_secs, mtime_nanos, size)
fn alias_file_signature(meta: &fs::Metadata) -> Option<(u64, u32, u64)> {
    let d = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some((d.as_secs(), d.subsec_nanos(), meta.len()))
}

/// 工作区配置存储键（env_cmds 工作区 config，与 framework_hints / dep_ignored 同文件同口径）
const IMPORT_ALIASES_KEY: &str = "import_aliases";

/// 学习别名 + 增量扫描缓存落盘（同一次 load/save 写两个键）；空清单移除别名键
/// 保持配置精简（同 dep_ignored 先例），缓存始终覆盖写（作为下次扫描的增量基线）
fn save_import_aliases(root: &str, hits: &[ImportAliasHit], scan_cache: &Value) -> Result<(), String> {
    let mut v = crate::env_cmds::load_config(root);
    let obj = v.as_object_mut().ok_or("工作区配置格式非法")?;
    if hits.is_empty() {
        obj.remove(IMPORT_ALIASES_KEY);
    } else {
        obj.insert(
            IMPORT_ALIASES_KEY.into(),
            serde_json::to_value(hits).map_err(|e| e.to_string())?,
        );
    }
    obj.insert(ALIAS_SCAN_CACHE_KEY.into(), scan_cache.clone());
    crate::env_cmds::save_config(root, &v)
}

/// 从工作区配置读缓存（字段缺失 / 类型错误 / 条目损坏 → None，绝不 panic，同 load_config 口径）
fn import_aliases_from_config(v: &Value) -> Option<Vec<ImportAliasHit>> {
    v.get(IMPORT_ALIASES_KEY)
        .and_then(|x| serde_json::from_value::<Vec<ImportAliasHit>>(x.clone()).ok())
}

/// 读学习别名缓存（前端打开工作区先展示缓存，后台重扫刷新；同步纯 fs，零子进程）
#[tauri::command]
pub fn read_import_aliases(root: String) -> Option<Vec<ImportAliasHit>> {
    import_aliases_from_config(&crate::env_cmds::load_config(&root))
}

/// 解析 import 语句文本中的别名绑定，kind 0 = module（`import X as Y`）、1 = member
/// （`from X import A as Y`）。仅认稳定语法：多目标逗号分隔、from 后圆括号（含跨行
/// 续行）、行尾 `#` 注释截断（模块名不可能含引号/#，朴素截断安全）、分号多语句
/// （每段独立成语句；续行中首个 `;` 结束续行）。字符串字面量内的分号不识别（朴素口径）。
fn parse_import_alias_content(content: &str) -> Vec<(u8, String, String)> {
    let mut out = Vec::new();
    // Some(module) = from-import 续行进行中（上一段以 ',' 或 '(' 结尾）
    let mut pending_from: Option<String> = None;
    for raw in content.lines() {
        let trimmed = raw.trim();
        // 行尾注释截断（'#' 前有空白才算，防 base 编码类误截；模块名后必有空白才跟注释）
        let trimmed = match trimmed.find(" #") {
            Some(pos) => trimmed[..pos].trim_end(),
            None => trimmed,
        };
        if trimmed.is_empty() {
            continue;
        }
        let mut segments = trimmed.split(';');
        if let Some(module) = pending_from.take() {
            // 续行段：首个分号前的部分仍是成员段，之后的是新语句
            let first = segments.next().unwrap_or("");
            pending_from = parse_from_members(first, &module, &mut out).then(|| module.clone());
        }
        for stmt in segments {
            let stmt = stmt.trim();
            if stmt.is_empty() {
                continue;
            }
            if let Some(rest) = stmt.strip_prefix("import ") {
                parse_import_targets(rest, &mut out);
            } else if let Some(rest) = stmt.strip_prefix("from ") {
                if let Some(module) = parse_from_stmt(rest, &mut out) {
                    pending_from = Some(module); // 同行多条 from 语句取最后一条的续行态
                }
            }
        }
    }
    out
}

/// `import X as Y, Z` → 逗号分段逐段认领（无续行语义）
fn parse_import_targets(rest: &str, out: &mut Vec<(u8, String, String)>) {
    for seg in rest.split(',') {
        let t: Vec<&str> = seg.split_whitespace().collect();
        if t.len() == 3 && t[1] == "as" && is_dotted_ident(t[0]) && is_ident(t[2]) {
            out.push((0u8, t[0].to_string(), t[2].to_string()));
        }
    }
}

/// `from X import <members>` → 成员别名绑定；返回 Some(module) 表示 members 以
/// ',' 或 '(' 结尾（跨行续行开启）。模块名非法返回 None 且不产生绑定。
fn parse_from_stmt(rest: &str, out: &mut Vec<(u8, String, String)>) -> Option<String> {
    let pos = rest.find(" import ")?;
    let module = rest[..pos].trim();
    if !is_dotted_ident(module) {
        return None;
    }
    let members = rest[pos + " import ".len()..].trim_start();
    parse_from_members(members, module, out).then(|| module.to_string())
}

/// 成员段（可能是跨行续行）解析：逐逗号分段，段首 '(' / 段尾 ')' 剥除（括号容错，
/// 含 `(A as B, C as D)` 尾段 ')' 粘连形态——旧实现该形态尾段会被 is_ident 拒绝）；
/// 只认领 `A as B` 形态（成员无别名不学）。返回是否续行（原始 members 以 ','/'(' 结尾）。
fn parse_from_members(members: &str, module: &str, out: &mut Vec<(u8, String, String)>) -> bool {
    let cont = members.ends_with(',') || members.ends_with('(');
    for seg in members.split(',') {
        let seg = seg.trim().trim_start_matches('(').trim_end_matches(')');
        if seg.is_empty() {
            continue;
        }
        let t: Vec<&str> = seg.split_whitespace().collect();
        if t.len() == 3 && t[1] == "as" && is_dotted_ident(t[0]) && is_ident(t[2]) {
            out.push((1u8, format!("{module}.{}", t[0]), t[2].to_string()));
        }
    }
    cont
}

/// 点分标识符：非空且每个 `.` 段均为合法标识符（含 Unicode 字母，走 char 判定）
fn is_dotted_ident(s: &str) -> bool {
    !s.is_empty() && s.split('.').all(is_ident)
}

/// 单段标识符：字母/下划线开头，后续字母/数字/下划线（ASCII 口径足够——
/// 目标是过滤注释/字符串/运算符误入，不是完整 lexgate）
fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

// ---------- 端点扫描（F1：FastAPI / Flask 静态路由，docs/pycharm_framework_support_report.md §8.3） ----------
//
// 对标 PyCharm Endpoints 工具窗口的**静态可见**部分（不做 HTTP Client / OpenAPI 引擎）。
// 设计纪律（同框架探针表）：
// - **纯文本逐行正则级解析、零子进程**，复用 collect_files 的 ignore 走查（限深限数）；
// - 只认**稳定的公开约定**：`@obj.<method>("path")` / `@obj.route(..., methods=[...])` /
//   `<obj> = APIRouter(prefix=...)` / `<obj> = Blueprint(..., url_prefix=...)` /
//   `x.include_router(obj, prefix=...)` / `x.register_blueprint(obj, url_prefix=...)`，
//   不解析框架源码结构、不做跨文件类型推断；
// - 前缀合并按**对象名**全局匹配（router 声明处 + include 处各取一段），支持一层
//   include_router / register_blueprint；多级嵌套与多行装饰器（path 换行）是已知边界；
// - 结果上限 MAX_ENDPOINTS（同 scan_todos 思路）。

/// 结果上限（防超大仓库把序列化与前端渲染拖垮）
const MAX_ENDPOINTS: usize = 2000;

/// FastAPI 风格路由装饰器（方法名小写）；api_route 的方法取行内 methods=[...]，默认 GET
const FASTAPI_ROUTE_DECORATORS: [&str; 10] = [
    "get", "post", "put", "patch", "delete", "options", "head", "trace", "websocket", "api_route",
];

#[derive(Serialize, Clone, PartialEq)]
pub struct EndpointInfo {
    /// "fastapi" | "flask" | "unknown"（按路由对象的声明类判定；未识别对象只知方法）
    pub framework: String,
    /// HTTP 方法（大写；多方法用 "/" 连接；websocket = "WS"）
    pub method: String,
    /// 合并后的完整路由（include 前缀 + router 前缀 + 声明路径，斜杠归一）
    pub route: String,
    /// 声明文件（**绝对路径**、正斜杠——openFile → read_file 只认绝对路径，
    /// 对齐 scan_todos 的路径契约；相对路径会导致「打开文件失败：找不到路径」）
    pub file: String,
    /// 声明行号（1 起）
    pub line: u32,
    /// 处理函数名（装饰器之后首个 def；装饰器与 def 间被其他语句隔开时为空）
    pub handler: String,
}

/// 是否为合法 Python 标识符（防止 `@app.get(path="/x")` 被 `=` 切开后误判为赋值声明）
fn ep_is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 行内第一个字符串字面量（单双引号均可；不支持转义——路由字面量一般不含引号）
fn ep_first_string_literal(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'"' || b == b'\'' {
            let rest = &line[i + 1..];
            let end = rest.find(b as char)?;
            return Some(rest[..end].to_string());
        }
    }
    None
}

/// 取行内 `key="..."` 形式的关键字参数值；`before` 检查保证 key 不
/// 是更长标识符的尾部（找 "prefix=" 不得命中 "url_prefix="）。
fn ep_kwarg_string(line: &str, key: &str) -> Option<String> {
    let pat = format!("{key}=");
    let bytes = line.as_bytes();
    let mut from = 0usize;
    while let Some(pos) = line[from..].find(&pat) {
        let at = from + pos;
        let before_ok = at == 0 || !(bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_');
        if before_ok {
            let after = line[at + pat.len()..].trim_start();
            if after.starts_with('"') || after.starts_with('\'') {
                return ep_first_string_literal(after);
            }
        }
        from = at + pat.len();
    }
    None
}

/// 装饰器行 `@obj.method("path"...)` → (obj, 展示方法, 路径字面量)。
/// 方法展示在**装饰器行**上完成（methods=[...] 只在装饰器行上，def 行拿不到）；
/// 只认 FASTAPI_ROUTE_DECORATORS 与 "route"（Flask）；其余装饰器返回 None（不截断 pending）。
fn ep_parse_route_decorator(line: &str) -> Option<(String, String, String)> {
    let rest = line.trim().strip_prefix('@')?;
    let (obj, method_part) = rest.split_once('.')?;
    let obj = obj.trim();
    let method = method_part.split('(').next()?.trim();
    if obj.is_empty() || method.is_empty() {
        return None;
    }
    let known = method == "route" || FASTAPI_ROUTE_DECORATORS.contains(&method);
    if !known {
        return None;
    }
    let path = ep_first_string_literal(line).unwrap_or_default();
    Some((obj.to_string(), ep_display_method(method, line), path))
}

/// 对象声明行 `<name> = APIRouter(...)` / `<name> = Blueprint(...)` / `<name> = Flask(...)`
/// / `<name> = FastAPI(...)` → (对象名, 框架 "fastapi"|"flask", 前缀)
fn ep_parse_router_decl(line: &str) -> Option<(String, &'static str, String)> {
    let t = line.trim();
    if t.starts_with('#') {
        return None;
    }
    let (lhs, rhs) = t.split_once('=')?;
    let name = lhs.trim();
    if !ep_is_ident(name) {
        return None;
    }
    let rhs_trim = rhs.trim_start();
    let (framework, prefix_key) = if rhs_trim.starts_with("APIRouter") {
        ("fastapi", "prefix")
    } else if rhs_trim.starts_with("Blueprint") {
        ("flask", "url_prefix")
    } else if rhs_trim.starts_with("Flask") {
        ("flask", "")
    } else if rhs_trim.starts_with("FastAPI") {
        ("fastapi", "")
    } else {
        return None;
    };
    let prefix = if prefix_key.is_empty() {
        String::new()
    } else {
        ep_kwarg_string(t, prefix_key).unwrap_or_default()
    };
    Some((name.to_string(), framework, prefix))
}

/// include 行 `x.include_router(<name>, prefix="...")` / `x.register_blueprint(<name>, url_prefix="...")`
/// → (路由对象名, 合并前缀；缺省为空串)
fn ep_parse_include(line: &str) -> Option<(String, String)> {
    let t = line.trim();
    if t.starts_with('#') {
        return None;
    }
    let (key, kw) = if t.contains(".include_router(") {
        ("include_router(", "prefix")
    } else if t.contains(".register_blueprint(") {
        ("register_blueprint(", "url_prefix")
    } else {
        return None;
    };
    let at = t.find(key)? + key.len();
    let name: String = t[at..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    if name.is_empty() {
        return None;
    }
    let prefix = ep_kwarg_string(t, kw).unwrap_or_default();
    Some((name, prefix))
}

/// def 行（含 async def）→ 函数名
fn ep_parse_def_name(line: &str) -> Option<String> {
    let t = line.trim();
    let rest = t.strip_prefix("async def ").or_else(|| t.strip_prefix("def "))?;
    let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    if name.is_empty() { None } else { Some(name) }
}

/// 方法名 → 展示方法（大写；websocket → WS；route/api_route 取行内 methods=[...]，缺省 GET）
fn ep_display_method(method: &str, line: &str) -> String {
    match method {
        "websocket" => "WS".to_string(),
        "api_route" | "route" => {
            let inner = line.find("methods").and_then(|a| {
                let seg = &line[a..];
                let lb = seg.find('[')?;
                let rb = seg.find(']')?;
                if rb > lb { Some(&seg[lb + 1..rb]) } else { None }
            });
            let ms: Vec<String> = inner
                .unwrap_or("")
                .split(',')
                .map(|p| p.trim().trim_matches(|c| c == '"' || c == '\'').trim())
                .filter(|p| !p.is_empty())
                .map(|p| p.to_ascii_uppercase())
                .collect();
            if ms.is_empty() { "GET".to_string() } else { ms.join("/") }
        }
        other => other.to_ascii_uppercase(),
    }
}

/// 路由段合并：两端斜杠归一 + 空段跳过；全空 → "/"
fn ep_join_route(parts: &[&str]) -> String {
    let segs: Vec<&str> = parts
        .iter()
        .map(|p| p.trim().trim_matches('/'))
        .filter(|p| !p.is_empty())
        .collect();
    if segs.is_empty() { "/".to_string() } else { format!("/{}", segs.join("/")) }
}

/// 工作区端点扫描：按「文件 → 行号」排序（前端再按方法分组展示）
#[tauri::command]
pub async fn scan_endpoints(root: String) -> Result<Vec<EndpointInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_endpoints_impl(&root))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn scan_endpoints_impl(root: &str) -> Result<Vec<EndpointInfo>, String> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("工作区目录不存在：{root}"));
    }
    let mut router_prefix: HashMap<String, String> = HashMap::new();
    let mut include_prefix: HashMap<String, String> = HashMap::new();
    let mut framework_of: HashMap<String, String> = HashMap::new();
    // 第一遍的中间产物：(对象名, 展示方法, 声明路径, 文件, 行号, 处理函数)
    // —— include 行常写在装饰器之后，前缀合并必须**等全部文件扫完**再统一做（单遍会漏）
    let mut raw_endpoints: Vec<(String, String, String, String, u32, String)> = Vec::new();

    for path in collect_files(root_path) {
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() > MAX_FILE_SIZE {
                continue;
            }
        }
        let Some(content) = read_text_file(&path) else { continue };
        // 声明文件用绝对路径（对齐 scan_todos）：openFile → read_file 直接 fs 读，
        // 相对路径相对进程 cwd 几乎必失败（E-BASIC 端点真机复现：os error 3）
        let file_abs = path.to_string_lossy().replace('\\', "/");
        // 待配对的装饰器 (obj, 展示方法, 路径)：命中后续 def 行时成对产出
        let mut pending: Option<(String, String, String)> = None;
        for (i, raw) in content.lines().enumerate() {
            let t = raw.trim();
            if t.is_empty() || t.starts_with('#') {
                continue; // 注释/空行不打断 pending（装饰器与 def 之间允许有注释）
            }
            // 1) 对象声明（APIRouter / Blueprint / Flask / FastAPI）
            if let Some((name, framework, prefix)) = ep_parse_router_decl(raw) {
                framework_of.insert(name.clone(), framework.to_string());
                if !prefix.is_empty() {
                    router_prefix.insert(name, prefix);
                }
                pending = None; // 声明插入会打断「装饰器 → def」配对
                continue;
            }
            // 2) include（合并前缀）
            if let Some((name, prefix)) = ep_parse_include(raw) {
                include_prefix.insert(name, prefix);
                continue;
            }
            // 3) def：与 pending 装饰器配对产出端点
            if let Some(handler) = ep_parse_def_name(t) {
                if let Some((obj, method, route_path)) = pending.take() {
                    raw_endpoints.push((obj, method, route_path, file_abs.clone(), (i + 1) as u32, handler));
                }
                continue;
            }
            // 4) 装饰器：可识别的路由装饰器更新 pending；不可识别的装饰器保留 pending（堆叠装饰器）
            if t.starts_with('@') {
                if let Some((obj, method, route_path)) = ep_parse_route_decorator(raw) {
                    pending = Some((obj, method, route_path));
                }
            }
        }
    }

    // 第二遍（纯内存）：include 已收齐，统一做前缀合并
    let mut out: Vec<EndpointInfo> = Vec::new();
    for (obj, method, route_path, file, line, handler) in raw_endpoints {
        if out.len() >= MAX_ENDPOINTS {
            break;
        }
        let framework = framework_of.get(&obj).cloned().unwrap_or_else(|| "unknown".into());
        let inc = include_prefix.get(&obj).cloned().unwrap_or_default();
        let pre = router_prefix.get(&obj).cloned().unwrap_or_default();
        out.push(EndpointInfo {
            framework,
            method,
            route: ep_join_route(&[&inc, &pre, &route_path]),
            file,
            line,
            handler,
        });
    }
    out.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
    Ok(out)
}

// ---------- Pydantic 构造校验与改名传播（阶段 4：诊断第四桶 + rename 补充） ----------
//
// docs/pyrefly_pydantic_support_plan.md §3.4：pyrefly 缺 Pydantic 构造校验与字段改名传播
// （F0 实测 references=0，rename 只改声明处），这里用轻量文本解析补齐，纪律与 scan_endpoints
// 完全一致：纯文本逐行解析、零子进程、零正则依赖、拉取式（前端显式 invoke）、无守护无索引
// ——架构裁决 §3.4.0 四条全部满足（≤500 行、无守护、无持久索引、被动响应）。
//
// 判定语义（v2 红线，全部「识别到即跳过」——宁可漏报不误报）：
// - alias 字段（Field(alias=...)）跳过校验（basedpyright 都在此误报）；
// - Optional[...] 无默认值在 Pydantic v2 是必填——按 v2 语义处理（不做 v1 兼容）；
// - `**kwargs` 展开传参的调用点整行跳过；位置参数传字段（User(1, "a")）跳过；
// - 跨文件继承链不合并（模型解析按单文件）；
// - 类型检查只做字面量名义等价（"str" vs int / 1 vs str）；复杂表达式静默跳过。

/// 解析出的 Pydantic 字段（单文件内）
#[derive(Debug, Clone, PartialEq)]
struct PydField {
    name: String,
    /// 类型标注文本（如 "int" / "Optional[str]"）；用于字面量名义比对
    type_text: Option<String>,
    /// 是否必填（无默认值）
    required: bool,
    /// Field(alias="...") 的别名（构造处可用别名传参）；has_alias 时校验按别名放行
    alias: Option<String>,
}

/// 解析出的 Pydantic 模型（BaseModel 子类，含同文件继承合并后的字段）
#[derive(Debug, Clone)]
struct PydModel {
    name: String,
    /// 类声明所在文件绝对路径（正斜杠）
    file: String,
    /// 合并后字段（继承在前、自有覆盖在后）
    fields: Vec<PydField>,
}

/// 单文件类解析中间结构（尚未判定是否 Pydantic 模型、未合并继承）
#[derive(Debug, Clone)]
struct PydClassInfo {
    name: String,
    /// 基类名列表（去空白；模块限定名取尾段）
    bases: Vec<String>,
    /// 本类自有字段
    fields: Vec<PydField>,
}

/// 行首缩进宽度（空格数；Tab 计 1——仅作类体边界比较，不追求精确列）
fn pyd_indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// 剥离行内注释：首个**引号外** `#` 起截断（引号状态机，与 find_call_head 同款语义）。
/// 返回前缀切片（字节偏移不变，调用方的列号计算不受影响）。
fn pyd_strip_comment(line: &str) -> &str {
    let mut quote: Option<u8> = None;
    for (i, &b) in line.as_bytes().iter().enumerate() {
        match quote {
            None => {
                if b == b'"' || b == b'\'' {
                    quote = Some(b);
                } else if b == b'#' {
                    return &line[..i];
                }
            }
            Some(q) if b == q => quote = None,
            _ => {}
        }
    }
    line
}

/// 字节偏移 → 字符索引（列号必须按字符算：中文值字面量会让字节列错位，
/// 错位列号在 rename 编辑里会写坏代码——2026-09-29 复核修复）
fn byte_to_char_idx(line: &str, byte_idx: usize) -> usize {
    line[..byte_idx].chars().count()
}

/// `class X(BaseModel):` / `class X(User):` → 类名与基类列表文本；非类声明行返回 None。
/// 行内注释先剥离（`class A(BaseModel):  # 说明` 的注释文本不进基类列表）。
fn pyd_parse_class_decl(line: &str) -> Option<(String, String)> {
    let t = pyd_strip_comment(line).trim_start();
    if t.starts_with('#') {
        return None;
    }
    let rest = t.strip_prefix("class ")?;
    let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    if name.is_empty() {
        return None;
    }
    let after = rest[name.len()..].trim_start();
    let paren = after.strip_prefix('(')?;
    let close = paren.rfind(')')?;
    Some((name, paren[..close].trim().to_string()))
}

/// 字段声明行 `name: type` / `name: type = default` / `name: type = Field(...)`
/// → PydField。非字段行返回 None：方法 / 嵌套类 / 装饰器 / `model_config =` 赋值
/// （Pydantic 类配置不是字段）/ `ClassVar[...]` 注解（v2 语义：非构造字段）。
fn pyd_parse_field(line: &str) -> Option<PydField> {
    let t = pyd_strip_comment(line).trim_start();
    if t.starts_with('#') || t.is_empty() {
        return None;
    }
    if t.starts_with("def ") || t.starts_with("async def ") || t.starts_with("class ") || t.starts_with('@') {
        return None;
    }
    let Some(colon) = t.find(':') else { return None };
    let name = t[..colon].trim();
    if name.is_empty() || !name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') {
        return None;
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    let after = t[colon + 1..].trim_start();
    if after.is_empty() {
        return None;
    }
    if after.starts_with("ClassVar") {
        return None; // v2：ClassVar 不是构造字段
    }
    if name == "model_config" {
        return None; // Pydantic 类配置（ConfigDict 赋值），不是构造字段
    }
    // 类型文本截到 `=` 或行尾：类型标注不含裸 `=`（嵌套 [] 内也无），split_once 安全
    let (type_part, default_part) = match after.split_once('=') {
        Some((ty, d)) => (ty.trim(), Some(d.trim())),
        None => (after.trim_end(), None),
    };
    if type_part.is_empty() {
        return None;
    }
    // Field(alias="...") 提取别名（单双引号均可；不含引号的复杂 alias 表达式不认）
    let alias = default_part.and_then(|d| {
        if !d.starts_with("Field") {
            return None;
        }
        let v = d.find("alias")?;
        let seg = &d[v..];
        let eq = seg.find('=')? + 1;
        let after = seg[eq..].trim_start();
        let q = after.chars().next()?;
        if q != '"' && q != '\'' {
            return None;
        }
        let rest = &after[1..];
        let end = rest.find(q)?;
        Some(rest[..end].to_string())
    });
    Some(PydField {
        name: name.to_string(),
        type_text: Some(type_part.to_string()),
        required: default_part.is_none(),
        alias,
    })
}

/// 单文件解析：收集全部类声明与各自类体字段（类体 = 声明行之后缩进更深的行，
/// 遇到缩进 ≤ 类行缩进的非空行即结束）。
fn pyd_parse_file(content: &str) -> Vec<PydClassInfo> {
    let lines: Vec<&str> = content.lines().collect();
    let mut classes: Vec<PydClassInfo> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        if let Some((name, bases)) = pyd_parse_class_decl(lines[i]) {
            let class_indent = pyd_indent_of(lines[i]);
            let mut fields: Vec<PydField> = Vec::new();
            let mut j = i + 1;
            while j < lines.len() {
                let l = lines[j];
                let t = l.trim();
                if t.is_empty() || t.starts_with('#') {
                    j += 1;
                    continue;
                }
                if pyd_indent_of(l) <= class_indent {
                    break;
                }
                if let Some(f) = pyd_parse_field(l) {
                    fields.push(f);
                }
                j += 1;
            }
            classes.push(PydClassInfo {
                name,
                bases: bases
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
                fields,
            });
            i = j;
        } else {
            i += 1;
        }
    }
    classes
}

/// 类是否为 Pydantic 模型：基类链（同文件）含 BaseModel（或 pydantic.BaseModel）。
/// memo 防环（文本层面的循环继承）；未知基类（跨文件 / 外部库）不认。
fn pyd_class_is_model(name: &str, classes: &[PydClassInfo], memo: &mut HashMap<String, bool>) -> bool {
    if let Some(&v) = memo.get(name) {
        return v;
    }
    memo.insert(name.to_string(), false); // 防环：计算中再入直接 false
    let v = classes
        .iter()
        .find(|c| c.name == name)
        .map_or(false, |cls| {
            cls.bases.iter().any(|b| {
                let base = b.rsplit('.').next().unwrap_or(b);
                base == "BaseModel" || pyd_class_is_model(base, classes, memo)
            })
        });
    memo.insert(name.to_string(), v);
    v
}

/// 继承合并：父类字段在前、自有覆盖在后（同名去重）；depth 防文本循环继承。
fn pyd_resolve_fields(cls: &PydClassInfo, classes: &[PydClassInfo], depth: usize) -> Vec<PydField> {
    let mut fields: Vec<PydField> = Vec::new();
    if depth < 10 {
        for b in &cls.bases {
            let base = b.rsplit('.').next().unwrap_or(b);
            if let Some(parent) = classes.iter().find(|c| c.name == base) {
                for f in pyd_resolve_fields(parent, classes, depth + 1) {
                    if !fields.iter().any(|x| x.name == f.name) {
                        fields.push(f);
                    }
                }
            }
        }
    }
    for f in &cls.fields {
        fields.retain(|x| x.name != f.name);
        fields.push(f.clone());
    }
    fields
}

/// 工作区扫描收集全部 Pydantic 模型（单文件解析 + 同文件继承合并；跨文件继承不合并）
fn pyd_collect_models(root: &Path) -> Vec<PydModel> {
    let mut out: Vec<PydModel> = Vec::new();
    for path in collect_files(root) {
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() > MAX_FILE_SIZE {
                continue;
            }
        }
        let Some(content) = read_text_file(&path) else { continue };
        let file_abs = path.to_string_lossy().replace('\\', "/");
        let classes = pyd_parse_file(&content);
        let mut memo: HashMap<String, bool> = HashMap::new();
        for cls in &classes {
            if pyd_class_is_model(&cls.name, &classes, &mut memo) {
                out.push(PydModel {
                    name: cls.name.clone(),
                    file: file_abs.clone(),
                    fields: pyd_resolve_fields(cls, &classes, 0),
                });
            }
        }
    }
    out
}

/// 字面量名义类型："..."→str、整数→int、True/False→bool、浮点→float；
/// 复杂表达式返回 None（跳过类型检查）
fn pyd_literal_type(text: &str) -> Option<&'static str> {
    let t = text.trim();
    if (t.starts_with('"') && t.ends_with('"') && t.len() >= 2)
        || (t.starts_with('\'') && t.ends_with('\'') && t.len() >= 2)
    {
        return Some("str");
    }
    if t == "True" || t == "False" {
        return Some("bool");
    }
    if t.parse::<i64>().is_ok() {
        return Some("int");
    }
    if t.parse::<f64>().is_ok() {
        return Some("float");
    }
    None
}

/// 注解文本 → 名义类型名（仅 int / str / bool / float；Optional[X] 剥壳后同判；其余 None）
fn pyd_annot_type(text: &str) -> Option<String> {
    let t = text.trim();
    let inner = t.strip_prefix("Optional[").and_then(|r| r.strip_suffix(']'));
    let base = inner.unwrap_or(t);
    match base {
        "int" | "str" | "bool" | "float" => Some(base.to_string()),
        _ => None,
    }
}

/// 构造调用诊断（owner = pylume-pydantic，前端第四桶）
#[derive(Serialize, Clone, Debug)]
pub struct PydanticIssue {
    /// 诊断所在文件（绝对路径正斜杠）
    pub file: String,
    /// 1 基行号
    pub line: u32,
    /// 1 基列号（参数名起始列）
    pub column: u32,
    pub end_column: u32,
    /// "missing" | "unknown" | "type"
    pub kind: String,
    pub message: String,
    /// 涉及字段名
    pub field: String,
    /// 所属模型名
    pub model: String,
}

/// 工作区 Pydantic 构造校验扫描：模型收集 + `X(...)` 调用点逐行校验。
#[tauri::command]
pub async fn scan_pydantic_issues(root: String) -> Result<Vec<PydanticIssue>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_pydantic_issues_impl(&root))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn scan_pydantic_issues_impl(root: &str) -> Result<Vec<PydanticIssue>, String> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("工作区目录不存在：{root}"));
    }
    let models = pyd_collect_models(root_path);
    if models.is_empty() {
        return Ok(Vec::new());
    }
    let mut out: Vec<PydanticIssue> = Vec::new();
    for path in collect_files(root_path) {
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() > MAX_FILE_SIZE {
                continue;
            }
        }
        let Some(content) = read_text_file(&path) else { continue };
        let file_abs = path.to_string_lossy().replace('\\', "/");
        for (i, raw) in content.lines().enumerate() {
            let line = pyd_strip_comment(raw); // 注释里的 `User(name=)` 不参与诊断（2026-09-29 修复）
            let lineno = (i + 1) as u32;
            // **kwargs 展开传参：该行所有调用点跳过（v2 红线）
            if line.contains("**") {
                continue;
            }
            for m in &models {
                let Some(at) = find_call_head(line, &m.name) else { continue };
                scan_pydantic_call_args(line, lineno, &file_abs, at, m, &mut out);
            }
        }
    }
    out.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
    Ok(out)
}

/// 行内 `Model(` 调用头位置：Model 名前后非标识符字符、后紧跟 `(`、
/// 前文不是 `def ` / `class `（`def Model(` 不算调用）、且不在字符串字面量内
/// （`e = "User(name=1)"` 不算）。简易引号状态机：行内未闭合引号后的内容全部跳过。
fn find_call_head(line: &str, name: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut from = 0usize;
    while let Some(pos) = line[from..].find(name) {
        let at = from + pos;
        let after = at + name.len();
        let ok_before = at == 0 || !(bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_');
        let ok_after = bytes.get(after).copied() == Some(b'(');
        let head = line[..at].trim_end();
        let not_def = !head.ends_with("def ") && !head.ends_with("class ");
        let in_string = count_unpaired_quote(line, at) > 0;
        if ok_before && ok_after && not_def && !in_string {
            return Some(at);
        }
        from = at + name.len();
    }
    None
}

/// line[..at] 内未配对引号数（>0 = at 处于字符串字面量内；简易状态机，不处理转义嵌套）
fn count_unpaired_quote(line: &str, upto: usize) -> usize {
    let mut quote: Option<u8> = None;
    let mut n = 0usize;
    for &b in &line.as_bytes()[..upto] {
        match quote {
            None => {
                if b == b'"' || b == b'\'' {
                    quote = Some(b);
                    n += 1;
                }
            }
            Some(q) if b == q => {
                quote = None;
                n -= 1;
            }
            _ => {}
        }
    }
    n
}

/// 单行调用点参数校验：kwargs 提取 → unknown / type；必填缺失另查。
/// 没识别出任何 kwargs（位置参数 / 跨行调用）时整个调用点跳过（v2 红线）。
fn scan_pydantic_call_args(
    line: &str,
    lineno: u32,
    file: &str,
    at: usize,
    model: &PydModel,
    out: &mut Vec<PydanticIssue>,
) {
    let args = extract_call_kwargs(line, at);
    if args.is_empty() {
        let inner = line[at + model.name.len() + 1..].trim_start();
        // 空参数 `User()` 也要判缺失必填；其余（位置参数 / 跨行）跳过
        if !inner.starts_with(')') {
            return;
        }
    }
    for (k, v, col) in &args {
        // 字段本体或其 alias 均合法（populate_by_name 语义：双合法）
        let Some(field) = model
            .fields
            .iter()
            .find(|f| f.name == *k || f.alias.as_deref() == Some(k.as_str()))
        else {
            out.push(PydanticIssue {
                file: file.to_string(),
                line: lineno,
                column: *col,
                end_column: col + k.len() as u32,
                kind: "unknown".into(),
                message: format!("Pydantic：模型 {} 没有字段 {}（构造参数未知）", model.name, k),
                field: k.clone(),
                model: model.name.clone(),
            });
            continue;
        };
        // alias 字段的类型检查跳过（basedpyright 都在此误报；本名与别名混传形态太复杂）
        if field.alias.is_some() {
            continue;
        }
        if let (Some(ann), Some(lit)) = (
            field.type_text.as_deref().and_then(pyd_annot_type),
            pyd_literal_type(v),
        ) {
            if ann != lit {
                out.push(PydanticIssue {
                    file: file.to_string(),
                    line: lineno,
                    column: *col,
                    end_column: col + k.len() as u32,
                    kind: "type".into(),
                    message: format!(
                        "Pydantic：字段 {} 期望 {}，传入 {}",
                        k,
                        field.type_text.as_deref().unwrap_or("?"),
                        v
                    ),
                    field: k.clone(),
                    model: model.name.clone(),
                });
            }
        }
    }
    // 缺失必填：只对「全部 kwargs 形态 / 空参数」的调用点判；
    // 有 alias 的字段按「本名或别名任一传入」判定
    let passed: std::collections::HashSet<&str> = args.iter().map(|(k, _, _)| k.as_str()).collect();
    for f in &model.fields {
        let ok = passed.contains(f.name.as_str())
            || f.alias.as_deref().map_or(false, |a| passed.contains(a));
        if f.required && !ok {
            out.push(PydanticIssue {
                file: file.to_string(),
                line: lineno,
                column: 0,
                end_column: 0,
                kind: "missing".into(),
                message: format!("Pydantic：构造 {} 缺少必填字段 {}", model.name, f.name),
                field: f.name.clone(),
                model: model.name.clone(),
            });
        }
    }
}

/// 从调用行提取关键字参数 `k=v`（v 为到下一个 `,` 或 `)` 的文本）。
/// 返回 (参数名, 值文本, 参数名列 1 基)；不完整（跨行/嵌套括号）时返回已识别前缀。
fn extract_call_kwargs(line: &str, open_byte: usize) -> Vec<(String, String, u32)> {
    let mut out = Vec::new();
    let Some(open) = line.get(open_byte..).and_then(|s| s.find('(')).map(|p| open_byte + p) else {
        return out;
    };
    let rest = &line[open + 1..];
    // 逐字符扫描：ident= → 值到下一个顶层逗号
    let mut i = 0usize;
    let chars: Vec<char> = rest.chars().collect();
    // 列号按**字符**算（1 基）：open 前字符数 + 1（'('）+ i + 1。
    // 旧实现按字节偏移直加——中文值字面量会让列错位，rename 编辑落点会写坏代码。
    let prefix_chars = byte_to_char_idx(line, open);
    while i < chars.len() {
        let c = chars[i];
        if c == ')' {
            break;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            // 跳过空白找 `=`
            let mut j = i;
            while j < chars.len() && chars[j] == ' ' { j += 1; }
            if j < chars.len() && chars[j] == '=' && (j + 1 >= chars.len() || chars[j + 1] != '=') {
                // 值：从 j+1 到顶层 `,` 或 `)`
                let mut k = j + 1;
                let mut d2 = 0i32;
                while k < chars.len() {
                    let ck = chars[k];
                    if ck == '(' { d2 += 1; }
                    if ck == ')' && d2 == 0 { break; }
                    if ck == ')' { d2 -= 1; }
                    if ck == ',' && d2 == 0 { break; }
                    k += 1;
                }
                let name: String = chars[start..i].iter().collect();
                let value: String = chars[j + 1..k.min(chars.len())].iter().collect();
                out.push((name, value.trim().to_string(), (prefix_chars + 1 + start + 1) as u32));
                i = k;
                continue;
            }
            // 不是 kwargs 形态（位置参数）：跳过到顶层 `,`
            let mut k = i;
            let mut d2 = 0i32;
            while k < chars.len() {
                let ck = chars[k];
                if ck == '(' { d2 += 1; }
                if ck == ')' && d2 == 0 { break; }
                if ck == ')' { d2 -= 1; }
                if ck == ',' && d2 == 0 { break; }
                k += 1;
            }
            i = k;
            continue;
        }
        i += 1;
    }
    out
}

/// rename 补充引用点（子项 2a）：`Model(field=` 的文本级定位。
#[derive(Serialize, Clone, Debug)]
pub struct PydanticCtorRef {
    /// 文件绝对路径（正斜杠）
    pub file: String,
    /// 1 基行号
    pub line: u32,
    /// field 参数名 1 基起始列
    pub column: u32,
    /// 字段名长度（rename 替换宽度）
    pub len: u32,
}

/// 扫描工作区内 `Model(field=` 构造调用点（rename 传播补充；无索引按需扫描）。
/// 匹配规则：Model 名后紧跟 `(`，括号内出现 `field=`（field 后必须紧跟 `=`，
/// 前一字符非标识符——`name=` 不命中 `user_name=`）。
/// 子类调用点一并命中（字段可经继承传入：`User.name` 改名时 `Admin(name=)` 也要改）；
/// 行内注释先剥离（2026-09-29 复核修复）。
#[tauri::command]
pub async fn scan_pydantic_ctor_refs(
    root: String,
    model: String,
    field: String,
) -> Result<Vec<PydanticCtorRef>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_pydantic_ctor_refs_impl(&root, &model, &field))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn scan_pydantic_ctor_refs_impl(root: &str, model: &str, field: &str) -> Result<Vec<PydanticCtorRef>, String> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("工作区目录不存在：{root}"));
    }
    // 同文件继承链上的全部模型名（子类构造调用点也算字段引用）
    let mut names: Vec<String> = vec![model.to_string()];
    for m in pyd_collect_models(root_path) {
        if &m.name != model && m.fields.iter().any(|f| f.name == field) {
            // 只收「继承链含 model」的子类（fields 含同名字段可能是巧合的独立字段）
            if model_inherits_from(&m.name, model, root_path) {
                names.push(m.name.clone());
            }
        }
    }
    let mut out: Vec<PydanticCtorRef> = Vec::new();
    for path in collect_files(root_path) {
        let Ok(meta) = fs::metadata(&path) else { continue };
        if meta.len() > MAX_FILE_SIZE {
            continue;
        }
        let Some(content) = read_text_file(&path) else { continue };
        let file_abs = path.to_string_lossy().replace('\\', "/");
        for (i, raw) in content.lines().enumerate() {
            let line = pyd_strip_comment(raw);
            for name in &names {
                let Some(at) = find_call_head(line, name) else { continue };
                let args = extract_call_kwargs(line, at);
                for (k, _, col) in args {
                    if k == field {
                        out.push(PydanticCtorRef {
                            file: file_abs.clone(),
                            line: (i + 1) as u32,
                            column: col, // extract_call_kwargs 已按整行字符列计算（含 at 偏移）
                            len: field.chars().count() as u32,
                        });
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)).then(a.column.cmp(&b.column)));
    Ok(out)
}

/// model_name 的同文件继承链是否含 ancestor（BFS 全链遍历，多继承不漏；
/// 跨文件继承不判——已知边界）
fn model_inherits_from(model_name: &str, ancestor: &str, root: &Path) -> bool {
    let Some(m) = pyd_collect_models(root).into_iter().find(|m| m.name == model_name) else {
        return false;
    };
    let Some(content) = read_text_file(Path::new(&m.file)) else { return false };
    let classes = pyd_parse_file(&content);
    let mut queue: Vec<String> = vec![model_name.to_string()];
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    while let Some(cur) = queue.pop() {
        if !seen.insert(cur.clone()) {
            continue;
        }
        let Some(cls) = classes.iter().find(|c| c.name == cur) else { continue };
        for b in &cls.bases {
            let base = b.rsplit('.').next().unwrap_or(b).to_string();
            if base == ancestor {
                return true;
            }
            if base != "BaseModel" {
                queue.push(base); // 未知基类（跨文件/外部）也入队：找到声明就继续向上
            }
        }
    }
    false
}

// ---------- ruff 实时 lint（P2：诊断第三桶） ----------

/// lint 规则集：E/W = pycodestyle（PEP8 风格与格式），F = pyflakes（未使用导入/变量、未定义名）。
/// 与 Optimize Imports 的区别：那里是**改写**（只取 I/F401 且 --fix），这里是**只读诊断**，
/// 故范围更宽——用户看到的是「PEP8 级卫生问题」，不动代码。
///
/// 刻意显式指定而非交给项目配置：诊断口径必须**稳定可预期**（同一个文件不会因为
/// 工作区里多了一个 pyproject.toml 就突然刷出几百条），否则 lint 很快会被当成噪音关掉。
const LINT_RULES: &str = "E,W,F";

#[derive(Serialize, Clone)]
pub struct RuffDiagnostic {
    /// 1 基行号
    pub line: u32,
    /// 1 基列号
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub message: String,
    /// 规则码（如 "F401"）；缺失时为 null
    pub code: Option<String>,
}

/// ruff check（JSON 输出）在缓冲区上做只读诊断，不改写任何内容。
///
/// 退出码语义（与 optimize_imports 同款）：0 = 无诊断，1 = 有诊断，>1 = 用法/内部错误。
/// 故 **1 是正常路径**，只有 >1 才判失败——把「有诊断」当错误会让 lint 恒为空。
/// ruff 缺席/失败一律返回空列表：lint 是增强，绝不能拖垮编辑（与探针缺席策略一致）。
#[tauri::command]
pub async fn ruff_lint(path: String, content: String) -> Result<Vec<RuffDiagnostic>, String> {
    tauri::async_runtime::spawn_blocking(move || ruff_lint_impl(&path, &content))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn ruff_lint_impl(path: &str, content: &str) -> Result<Vec<RuffDiagnostic>, String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut cmd = tool_command("ruff", ENV_RUFF);
    cmd.args([
        "check",
        "--output-format",
        "json",
        "--select",
        LINT_RULES,
        "--no-cache",
        "--stdin-filename",
        path,
        "-",
    ]);
    let mut child = match no_window(&mut cmd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return Ok(Vec::new()), // ruff 缺席：静默降级
    };
    if let Some(mut stdin) = child.stdin.take() {
        // 子进程可能提前退出（如语法错误极多），忽略 BrokenPipe
        let _ = stdin.write_all(content.as_bytes());
    }
    let out = match child.wait_with_output() {
        Ok(o) => o,
        Err(_) => return Ok(Vec::new()),
    };
    // 与 optimize_imports 同口径：>1 才是真失败
    if out.status.code().unwrap_or(1) > 1 {
        return Ok(Vec::new());
    }
    Ok(parse_ruff_json(&String::from_utf8_lossy(&out.stdout)))
}

/// 解析 ruff 的 JSON 诊断数组；解析失败返回空（宁可少报也不要报错弹窗）
fn parse_ruff_json(raw: &str) -> Vec<RuffDiagnostic> {
    let value: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for it in items {
        let start = it.get("location").and_then(|l| l.get("row")).and_then(serde_json::Value::as_u64);
        let Some(line) = start else { continue };
        let col = it.get("location").and_then(|l| l.get("column")).and_then(serde_json::Value::as_u64).unwrap_or(1);
        // end_location 缺失（旧版 ruff）时退化为「起点 + 1 列」的单字符范围——
        // Monaco 不接受 0 宽范围以外的非法范围，退化值至少保证标记能落在正确行上
        let end_line = it.get("end_location").and_then(|l| l.get("row")).and_then(serde_json::Value::as_u64).unwrap_or(line);
        let end_col = it.get("end_location").and_then(|l| l.get("column")).and_then(serde_json::Value::as_u64).unwrap_or(col + 1);
        let message = it.get("message").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
        if message.is_empty() {
            continue;
        }
        let code = it.get("code").and_then(serde_json::Value::as_str).map(|s| s.to_string());
        out.push(RuffDiagnostic {
            line: line as u32,
            column: col as u32,
            end_line: end_line as u32,
            end_column: end_col as u32,
            message,
            code,
        });
    }
    out
}

// ---------- 工作区文件清单（P1：Search Everywhere 文件名检索用） ----------

/// 文件清单上限：超大仓库只取前 N 条，避免序列化与前端渲染被拖垮
///（清单只服务于「按文件名快速跳转」，截断不影响定位常用文件）。
const MAX_FILE_LIST: usize = 20_000;

/// 列出工作区内的全部文件路径（复用 search_workspace 的 `ignore` 走查：.gitignore 感知 +
/// 隐藏过滤 + 噪声目录剪枝），按路径排序。
/// async + spawn_blocking：大仓库遍历可能耗时，同步 command 会卡死主线程 UI。
#[tauri::command]
pub async fn list_workspace_files(root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || list_workspace_files_impl(&root))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn list_workspace_files_impl(root: &str) -> Result<Vec<String>, String> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("工作区目录不存在：{root}"));
    }
    let mut files: Vec<String> = collect_files(root_path)
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    files.sort();
    files.truncate(MAX_FILE_LIST);
    Ok(files)
}

const MAX_DIR_LIST: usize = 2_000;

/// 列出工作区内的子目录（相对工作区根、统一正斜杠；复用 list_workspace_files 同一套
/// `ignore` 走查：.gitignore 感知 + 隐藏过滤 + 噪声目录剪枝）。运行配置「工作目录」候选用；
/// 不含根自身（根由前端以 `${workspaceRoot}` 单列），按路径排序、去重、截断。
#[tauri::command]
pub async fn list_workspace_dirs(root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || list_workspace_dirs_impl(&root))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn list_workspace_dirs_impl(root: &str) -> Result<Vec<String>, String> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("工作区目录不存在：{root}"));
    }
    let root_norm = root.replace('\\', "/");
    let root_norm = root_norm.trim_end_matches('/');
    let mut dirs: Vec<String> = Vec::new();
    let mut builder = ignore::WalkBuilder::new(root_path);
    builder
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            !SEARCH_IGNORED_DIRS.contains(&name.as_str())
        });
    for entry in builder.build() {
        if let Ok(entry) = entry {
            if entry.depth() == 0 {
                continue; // 根自身不计入
            }
            if entry.file_type().map_or(false, |ft| ft.is_dir()) {
                let s = entry.into_path().to_string_lossy().replace('\\', "/");
                if let Some(rel) = s.strip_prefix(root_norm).and_then(|r| r.strip_prefix('/')) {
                    if !rel.is_empty() {
                        dirs.push(rel.to_string());
                    }
                }
            }
        }
    }
    dirs.sort();
    dirs.dedup();
    dirs.truncate(MAX_DIR_LIST);
    Ok(dirs)
}

// ---------- 单元测试 ----------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmpdir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("pylume-test-{tag}-{nanos}"));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn test_read_file_rejects_oversized_and_dir() {
        let dir = tmpdir("readguard");
        // 超过 10 MB 上限：报「文件过大」而非整读卡死
        let big = dir.join("big.txt");
        fs::write(&big, vec![b'a'; 10 * 1024 * 1024 + 1]).unwrap();
        let err = read_file(big.to_str().unwrap()).unwrap_err();
        assert!(err.contains("文件过大"), "实际错误：{err}");
        // 目录路径：明确报错而非 io 错误裸串
        let err = read_file(dir.to_str().unwrap()).unwrap_err();
        assert!(err.contains("目录"), "实际错误：{err}");
        // 正常小文件照常可读
        let ok = dir.join("ok.txt");
        fs::write(&ok, "hello").unwrap();
        assert_eq!(read_file(ok.to_str().unwrap()).unwrap(), "hello");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_normalize_project_name() {
        let dir = tmpdir("pkgname");
        // 模拟 uv init --bare 生成的 pyproject：name 按 uv 口径（保留空格/大小写）
        fs::write(
            dir.join("pyproject.toml"),
            "[project]\nname = \"My Proj\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        normalize_project_name(&dir, "My Proj").unwrap();
        let content = fs::read_to_string(dir.join("pyproject.toml")).unwrap();
        assert!(content.contains("name = \"my-proj\""), "实际内容：{content}");

        // 非 [project] 段的 name（如 [tool.uv]）不被误改
        fs::write(
            dir.join("pyproject.toml"),
            "[project]\nname = \"ok\"\n[tool.uv]\nname = \"keep\"\n",
        )
        .unwrap();
        normalize_project_name(&dir, "ok").unwrap();
        let content2 = fs::read_to_string(dir.join("pyproject.toml")).unwrap();
        assert!(content2.contains("name = \"ok\""), "实际内容：{content2}");
        assert!(content2.contains("name = \"keep\""), "实际内容：{content2}");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_valid_project_name() {
        assert!(valid_project_name("my-project"));
        assert!(valid_project_name("我的项目"));
        assert!(valid_project_name("proj_1.2"));
        assert!(!valid_project_name(""));
        assert!(!valid_project_name(" "));
        assert!(!valid_project_name("."));
        assert!(!valid_project_name(".."));
        for bad in ["a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "a\nb"] {
            assert!(!valid_project_name(bad), "应拒绝：{bad:?}");
        }
    }

    #[test]
    fn test_create_project_basic() {
        let base = tmpdir("proj");
        let r = create_project_impl(base.to_string_lossy().to_string(), "demo".into(), false, None, None).unwrap();
        let root = Path::new(&r.path);
        assert!(root.is_dir());
        assert!(root.join("main.py").is_file());
        // P2（建议 1）：默认生成最小 pyproject.toml，requires-python 回退 >=3.12
        let pyproject = fs::read_to_string(root.join("pyproject.toml")).unwrap();
        assert!(pyproject.contains("name = \"demo\""));
        assert!(pyproject.contains("requires-python = \">=3.12\""));
        assert!(!root.join(".gitignore").exists()); // 未要求 git
        assert!(r.git_ok);
        // script 默认：main.py 是脚本模板（不含 FastAPI），pyproject 无 fastapi 依赖
        let main_py = fs::read_to_string(root.join("main.py")).unwrap();
        assert!(main_py.contains("def main()"), "实际内容：{main_py}");
        assert!(!main_py.contains("FastAPI"));
        assert!(!pyproject.contains("fastapi"));
        // 重名 / 非法名 / 父目录不存在
        assert!(create_project_impl(base.to_string_lossy().to_string(), "demo".into(), false, None, None).is_err());
        assert!(create_project_impl(base.to_string_lossy().to_string(), "a/b".into(), false, None, None).is_err());
        assert!(create_project_impl(base.join("nope").to_string_lossy().to_string(), "x".into(), false, None, None).is_err());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn test_create_project_git_best_effort() {
        let base = tmpdir("proj-git");
        let r = create_project_impl(base.to_string_lossy().to_string(), "demo".into(), true, None, None).unwrap();
        let root = Path::new(&r.path);
        // .gitignore 必写；git 是否成功取决于环境（未装 git 时 git_ok=false 但项目仍创建）
        assert!(root.join(".gitignore").is_file());
        assert!(root.join("main.py").is_file());
        if r.git_ok {
            assert!(root.join(".git").exists());
        } else {
            assert!(!r.git_message.is_empty());
        }
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn test_create_project_version_reflects_in_pyproject() {
        let base = tmpdir("proj-ver");
        // 选 3.13（uv spec 形式）→ requires-python 反映所选版本
        let r = create_project_impl(
            base.to_string_lossy().to_string(),
            "My Demo".into(),
            false,
            Some("cpython-3.13.7-windows-x86_64-none".into()),
            None,
        )
        .unwrap();
        let root = Path::new(&r.path);
        let pyproject = fs::read_to_string(root.join("pyproject.toml")).unwrap();
        assert!(pyproject.contains("requires-python = \">=3.13\""));
        assert!(pyproject.contains("name = \"my-demo\"")); // 非法字符折叠为 '-'
        fs::remove_dir_all(&base).unwrap();
    }

    /// F9：fastapi 类型 → FastAPI 模板 main.py + pyproject 写入 fastapi/uvicorn 依赖。
    /// 断言**路径无关**（contains 而非精确全文比对）：CI 有无 uv 走方案 A/B 均过——
    /// 方案 A（uv init --bare 产物 + 行扫描注入）与方案 B（最小模板直接带 deps）的
    /// pyproject 具体行序/备注可能不同，但两个关键契约（模板形状 + 依赖存在）必须都满足。
    #[test]
    fn test_create_project_fastapi_template_and_deps() {
        let base = tmpdir("proj-fa");
        let r = create_project_impl(
            base.to_string_lossy().to_string(),
            "demo-api".into(),
            false,
            None,
            Some("fastapi".into()),
        )
        .unwrap();
        let root = Path::new(&r.path);
        // main.py：FastAPI 模板（app = FastAPI( 命中探针 scan_app_decl；两条路由命中端点扫描）
        let main_py = fs::read_to_string(root.join("main.py")).unwrap();
        assert!(main_py.contains("from fastapi import FastAPI"), "实际内容：{main_py}");
        assert!(main_py.contains("app = FastAPI("), "实际内容：{main_py}");
        assert!(main_py.contains("@app.get(\"/\")"), "实际内容：{main_py}");
        assert!(main_py.contains("@app.get(\"/items/{item_id}\")"), "实际内容：{main_py}");
        // pyproject：依赖写入（两条生成路径都要注入）
        let pyproject = fs::read_to_string(root.join("pyproject.toml")).unwrap();
        assert!(pyproject.contains("\"fastapi\""), "实际内容：{pyproject}");
        assert!(pyproject.contains("\"uvicorn\""), "实际内容：{pyproject}");
        fs::remove_dir_all(&base).unwrap();
    }

    /// F9 边界：未知 project_type 按脚本模板处理（None / 空 / "script" 等价）
    #[test]
    fn test_create_project_unknown_type_falls_back_to_script() {
        let base = tmpdir("proj-unknown");
        for (i, t) in [None, Some(""), Some("script"), Some("django")].into_iter().enumerate() {
            let r = create_project_impl(
                base.to_string_lossy().to_string(),
                format!("p-{i}").into(),
                false,
                None,
                t.map(String::from),
            )
            .unwrap();
            let main_py = fs::read_to_string(Path::new(&r.path).join("main.py")).unwrap();
            assert!(main_py.contains("def main()"), "type={t:?} 应回退脚本模板：{main_py}");
        }
        fs::remove_dir_all(&base).unwrap();
    }

    /// F9：方案 A 路径依赖注入（行扫描）——空 dependencies 行替换 / 已有键跳过 / 无键段末插入
    #[test]
    fn test_inject_project_deps_line_scan() {
        // ① uv init --bare 实测产物：空 dependencies = [] → 替换
        let dir = tmpdir("inj-empty");
        fs::write(
            dir.join("pyproject.toml"),
            "[project]\nname = \"demo\"\nversion = \"0.1.0\"\nrequires-python = \">=3.12\"\ndependencies = []\n",
        )
        .unwrap();
        inject_project_deps(&dir, &["fastapi", "uvicorn"]).unwrap();
        let c = fs::read_to_string(dir.join("pyproject.toml")).unwrap();
        assert!(c.contains("dependencies = [\"fastapi\", \"uvicorn\"]"), "实际内容：{c}");
        assert_eq!(c.matches("dependencies").count(), 1, "旧空行应被替换而非并存：{c}");
        fs::remove_dir_all(dir).unwrap();

        // ② 已有 dependencies 键（含值）→ 跳过（幂等：不合并、不重复）
        let dir2 = tmpdir("inj-skip");
        fs::write(
            dir2.join("pyproject.toml"),
            "[project]\nname = \"demo\"\ndependencies = [\"httpx\"]\n[tool.uv]\n\n[build-system]\nrequires = [\"hatchling\"]\n",
        )
        .unwrap();
        inject_project_deps(&dir2, &["fastapi"]).unwrap();
        let c2 = fs::read_to_string(dir2.join("pyproject.toml")).unwrap();
        assert!(c2.contains("dependencies = [\"httpx\"]"), "实际内容：{c2}");
        assert!(!c2.contains("fastapi"), "已有键应跳过注入：{c2}");
        // 其他段（含同样以 requires 开头的 [build-system] 键）不受影响
        assert!(c2.contains("[tool.uv]"));
        assert!(c2.contains("requires = [\"hatchling\"]"), "build-system 的 requires 不得误伤：{c2}");
        fs::remove_dir_all(dir2).unwrap();

        // ③ 无 dependencies 键 → [project] 段末尾、下一个 [ 段之前插入
        let dir3 = tmpdir("inj-append");
        fs::write(
            dir3.join("pyproject.toml"),
            "[project]\nname = \"demo\"\nversion = \"0.1.0\"\n\n[tool.uv]\npackage = false\n",
        )
        .unwrap();
        inject_project_deps(&dir3, &["fastapi", "uvicorn"]).unwrap();
        let c3 = fs::read_to_string(dir3.join("pyproject.toml")).unwrap();
        let proj_end = c3.find("[tool.uv]").unwrap();
        let deps_at = c3.find("dependencies = [\"fastapi\", \"uvicorn\"]").expect("应已插入");
        assert!(deps_at < proj_end, "应插在 [project] 段内：{c3}");
        assert!(c3.contains("package = false"), "后段内容不丢：{c3}");
        fs::remove_dir_all(dir3).unwrap();

        // ④ [project] 是最后一个段（无后续 [）→ 段末追加
        let dir4 = tmpdir("inj-tail");
        fs::write(dir4.join("pyproject.toml"), "[project]\nname = \"demo\"\n").unwrap();
        inject_project_deps(&dir4, &["fastapi"]).unwrap();
        let c4 = fs::read_to_string(dir4.join("pyproject.toml")).unwrap();
        assert!(c4.contains("dependencies = [\"fastapi\"]"), "实际内容：{c4}");
        fs::remove_dir_all(dir4).unwrap();
    }

    #[test]
    fn test_requires_python_and_pkg_name() {
        // 版本标识 → "3.MINOR"（uv --python 与 requires-python 共用）；无法解析 → None（调用方回退 3.12）
        assert_eq!(python_short_from(""), None);
        assert_eq!(python_short_from("3.12").as_deref(), Some("3.12"));
        assert_eq!(python_short_from("cpython-3.11.9-linux-x86_64-gnu").as_deref(), Some("3.11"));
        assert_eq!(python_short_from("garbage"), None);
        assert_eq!(sanitize_pkg_name("Hello World"), "hello-world");
        assert_eq!(sanitize_pkg_name("__init__"), "init");
        assert_eq!(sanitize_pkg_name("///"), "app");
    }

    #[test]
    fn test_search_workspace() {
        let base = tmpdir("search");
        fs::write(base.join("a.py"), "hello world\nfoo bar\nhello again\n").unwrap();
        fs::create_dir_all(base.join("pkg")).unwrap();
        fs::write(base.join("pkg").join("b.py"), "say hello\n").unwrap();
        // 忽略目录内的文件不应被扫描
        fs::create_dir_all(base.join(".venv")).unwrap();
        fs::write(base.join(".venv").join("c.py"), "hello hidden\n").unwrap();
        // 无扩展名文件也应被扫描
        fs::write(base.join("README"), "hello readme\n").unwrap();

        let r = search_workspace_impl(base.to_string_lossy().to_string(), "hello".into(), false, SearchOptions::default()).unwrap();
        assert_eq!(r.files_scanned, 3); // a.py + pkg/b.py + README
        assert_eq!(r.matches.len(), 4); // a.py×2 + b.py×1 + README×1
        assert!(r.matches.iter().all(|m| !m.path.contains(".venv")));
        assert!(!r.truncated);
        // 行号/列号正确性（排序后 README 在 a.py 前：大写 ASCII 靠前）
        let a_py = r.matches.iter().find(|m| m.path.ends_with("a.py")).unwrap();
        assert_eq!(a_py.line, 1);
        assert_eq!(a_py.column, 1);
        assert_eq!(a_py.length, 5);

        // 大小写敏感
        let r2 = search_workspace_impl(base.to_string_lossy().to_string(), "Hello".into(), true, SearchOptions::default()).unwrap();
        assert_eq!(r2.matches.len(), 0);
        let r3 = search_workspace_impl(base.to_string_lossy().to_string(), "hello".into(), true, SearchOptions::default()).unwrap();
        assert_eq!(r3.matches.len(), 4);

        // 空查询
        let r4 = search_workspace_impl(base.to_string_lossy().to_string(), "".into(), false, SearchOptions::default()).unwrap();
        assert_eq!(r4.matches.len(), 0);
        assert_eq!(r4.files_scanned, 0);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn test_search_multiline_and_column() {
        let base = tmpdir("search2");
        fs::write(base.join("x.py"), "aaa bbb aaa\nccc\n").unwrap();
        let r = search_workspace_impl(base.to_string_lossy().to_string(), "aaa".into(), false, SearchOptions::default()).unwrap();
        assert_eq!(r.matches.len(), 2);
        // 第二个 aaa 在第 1 行第 9 列
        let second = &r.matches[1];
        assert_eq!(second.line, 1);
        assert_eq!(second.column, 9);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn test_search_case_insensitive_uppercase_content() {
        // 覆盖「大写内容 + 不敏感搜索」（此前测试盲区，真实代码最常见场景）
        let base = tmpdir("search3");
        fs::write(base.join("u.py"), "Hello World\nhello again\nHELLO\nnoMatch\n").unwrap();
        // 不敏感：Hello / hello / HELLO 三处均应命中
        let r = search_workspace_impl(base.to_string_lossy().to_string(), "hello".into(), false, SearchOptions::default()).unwrap();
        assert_eq!(r.matches.len(), 3, "不敏感搜索应命中 Hello/hello/HELLO 三处");
        assert_eq!(r.matches[0].line, 1);
        assert_eq!(r.matches[0].column, 1);
        assert_eq!(r.matches[1].line, 2);
        assert_eq!(r.matches[2].line, 3);
        // 敏感：仅第 2 行 hello 命中
        let r2 = search_workspace_impl(base.to_string_lossy().to_string(), "hello".into(), true, SearchOptions::default()).unwrap();
        assert_eq!(r2.matches.len(), 1);
        assert_eq!(r2.matches[0].line, 2);
        fs::remove_dir_all(&base).unwrap();
    }

    // ---------- PR-H（dx_features_backlog §6.6）：全局搜索正则 + 文件掩码 ----------

    fn opts_regex() -> SearchOptions {
        SearchOptions { use_regex: true, file_glob: None }
    }

    #[test]
    fn search_regex_matches_and_reports_column_and_length() {
        let base = tmpdir("search-regex");
        fs::write(base.join("a.py"), "foo_aa barrier\nfoo_bbb nothing\nplain\n").unwrap();
        // `foo_\w+` 应命中两行：长度分别为 6 / 7（按字符计，宽字符场景才与前端切片对齐）
        let r = search_workspace_impl(
            base.to_string_lossy().to_string(),
            r"foo_\w+".into(),
            true,
            opts_regex(),
        )
        .unwrap();
        assert_eq!(r.matches.len(), 2);
        assert_eq!(r.matches[0].line, 1);
        assert_eq!(r.matches[0].column, 1);
        assert_eq!(r.matches[0].length, 6);
        assert_eq!(r.matches[1].line, 2);
        assert_eq!(r.matches[1].column, 1);
        assert_eq!(r.matches[1].length, 7);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn search_regex_respects_case_toggle_and_line_offsets() {
        let base = tmpdir("search-regex-case");
        fs::write(base.join("a.py"), "ERROR at x\nerror at y\n").unwrap();
        let root = base.to_string_lossy().to_string();
        // 敏感：仅 "error" 命中（第 2 行）
        let r = search_workspace_impl(root.clone(), "error".into(), true, opts_regex()).unwrap();
        assert_eq!(r.matches.len(), 1);
        assert_eq!(r.matches[0].line, 2);
        // 不敏感：两行都命中
        let r2 = search_workspace_impl(root, "error".into(), false, opts_regex()).unwrap();
        assert_eq!(r2.matches.len(), 2);
        // 非行首匹配也要给出正确列号
        let r3 = search_workspace_impl(
            base.to_string_lossy().to_string(),
            r"at\s\w".into(),
            true,
            opts_regex(),
        )
        .unwrap();
        assert_eq!(r3.matches[0].column, 7);
        assert_eq!(r3.matches[0].length, 4); // "at x"
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn search_file_glob_filters_candidates() {
        let base = tmpdir("search-glob");
        fs::create_dir_all(base.join("pkg")).unwrap();
        fs::write(base.join("a.py"), "hit here\n").unwrap();
        fs::write(base.join("b.txt"), "hit here\n").unwrap();
        fs::write(base.join("pkg").join("c.py"), "hit here\n").unwrap();
        let root = base.to_string_lossy().to_string();
        // 无斜杠掩码 = 任意深度（gitignore 语义），故 a.py + pkg/c.py
        let r = search_workspace_impl(root.clone(), "hit".into(), false, SearchOptions {
            use_regex: false,
            file_glob: Some("*.py".into()),
        })
        .unwrap();
        assert_eq!(r.files_scanned, 2, "掩码 *.py 应扫描 a.py 与 pkg/c.py");
        assert!(r.matches.iter().all(|m| m.path.ends_with(".py")));
        // 路径分隔符 Windows 是 `\`：断言前归一，避免「只在 CI(Linux) 才过」的写法
        assert!(
            r.matches.iter().any(|m| m.path.replace('\\', "/").ends_with("pkg/c.py")),
            "无斜杠掩码需命中子目录"
        );
        // 带斜杠的掩码按相对根路径锚定
        let r2 = search_workspace_impl(root, "hit".into(), false, SearchOptions {
            use_regex: false,
            file_glob: Some("pkg/*.py".into()),
        })
        .unwrap();
        assert_eq!(r2.files_scanned, 1);
        assert!(r2.matches[0].path.replace('\\', "/").ends_with("pkg/c.py"));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn search_invalid_regex_and_glob_report_errors() {
        let base = tmpdir("search-invalid");
        fs::write(base.join("a.py"), "hello\n").unwrap();
        let root = base.to_string_lossy().to_string();
        // 非法正则：明确报错，不静默退回子串匹配（静默会让用户以为「正则没生效」）
        // `.err()` 而非 `unwrap_err()`：后者要求 Ok 侧实现 Debug，会为了一条断言给产物类型加 derive
        let msg = search_workspace_impl(root.clone(), "foo(".into(), false, opts_regex())
            .err()
            .expect("非法正则必须报错而非静默降级");
        assert!(msg.contains("正则表达式无效"));
        // 掩码与正则可叠加使用（正则 + 掩码都是有效组合）
        let r = search_workspace_impl(root, "h.llo".into(), false, SearchOptions {
            use_regex: true,
            file_glob: Some("*.py".into()),
        })
        .unwrap();
        assert_eq!(r.matches.len(), 1);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn todo_tag_requires_word_boundary() {
        // 词边界：变量名里的子串不算 TODO
        assert_eq!(find_todo_tag("# TODO: 重构这里").map(|(_, t)| t), Some("TODO"));
        assert_eq!(find_todo_tag("# todo 也识别（大小写不敏感）").map(|(_, t)| t), Some("TODO"));
        assert!(find_todo_tag("todos = []").is_none(), "TODOS 不应命中");
        assert!(find_todo_tag("my_todo_helper()").is_none(), "下划线连接的词不算");
        assert!(find_todo_tag("def fixme_handler():").is_none(), "FIXME_ 前缀不是标记");
        // XXX/HACK/BUG 要求全大写（小写形态过于常见）
        assert_eq!(find_todo_tag("# XXX 临时方案").map(|(_, t)| t), Some("XXX"));
        assert!(find_todo_tag("# xxx 小写不识别").is_none());
        assert_eq!(find_todo_tag("# HACK: 绕过").map(|(_, t)| t), Some("HACK"));
        assert!(find_todo_tag("# hack").is_none());
        // 无标记
        assert!(find_todo_tag("x = 1").is_none());
    }

    #[test]
    fn todo_message_strips_leading_separators() {
        assert_eq!(find_todo_tag("# TODO: 补齐异常分支").map(|(c, t)| (c, t)), Some((2, "TODO")));
        // message 由调用方裁剪，这里验证裁剪口径（冒号/横线/括号/中文冒号）
        for (raw, expect) in [
            ("# TODO: 补齐异常分支", "补齐异常分支"),
            ("# TODO - 补齐异常分支", "补齐异常分支"),
            ("# TODO 补齐异常分支", "补齐异常分支"),
            ("# TODO", ""),
        ] {
            let (col, tag) = find_todo_tag(raw).expect("应命中");
            let after = raw[col + tag.len()..].trim();
            let msg = after
                .trim_start_matches(|c: char| c == ':' || c == '-' || c == '(' || c == '：')
                .trim();
            assert_eq!(msg, expect, "raw={raw}");
        }
    }

    #[test]
    fn test_scan_todos() {
        let base = tmpdir("todo");
        fs::write(
            base.join("a.py"),
            "import os\n# TODO: 删掉未使用的导入\nx = os.sep  # FIXME(x): 边界没兜住\nnormal = 1\n",
        )
        .unwrap();
        fs::create_dir_all(base.join("pkg")).unwrap();
        fs::write(base.join("pkg").join("b.py"), "# XXX 临时实现\n").unwrap();
        // 忽略目录内的 TODO 不应出现（复用 collect_files 的 .gitignore/噪声目录剪枝）
        fs::create_dir_all(base.join(".venv")).unwrap();
        fs::write(base.join(".venv").join("c.py"), "# TODO hidden\n").unwrap();

        let r = scan_todos_impl(&base.to_string_lossy()).unwrap();
        assert_eq!(r.len(), 3, "a.py 两处 + pkg/b.py 一处");
        assert!(r.iter().all(|m| !m.path.contains(".venv")));
        // 按文件 → 行号排序
        assert_eq!(r[0].line, 2);
        assert_eq!(r[0].tag, "TODO");
        assert_eq!(r[0].message, "删掉未使用的导入");
        assert_eq!(r[1].line, 3);
        assert_eq!(r[1].tag, "FIXME");
        assert_eq!(r[1].message, "x): 边界没兜住");
        assert_eq!(r[2].tag, "XXX");
        assert!(r[2].path.ends_with("b.py"));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn scan_todos_rejects_missing_root() {
        let missing = std::env::temp_dir().join("pylume-scan-todos-missing-dir");
        assert!(scan_todos_impl(&missing.to_string_lossy()).is_err());
    }

    // ---------- import 别名扫描单测 ----------

    #[test]
    fn import_alias_parse_module_and_member() {
        let mut hits = parse_import_alias_content("import pandas as pd");
        assert_eq!(hits, vec![(0, "pandas".to_string(), "pd".to_string())]);
        // from-import 成员型：target 为 module.member
        hits = parse_import_alias_content("from pandas import DataFrame as DF");
        assert_eq!(
            hits,
            vec![(1, "pandas.DataFrame".to_string(), "DF".to_string())]
        );
    }

    #[test]
    fn import_alias_parse_multi_and_paren_and_comment() {
        // 多目标 + 混合有无别名
        let hits = parse_import_alias_content("import os, numpy as np");
        assert_eq!(hits, vec![(0, "numpy".to_string(), "np".to_string())]);
        // from + 圆括号 + 多成员
        let hits = parse_import_alias_content("from torch import (nn as NN, optim)");
        assert_eq!(hits, vec![(1, "torch.nn".to_string(), "NN".to_string())]);
        // 行尾注释截断（'#' 前有空白）
        let hits = parse_import_alias_content("import pandas as pd  # 数据处理");
        assert_eq!(hits, vec![(0, "pandas".to_string(), "pd".to_string())]);
    }

    #[test]
    fn import_alias_parse_rejects_noise() {
        assert!(parse_import_alias_content("# import pandas as pd").is_empty()); // 注释行
        assert!(parse_import_alias_content("import pandas").is_empty()); // 无别名
        assert!(parse_import_alias_content("from pandas import DataFrame").is_empty());
        assert!(parse_import_alias_content("x = import pandas as pd").is_empty()); // 非 import 行首
        assert!(parse_import_alias_content("import pandas as pd.DataFrame").is_empty()); // 别名非法
        assert!(parse_import_alias_content("from 'x' import y as z").is_empty()); // 模块名非法
    }

    #[test]
    fn import_alias_parse_multiline_from_import() {
        // 圆括号跨行续行（含逗号尾行与闭括号行）
        let src = "from pandas import (\n    DataFrame as DF,\n    read_csv as rc,\n)\n";
        assert_eq!(
            parse_import_alias_content(src),
            vec![
                (1u8, "pandas.DataFrame".to_string(), "DF".to_string()),
                (1, "pandas.read_csv".to_string(), "rc".to_string()),
            ]
        );
        // 逗号续行（无括号形态）
        let src = "from torch import nn as NN,\n    optim as opt\nx = 1\n";
        assert_eq!(
            parse_import_alias_content(src),
            vec![
                (1u8, "torch.nn".to_string(), "NN".to_string()),
                (1, "torch.optim".to_string(), "opt".to_string()),
            ]
        );
        // 同行多成员尾段 ')' 粘连（旧实现只学到第一个）
        assert_eq!(
            parse_import_alias_content("from lib import (A as B, C as D)"),
            vec![
                (1u8, "lib.A".to_string(), "B".to_string()),
                (1, "lib.C".to_string(), "D".to_string()),
            ]
        );
        // 续行遇非续行语句收束；空行不打断计数判定由语句边界负责
        let src = "from lib import (\n    A as B,\n)\nx = 1\nimport os as o\n";
        assert_eq!(
            parse_import_alias_content(src),
            vec![
                (1u8, "lib.A".to_string(), "B".to_string()),
                (0, "os".to_string(), "o".to_string()),
            ]
        );
    }

    #[test]
    fn import_alias_parse_semicolon_statements() {
        // 分号多语句：两条 module 别名都学到
        assert_eq!(
            parse_import_alias_content("import pandas as pd; import numpy as np"),
            vec![
                (0u8, "pandas".to_string(), "pd".to_string()),
                (0, "numpy".to_string(), "np".to_string()),
            ]
        );
        // from + import 混排
        assert_eq!(
            parse_import_alias_content("from pandas import DataFrame as DF; import numpy as np"),
            vec![
                (1u8, "pandas.DataFrame".to_string(), "DF".to_string()),
                (0, "numpy".to_string(), "np".to_string()),
            ]
        );
        // 分号后的语句独立成句（不再受前句非 import 前缀影响）
        assert_eq!(
            parse_import_alias_content("x = 1; import pandas as pd"),
            vec![(0u8, "pandas".to_string(), "pd".to_string())]
        );
        // 跨行续行中首个分号结束续行，其后是新语句
        assert_eq!(
            parse_import_alias_content("from lib import (\n    A as B; import os as o\n)\n"),
            vec![
                (1u8, "lib.A".to_string(), "B".to_string()),
                (0, "os".to_string(), "o".to_string()),
            ]
        );
        // 无别名的分号段不产生绑定
        assert!(parse_import_alias_content("import pandas as pd; x = 1")
            == vec![(0u8, "pandas".to_string(), "pd".to_string())]);
    }

    #[test]
    fn scan_import_aliases_aggregates_and_ranks() {
        let base = tmpdir("import-alias");
        fs::write(
            base.join("a.py"),
            "import pandas as pd\nimport pandas as pd\nimport pandas as unusual\n",
        )
        .unwrap();
        fs::write(base.join("b.py"), "from numpy import array as arr\n").unwrap();
        fs::write(base.join("c.txt"), "import pandas as pd\n").unwrap(); // 非 .py 不扫
        let r = scan_import_aliases_impl(&base.to_string_lossy()).unwrap();
        assert_eq!(r[0].target, "pandas");
        assert_eq!(r[0].alias, "pd");
        assert_eq!(r[0].count, 2);
        assert_eq!(r[0].kind, "module");
        assert!(r.iter().any(|h| h.kind == "member" && h.target == "numpy.array"));
        // 同 target 不同 alias 是两条独立聚合（unusual 仅 1 次，pd 2 次）
        assert!(r.iter().any(|h| h.target == "pandas" && h.alias == "unusual" && h.count == 1));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn scan_import_aliases_rejects_missing_root() {
        let missing = std::env::temp_dir().join("pylume-import-alias-missing-dir");
        assert!(scan_import_aliases_impl(&missing.to_string_lossy()).is_err());
    }

    #[test]
    fn scan_import_aliases_incremental_reuse_and_invalidation() {
        let base = tmpdir("import-alias-incr");
        let a = base.join("a.py");
        fs::write(&a, "import pandas as pd\n").unwrap();
        fs::write(base.join("b.py"), "from numpy import array as arr\n").unwrap();
        let root_str = base.to_string_lossy().to_string();
        let r1 = scan_import_aliases_impl(&root_str).unwrap();
        assert_eq!(r1.iter().find(|h| h.target == "pandas").unwrap().count, 1);

        // 哨兵验证：不动文件、直接改写缓存绑定 → 重扫命中缓存复用哨兵（证明未重读文件）
        let mut cfg = crate::env_cmds::load_config(&root_str);
        cfg["import_aliases_scan_cache"]["files"]["a.py"]["bindings"] =
            json!([[0, "pandas", "sentinel"]]);
        crate::env_cmds::save_config(&root_str, &cfg).unwrap();
        let r2 = scan_import_aliases_impl(&root_str).unwrap();
        assert!(r2.iter().any(|h| h.target == "pandas" && h.alias == "sentinel"));
        assert!(!r2.iter().any(|h| h.target == "pandas" && h.alias == "pd"));
        // 未动过的 b.py 条目同轮复用（arr 仍在）
        assert!(r2.iter().any(|h| h.kind == "member" && h.target == "numpy.array"));

        // 文件内容变化（长度不同确保签名变化）→ 该文件缓存失效重新解析
        fs::write(&a, "import pandas as pd\nimport pandas as pd\nimport os as o\n").unwrap();
        let r3 = scan_import_aliases_impl(&root_str).unwrap();
        assert_eq!(
            r3.iter().find(|h| h.target == "pandas" && h.alias == "pd").unwrap().count,
            2
        );
        assert!(r3.iter().any(|h| h.target == "os" && h.alias == "o"));
        assert!(!r3.iter().any(|h| h.alias == "sentinel"));

        // 文件删除 → 条目从聚合与缓存基线中消失
        fs::remove_file(&a).unwrap();
        let r4 = scan_import_aliases_impl(&root_str).unwrap();
        assert!(!r4.iter().any(|h| h.target == "pandas"));
        assert!(!r4.iter().any(|h| h.target == "os"));
        assert!(r4.iter().any(|h| h.kind == "member" && h.target == "numpy.array"));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn scan_import_aliases_tolerates_garbage_cache() {
        let base = tmpdir("import-alias-garbage");
        fs::write(base.join("a.py"), "import pandas as pd\n").unwrap();
        let root_str = base.to_string_lossy().to_string();
        let mut cfg = crate::env_cmds::load_config(&root_str);
        cfg["import_aliases_scan_cache"] = json!("not-an-object");
        crate::env_cmds::save_config(&root_str, &cfg).unwrap();
        // 缓存损坏 → 整体作废走全量，结果正确
        let r = scan_import_aliases_impl(&root_str).unwrap();
        assert!(r.iter().any(|h| h.target == "pandas" && h.alias == "pd"));
        // 重扫后缓存被健康结构覆盖写
        let cfg2 = crate::env_cmds::load_config(&root_str);
        assert_eq!(cfg2["import_aliases_scan_cache"]["v"], json!(1));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn import_aliases_from_config_tolerates_garbage() {
        // 字段缺失 / 类型错误 / 条目损坏 → None（绝不 panic，同 dep_ignored 口径）
        assert!(import_aliases_from_config(&json!({})).is_none());
        assert!(import_aliases_from_config(&json!({"import_aliases": "not-an-array"})).is_none());
        assert!(import_aliases_from_config(&json!({"import_aliases": [{"bogus": 1}]})).is_none());
        let v = json!({"import_aliases": [
            {"kind": "module", "target": "pandas", "alias": "pd", "count": 2},
            {"kind": "member", "target": "numpy.array", "alias": "arr", "count": 1}
        ]});
        let hits = import_aliases_from_config(&v).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].target, "pandas");
        assert_eq!(hits[1].kind, "member");
    }

    // ---------- 端点扫描（F1）单测 ----------

    /// FastAPI：@app.get + APIRouter(prefix) + include_router 合并；websocket → WS
    #[test]
    fn endpoints_fastapi_prefix_merge() {
        let d = tmpdir("ep-fastapi");
        fs::write(
            d.join("main.py"),
            "from fastapi import APIRouter, FastAPI\n\
             app = FastAPI()\n\
             router = APIRouter(prefix=\"/api\")\n\
             \n\
             @app.get(\"/health\")\n\
             async def health(): ...\n\
             \n\
             @router.get(\"/users/{uid}\")\n\
             def list_users(uid: int): ...\n\
             \n\
             @router.websocket(\"/ws\")\n\
             async def ws(): ...\n\
             \n\
             app.include_router(router, prefix=\"/v1\")\n",
        )
        .unwrap();
        let r = scan_endpoints_impl(&d.to_string_lossy()).unwrap();
        assert_eq!(r.len(), 3);
        // 按文件 → 行号排序：health(5) / list_users(9) / ws(13)
        assert_eq!(r[0].route, "/health");
        assert_eq!(r[0].method, "GET");
        assert_eq!(r[0].framework, "fastapi");
        assert_eq!(r[0].handler, "health");
        // file 是绝对路径（正斜杠）——openFile → read_file 只认绝对路径（真机复现回归钉死）
        assert!(r[0].file.starts_with('/') || r[0].file.as_bytes()[1] == b':', "file 应为绝对路径: {}", r[0].file);
        assert!(r[0].file.ends_with("/main.py"), "file 应为绝对路径: {}", r[0].file);
        // include 前缀 /v1 + router 前缀 /api + /users/{uid}
        assert_eq!(r[1].route, "/v1/api/users/{uid}");
        assert_eq!(r[1].handler, "list_users");
        assert!(r[1].file.ends_with("/main.py"));
        assert_eq!(r[2].method, "WS");
        assert_eq!(r[2].route, "/v1/api/ws");
    }

    /// Flask：@app.route 默认 GET + methods 多方法 + Blueprint url_prefix 两处来源
    #[test]
    fn endpoints_flask_methods_and_blueprint() {
        let d = tmpdir("ep-flask");
        fs::write(
            d.join("app.py"),
            "from flask import Blueprint, Flask\n\
             app = Flask(__name__)\n\
             bp = Blueprint(\"admin\", __name__, url_prefix=\"/admin\")\n\
             \n\
             @app.route(\"/index\")\n\
             def index(): ...\n\
             \n\
             @app.route(\"/submit\", methods=[\"POST\"])\n\
             def submit(): ...\n\
             \n\
             @bp.route(\"/dash\", methods=[\"GET\", \"POST\"])\n\
             def dash(): ...\n\
             \n\
             app.register_blueprint(bp)\n",
        )
        .unwrap();
        let r = scan_endpoints_impl(&d.to_string_lossy()).unwrap();
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].method, "GET"); // route 无 methods → 默认 GET
        assert_eq!(r[0].route, "/index");
        assert_eq!(r[0].framework, "flask");
        assert_eq!(r[1].method, "POST");
        assert_eq!(r[2].method, "GET/POST"); // 多方法 "/" 连接
        assert_eq!(r[2].route, "/admin/dash"); // register_blueprint 无 url_prefix → 只用 Blueprint 自带
        // 契约：file 绝对路径（见 endpoints_files_readable_by_openfile_consumer）
        assert!(r.iter().all(|e| e.file.starts_with('/') || e.file.as_bytes().get(1) == Some(&b':')));
    }

    /// 边界：非路由装饰器不截断 pending（堆叠装饰器）；未声明对象 → framework=unknown；
    /// 关键字形态 `@app.get(path="/x")` 不得被误判为赋值声明；api_route 缺 methods → GET
    #[test]
    fn endpoints_edges() {
        assert!(ep_parse_router_decl("@app.get(path=\"/x\")").is_none());
        assert_eq!(
            ep_parse_router_decl("api = APIRouter()").map(|(n, f, p)| (n, f.to_string(), p)),
            Some(("api".into(), "fastapi".into(), String::new()))
        );
        // kwarg 的 before 检查：找 "prefix=" 不得命中 "url_prefix="
        assert_eq!(ep_kwarg_string("bp = Blueprint(\"a\", __name__, url_prefix=\"/u\")", "prefix"), None);
        assert_eq!(ep_kwarg_string("bp = Blueprint(\"a\", __name__, url_prefix=\"/u\")", "url_prefix"), Some("/u".into()));
        let d = tmpdir("ep-edges");
        fs::write(
            d.join("svc.py"),
            "from functools import cache\n\
             svc = object()\n\
             \n\
             @svc.get(\"/x\")\n\
             @cache\n\
             def x(): ...\n\
             \n\
             @app.api_route(\"/y\")\n\
             def y(): ...\n",
        )
        .unwrap();
        let r = scan_endpoints_impl(&d.to_string_lossy()).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].framework, "unknown"); // svc 未用已知类声明
        assert_eq!(r[0].handler, "x"); // 堆叠装饰器 @cache 不截断配对
        assert_eq!(r[1].method, "GET"); // api_route 缺 methods → GET
        fs::remove_dir_all(&d).unwrap();
    }

    /// 路由段合并纯函数：空段跳过、全空 → "/"
    #[test]
    fn endpoints_join_route() {
        assert_eq!(ep_join_route(&["/v1", "/api", "/users"]), "/v1/api/users");
        assert_eq!(ep_join_route(&["", "/x"]), "/x");
        assert_eq!(ep_join_route(&["", ""]), "/");
        assert_eq!(ep_join_route(&["v1/", "//users/"]), "/v1/users");
    }

    /// 【消费者契约测试】scan_endpoints 产出的 file 必须能被 openFile → read_file 直接消费。
    ///
    /// 背景（真机缺陷复盘）：file 曾返回相对工作区根路径，而前端 `openFile` → Rust
    /// `read_file` 直接 `fs` 读、只认绝对路径 → 真机上点击每个端点都报「打开文件失败：
    /// 系统找不到指定的路径 (os error 3)」。当时的单测按**实现的相对形状**写断言，把
    /// 错误契约钉死了；本测试改按**消费者需要的形状**断言——对扫描结果的每个 file 直接
    /// 走一次 fs 读取，任何人改回相对路径都会在这里红（E2E mock 桥对相对路径有 join
    /// 兜底，测不出这个缺口，必须由本层契约测试守卫）。
    #[test]
    fn endpoints_files_readable_by_openfile_consumer() {
        let d = tmpdir("ep-contract");
        fs::write(
            d.join("main.py"),
            "from fastapi import FastAPI\n\napp = FastAPI()\n\nMARKER_MAIN = 1\n\n@app.get(\"/health\")\nasync def health(): ...\n",
        )
        .unwrap();
        fs::create_dir_all(d.join("routes")).unwrap();
        fs::write(
            d.join("routes").join("users.py"),
            "from fastapi import APIRouter\n\nrouter = APIRouter()\n\nMARKER_USERS = 2\n\n@router.get(\"/users\")\nasync def users(): ...\n",
        )
        .unwrap();

        let r = scan_endpoints_impl(&d.to_string_lossy()).unwrap();
        assert!(r.len() >= 2, "至少 main.py 与 routes/users.py 各一个端点，实际 {} 项", r.len());
        for ep in &r {
            // 契约 1：绝对路径（正斜杠）
            assert!(
                ep.file.starts_with('/') || ep.file.as_bytes().get(1) == Some(&b':'),
                "file 必须是绝对路径（正斜杠）：{}",
                ep.file
            );
            // 契约 2：可被 read_file 语义直接消费（fs 打开成功且读到工作区内容）
            let content = fs::read_to_string(&ep.file)
                .unwrap_or_else(|e| panic!("read_file 消费失败（{}）：{}", ep.file, e));
            assert!(content.contains("MARKER_"), "读到的不是工作区文件内容：{}", ep.file);
        }
    }

    // ---------- Pydantic 语义层（阶段 4）单测 ----------

    fn pyd_tmpdir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("pylume-pyd-{tag}-{nanos}"));
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 受控语义用例（与 bench/sample/pydantic_models 同款）：类型错 / 缺必填 / 继承合并 / unknown
    #[test]
    fn pydantic_issues_full_semantics() {
        let d = pyd_tmpdir("issues");
        fs::write(
            d.join("models.py"),
            concat!(
                "from pydantic import BaseModel\n",
                "\n",
                "\n",
                "class User(BaseModel):\n",
                "    id: int\n",
                "    name: str\n",
                "    is_active: bool = True\n",
                "\n",
                "\n",
                "class Admin(User):\n",
                "    level: int = 1\n",
            ),
        )
        .unwrap();
        fs::write(
            d.join("usage.py"),
            concat!(
                "from models import Admin, User\n",
                "\n",
                "good = User(id=1, name=\"Alice\")\n",
                "bad_type = User(id=\"not-an-int\", name=\"Steve\")\n",
                "missing = User(id=1)\n",
                "admin = Admin(id=2, name=\"Bob\", level=3)\n",
                "bad_admin = Admin(id=3, level=\"x\")\n",
            ),
        )
        .unwrap();
        let r = scan_pydantic_issues_impl(&d.to_string_lossy()).unwrap();
        // bad_type：id 传 str（type）+ bad_admin：level 传 str（type，继承字段默认值可省）+ missing：缺 name
        // 4 条：bad_type 的 id 类型错（行4）；missing 的 name 缺失（行5）；
        // bad_admin 的 level 类型错（行7）+ name 缺失（行7，Admin 继承 User 必填 name）
        assert_eq!(r.len(), 4, "应恰好 4 条：type×2 + missing×2，实际 {:?}",
            r.iter().map(|i| (i.kind.as_str(), i.field.as_str(), i.line)).collect::<Vec<_>>());
        let types: Vec<_> = r.iter().filter(|i| i.kind == "type").map(|i| (i.field.clone(), i.line)).collect();
        assert!(types.contains(&("id".to_string(), 4)), "bad_type 行的 id 类型错：{:?}", types);
        assert!(types.contains(&("level".to_string(), 7)), "bad_admin 行的 level 类型错（继承链合并）：{:?}", types);
        assert!(r.iter().any(|i| i.kind == "missing" && i.field == "name" && i.line == 5));
        assert!(r.iter().any(|i| i.kind == "missing" && i.field == "name" && i.line == 7), "Admin 继承必填 name");
        fs::remove_dir_all(&d).unwrap();
    }

    /// v2 红线：alias 跳过 / **kwargs 跳过 / 位置参数跳过 / unknown 报告 / 空参数判缺失
    #[test]
    fn pydantic_issues_v2_skip_rules() {
        let d = pyd_tmpdir("v2");
        fs::write(
            d.join("m.py"),
            concat!(
                "from pydantic import BaseModel, Field\n",
                "\n",
                "class M(BaseModel):\n",
                "    a: str = Field(alias=\"a_alias\")\n",
                "    b: int\n",
                "    c: str = \"x\"\n",
            ),
        )
        .unwrap();
        fs::write(
            d.join("u.py"),
            concat!(
                "from m import M\n",
                "\n",
                "x = M(b=1)\n",
                "y = M(a_alias=\"s\", b=2)\n",
                "z = M(**data)\n",
                "w = M(1, 2)\n",
                "v = M(b=1, d=9)\n",
            ),
        )
        .unwrap();
        let r = scan_pydantic_issues_impl(&d.to_string_lossy()).unwrap();
        // x/y/z/w 都不报（alias 跳过含缺失判定；** 与位置参数整行跳过）；
        // v 报 unknown d（c 有默认可省、a 有 alias 缺失不判）。
        // 注意 `z = M(**data)` 与 `w = M(1, 2)` 行内含引号前的嵌套括号不影响——
        // `w = M(1, 2)` 首参位置参数整点跳过；`z` 含 ** 跳过。
        assert_eq!(r.len(), 1, "只应报 v 行的 unknown d，实际 {:?}", r);
        assert_eq!(r[0].kind, "unknown");
        assert_eq!(r[0].field, "d");
        assert_eq!(r[0].line, 7);
        // 空参数判缺失：M() 缺 b
        fs::write(d.join("u.py"), "from m import M\n\nv = M()\n").unwrap();
        let r2 = scan_pydantic_issues_impl(&d.to_string_lossy()).unwrap();
        assert!(r2.iter().any(|i| i.kind == "missing" && i.field == "b"), "M() 应缺必填 b：{:?}", r2);
        fs::remove_dir_all(&d).unwrap();
    }

    /// 非模型类不产生诊断；def Model( / 同前缀类名不误命中
    #[test]
    fn pydantic_issues_no_false_positive() {
        let d = pyd_tmpdir("nfp");
        fs::write(
            d.join("a.py"),
            concat!(
                "class Plain:\n",
                "    x: int\n",
                "\n",
                "def Model():\n",
                "    return 1\n",
                "\n",
                "class MyModel(BaseModel):\n",
                "    y: int\n",
            ),
        )
        .unwrap();
        fs::write(
            d.join("b.py"),
            concat!(
                "from a import MyModel\n",
                "\n",
                "p = Plain(x=1)\n",
                "m = MyModel(y=\"s\")\n",
            ),
        )
        .unwrap();
        let r = scan_pydantic_issues_impl(&d.to_string_lossy()).unwrap();
        // Plain 非 BaseModel 链：不报；def Model() 非调用：不报；MyModel(y=\"s\")：报 type
        assert_eq!(r.len(), 1, "只应报 MyModel(y=\"s\") 的 type，实际 {:?}", r);
        assert_eq!(r[0].kind, "type");
        assert_eq!(r[0].model, "MyModel");
        fs::remove_dir_all(&d).unwrap();
    }

    /// rename 传播补充：`Model(field=` 命中 / 同前缀字段不命中 / 非调用行不命中
    #[test]
    fn pydantic_ctor_refs_semantics() {
        let d = pyd_tmpdir("refs");
        fs::write(
            d.join("m.py"),
            concat!(
                "from pydantic import BaseModel\n",
                "\n",
                "class User(BaseModel):\n",
                "    name: str\n",
            ),
        )
        .unwrap();
        fs::write(
            d.join("u.py"),
            concat!(
                "from m import User\n",
                "\n",
                "a = User(name=\"x\")\n",
                "b = User(  name = 2)\n",
                "c = User(user_name=\"y\")\n",
                "d = User(name)\n",
                "\n",
                "name = User(name=\"z\")\n",
                "e = \"User(name=1)\"\n",
            ),
        )
        .unwrap();
        let r = scan_pydantic_ctor_refs_impl(&d.to_string_lossy(), "User", "name").unwrap();
        // 行 3（紧邻）/ 行 4（空白容忍）/ 行 8（赋值行右侧调用）命中；
        // 行 5 user_name= 不命中；行 6 name 无 = 不命中；行 9 字符串内不命中（引号状态机）
        assert_eq!(r.len(), 3, "应命中 3 处（行3/4/8），实际 {:?}", r);
        let lines: Vec<u32> = r.iter().map(|x| x.line).collect();
        assert_eq!(lines, vec![3, 4, 8]);
        // 列号：行 3 `a = User(name=...)` → name 起始列 10（1 基）
        assert_eq!(r[0].column, 10, "行3 name 列号");
        assert_eq!(r[0].len, 4);
        fs::remove_dir_all(&d).unwrap();
    }

    /// 开销红线实测（§5：受控用例全量 < 500ms）：对 bench/sample/pydantic_models 计时。
    /// ignored + 手动跑：cargo test --release pyd_bench -- --ignored --nocapture
    #[test]
    #[ignore]
    fn pyd_bench_scan_issues() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../bench/sample/pydantic_models");
        for i in 0..5 {
            let t = std::time::Instant::now();
            let n = scan_pydantic_issues_impl(root).unwrap().len();
            println!("run {}: {} issues in {:?}", i + 1, n, t.elapsed());
        }
    }

    /// 复核修复回归（2026-09-29）：中文值字面量的字符列号 / 嵌套调用 / 注释剥离
    #[test]
    fn pydantic_review_fixes() {
        let d = pyd_tmpdir("review");
        fs::write(
            d.join("m.py"),
            concat!(
                "from pydantic import BaseModel\n",
                "\n",
                "class User(BaseModel):  # 用户模型\n",
                "    name: str  # 姓名\n",
                "    id: int\n",
            ),
        )
        .unwrap();
        fs::write(
            d.join("u.py"),
            concat!(
                "from m import User\n",
                "\n",
                "a = User(name=\"中文字符串\", id=1)\n",
                "b = wrap(User(name=\"x\", id=2), extra=3)\n",
                "c = User(name=\"y\", id=3)  # User(name=错, id=0)\n",
            ),
        )
        .unwrap();
        let r = scan_pydantic_issues_impl(&d.to_string_lossy()).unwrap();
        // 行3：中文串后 id 列号必须按字符算（旧字节列会偏移）；行4 嵌套：extra 不算 User 参数；
        // 行5 注释里的调用不诊断。三条调用点全部正确传参 → 零诊断
        assert_eq!(r.len(), 0, "三行调用点均合法，不应有诊断，实际 {:?}", r);

        // 列号精确性：构造含中文前缀的坏参行，验证 type 诊断的 column 落在参数名上
        fs::write(
            d.join("u.py"),
            concat!(
                "from m import User\n",
                "\n",
                "a = User(name=\"中文\", id=\"bad\")\n",
            ),
        )
        .unwrap();
        let r2 = scan_pydantic_issues_impl(&d.to_string_lossy()).unwrap();
        assert_eq!(r2.len(), 1, "id 传 str 应报 type：{:?}", r2);
        // `a = User(name="中文", id="bad")`：id 的 1 基字符列 = 21
        assert_eq!(r2[0].column, 21, "列号必须按字符算（中文场景），实际 {}", r2[0].column);

        // 旧实现的真正错位场景：`(` 之前有非 ASCII（旧 base 按字节偏移直加）
        fs::write(
            d.join("u.py"),
            concat!(
                "from m import User\n",
                "\n",
                "变量 = User(name=\"x\", id=\"bad\")\n",
            ),
        )
        .unwrap();
        let r3 = scan_pydantic_issues_impl(&d.to_string_lossy()).unwrap();
        assert_eq!(r3.len(), 1, "id 传 str 应报 type：{:?}", r3);
        // `变量 = User(...)`：`变`(1)`量`(2)` `(3)`=`(4)` `(5)U(6)s(7)e(8)r(9)`(`(10)n(11)...
        // id 的 1 基字符列 = 21；旧字节算法 `(` 在字节 12 → base 13 → 会报 24
        assert_eq!(r3[0].column, 21, "（ 前有中文时列号仍须按字符算，实际 {}", r3[0].column);

        // ctor_refs：注释里的 field= 不命中；列号按字符算
        let refs = scan_pydantic_ctor_refs_impl(&d.to_string_lossy(), "User", "name").unwrap();
        assert!(refs.iter().all(|x| x.line == 3), "只应命中行3，实际 {:?}", refs);
        // 行3 `变量 = User(name="x", id="bad")`：name 的 1 基字符列 = 11
        assert_eq!(refs[0].column, 11, "name 列号按字符算，实际 {}", refs[0].column);
        fs::remove_dir_all(&d).unwrap();
    }

    /// 复核修复回归：子类调用点传播（User.name 改名 → Admin(name=) 也命中）
    #[test]
    fn pydantic_ctor_refs_subclass() {
        let d = pyd_tmpdir("sub");
        fs::write(
            d.join("m.py"),
            concat!(
                "from pydantic import BaseModel\n",
                "\n",
                "class User(BaseModel):\n",
                "    name: str\n",
                "\n",
                "\n",
                "class Admin(User):\n",
                "    level: int = 1\n",
            ),
        )
        .unwrap();
        fs::write(
            d.join("u.py"),
            concat!(
                "from m import Admin, User\n",
                "\n",
                "a = User(name=\"x\")\n",
                "b = Admin(name=\"y\", level=2)\n",
                "c = Admin(level=3)  # 独立字段 rename 不应命中 User.name\n",
            ),
        )
        .unwrap();
        // User.name → 两处调用点（User 直调 + Admin 子类调用）
        let r = scan_pydantic_ctor_refs_impl(&d.to_string_lossy(), "User", "name").unwrap();
        assert_eq!(r.len(), 2, "User(name=) 与 Admin(name=) 都应命中，实际 {:?}", r);
        let lines: Vec<u32> = r.iter().map(|x| x.line).collect();
        assert_eq!(lines, vec![3, 4]);
        // Admin.level → Admin 自己的两处调用点（行4 b 与行5 c）；User(name=) 无 level 不命中
        let r2 = scan_pydantic_ctor_refs_impl(&d.to_string_lossy(), "Admin", "level").unwrap();
        assert_eq!(r2.len(), 2, "Admin 两处构造调用都应命中 level，实际 {:?}", r2);
        let lines2: Vec<u32> = r2.iter().map(|x| x.line).collect();
        assert_eq!(lines2, vec![4, 5]);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn test_list_workspace_files() {
        let base = tmpdir("filelist");
        fs::write(base.join("a.py"), "x=1").unwrap();
        fs::create_dir_all(base.join("pkg")).unwrap();
        fs::write(base.join("pkg").join("b.py"), "y=2").unwrap();
        // 噪声/忽略目录不出现（与 search_workspace 同一走查口径）
        fs::create_dir_all(base.join(".venv")).unwrap();
        fs::write(base.join(".venv").join("c.py"), "z=3").unwrap();

        let files = list_workspace_files_impl(&base.to_string_lossy()).unwrap();
        assert_eq!(files.len(), 2, "只应有 a.py 与 pkg/b.py");
        assert!(files.iter().all(|p| !p.contains(".venv")));
        // 按路径排序（稳定输出，前端可直接按序渲染）
        let mut sorted = files.clone();
        sorted.sort();
        assert_eq!(files, sorted);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn test_list_workspace_dirs() {
        let base = tmpdir("dirlist");
        fs::create_dir_all(base.join("src").join("pkg")).unwrap();
        fs::write(base.join("src").join("a.py"), "x=1").unwrap();
        // 噪声目录（.venv 在 SEARCH_IGNORED_DIRS + hidden 双重过滤）不应出现
        fs::create_dir_all(base.join(".venv").join("lib")).unwrap();

        let dirs = list_workspace_dirs_impl(&base.to_string_lossy()).unwrap();
        assert!(dirs.contains(&"src".to_string()), "应含 src");
        assert!(dirs.contains(&"src/pkg".to_string()), "应含 src/pkg（正斜杠相对路径）");
        assert!(!dirs.iter().any(|d| d.contains(".venv")), "噪声目录应被剪枝");
        assert!(!dirs.iter().any(|d| d.is_empty()), "不含根自身（空串）");
        // 排序 + 去重
        let mut sorted = dirs.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(dirs, sorted);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn create_scratch_picks_next_free_number() {
        let d = tmpdir("scratch");
        let a = create_scratch_in(&d, ".py").unwrap();
        assert_eq!(a.file_name().unwrap().to_string_lossy(), "scratch-1.py");
        // .py 草稿带可直接运行的骨架（含 __main__ 守卫）
        let body = fs::read_to_string(&a).unwrap();
        assert!(body.contains("if __name__"));
        let b = create_scratch_in(&d, "py").unwrap(); // 无点前缀也应补上
        assert_eq!(b.file_name().unwrap().to_string_lossy(), "scratch-2.py");
        let c = create_scratch_in(&d, ".md").unwrap();
        assert_eq!(c.file_name().unwrap().to_string_lossy(), "scratch-3.md");
        assert_eq!(fs::read_to_string(&c).unwrap(), ""); // 非 Python 草稿是空文件
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn parse_ruff_json_maps_diagnostics() {
        let raw = r#"[
            {"code":"F401","message":"`os` imported but unused","location":{"row":1,"column":8},"end_location":{"row":1,"column":10}},
            {"code":null,"message":"no code","location":{"row":7,"column":2}}
        ]"#;
        let got = parse_ruff_json(raw);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].code.as_deref(), Some("F401"));
        assert_eq!(got[0].line, 1);
        assert_eq!(got[0].column, 8);
        assert_eq!(got[0].end_line, 1);
        assert_eq!(got[0].end_column, 10);
        // code 缺失 → None；end_location 缺失 → 退化为「起点 + 1 列」
        assert_eq!(got[1].code, None);
        assert_eq!(got[1].end_column, 3);
    }

    #[test]
    fn parse_ruff_json_tolerates_garbage() {
        // 非 JSON / 非数组 / 缺 message / 空数组：一律返回空，不报错
        assert!(parse_ruff_json("not json").is_empty());
        assert!(parse_ruff_json("{}").is_empty());
        assert!(parse_ruff_json("[]").is_empty());
        assert!(parse_ruff_json(r#"[{"code":"E1"}]"#).is_empty());
    }

    #[test]
    fn list_workspace_files_rejects_missing_root() {
        let missing = std::env::temp_dir().join("pylume-file-list-missing-dir");
        assert!(list_workspace_files_impl(&missing.to_string_lossy()).is_err());
    }
}
