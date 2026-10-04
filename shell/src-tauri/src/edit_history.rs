//! 编辑历史采集（低延迟编辑预测数据源，V1）。
//!
//! 采集「行对」事件：用户完成一行（光标离开该行）时，记录该行净内容 + 前导缩进 +
//! 上一非空行内容，追加写 JSONL。数据只落本地，为后续「整行回放」预测攒语料；
//! 预测引擎本身 Phase 后置，此模块仅负责采集与落盘，不参与逐键热路径。
//!
//! 存储：`<data_root>/edit_history/events.jsonl`，超限轮转 `events.1.jsonl`。
//! 契约字段与前端 `shell/src/editHistory.ts` 的 `EditEvent` 一一对应，字段名不得随意
//! 变更（JSONL 持久化契约，改字段即改契约、旧数据作废）。

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::util::pylume_home;

/// 单文件超过此字节数即轮转（8 MiB；正常采集量级一年仅数 MB，此上限纯属防御）。
const MAX_BYTES: u64 = 8 * 1024 * 1024;
/// 单行 / 上一行字段长度上限（防异常脏数据撑大文件）。
const MAX_LINE_LEN: usize = 512;
/// 单次调用事件数上限（前端逐事件调用，此处防御批量接口异常）。
const MAX_EVENTS_PER_CALL: usize = 256;

/// 一条「行对」采集事件（与前端 `EditEvent` 契约一致）。
#[derive(Serialize, Deserialize)]
pub struct EditEvent {
    /// 毫秒时间戳（后续新鲜度加权用）
    pub ts: i64,
    /// 语言，V1 仅采集 "python"
    pub lang: String,
    /// 该行前导空白字符数（预测时复现缩进）
    pub indent: u32,
    /// 上一非空行净内容（无则 None）
    pub prev: Option<String>,
    /// 本行净内容（去首尾空白）
    pub line: String,
}

fn dir() -> PathBuf {
    pylume_home().join("edit_history")
}

fn current_file() -> PathBuf {
    dir().join("events.jsonl")
}

fn rotated_file() -> PathBuf {
    dir().join("events.1.jsonl")
}

/// 写句柄（懒初始化 + 跨线程安全；仅接管文件对象，不做业务级全局锁以保证 append 吞吐）。
static WRITER: Mutex<Option<std::fs::File>> = Mutex::new(None);

/// 跨线程锁统一走 util::unpoison（避免一次 panic 污染锁后连锁 panic）。此处复刻其语义。
fn unpoison<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 事件合法性：语言为 python、本行非空、字段长度不超限、prev 非空则不超限且非空白。
fn is_valid(e: &EditEvent) -> bool {
    e.lang == "python"
        && !e.line.trim().is_empty()
        && e.line.len() <= MAX_LINE_LEN
        && e.prev
            .as_deref()
            .map_or(true, |p| !p.trim().is_empty() && p.len() <= MAX_LINE_LEN)
}

/// 追加一批编辑事件到 JSONL（前端逐事件调用，接口保留批量能力）。
#[tauri::command]
pub fn edit_history_append(events: Vec<EditEvent>) -> Result<(), String> {
    if events.is_empty() {
        return Ok(());
    }
    if events.len() > MAX_EVENTS_PER_CALL {
        return Err(format!(
            "编辑历史事件过多（{}>{}）",
            events.len(),
            MAX_EVENTS_PER_CALL
        ));
    }

    let mut guard = unpoison(&WRITER);
    if guard.is_none() {
        std::fs::create_dir_all(dir()).map_err(|e| format!("创建编辑历史目录失败：{e}"))?;
        *guard = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(current_file())
            .ok();
    }
    let Some(f) = guard.as_mut() else {
        return Err("打开编辑历史文件失败".into());
    };

    // 轮转：超限切 events.1，重开新文件继续追加。
    if let Ok(meta) = f.metadata() {
        if meta.len() > MAX_BYTES {
            rotate();
            if let Ok(nf) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(current_file())
            {
                *f = nf;
            }
        }
    }

    let mut buf = String::new();
    for e in events.iter().filter(|e| is_valid(e)) {
        if let Ok(s) = serde_json::to_string(e) {
            buf.push_str(&s);
            buf.push('\n');
        }
    }
    f.write_all(buf.as_bytes())
        .map_err(|e| format!("写入编辑历史失败：{e}"))?;
    f.flush().map_err(|e| format!("刷新编辑历史失败：{e}"))?;
    Ok(())
}

/// 轮转：删除旧 .1，把当前文件改名为 events.1.jsonl。
fn rotate() {
    let cur = current_file();
    let rot = rotated_file();
    let _ = std::fs::remove_file(&rot);
    if cur.is_file() {
        let _ = std::fs::rename(&cur, &rot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(ts: i64, indent: u32, prev: Option<&str>, line: &str) -> EditEvent {
        EditEvent {
            ts,
            lang: "python".into(),
            indent,
            prev: prev.map(str::to_owned),
            line: line.into(),
        }
    }

    #[test]
    fn is_valid_accepts_normal_lines() {
        assert!(is_valid(&ok(1, 4, None, "x = 1")));
        assert!(is_valid(&ok(
            1,
            4,
            Some("data = parse_page(html)"),
            "print(data[\"title\"])"
        )));
    }

    #[test]
    fn is_valid_rejects_bad_events() {
        // 纯空白 / 空行
        assert!(!is_valid(&ok(1, 0, None, "   ")));
        assert!(!is_valid(&ok(1, 0, None, "")));
        // 非 python
        assert!(!is_valid(&EditEvent {
            ts: 1,
            lang: "js".into(),
            indent: 0,
            prev: None,
            line: "x".into(),
        }));
        // 超长行
        assert!(!is_valid(&ok(1, 0, None, &"x".repeat(1000))));
        // 上一行超长
        assert!(!is_valid(&ok(1, 0, Some(&"y".repeat(1000)), "x")));
        // 空 prev（Some("")）拒绝
        assert!(!is_valid(&ok(1, 0, Some(""), "x")));
    }
}