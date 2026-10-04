// 工具解析层（Phase 4 打包部署 · 第 1 步）：统一外部命令（uv / pyrefly / ruff / git 等）的定位规则。
//
// 背景：当前 shell 直接 `Command::new("uv")` / `Command::new("pyrefly")` 等裸调 PATH，
// 全新系统缺这些工具时只会得到「无法启动」报错，无法进入可引导状态。
// 本模块把「工具在哪」收敛到一个解析点，后续第 2~5 步再在其上叠加
// 「资源目录解压 + 首次启动引导安装」，本层只做解析、不做安装。
//
// 解析优先级：
//   1. 环境变量显式指定（如 PYLUME_UV_BIN，值须为现存文件的路径）；
//   2. uv 官方默认用户级安装目录 ~/.local/bin/<name>[.exe]（引导安装落点，无需刷新 PATH 即可命中）；
//   3. 均未命中 → 回退 Command::new(name)（走系统 PATH，保持现状行为，开发态零破坏）。

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::util::{pylume_home, user_home};

// 各工具的环境变量 override 名（约定为完整路径或二进制名，便于 CI / 用户注入）
pub const ENV_UV: &str = "PYLUME_UV_BIN";
pub const ENV_RUFF: &str = "PYLUME_RUFF_BIN";
pub const ENV_GIT: &str = "PYLUME_GIT_BIN";

/// 为 uv 子进程注入 PyPI 包源（值来自设置项 `Settings.pypi_index`，默认官方源；
/// 国内网络可在设置面板「Python → PyPI 镜像源」切镜像，规避 files.pythonhosted.org
/// 在部分网络下连接重置）。用户已显式设置 `UV_DEFAULT_INDEX` / `UV_INDEX_URL` 时保持原样。
fn inject_pypi_mirror(cmd: &mut Command) {
    if std::env::var("UV_DEFAULT_INDEX").is_err() && std::env::var("UV_INDEX_URL").is_err() {
        let index = crate::settings::load().pypi_index.trim().to_string();
        if !index.is_empty() {
            cmd.env("UV_DEFAULT_INDEX", index);
        }
    }
}

/// Pylume 运行时组件目录：<data_root>/runtime（放置随包分发的自研组件——
/// pylume-intel 二进制、probe/src 源码等，见第 2 步 locate_* 函数）。
pub fn runtime_dir() -> PathBuf {
    pylume_home().join("runtime")
}

/// uv / uv tool 的默认用户级安装目录：~/.local/bin（Windows：%USERPROFILE%\\.local\\bin）。
/// uv 官方 install.ps1 与 `uv tool install` 均默认安装到这里，
/// 因此把该目录纳入解析候选，引导安装后无需新 shell 刷新 PATH 即可命中。
pub fn local_bin_dir() -> PathBuf {
    user_home().join(".local").join("bin")
}

/// Windows 下补 `.exe` 候选名（已带 `.exe` 则不重复追加）；其他平台原样。
fn candidates(name: &str) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        if name.to_ascii_lowercase().ends_with(".exe") {
            vec![PathBuf::from(name)]
        } else {
            vec![PathBuf::from(format!("{name}.exe")), PathBuf::from(name)]
        }
    }
    #[cfg(not(windows))]
    {
        vec![PathBuf::from(name)]
    }
}

/// 在给定目录列表中查找首个存在的工具二进制。
fn find_in_dirs(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    for dir in dirs {
        for cand in candidates(name) {
            let p = dir.join(cand);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// 定位工具：环境变量 override → uv 官方默认用户级安装目录（~/.local/bin）；
/// 未命中返回 None（调用方回退 PATH）。
pub fn resolve_tool(name: &str, env_override: &str) -> Option<PathBuf> {
    if !env_override.is_empty() {
        if let Ok(p) = std::env::var(env_override) {
            let p = PathBuf::from(p);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    find_in_dirs(name, &[local_bin_dir()])
}

/// 在系统 PATH 中查找工具二进制（用于探测；较目录探测慢，仅首次启动/引导时调用）。
pub(crate) fn find_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var("PATH").ok()?;
    let sep = if cfg!(windows) { ';' } else { ':' };
    for dir in path_var.split(sep) {
        if dir.is_empty() {
            continue;
        }
        for cand in candidates(name) {
            let p = Path::new(dir).join(cand);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// 工具是否可用：环境变量 / ~/.local/bin 命中，或系统 PATH 中存在。
pub fn is_available(name: &str, env_override: &str) -> bool {
    resolve_tool(name, env_override).is_some() || find_on_path(name).is_some()
}

/// 构造工具命令：命中绝对路径则直接使用，否则回退原命令名（走系统 PATH）。
/// 不注入 UV_CACHE_DIR / UV_TOOL_DIR——uv 与其工具链是用户级跨项目资产，
/// 使用用户自有缓存与工具目录（uv 工具所有权原则，见 docs/data-directory-layout-v2.md §4.2）。
pub fn tool_command(name: &str, env_override: &str) -> Command {
    let resolved = resolve_tool(name, env_override);
    let mut cmd = resolved
        .as_ref()
        .map_or_else(|| Command::new(name), |p| Command::new(p));
    if name == "uv" {
        // 所有 uv 网络操作（tool install / pip install / uv add / uv run 等）统一走设置中的 PyPI 包源
        inject_pypi_mirror(&mut cmd);
    }
    cmd
}

/// 构造 LSP 引擎命令：前端传入的 `command` 可能是「绝对/相对路径」或「裸命令名」。
/// 已是路径 → 原样使用；裸命令名 → 走工具解析（~/.local/bin 优先，回退 PATH）。
pub fn resolve_lsp_command(command: &str) -> Command {
    let cmd = command.trim();
    if cmd.is_empty() {
        return Command::new(command);
    }
    if Path::new(cmd).is_absolute() || cmd.contains('\\') || cmd.contains('/') {
        return Command::new(cmd);
    }
    tool_command(cmd, "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmpdir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("pylume-tool-path-{tag}-{nanos}"));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn find_in_dirs_hits_existing_binary() {
        let dir = tmpdir("hit");
        let bin = dir.join(if cfg!(windows) { "uv.exe" } else { "uv" });
        std::fs::write(&bin, "").unwrap();
        let found = find_in_dirs("uv", &[dir.clone()]).expect("应命中已存在的二进制");
        assert_eq!(found, bin);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn find_in_dirs_misses_nonexistent() {
        let dir = tmpdir("miss");
        assert!(find_in_dirs("no-such-tool", &[dir.clone()]).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn candidates_appends_exe_on_windows() {
        let cands = candidates("uv");
        let names: Vec<String> = cands
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        #[cfg(windows)]
        {
            assert_eq!(names, vec!["uv.exe".to_string(), "uv".to_string()]);
        }
        #[cfg(not(windows))]
        {
            assert_eq!(names, vec!["uv".to_string()]);
        }
        // 已带 .exe 不重复追加
        let cands2 = candidates("x.exe");
        assert_eq!(cands2.len(), 1);
    }

    #[test]
    fn resolve_lsp_command_keeps_absolute_path() {
        let input = if cfg!(windows) { r"C:\tools\pyrefly.exe" } else { "/usr/local/bin/pyrefly" };
        let cmd = resolve_lsp_command(input);
        assert_eq!(cmd.get_program().to_string_lossy(), input);
    }

    #[test]
    fn resolve_lsp_command_falls_back_to_bare_name() {
        // 用必然不存在的工具名，避免受本机工具环境干扰
        let cmd = resolve_lsp_command("__pylume_no_such_lsp__");
        assert_eq!(cmd.get_program().to_string_lossy(), "__pylume_no_such_lsp__");
    }
}