//! P3-T04 跳转：definition 返回 trace 库记录的函数定义位置。
//!
//! 光标落在函数名（调用处/定义处/模块限定名，复用 `hover::ident_at` 定位）时，
//! 按 qualname 最后段匹配 trace 函数，返回其 `(filename, lineno)`（probe 记下的 def 行）。

use std::collections::HashSet;

use pylume_intel_index::{Function, TraceIndex};

use crate::hover::ident_at;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefinitionTarget {
    /// 绝对路径（probe 存储格式，Windows 反斜杠）。
    pub filename: String,
    /// 1 基行号（`functions.lineno`，即 def 行）。
    pub lineno: i64,
    pub qualname: String,
}

/// 同名函数返回多个（去重后按 hits 降序，最常运行的实现排前）。
pub fn definition(
    index: &TraceIndex,
    text: &str,
    line: u32,
    character: u32,
) -> Vec<DefinitionTarget> {
    let Some(name) = ident_at(text, line, character) else {
        return Vec::new();
    };
    let seg = name.rsplit('.').next().unwrap_or(&name);

    // CR-17：走 by_last_segment 倒排（原全量函数扫描 + 每函数 rsplit）
    let mut funcs: Vec<&Function> = index.by_last_segment(seg).collect();
    // P3-T08 新鲜度：非 stale 优先，再按 hits 降序（stale 代码变更后的旧位置排后）
    funcs.sort_by(|a, b| a.stale.cmp(&b.stale).then_with(|| b.hits.cmp(&a.hits)));

    let mut seen: HashSet<(String, i64)> = HashSet::new();
    let mut targets = Vec::new();
    for f in funcs {
        if seen.insert((f.filename.clone(), f.lineno)) {
            targets.push(DefinitionTarget {
                filename: f.filename.clone(),
                lineno: f.lineno,
                qualname: f.qualname.clone(),
            });
        }
    }
    targets
}

#[cfg(test)]
mod tests {
    use super::*;
    use pylume_intel_index::SCHEMA;
    use rusqlite::Connection;

    fn fixture() -> TraceIndex {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            // Windows 风格绝对路径（probe 用 normpath(realpath)）
            conn.execute(
                "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('F:\\proj\\scraper.py','scraper.parse_page',42,10,0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('F:\\proj\\other.py','other.parse_page',5,3,0)",
                [],
            )
            .unwrap();
        }
        TraceIndex::open(&path).unwrap()
    }

    #[test]
    fn jumps_by_last_segment_hits_desc() {
        let idx = fixture();
        let text = "x = parse_page()\n";
        let col = text.find("parse_page").unwrap() as u32 + 3;
        let targets = definition(&idx, text, 0, col);
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].lineno, 42); // hits 高排前
        assert_eq!(targets[0].qualname, "scraper.parse_page");
        assert_eq!(targets[1].lineno, 5);
    }

    #[test]
    fn no_definition_when_unknown() {
        let idx = fixture();
        let text = "print(nope)\n";
        assert!(definition(&idx, text, 0, 7).is_empty());
    }
}