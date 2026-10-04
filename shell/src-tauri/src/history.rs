// 本地历史（Local History，P1）：保存时自动快照，可在没有 Git 的工作区里回看与回滚。
// 存储布局：<data_root>/history/<project_hash>/<file_hash>/<epoch_millis>-<kind>.txt

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::command;

use crate::file_ops::project_hash;
use crate::util::pylume_home;

/// 单文件保留的快照上限（超出按时间淘汰最旧的）
const MAX_ENTRIES_PER_FILE: usize = 100;

/// 快照种类：save（保存前自动）/ manual（用户手动标记）/ restore（回滚前的现场）
const KIND_SAVE: &str = "save";
const KIND_MANUAL: &str = "manual";
const KIND_RESTORE: &str = "restore";

/// 允许的种类集合（id 校验白名单，防路径穿越）
const KINDS: [&str; 3] = [KIND_SAVE, KIND_MANUAL, KIND_RESTORE];

#[derive(Serialize, Clone)]
pub struct HistoryEntry {
    pub id: String,
    pub ts: i64,
    pub kind: String,
    pub size: u64,
}

// ---------- 路径 ----------

/// 某文件在其工作区下的哈希键（sha1 前 16 位 hex）
fn file_hash(workspace_root: &str, path: &str) -> String {
    use sha1::{Digest, Sha1};
    let rel = relative_key(workspace_root, path);
    let mut hasher = Sha1::new();
    hasher.update(rel.as_bytes());
    let digest = hasher.finalize();
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// 相对键：相对工作区根、统一正斜杠（与 env_cmds::run_config_key 同口径，跨平台稳定）
fn relative_key(workspace_root: &str, path: &str) -> String {
    let norm_root = workspace_root.replace('\\', "/");
    let norm_path = path.replace('\\', "/");
    let r = norm_root.trim_end_matches('/');
    if !r.is_empty() {
        if let Some(rest) = norm_path.strip_prefix(r) {
            let rest = rest.trim_start_matches('/');
            if !rest.is_empty() {
                return rest.to_string();
            }
        }
    }
    norm_path
}

fn history_dir(workspace_root: &str, path: &str) -> PathBuf {
    pylume_home()
        .join("history")
        .join(project_hash(workspace_root))
        .join(file_hash(workspace_root, path))
}

// ---------- 内部实现 ----------

/// 列出目录下的快照（按时间从新到旧）
fn collect(dir: &Path) -> Vec<HistoryEntry> {
    let mut out: Vec<HistoryEntry> = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else {
        return out;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(ts) = parse_entry(&name) else { continue };
        let size = fs::metadata(e.path()).map(|m| m.len()).unwrap_or(0);
        let kind = name.rsplit_once('-').map(|(_, k)| k.to_string()).unwrap_or_default();
        out.push(HistoryEntry { id: name, ts, kind, size });
    }
    out.sort_by(|a, b| b.ts.cmp(&a.ts).then(a.id.cmp(&b.id)));
    out
}

/// 解析快照文件名得到时间戳；非法（含路径穿越字符或非本模块格式）返回 None
fn parse_entry(name: &str) -> Option<i64> {
    let slash = name.contains('/') || name.contains('\\');
    if slash {
        return None;
    }
    let (ts_raw, kind) = name.rsplit_once('-')?;
    if !KINDS.contains(&kind) || ts_raw.is_empty() || !ts_raw.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    ts_raw.parse::<i64>().ok()
}

/// id 合法性（history_read / history_restore 的入参来自前端，必须白名单校验）
fn valid_id(id: &str) -> bool {
    parse_entry(id).is_some()
}

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// 写入一版快照；与最新一版内容相同则跳过（连续保存不刷出重复条目）。
/// 返回新条目（跳过时返回 None）。
fn write_snapshot(dir: &Path, content: &str, kind: &str) -> Result<Option<HistoryEntry>, String> {
    let latest = collect(dir).first().map(|e| e.id.clone());
    if let Some(id) = latest {
        if let Ok(old) = fs::read_to_string(dir.join(&id)) {
            if old == content {
                return Ok(None);
            }
        }
    }
    fs::create_dir_all(dir).map_err(|e| format!("创建历史目录失败：{e}"))?;
    // 同毫秒冲突（手动标记紧接保存）时后退 1ms，保证文件名唯一
    let mut ts = now_millis();
    let mut name = format!("{ts}-{kind}");
    while dir.join(&name).exists() {
        ts -= 1;
        name = format!("{ts}-{kind}");
    }
    let p = dir.join(&name);
    fs::write(&p, content).map_err(|e| format!("写入历史快照失败：{e}"))?;
    let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    prune(dir);
    Ok(Some(HistoryEntry { id: name, ts, kind: kind.to_string(), size }))
}

/// 淘汰超出上限的最旧快照
fn prune(dir: &Path) {
    let entries = collect(dir);
    if entries.len() <= MAX_ENTRIES_PER_FILE {
        return;
    }
    for e in entries.iter().skip(MAX_ENTRIES_PER_FILE) {
        let _ = fs::remove_file(dir.join(&e.id));
    }
}

// ---------- Tauri 命令 ----------

/// 保存一版快照。content 为 null 时从磁盘读取当前内容（保存流程先快照后写盘，
/// 落的是保存前的内容）；非空则直接采用（手动标记可来自未保存的编辑器缓冲区）。
#[command]
pub fn history_snapshot(
    workspace_root: String,
    path: String,
    content: Option<String>,
    kind: Option<String>,
) -> Result<Option<HistoryEntry>, String> {
    let dir = history_dir(&workspace_root, &path);
    let body = match content {
        Some(c) => c,
        None => {
            // 文件尚不存在（新建文件的首次保存）：没有「保存前」可言，静默跳过而非报错，
            // 否则每次新建文件保存都会在控制台留下一条无意义的警告。
            if !Path::new(&path).is_file() {
                return Ok(None);
            }
            fs::read_to_string(&path).map_err(|e| format!("读取文件失败：{e}"))?
        }
    };
    let k = match kind.as_deref() {
        Some(KIND_MANUAL) => KIND_MANUAL,
        Some(KIND_RESTORE) => KIND_RESTORE,
        _ => KIND_SAVE,
    };
    write_snapshot(&dir, &body, k)
}

/// 列出某文件的历史快照（从新到旧）
#[command]
pub fn history_list(workspace_root: String, path: String) -> Result<Vec<HistoryEntry>, String> {
    Ok(collect(&history_dir(&workspace_root, &path)))
}

/// 读取某版快照内容
#[command]
pub fn history_read(workspace_root: String, path: String, id: String) -> Result<String, String> {
    if !valid_id(&id) {
        return Err(format!("非法的历史快照 id：{id}"));
    }
    fs::read_to_string(history_dir(&workspace_root, &path).join(&id))
        .map_err(|e| format!("读取历史快照失败：{e}"))
}

/// 回滚到某版快照：先把当前内容存为一版 restore 快照（回滚本身可再回滚），再写回文件。
#[command]
pub fn history_restore(workspace_root: String, path: String, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err(format!("非法的历史快照 id：{id}"));
    }
    let dir = history_dir(&workspace_root, &path);
    let target = fs::read_to_string(dir.join(&id)).map_err(|e| format!("读取历史快照失败：{e}"))?;
    if let Ok(current) = fs::read_to_string(&path) {
        let _ = write_snapshot(&dir, &current, KIND_RESTORE);
    }
    fs::write(&path, target).map_err(|e| format!("写入文件失败：{e}"))
}

/// 清空某文件的全部历史快照
#[command]
pub fn history_clear(workspace_root: String, path: String) -> Result<(), String> {
    let dir = history_dir(&workspace_root, &path);
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|e| format!("清空历史失败：{e}"))?;
    }
    Ok(())
}

// ---------- 单元测试 ----------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmpdir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("pylume-hist-{tag}-{nanos}"));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn snap(dir: &Path, content: &str, kind: &str) -> Option<HistoryEntry> {
        write_snapshot(dir, content, kind).unwrap()
    }

    #[test]
    fn parse_entry_accepts_own_format_only() {
        assert_eq!(parse_entry("1700000000000-save"), Some(1_700_000_000_000));
        assert_eq!(parse_entry("1700000000000-manual"), Some(1_700_000_000_000));
        assert_eq!(parse_entry("1700000000000-restore"), Some(1_700_000_000_000));
        assert!(parse_entry("1700000000000-drop").is_none());
        assert!(parse_entry("abc-save").is_none());
        assert!(parse_entry("save").is_none());
    }

    #[test]
    fn rejects_traversal_ids() {
        assert!(valid_id("1700000000000-save"));
        assert!(!valid_id("../../../settings-save"));
        assert!(!valid_id(""));
    }

    #[test]
    fn relative_key_normalizes_separators() {
        let a = relative_key("F:/ws", "F:/ws/pkg/mod.py");
        assert_eq!(a, "pkg/mod.py");
        let b = relative_key("F:/ws", "G:/other/a.py");
        assert_eq!(b, "G:/other/a.py");
    }

    #[test]
    fn snapshot_dedups_identical_content() {
        let d = tmpdir("dedup");
        assert!(snap(&d, "v1", KIND_SAVE).is_some());
        assert!(snap(&d, "v1", KIND_SAVE).is_none());
        assert!(snap(&d, "v2", KIND_SAVE).is_some());
        assert_eq!(collect(&d).len(), 2);
        assert!(snap(&d, "v1", KIND_SAVE).is_some());
        assert_eq!(collect(&d).len(), 3);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn collect_sorts_newest_first() {
        let d = tmpdir("sort");
        fs::write(d.join("1000-save"), "old").unwrap();
        fs::write(d.join("3000-manual"), "new").unwrap();
        fs::write(d.join("2000-save"), "mid").unwrap();
        let got = collect(&d);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].id, "3000-manual");
        assert_eq!(got[1].id, "2000-save");
        assert_eq!(got[2].id, "1000-save");
        assert_eq!(got[0].kind, "manual");
        assert_eq!(got[0].size, 3);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn prune_keeps_latest_n() {
        let d = tmpdir("prune");
        for i in 0..(MAX_ENTRIES_PER_FILE + 5) {
            fs::write(d.join(format!("{i}-save")), "x").unwrap();
        }
        assert_eq!(collect(&d).len(), MAX_ENTRIES_PER_FILE + 5);
        prune(&d);
        let left = collect(&d);
        assert_eq!(left.len(), MAX_ENTRIES_PER_FILE);
        // 保留的是最新的（时间戳最大）那批
        assert_eq!(left[0].ts, (MAX_ENTRIES_PER_FILE + 4) as i64);
        fs::remove_dir_all(&d).unwrap();
    }
}
