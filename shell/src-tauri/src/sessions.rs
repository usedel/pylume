// 会话快照（A-5，PyCharm 调研）：重开工作区后恢复 tab / 光标 / 未保存草稿。
//
// 与本地历史（history.rs）的区别：本地历史存**逐次保存的内容版本**（可回退任意一版）；
// 这里只存「当前这一刻的工作现场」——打开的标签、光标落在哪、哪些文件还没保存——
// 每次变更覆盖同一份文件。两者互补，不合并。
//
// 落盘：<data_root>/sessions/<project_hash>.json（与断点 / 书签同口径，见 file_ops.rs）。
// 路径一律存**工作区相对路径**：换盘符、大小写变化、目录改名都不影响恢复。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::file_ops::project_hash;
use crate::util::pylume_home;

/// 快照里单个标签页的状态
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    /// 工作区相对路径
    pub path: String,
    /// 光标位置（1-based）
    pub line: u32,
    pub column: u32,
    /// 未保存内容（仅 dirty 的标签携带）；None = 与磁盘一致
    pub draft: Option<String>,
}

/// 会话快照整体
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub tabs: Vec<SessionTab>,
    /// 恢复后要激活的标签（相对路径；None = 激活最后一个）
    pub active: Option<String>,
}

/// 快照上限（G-1 红线：任何持久化结构都要有上限，防止无界增长）
const MAX_TABS: usize = 40;

fn session_path(root: &str) -> PathBuf {
    pylume_home()
        .join("sessions")
        .join(format!("{}.json", project_hash(root)))
}

/// 相对路径合法性：拒绝空 / 超长 / 绝对路径 / 盘符 / `..`（防快照被手改或跨工作区复用时越权）
fn valid_rel(p: &str) -> bool {
    if p.is_empty() || p.len() > 512 {
        return false;
    }
    if p.contains("..") {
        return false;
    }
    if p.starts_with('/') || p.starts_with('\\') {
        return false;
    }
    if p.chars().nth(1) == Some(':') {
        return false; // C:\…
    }
    true
}

fn sanitize(mut st: SessionState) -> SessionState {
    st.tabs.retain(|t| valid_rel(&t.path));
    if st.tabs.len() > MAX_TABS {
        st.tabs.truncate(MAX_TABS);
    }
    if let Some(a) = &st.active {
        if !valid_rel(a) {
            st.active = None;
        }
    }
    st
}

/// 读取工作区会话快照（无文件 / 坏文件 → 空快照，不报错：恢复失败不该阻断启动）
#[tauri::command]
pub fn get_session(root: String) -> Result<SessionState, String> {
    let p = session_path(&root);
    if !p.is_file() {
        return Ok(SessionState::default());
    }
    let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let st: SessionState = serde_json::from_str(&s).unwrap_or_default();
    Ok(sanitize(st))
}

/// 写入工作区会话快照（覆盖式）
#[tauri::command]
pub fn save_session(root: String, state: SessionState) -> Result<(), String> {
    let p = session_path(&root);
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(&sanitize(state)).map_err(|e| e.to_string())?;
    fs::write(&p, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_rel_accepts_normal_relative_paths() {
        assert!(valid_rel("main.py"));
        assert!(valid_rel("pkg/mod.py"));
        assert!(valid_rel("a/b/c/d.py"));
    }

    #[test]
    fn valid_rel_rejects_absolute_and_traversal() {
        assert!(!valid_rel(""));
        assert!(!valid_rel("../outside.py"));
        assert!(!valid_rel("a/../../b.py"));
        assert!(!valid_rel("/etc/passwd"));
        assert!(!valid_rel("C:\\secret.py"));
        assert!(!valid_rel("\\\\server\\share\\x.py"));
        assert!(!valid_rel(&"x".repeat(600)));
    }

    #[test]
    fn sanitize_drops_bad_tabs_and_caps_count() {
        let st = SessionState {
            tabs: vec![
                SessionTab { path: "ok.py".into(), line: 1, column: 1, draft: None },
                SessionTab { path: "../bad.py".into(), line: 1, column: 1, draft: None },
            ],
            active: Some("/abs.py".into()),
        };
        let got = sanitize(st);
        assert_eq!(got.tabs.len(), 1);
        assert_eq!(got.tabs[0].path, "ok.py");
        assert_eq!(got.active, None); // 非法 active 一并清掉

        let many = SessionState {
            tabs: (0..MAX_TABS + 5)
                .map(|i| SessionTab { path: format!("f{i}.py"), line: 1, column: 1, draft: None })
                .collect(),
            active: None,
        };
        assert_eq!(sanitize(many).tabs.len(), MAX_TABS);
    }
}
