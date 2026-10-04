//! P3-T05 hover：悬停展示运行时观测。
//!
//! - 悬停函数名（含调用/定义/模块限定名）→ 该函数的 args/rets/excs 观测摘要；
//! - 悬停对象变量 → 推断其运行时类型 + shape 字段（复用 P3-T03b `type_infer`）。
//!
//! 纯函数设计：返回结构化 `Hover`，`render` 转 markdown；server 层负责 LSP 类型转换。

use pylume_intel_index::{Function, TraceIndex};
use pylume_intel_index::type_label::is_dict;

use crate::completion::utf16_to_byte;
use crate::type_infer;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArgObs {
    pub arg: String,
    pub type_label: String,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionHover {
    pub qualname: String,
    pub hits: i64,
    pub args: Vec<ArgObs>,
    pub rets: Vec<(String, i64)>,
    pub excs: Vec<(String, i64)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariableHover {
    pub name: String,
    pub type_label: String,
    pub members: Vec<(String, i64)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hover {
    Function(FunctionHover),
    Variable(VariableHover),
}

/// 悬停入口：先按函数匹配，再尝试变量类型推断。
pub fn hover(index: &TraceIndex, text: &str, line: u32, character: u32) -> Option<Hover> {
    let name = ident_at(text, line, character)?;
    if let Some(f) = find_function(index, &name) {
        return Some(Hover::Function(f));
    }
    if !name.contains('.') {
        if let Some(ty) = type_infer::infer_receiver_type(index, text, &name, line) {
            let members = type_infer::members_for_type(index, &ty);
            return Some(Hover::Variable(VariableHover {
                name,
                type_label: ty,
                members,
            }));
        }
    }
    None
}

/// 取 qualname 最后段 == name 最后段的函数中 hits 最高者，聚合观测（按 count 降序）。
/// CR-17：走 `by_last_segment` 倒排（原全量函数扫描 + 每函数 rsplit）。
fn find_function(index: &TraceIndex, name: &str) -> Option<FunctionHover> {
    let seg = name.rsplit('.').next().unwrap_or(name);
    let mut best: Option<&Function> = None;
    for f in index.by_last_segment(seg) {
        // P3-T08 新鲜度：非 stale 优先，再按 hits 降序
        if best.map_or(true, |b| (!f.stale, f.hits) > (!b.stale, b.hits)) {
            best = Some(f);
        }
    }
    let f = best?;

    let mut args: Vec<ArgObs> = f
        .args
        .iter()
        .map(|a| ArgObs {
            arg: a.arg.clone(),
            type_label: a.type_label.clone(),
            count: a.count,
        })
        .collect();
    args.sort_by(|a, b| b.count.cmp(&a.count));

    let mut rets: Vec<(String, i64)> = f
        .rets
        .iter()
        .map(|r| (r.type_label.clone(), r.count))
        .collect();
    rets.sort_by(|a, b| b.1.cmp(&a.1));

    let mut excs: Vec<(String, i64)> = f
        .excs
        .iter()
        .map(|e| (e.exc_label.clone(), e.count))
        .collect();
    excs.sort_by(|a, b| b.1.cmp(&a.1));

    Some(FunctionHover {
        qualname: f.qualname.clone(),
        hits: f.hits,
        args,
        rets,
        excs,
    })
}

/// 提取光标处的完整「点链」标识符（前后双向扫描）；供 definition 模块复用。
pub(crate) fn ident_at(text: &str, line: u32, character: u32) -> Option<String> {
    let target = text.lines().nth(line as usize)?;
    let target = target.trim_end_matches('\r');
    let byte = utf16_to_byte(target, character);
    let bytes = target.as_bytes();
    let mut start = byte;
    while start > 0 {
        let c = bytes[start - 1];
        if c.is_ascii_alphanumeric() || c == b'_' || c == b'.' {
            start -= 1;
        } else {
            break;
        }
    }
    let mut end = byte;
    while end < bytes.len() {
        let c = bytes[end];
        if c.is_ascii_alphanumeric() || c == b'_' || c == b'.' {
            end += 1;
        } else {
            break;
        }
    }
    let token = target[start..end].trim_matches('.');
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// 渲染为 markdown（server 层直接入 `MarkupContent`）。
pub fn render(h: &Hover) -> String {
    match h {
        Hover::Function(f) => render_function(f),
        Hover::Variable(v) => render_variable(v),
    }
}

fn render_function(f: &FunctionHover) -> String {
    let mut s = format!("**⟳ runtime** `{}` · {} hits\n", f.qualname, f.hits);
    if !f.args.is_empty() {
        s.push_str("\n参数观测:\n");
        for a in &f.args {
            s.push_str(&format!("- `{}`: {} ×{}\n", a.arg, a.type_label, a.count));
        }
    }
    if !f.rets.is_empty() {
        s.push_str("\n返回观测:\n");
        for (t, c) in &f.rets {
            s.push_str(&format!("- {} ×{}\n", t, c));
        }
    }
    if !f.excs.is_empty() {
        s.push_str("\n异常观测:\n");
        for (e, c) in &f.excs {
            s.push_str(&format!("- {} ×{}\n", e, c));
        }
    }
    s.trim_end().to_string()
}

fn render_variable(v: &VariableHover) -> String {
    let mut s = format!("**⟳ runtime** `{}` : {}\n", v.name, v.type_label);
    if !v.members.is_empty() {
        s.push_str("\n字段（shape）:\n");
        for (m, c) in &v.members {
            // dict 键用下标形式（`["title"]`）提示正确访问方式；实例属性原样展示
            if is_dict(&v.type_label) {
                s.push_str(&format!("- `[\"{}\"]` ×{}\n", m, c));
            } else {
                s.push_str(&format!("- {} ×{}\n", m, c));
            }
        }
    }
    s.trim_end().to_string()
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
            conn.execute(
                "INSERT INTO arg_types(fid,arg,type_label,shape,count) VALUES(1,'resp','requests.Response','[\"status_code\"]',9)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO exc_types(fid,exc_label,count) VALUES(1,'ValueError',2)",
                [],
            )
            .unwrap();
        }
        TraceIndex::open(&path).unwrap()
    }

    #[test]
    fn hover_function_shows_observations() {
        let idx = fixture();
        let text = "url = scraper.parse_page(resp)\n";
        let col = text.find("parse_page").unwrap() as u32 + 3;
        match hover(&idx, text, 0, col).unwrap() {
            Hover::Function(f) => {
                assert_eq!(f.qualname, "scraper.parse_page");
                assert_eq!(f.hits, 10);
                assert_eq!(f.args[0].arg, "resp");
                assert_eq!(f.rets[0], ("dict[str, int]".to_string(), 7));
                assert_eq!(f.excs[0], ("ValueError".to_string(), 2));
            }
            _ => panic!("应为函数 hover"),
        }
    }

    #[test]
    fn hover_variable_shows_type_and_members() {
        let idx = fixture();
        let text = "data = parse_page(url)\nprint(data)\n";
        // 悬停第二行 print(data) 里的 data（字符 7）
        match hover(&idx, text, 1, 7).unwrap() {
            Hover::Variable(v) => {
                assert_eq!(v.name, "data");
                assert_eq!(v.type_label, "dict[str, int]");
                assert!(v.members.iter().any(|(m, _)| m == "title"));
            }
            _ => panic!("应为变量 hover"),
        }
    }

    #[test]
    fn hover_unknown_returns_none() {
        let idx = fixture();
        let text = "print(nope)\n";
        assert_eq!(hover(&idx, text, 0, 7), None);
    }

    #[test]
    fn render_contains_runtime_badge() {
        let idx = fixture();
        let text = "url = scraper.parse_page(resp)\n";
        let col = text.find("parse_page").unwrap() as u32 + 3;
        let h = hover(&idx, text, 0, col).unwrap();
        let md = render(&h);
        assert!(md.contains("⟳ runtime"));
        assert!(md.contains("scraper.parse_page"));
        assert!(md.contains("参数观测"));
    }

    #[test]
    fn render_variable_dict_keys_shown_as_subscript() {
        let v = VariableHover {
            name: "data".into(),
            type_label: "dict[str, int]".into(),
            members: vec![("title".into(), 7), ("url".into(), 5)],
        };
        let md = render(&Hover::Variable(v));
        assert!(md.contains("[\"title\"]"), "dict 键应以下标形式展示，实际 {md:?}");
        assert!(md.contains("[\"url\"]"));
    }
}