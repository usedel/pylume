//! P3-T07 运行时类型 inlay hints：对无注解赋值标注推断出的运行时类型。
//!
//! 扫描文档每行，识别「简单标识符赋值」`name = <expr>`（跳过带注解 `name: T = ...`、
//! def/class/import/return 等非赋值语句），经 `type_infer` 推断右值运行时类型，
//! 在行末输出 `: <type>` 标注（`InlayHintKind::Type`）。
//!
//! 纯函数设计：返回结构化 items，server 层负责转 LSP `InlayHint`。

use pylume_intel_index::TraceIndex;

use crate::type_infer;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlayHintItem {
    /// 0 基行号。
    pub line: u32,
    /// 行末 UTF-16 列（标注插入点）。
    pub character: u32,
    /// 标注文本（如 `: dict[str, int]`）。
    pub label: String,
}

/// 全文档 inlay hint 扫描。
pub fn inlay_hints(index: &TraceIndex, text: &str) -> Vec<InlayHintItem> {
    let mut items = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        let line = raw.trim_end_matches('\r');
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // 只标注赋值语句，跳过控制流/定义/导入等
        if trimmed.starts_with("def ")
            || trimmed.starts_with("class ")
            || trimmed.starts_with("import ")
            || trimmed.starts_with("from ")
            || trimmed.starts_with("return ")
            || trimmed.starts_with("if ")
            || trimmed.starts_with("elif ")
            || trimmed.starts_with("else")
            || trimmed.starts_with("for ")
            || trimmed.starts_with("while ")
            || trimmed.starts_with("with ")
            || trimmed.starts_with("try")
            || trimmed.starts_with("except")
            || trimmed.starts_with("finally")
        {
            continue;
        }
        let Some(rhs) = plain_assignment_rhs(trimmed) else {
            continue;
        };
        let Some(ty) = type_infer::infer_rhs(index, rhs) else {
            continue;
        };
        items.push(InlayHintItem {
            line: i as u32,
            character: utf16_len(raw.trim_end_matches('\r')) as u32,
            label: format!(": {ty}"),
        });
    }
    items
}

/// 提取 `name = <expr>` 的右值；lhs 必须是纯标识符（带注解 `name: T = ...` 会被排除）。
fn plain_assignment_rhs(line: &str) -> Option<&str> {
    let eq = line.find('=')?;
    let lhs = line[..eq].trim();
    if !is_simple_ident(lhs) {
        return None;
    }
    Some(line[eq + 1..].trim())
}

fn is_simple_ident(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_')
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
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
            conn.execute(
                "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('m.py','scraper.parse_page',1,10,0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO ret_types(fid,type_label,shape,count) VALUES(1,'dict[str, int]','[\"title\",\"url\"]',7)",
                [],
            )
            .unwrap();
        }
        TraceIndex::open(&path).unwrap()
    }

    #[test]
    fn annotates_plain_assignments() {
        let idx = fixture();
        let text = "data = scraper.parse_page(url)\nname = 'alice'\nn = 3\nz = y + 1\n";
        let hints = inlay_hints(&idx, text);
        let labels: Vec<(&u32, &str)> = hints.iter().map(|h| (&h.line, h.label.as_str())).collect();
        assert!(labels.contains(&(&0, ": dict[str, int]")), "{labels:?}");
        assert!(labels.contains(&(&1, ": str")));
        assert!(labels.contains(&(&2, ": int")));
        // `z = y + 1` 无法推断 → 跳过
        assert!(!labels.iter().any(|(l, _)| **l == 3));
    }

    #[test]
    fn skips_annotated_and_control_flow() {
        let idx = fixture();
        let text = "data: dict = scrape()\nif x:\n    pass\nfor i in items:\n    pass\n";
        let hints = inlay_hints(&idx, text);
        // 带注解赋值 lhs 不是纯标识符（含冒号空格）→ 跳过；控制流跳过
        assert!(hints.is_empty(), "{hints:?}");
    }

    #[test]
    fn plain_assignment_rhs_cases() {
        assert_eq!(plain_assignment_rhs("x = 1"), Some("1"));
        assert_eq!(plain_assignment_rhs("data = parse_page()"), Some("parse_page()"));
        assert_eq!(plain_assignment_rhs("x: int = 1"), None);
        assert_eq!(plain_assignment_rhs("x.y = 1"), None);
        assert_eq!(plain_assignment_rhs("x += 1"), None);
        assert_eq!(plain_assignment_rhs("def f():"), None);
    }
}