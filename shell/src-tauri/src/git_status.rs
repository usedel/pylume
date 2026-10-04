// Git 状态读取：解析 `git status --porcelain=v1 -z` 输出，为文件树状态标记与 SCM 面板提供数据。
// 设计要点：
// - 异步执行（大仓库 git status 可能耗时）；
// - `-z`（NUL 分隔）彻底规避空格/引号/特殊字符歧义；`-c core.quotepath=false` 关闭非 ASCII 八进制转义；
// - 状态码语义：未跟踪返回 `?`，未合并冲突返回 `!`，其余取 `M/A/D/R` 等；
// - 非 git 仓库或无 git 命令时返回空列表（静默降级）。

use serde::Serialize;
use std::path::Path;

use crate::tool_paths::{tool_command, ENV_GIT};
use crate::util::no_window;

/// 单个变更文件的语义化状态。
#[derive(Serialize)]
pub struct GitStatusFile {
    /// 相对路径（`/` 分隔，相对仓库根）
    pub path: String,
    /// 暂存区（index）状态：' '、'M'、'A'、'D'、'R'、'?'、'U' 等
    pub x: char,
    /// 工作区状态：同上
    pub y: char,
    /// 合并后的展示状态码（用于 badge / 分组）：M / A / D / R / ? / !
    pub code: String,
}

#[derive(Serialize)]
pub struct GitStatusResult {
    /// 是否为 git 仓库
    pub is_git: bool,
    /// 当前分支名（detached HEAD 或非仓库时为 None）
    pub current_branch: Option<String>,
    /// 变更文件列表（按路径排序）
    pub files: Vec<GitStatusFile>,
}

/// 获取工作区 git 状态（`--porcelain=v1 -z` 格式解析）
#[tauri::command]
pub async fn git_status(root: String, paths: Option<Vec<String>>) -> Result<GitStatusResult, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_impl(&root, paths.as_deref()))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn git_status_impl(root: &str, paths: Option<&[String]>) -> Result<GitStatusResult, String> {
    let empty = || GitStatusResult { is_git: false, current_branch: None, files: Vec::new() };
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Ok(empty());
    }

    let mut cmd = tool_command("git", ENV_GIT);
    cmd.args(["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "-u"])
        .current_dir(root);

    // 增量查询：仅统计指定相对路径（目录会递归展开），避免大仓库全量扫描（TD-002）
    if let Some(paths) = paths {
        if !paths.is_empty() {
            cmd.arg("--");
            for p in paths {
                cmd.arg(p);
            }
        }
    }

    let out = match no_window(&mut cmd).output() {
        Ok(o) => o,
        Err(_) => return Ok(empty()),
    };
    if !out.status.success() {
        // 非 git 仓库或其他错误
        return Ok(empty());
    }

    let mut files = parse_porcelain_z(&out.stdout);
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let current_branch = current_branch(root);
    Ok(GitStatusResult { is_git: true, current_branch, files })
}

/// 获取当前分支名（detached HEAD 或失败时返回 None）。
fn current_branch(root: &str) -> Option<String> {
    let mut cmd = tool_command("git", ENV_GIT);
    cmd.arg("branch").arg("--show-current").current_dir(root);
    let out = no_window(&mut cmd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// 解析 `--porcelain=v1 -z` 输出。
/// 每个条目：`XY <path>\0`；重命名/复制为 `XY <orig>\0<dest>\0`（两个字段）。
fn parse_porcelain_z(stdout: &[u8]) -> Vec<GitStatusFile> {
    let mut files = Vec::new();
    let mut fields = stdout.split(|&b| b == 0);
    while let Some(field) = fields.next() {
        if field.len() < 4 {
            continue;
        }
        let x = field[0];
        let y = field[1];

        // 重命名/复制：下一个字段是目标路径（取新路径展示）
        let is_rename = x == b'R' || x == b'C';
        let (display_path, code) = if is_rename {
            let dest = match fields.next() {
                Some(d) => String::from_utf8_lossy(d).to_string(),
                None => continue, // 数据损坏，跳过
            };
            (dest, status_code(x, y))
        } else {
            (String::from_utf8_lossy(&field[3..]).to_string(), status_code(x, y))
        };

        if code.is_empty() {
            continue;
        }
        files.push(GitStatusFile {
            path: display_path,
            x: x as char,
            y: y as char,
            code,
        });
    }
    files
}

/// 将 porcelain 的 XY 状态两字符合并为单一展示码：
/// - `??` → `?`（未跟踪）
/// - 未合并冲突（双方非空格且均非 M，如 UU/AA/DD/AU/UD/UA/DU）→ `!`
/// - 其余优先工作区（Y），其次暂存区（X）
fn status_code(x: u8, y: u8) -> String {
    if x == b'?' && y == b'?' {
        return "?".to_string();
    }
    if x != b' ' && y != b' ' && x != b'M' && y != b'M' {
        return "!".to_string();
    }
    if y != b' ' {
        return (y as char).to_string();
    }
    if x != b' ' {
        return (x as char).to_string();
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_git_status_non_git_dir() {
        let tmp = std::env::temp_dir().join("pylume-git-test-nongit");
        std::fs::create_dir_all(&tmp).unwrap();
        let r = git_status_impl(tmp.to_str().unwrap(), None).unwrap();
        assert!(!r.is_git);
        assert!(r.current_branch.is_none());
        assert!(r.files.is_empty());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_parse_porcelain_z_basic() {
        // 普通修改 / 暂存新增 / 未跟踪 / 删除，含带空格路径
        // " M file with space.py\0A  staged.py\0?? untracked.py\0 D removed.py\0"
        let mut buf = Vec::new();
        buf.extend_from_slice(b" M file with space.py\0");
        buf.extend_from_slice(b"A  staged.py\0");
        buf.extend_from_slice(b"?? untracked.py\0");
        buf.extend_from_slice(b" D removed.py\0");
        let files = parse_porcelain_z(&buf);
        assert_eq!(files.len(), 4);

        let m = files.iter().find(|f| f.path == "file with space.py").unwrap();
        assert_eq!(m.code, "M");
        assert_eq!(m.x, ' ');
        assert_eq!(m.y, 'M');

        let a = files.iter().find(|f| f.path == "staged.py").unwrap();
        assert_eq!(a.code, "A");

        let u = files.iter().find(|f| f.path == "untracked.py").unwrap();
        assert_eq!(u.code, "?");

        let d = files.iter().find(|f| f.path == "removed.py").unwrap();
        assert_eq!(d.code, "D");
    }

    #[test]
    fn test_parse_porcelain_z_rename() {
        // 重命名：R  old.py\0new.py\0（取新路径）
        let mut buf = Vec::new();
        buf.extend_from_slice(b"R  old.py\0new.py\0");
        let files = parse_porcelain_z(&buf);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "new.py");
        assert_eq!(files[0].code, "R");
        assert_eq!(files[0].x, 'R');
    }

    #[test]
    fn test_parse_porcelain_z_conflict_and_untracked() {
        // 未合并冲突（UU）→ !；未跟踪（??）→ ?；双重修改（MM）→ M
        let mut buf = Vec::new();
        buf.extend_from_slice(b"UU conflict.py\0");
        buf.extend_from_slice(b"?? new.py\0");
        buf.extend_from_slice(b"MM both.py\0");
        let files = parse_porcelain_z(&buf);
        assert_eq!(files.len(), 3);

        let c = files.iter().find(|f| f.path == "conflict.py").unwrap();
        assert_eq!(c.code, "!");

        let u = files.iter().find(|f| f.path == "new.py").unwrap();
        assert_eq!(u.code, "?");

        let b = files.iter().find(|f| f.path == "both.py").unwrap();
        assert_eq!(b.code, "M");
    }

    #[test]
    fn test_status_code_mapping() {
        assert_eq!(status_code(b'?', b'?'), "?");
        assert_eq!(status_code(b'U', b'U'), "!");
        assert_eq!(status_code(b'D', b'D'), "!");
        assert_eq!(status_code(b'A', b'A'), "!");
        assert_eq!(status_code(b'M', b'M'), "M");
        assert_eq!(status_code(b' ', b'M'), "M");
        assert_eq!(status_code(b'M', b' '), "M");
        assert_eq!(status_code(b'A', b' '), "A");
        assert_eq!(status_code(b' ', b'D'), "D");
        assert_eq!(status_code(b' ', b' '), "");
    }
}