//! P3-T03 运行时补全：符号补全 + 属性补全的统一入口。
//!
//! - **符号补全**（P3-T03）：`qualname` 是命名空间链，直接匹配 `mod.cls.member` / 顶级函数名；
//! - **属性补全**（P3-T03b）：`x.` / `x.field` 时，经 `type_infer` 推断 `x` 的运行时类型，
//!   再用 `members_for_type` 聚合该类型的 shape 字段（dict 键 / 实例属性名）为候选。
//!
//! 纯函数设计：不依赖 tower-lsp，便于单元测试（server.rs 负责 LSP 类型转换）。

use std::collections::HashMap;

use pylume_intel_index::{Function, TraceIndex};
use pylume_intel_index::type_label::is_dict;

use crate::type_infer;

const MAX_CANDIDATES: usize = 50;

/// stale（所在文件在末次运行后被改过）函数的补全降权除数。
///
/// 此前是 `f.hits / 2` 的裸字面量，无常量名、无依据记录——`dev_plan_v2` §7
/// 「基于真实使用数据调整降权策略」因此长期标 ⚠️。
///
/// **首个实测依据**（2026-10-03，`tools/intel/trace_stats.py` + 可复现实验）：
/// 构造 2 个源文件各 2 个函数，先全量跑一次，改动其中 1 个文件的 mtime 后只跑另一半，
/// 结果 stale 占比 **30.0%**（3/10）。即在常见的「改一个文件、只跑相关代码」编辑流下，
/// 约三分之一的运行时观测立刻变 stale——这说明 stale 并非罕见边角情况。
/// 当时 `trace_stats.py` 的建议规则给出 0.25（stale ≥30% 档）。
///
/// **为何暂不改成 0.25**：上面样本仅 10 条函数，来源是合成实验，不足以支撑改交互体感。
/// 现状 0.5 保持不变，但参数从此显式可审；等真实项目跑出 ≥1000 条观测后按同一脚本复核
/// （`python tools/intel/trace_stats.py <db> --out bench/reports/trace-stats.md`）。
const STALE_HITS_DIVISOR: i64 = 2;

/// 补全候选（server 层转 `CompletionItem`，sortText `1xx` 段）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub label: String,
    pub kind: CandidateKind,
    pub detail: String,
    pub score: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateKind {
    Function,
    Field,
}

/// 统一补全入口：下标访问（dict 键）+ 符号补全 + 属性补全，去重后按证据强度（score）降序。
pub fn complete(index: &TraceIndex, text: &str, line: u32, character: u32) -> Vec<Candidate> {
    // jmespath 路径补全：`jmespath.search("data.diff[0].co", data)` 字符串内补字段
    if let Some(jm) = jmespath_ctx_at(text, line, character) {
        if let Some(ty) = type_infer::infer_receiver_type(index, text, &jm.data_var, line) {
            let member_keys = type_infer::chain_keys(index, &ty, &jm.chain);
            let mut candidates = Vec::new();
            for (field, count) in member_keys {
                if field.starts_with(&jm.prefix) {
                    candidates.push(Candidate {
                        label: field,
                        kind: CandidateKind::Field,
                        detail: format!("⟳ runtime · {} · {} obs", ty, count),
                        score: count,
                    });
                }
            }
            return dedup_sort_truncate(candidates);
        }
        return Vec::new();
    }

    // 下标访问补全（dict 键 / list 元素）：`data["prefix` / `data["key"]["prefix` / `rows[0]["prefix`
    if let Some(sub) = subscript_ctx_at(text, line, character) {
        if let Some(ty) = type_infer::infer_receiver_type(index, text, &sub.base, line) {
            // 沿访问链解析 shape（空链=顶层键；Key 进 dict 子节点；Index 进 list 元素）
            let member_keys = type_infer::chain_keys(index, &ty, &sub.chain);
            let mut candidates = Vec::new();
            for (field, count) in member_keys {
                if field.starts_with(&sub.prefix) {
                    candidates.push(Candidate {
                        label: field,
                        kind: CandidateKind::Field,
                        detail: format!("⟳ runtime · {} · {} obs", ty, count),
                        score: count,
                    });
                }
            }
            return dedup_sort_truncate(candidates);
        }
        // 下标访问但推断不到 base 类型：不产生补全
        return Vec::new();
    }

    let Some(token) = dot_chain_at(text, line, character) else {
        return Vec::new();
    };
    if token.is_empty() {
        return Vec::new();
    }

    let ends_with_dot = token.ends_with('.');
    let trimmed = token.trim_end_matches('.');
    let segs: Vec<String> = trimmed
        .split('.')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    if segs.is_empty() {
        return Vec::new();
    }

    let parent: Vec<String>;
    let prefix: String;
    let receiver: Option<String>;
    if ends_with_dot {
        parent = segs.clone();
        prefix = String::new();
        receiver = Some(trimmed.to_string());
    } else {
        let last = segs[segs.len() - 1].clone();
        parent = segs[..segs.len() - 1].to_vec();
        prefix = last;
        receiver = if parent.is_empty() {
            None
        } else {
            Some(parent.join("."))
        };
    }

    let mut candidates = symbol_candidates(index, &parent, &prefix);

    // 属性补全：仅单段 receiver（变量名）可做轻量类型推断；dict 键走下标补全，此处排除
    if let Some(recv) = &receiver {
        if is_identifier(recv) {
            if let Some(ty) = type_infer::infer_receiver_type(index, text, recv, line) {
                if !is_dict(&ty) {
                    for (field, count) in type_infer::members_for_type(index, &ty) {
                        if field.starts_with(&prefix) {
                            candidates.push(Candidate {
                                label: field,
                                kind: CandidateKind::Field,
                                detail: format!("⟳ runtime · {} · {} obs", ty, count),
                                score: count,
                            });
                        }
                    }
                }
            }
        }
    }

    dedup_sort_truncate(candidates)
}

/// 符号补全：qualname 命名空间链匹配。
/// CR-17：不再全量扫描 + 每函数 split('.')——
/// - parent 为空（顶级符号）：按最后段前缀倒排迭代；
/// - parent 非空：qualname 倒数第二段必须 == parent 末段，用倒排粗筛后再完整校验段链。
fn symbol_candidates(index: &TraceIndex, parent: &[String], prefix: &str) -> Vec<Candidate> {
    let mut by_label: HashMap<String, Candidate> = HashMap::new();

    let iter: Box<dyn Iterator<Item = &Function>> = if parent.is_empty() {
        Box::new(index.functions_by_last_segment_prefix(prefix))
    } else {
        // 倒数第二段 == parent 末段（matches_chain 的必要条件）
        let last_parent = &parent[parent.len() - 1];
        Box::new(index.by_second_last_segment(last_parent))
    };

    for f in iter {
        let qsegs: Vec<&str> = f.qualname.split('.').collect();
        if let Some(member) = matches_chain(&qsegs, parent, prefix) {
            let ret = top_ret(f);
            let ret_suffix = if ret.is_empty() {
                String::new()
            } else {
                format!(" · ret→{}", ret)
            };
            // P3-T08 新鲜度：stale（代码已变更）函数降权 + 标注，仍可见但排后
            let stale_note = if f.stale { " · stale" } else { "" };
            let cand = Candidate {
                label: member.clone(),
                kind: CandidateKind::Function,
                detail: format!("⟳ runtime · {} · {} hits{}{}", f.qualname, f.hits, ret_suffix, stale_note),
                score: if f.stale { f.hits / STALE_HITS_DIVISOR } else { f.hits },
            };
            by_label
                .entry(member)
                .and_modify(|e| {
                    if cand.score > e.score {
                        *e = cand.clone();
                    }
                })
                .or_insert(cand);
        }
    }
    by_label.into_values().collect()
}

/// 同 label 去重（保留 score 高者）→ score 降序 → 截断。
fn dedup_sort_truncate(cands: Vec<Candidate>) -> Vec<Candidate> {
    let mut map: HashMap<String, Candidate> = HashMap::new();
    for c in cands {
        map.entry(c.label.clone())
            .and_modify(|e| {
                if c.score > e.score {
                    *e = c.clone();
                }
            })
            .or_insert(c);
    }
    let mut v: Vec<Candidate> = map.into_values().collect();
    v.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.label.cmp(&b.label)));
    v.truncate(MAX_CANDIDATES);
    v
}

/// 光标前「点链 token」提取：回溯 `[A-Za-z0-9_.]`，允许以点结尾（成员补全信号）。
fn dot_chain_at(text: &str, line: u32, character: u32) -> Option<String> {
    let target_line = text.lines().nth(line as usize)?;
    let target_line = target_line.trim_end_matches('\r');
    let byte_end = utf16_to_byte(target_line, character);
    let bytes = target_line.as_bytes();
    let mut start = byte_end;
    while start > 0 {
        let c = bytes[start - 1];
        if c.is_ascii_alphanumeric() || c == b'_' || c == b'.' {
            start -= 1;
        } else {
            break;
        }
    }
    Some(target_line[start..byte_end].to_string())
}

/// jmespath 补全上下文：数据变量 + 已解析路径链 + 当前字段前缀。
struct JmCtx {
    data_var: String,
    chain: Vec<type_infer::Access>,
    prefix: String,
}

/// CR-12：识别 jmespath 一行式调用的接收者前缀（`quote 前的文本 trimmed）。
/// 收窄规则：
/// - `jmespath.search(` / `jmespath.compile(`：模块限定全名（最精确）；
/// - `).search(`：链式形态 `jmespath.compile("a").search("path", data)`——前面的
///   `)` 表明 receiver 是另一调用的返回值，jmespath 风格的链式用法；
/// - 裸 `search(` / `compile(` 与任意标识符同名调用（`re.search(` / `myobj.search(`
///   等）误判，已移除。
pub(crate) fn is_jmespath_call_prefix(before: &str) -> bool {
    if before.ends_with("jmespath.search(") || before.ends_with("jmespath.compile(") {
        return true;
    }
    if before.ends_with("re.search(") {
        return false;
    }
    before.ends_with(").search(")
}

/// 检测 `xxx.search("path…", data)` / `xxx.compile("path…", data)` 一行式调用，
/// 光标在路径字符串内时提取数据变量、解析访问链与未完成前缀。
fn jmespath_ctx_at(text: &str, line: u32, character: u32) -> Option<JmCtx> {
    let target = text.lines().nth(line as usize)?;
    let target = target.trim_end_matches('\r');
    let byte = utf16_to_byte(target, character);
    let bytes = target.as_bytes();

    // 1. 光标前路径文本（jmespath 字符集：标识符 / . / [ / ] / - / *）
    let mut i = byte;
    while i > 0 {
        let c = bytes[i - 1];
        if c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'[' | b']' | b'-' | b'*') {
            i -= 1;
        } else {
            break;
        }
    }
    let path_text = &target[i..byte];

    // 2. 路径文本前必须是开引号，且引号前是 jmespath 调用（收窄后的判定）
    if i == 0 || (bytes[i - 1] != b'"' && bytes[i - 1] != b'\'') {
        return None;
    }
    let open = i - 1;
    let before = target[..open].trim_end();
    if !is_jmespath_call_prefix(before) {
        return None;
    }

    // 3. 向右找闭合引号，再提取第二个参数（数据变量）
    let quote = bytes[open] as char;
    let close = byte + target[byte..].find(|c| c == quote)?;
    let after = target[close + 1..].trim_start();
    let rest = after.strip_prefix(',').unwrap_or(after).trim_start();
    let var_end = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(rest.len());
    let data_var = &rest[..var_end];
    if !is_identifier(data_var) {
        return None;
    }

    let (chain, prefix) = parse_jmespath_path(path_text);
    Some(JmCtx {
        data_var: data_var.to_string(),
        chain,
        prefix,
    })
}

/// 解析 jmespath 路径（光标前文本）→ (已解析段链, 未完成字段前缀)。
fn parse_jmespath_path(s: &str) -> (Vec<type_infer::Access>, String) {
    let trimmed = s.trim_end();
    if trimmed.is_empty() {
        return (Vec::new(), String::new());
    }
    // 以 `]` 结尾 → 全部是完整段（下标闭合），无前缀
    if trimmed.ends_with(']') {
        return (parse_jmespath_segments(trimmed), String::new());
    }
    // 否则最后一个 `.` 之后是未完成字段前缀
    let (done, prefix_part) = match trimmed.rfind('.') {
        Some(pos) => (trimmed[..pos].trim_end_matches('.'), &trimmed[pos + 1..]),
        None => ("", trimmed),
    };
    let prefix = prefix_part
        .split(|c| c == '[' || c == ']')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    (parse_jmespath_segments(done), prefix)
}

/// 把已完成段（点分隔，含下标）解析为访问链。诊断模块复用。
pub(crate) fn parse_jmespath_segments(s: &str) -> Vec<type_infer::Access> {
    let mut chain = Vec::new();
    for seg in s.split('.') {
        if seg.is_empty() {
            continue;
        }
        let bracket = seg.find('[').unwrap_or(seg.len());
        let field = seg[..bracket].trim();
        if is_identifier(field) {
            chain.push(type_infer::Access::Key(field.to_string()));
        }
        // 下标链：[*] / [0] / [-1]
        let mut rest = &seg[bracket..];
        while rest.starts_with('[') {
            let Some(close) = rest.find(']') else { break };
            let inner = &rest[1..close];
            let digits = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
            let is_index = inner == "*"
                || digits(inner)
                || (inner.len() > 1 && inner.as_bytes()[0] == b'-' && digits(&inner[1..]));
            if !is_index {
                break; // 过滤 [?] / 字段下标：不支持
            }
            chain.push(type_infer::Access::Index);
            rest = &rest[close + 1..];
        }
    }
    chain
}

/// 下标访问上下文：`base` 为最左标识符，`chain` 为中间访问链（`["key"]` / `[0]` / `.get("key")`）。
struct SubscriptCtx {
    base: String,
    chain: Vec<type_infer::Access>,
    prefix: String,
}

/// 提取下标访问上下文：`id["prefix` / `id["key"]["prefix` / `id["a"][0]["prefix` 等。
/// 链式最多 MAX_CHAIN 层；点链 receiver、变量索引暂不处理。
fn subscript_ctx_at(text: &str, line: u32, character: u32) -> Option<SubscriptCtx> {
    let target_line = text.lines().nth(line as usize)?;
    let target_line = target_line.trim_end_matches('\r');
    let byte_end = utf16_to_byte(target_line, character);
    let bytes = target_line.as_bytes();

    // 1. 光标前已输入的 key 前缀（标识符字符）
    let mut i = byte_end;
    while i > 0 && (bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_') {
        i -= 1;
    }
    let prefix = target_line[i..byte_end].to_string();

    // 2. 前缀前必须是开引号 `"` 或 `'`
    if i == 0 || (bytes[i - 1] != b'"' && bytes[i - 1] != b'\'') {
        return None;
    }
    let rest = target_line[..i - 1].trim_end();

    // 3. 剥离最外层 `.get(` 或 `[`，得到 receiver 侧表达式（含完整访问链）
    let receiver_expr = if let Some(base) = rest.strip_suffix(".get(") {
        base
    } else if let Some(base) = rest.strip_suffix('[') {
        base
    } else {
        return None;
    };
    let (base, chain) = parse_receiver(receiver_expr)?;
    Some(SubscriptCtx { base, chain, prefix })
}

/// 解析下标/调用链 receiver：`id`、`id["k"]`、`id[0]`、`id.get("k")` 及任意组合（≤ MAX_CHAIN）。
/// 逆向逐段剥离，容忍赋值前缀（如 `y = quotes["data"][0]`）。
fn parse_receiver(s: &str) -> Option<(String, Vec<type_infer::Access>)> {
    let mut cur = s.trim_end();
    let mut chain: Vec<type_infer::Access> = Vec::new();
    loop {
        // 尾部 `[...]`：字符串键 → Key；纯数字 → Index；其他 → 不支持
        if let Some(close) = cur.rfind(']') {
            let open = cur[..close].rfind('[')?;
            let inner = cur[open + 1..close].trim();
            if let Some(key) = strip_quotes(inner) {
                chain.push(type_infer::Access::Key(key));
            } else if !inner.is_empty() && inner.bytes().all(|b| b.is_ascii_digit()) {
                chain.push(type_infer::Access::Index);
            } else {
                return None;
            }
            cur = cur[..open].trim_end();
            continue;
        }
        // 尾部 `.get("key")`
        if let Some(close) = cur.rfind(')') {
            let dot = cur[..close].rfind(".get(")?;
            let key = strip_quotes(&cur[dot + 5..close])?;
            chain.push(type_infer::Access::Key(key));
            cur = cur[..dot].trim_end();
            continue;
        }
        break;
    }
    let base = last_identifier(cur)?;
    if chain.len() > type_infer::MAX_CHAIN {
        return None;
    }
    chain.reverse();
    Some((base, chain))
}

/// 取尾部独立标识符（前驱非 `.`，排除 `a.b` 点链 receiver）；空/非标识符返回 None。
fn last_identifier(s: &str) -> Option<String> {
    let s = s.trim_end();
    let bytes = s.as_bytes();
    let mut start = bytes.len();
    while start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'_') {
        start -= 1;
    }
    if start == bytes.len() {
        return None;
    }
    if start > 0 && bytes[start - 1] == b'.' {
        return None;
    }
    Some(s[start..].to_string())
}

/// 剥离一层配对引号 `"..."` / `'...'`，返回内部内容。
fn strip_quotes(s: &str) -> Option<String> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() >= 2 {
        let (o, c) = (b[0], b[b.len() - 1]);
        if (o == b'"' && c == b'"') || (o == b'\'' && c == b'\'') {
            return Some(s[1..s.len() - 1].to_string());
        }
    }
    None
}

/// LSP 0 基 UTF-16 列 → 行内字节偏移（hover 模块复用）。
pub(crate) fn utf16_to_byte(line: &str, char_idx: u32) -> usize {
    let mut utf16 = 0u32;
    for (byte, ch) in line.char_indices() {
        if utf16 >= char_idx {
            return byte;
        }
        utf16 += ch.len_utf16() as u32;
    }
    line.len()
}

/// 判断 qualname 段链与输入链的匹配；命中返回成员名（最后一段）。
fn matches_chain(qsegs: &[&str], parent: &[String], prefix: &str) -> Option<String> {
    let m = qsegs.len();
    let p = parent.len();
    if m < p + 1 {
        return None;
    }
    for (i, seg) in parent.iter().enumerate() {
        if qsegs[m - p - 1 + i] != seg.as_str() {
            return None;
        }
    }
    let member = qsegs[m - 1];
    if member.starts_with(prefix) && !member.is_empty() {
        Some(member.to_string())
    } else {
        None
    }
}

fn top_ret(f: &Function) -> String {
    f.rets
        .iter()
        .max_by_key(|r| r.count)
        .map(|r| r.type_label.clone())
        .unwrap_or_default()
}

fn is_identifier(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use pylume_intel_index::{TraceIndex, SCHEMA};
    use rusqlite::Connection;

    /// 建库：scraper.parse_page(hits 12, ret dict[str,int])、scraper.fetch_url(8)、
    /// other.parse_json(5)、other.parse_pages(3)。
    fn symbol_fixture() -> TraceIndex {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute(
                "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('scraper.py','scraper.parse_page',1,12,0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('scraper.py','scraper.fetch_url',2,8,0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('other.py','other.parse_json',3,5,0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('other.py','other.parse_pages',4,3,0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO ret_types(fid,type_label,shape,count) VALUES(1,'dict[str,int]','',4)",
                [],
            )
            .unwrap();
            // 泄漏 dir：fixture 返回索引后临时目录被删，但索引已全量载入内存，不受影响。
        }
        TraceIndex::open(&path).unwrap()
    }

    #[test]
    fn matches_parent_and_prefix() {
        let q: Vec<&str> = "scraper.parse_page".split('.').collect();
        let parent = vec!["scraper".to_string()];
        assert_eq!(matches_chain(&q, &parent, "par"), Some("parse_page".into()));
        assert_eq!(matches_chain(&q, &parent, ""), Some("parse_page".into()));
        assert_eq!(matches_chain(&q, &parent, "x"), None);

        let parent2 = vec!["other".to_string()];
        assert_eq!(matches_chain(&q, &parent2, "par"), None);
    }

    #[test]
    fn matches_top_level_name() {
        let q: Vec<&str> = "parse_page".split('.').collect();
        let parent: Vec<String> = Vec::new();
        assert_eq!(matches_chain(&q, &parent, "parse"), Some("parse_page".into()));
    }

    #[test]
    fn extracts_dot_chain() {
        let text = "x = scraper.par\nprint(1)\n";
        // 光标在 "scraper.par" 末尾（第 0 行第 15 个 UTF-16 列）
        assert_eq!(dot_chain_at(text, 0, 15), Some("scraper.par".to_string()));
        // 尾点形式：光标在 "." 之后（第 12 列），保留尾部点
        assert_eq!(dot_chain_at(text, 0, 12), Some("scraper.".to_string()));
        // 非标识符前（等号后空格，第 2 列）→ 空
        assert_eq!(dot_chain_at(text, 0, 2), Some(String::new()));
    }

    #[test]
    fn completes_symbols() {
        let idx = symbol_fixture();

        // `scraper.par` → parse_page
        let doc = "data = scraper.par";
        let cands = complete(&idx, doc, 0, doc.len() as u32);
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].label, "parse_page");
        assert_eq!(cands[0].kind, CandidateKind::Function);
        assert!(cands[0].detail.contains("⟳ runtime"));

        // `scraper.` → 全部成员
        let doc2 = "data = scraper.";
        let cands2 = complete(&idx, doc2, 0, doc2.len() as u32);
        let labels: Vec<&str> = cands2.iter().map(|c| c.label.as_str()).collect();
        assert!(labels.contains(&"parse_page") && labels.contains(&"fetch_url"));

        // `parse_p`（顶级名）→ 两个（跨文件），hits 降序
        let doc3 = "x = parse_p";
        let cands3 = complete(&idx, doc3, 0, doc3.len() as u32);
        assert_eq!(cands3.len(), 2);
        assert_eq!(cands3[0].label, "parse_page");
        assert_eq!(cands3[1].label, "parse_pages");
    }

    /// 下标访问补全端到端：`data = parse_page()` 返回 dict，shape 含 title/url → `data["` 补全键。
    #[test]
    fn completes_dict_keys_via_subscript() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute(
                "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('m.py','parse_page',1,10,0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO ret_types(fid,type_label,shape,count) VALUES(1,'dict[str, int]','[\"title\",\"url\"]',7)",
                [],
            )
            .unwrap();
        }
        let idx = TraceIndex::open(&path).unwrap();

        // `data["ti` → title 键
        let doc = "data = parse_page(url)\nprint(data[\"ti";
        let line_len = doc.lines().nth(1).unwrap().len() as u32;
        let cands = complete(&idx, doc, 1, line_len);
        let title = cands.iter().find(|c| c.label == "title");
        assert!(title.is_some(), "应补全出 title 键，实际 {cands:?}");
        let title = title.unwrap();
        assert_eq!(title.kind, CandidateKind::Field);
        assert!(title.detail.contains("dict[str, int]"));

        // `data["`（空前缀）→ title/url 两个键
        let doc2 = "data = parse_page(url)\ny = data[\"";
        let line_len2 = doc2.lines().nth(1).unwrap().len() as u32;
        let cands2 = complete(&idx, doc2, 1, line_len2);
        let fields: Vec<&str> = cands2.iter().map(|c| c.label.as_str()).collect();
        assert!(fields.contains(&"title") && fields.contains(&"url"));

        // `.get("` 形态同样补全键
        let doc3 = "data = parse_page(url)\nz = data.get(\"ur";
        let line_len3 = doc3.lines().nth(1).unwrap().len() as u32;
        let cands3 = complete(&idx, doc3, 1, line_len3);
        assert!(cands3.iter().any(|c| c.label == "url"), "data.get(\"ur 应补全 url，实际 {cands3:?}");

        // 点访问不再补 dict 键（dict 无属性访问）
        let doc4 = "data = parse_page(url)\ny = data.";
        let line_len4 = doc4.lines().nth(1).unwrap().len() as u32;
        let cands4 = complete(&idx, doc4, 1, line_len4);
        assert!(
            !cands4.iter().any(|c| c.label == "title"),
            "data. 不应补 dict 键 title，实际 {cands4:?}"
        );
    }

    /// 多层链式 + list 索引下标补全（`quotes["data"]["diff"][0]["`）。
    #[test]
    fn completes_nested_dict_keys_via_chain() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute(
                "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('m.py','get_quotes',1,10,0)",
                [],
            )
            .unwrap();
            // 递归 shape：data → dict{k: diff → list{e: dict{k: code,name}}}
            conn.execute(
                r#"INSERT INTO ret_types(fid,type_label,shape,count) VALUES(1,'dict[str, object]','{"data":{"t":"dict","k":{"diff":{"t":"list","e":{"t":"dict","k":{"code":"str","name":"str"}}}}}}',7)"#,
                [],
            )
            .unwrap();
        }
        let idx = TraceIndex::open(&path).unwrap();

        // `quotes["data"]["` → 补 diff
        let doc = "quotes = get_quotes()\ny = quotes[\"data\"][\"";
        let line_len = doc.lines().nth(1).unwrap().len() as u32;
        let cands = complete(&idx, doc, 1, line_len);
        let fields: Vec<&str> = cands.iter().map(|c| c.label.as_str()).collect();
        assert!(fields.contains(&"diff"), "应补 data 子键 diff，实际 {cands:?}");

        // `quotes["data"]["diff"][0]["` → 补 code/name（多层 + list 索引）
        let doc2 = "quotes = get_quotes()\ny = quotes[\"data\"][\"diff\"][0][\"";
        let line_len2 = doc2.lines().nth(1).unwrap().len() as u32;
        let cands2 = complete(&idx, doc2, 1, line_len2);
        let fields2: Vec<&str> = cands2.iter().map(|c| c.label.as_str()).collect();
        assert!(
            fields2.contains(&"code") && fields2.contains(&"name"),
            "深层应补 code/name，实际 {cands2:?}"
        );

        // `quotes.get("data")["` 同理（get 形态）
        let doc3 = "quotes = get_quotes()\ny = quotes.get(\"data\")[\"";
        let line_len3 = doc3.lines().nth(1).unwrap().len() as u32;
        let cands3 = complete(&idx, doc3, 1, line_len3);
        assert!(
            cands3.iter().any(|c| c.label == "diff"),
            "get 形态应补 diff，实际 {cands3:?}"
        );
    }

    /// jmespath 路径补全：`jmespath.search("data.diff[0].co", quotes)` 补 code。
    #[test]
    fn completes_jmespath_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute(
                "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('m.py','get_quotes',1,10,0)",
                [],
            )
            .unwrap();
            conn.execute(
                r#"INSERT INTO ret_types(fid,type_label,shape,count) VALUES(1,'dict[str, object]','{"data":{"t":"dict","k":{"diff":{"t":"list","e":{"t":"dict","k":{"code":"str","name":"str"}}}}}}',7)"#,
                [],
            )
            .unwrap();
        }
        let idx = TraceIndex::open(&path).unwrap();

        // 深层路径：`jmespath.search("data.diff[0].co", quotes)` → 补 code
        let text = "quotes = get_quotes()\nresult = jmespath.search(\"data.diff[0].co\", quotes)";
        let l2 = text.lines().nth(1).unwrap();
        let col = l2.find(".co").unwrap() as u32 + 3;
        let cands = complete(&idx, text, 1, col);
        assert!(cands.iter().any(|c| c.label == "code"), "深度 jmespath 应补 code，实际 {cands:?}");

        // 顶层：`jmespath.search("dat", quotes)` → 补 data
        let text2 = "quotes = get_quotes()\nresult = jmespath.search(\"dat\", quotes)";
        let l2b = text2.lines().nth(1).unwrap();
        let col2 = l2b.find("dat").unwrap() as u32 + 3;
        let cands2 = complete(&idx, text2, 1, col2);
        assert!(cands2.iter().any(|c| c.label == "data"), "顶层应补 data，实际 {cands2:?}");

        // 非 jmespath 字符串不影响：普通字符串不触发
        let line3 = "s = \"data.diff\"";
        let col3 = line3.len() as u32 - 1;
        let cands3 = complete(&idx, line3, 0, col3);
        assert!(cands3.is_empty(), "非 jmespath 字符串不应补全，实际 {cands3:?}");
    }

    // ---- P3-T10 运行时补全准确率评测（Gate D：无注解代码 ≥ 85%）----

    /// 评测点：文档内嵌 `<|>` 光标标记 + 期望补全 label。
    struct BenchCase {
        doc: &'static str,
        expect: &'static str,
    }

    /// 23 评测点的形态归类（索引 0 基，对应 cases 数组顺序）。
    /// 与 `bench/reports/gate-d-runtime-completion.md` 的形态表一一对应，
    /// 仅用于生成人工对标工作单，不参与判定。
    const BENCH_SHAPES: [&str; 23] = [
        "① 函数返回 dict → 字段",
        "① 函数返回 dict → 字段",
        "① 函数返回 dict → 字段（前缀 tit）",
        "① 函数返回 dict → 字段（前缀 li）",
        "② 工厂返回自定义实例 → 属性",
        "② 工厂返回自定义实例 → 属性",
        "② 工厂返回自定义实例 → 属性",
        "② 工厂返回自定义实例 → 属性",
        "② 工厂返回自定义实例 → 属性（前缀 cu）",
        "② 工厂返回自定义实例 → 属性（前缀 it）",
        "③ 商品字典字段",
        "③ 商品字典字段",
        "③ 商品字典字段（前缀 na）",
        "③ 商品字典字段（前缀 pr）",
        "③ 商品字典字段（前缀 st）",
        "④ 用户实例属性",
        "④ 用户实例属性",
        "④ 用户实例属性（前缀 em）",
        "④ 用户实例属性（前缀 ro）",
        "⑤ for 循环变量（list[User]）",
        "⑤ for 循环变量（list[User]）",
        "⑥ 函数参数类型观测",
        "⑥ 函数参数类型观测",
    ];

    /// 导出人工对标工作单（Gate D 剩余项 1「≥ PyCharm 同场景」用）。
    ///
    /// 为什么要自动化这一步：PyCharm 无 CLI 导出补全准确率，只能人工逐点复核。
    /// 若让人自己重新拼 23 个光标位置，既慢又会与本测试的 cases 数组漂移。
    /// 这里直接把**本测试自己的 cases** 渲染成工作单——Pylume 一列（期望 / 实际排名）
    /// 由测试填好，人只需在 PyCharm 里对同一位置点补全、勾「是否在 top-5」。
    ///
    /// 触发：设 `OC_GATE_D_WORKLIST=<输出路径>` 后跑
    /// `cargo test -p pylume-intel -- --nocapture runtime_completion_accuracy`。
    /// 不设则完全不写文件（保持测试无副作用）。
    fn dump_worklist(path: &str, cases: &[BenchCase], ranks: &[Option<usize>]) {
        use std::fmt::Write as _;
        let mut md = String::new();
        let _ = writeln!(md, "# Gate D 人工对标工作单（PyCharm 同场景）");
        let _ = writeln!(md);
        let _ = writeln!(
            md,
            "> 由 `cargo test -p pylume-intel -- --nocapture runtime_completion_accuracy` 自动导出（设 `OC_GATE_D_WORKLIST=<路径>`）。"
        );
        let _ = writeln!(
            md,
            "> **Pylume 两列已由测试填好**，人只需在 PyCharm 打开 `bench/sample/unannotated_scraper/` 同一样例、"
        );
        let _ = writeln!(
            md,
            "> 在下表「光标位置」处触发补全，勾选期望 label 是否出现在 **top-5**。"
        );
        let _ = writeln!(
            md,
            "> 判定口径与 `bench/reports/gate-d-runtime-completion.md` 一致：期望 label 出现在 top-5 即命中。");
        let _ = writeln!(md);
        let _ = writeln!(
            md,
            "> 读法：`▏` = 光标位置（在此触发补全），`↵` = 换行（同一列里换行只是排版，代码本身是一行接一行）。"
        );
        let _ = writeln!(md, "> 例：``data = parse_page(html)↵print(data[\"▏`` 表示在 `data[\"` 后触发补全。");
        let _ = writeln!(md);
        let _ = writeln!(md, "| # | 形态 | 期望 label | 光标位置 | Pylume 实际排名 | Pylume 命中 | PyCharm 命中（人工填） | 备注 |");
        let _ = writeln!(md, "|---|---|---|---|---|---|---|---|");
        for (i, c) in cases.iter().enumerate() {
            // 表格单元格必须单行：换行折成 ↵，光标标记 ▏ 保留，竖线转义
            let ctx = c.doc.replace("\r\n", "\n").replace('\n', "↵").replace("<|>", "▏");
            let rank = ranks[i];
            let oc_rank = match rank {
                Some(0) => "**1**".to_string(),
                Some(r) => (r + 1).to_string(),
                None => "未进 top-5".to_string(),
            };
            let oc_hit = if rank.is_some() { "✅" } else { "❌" };
            let _ = writeln!(
                md,
                "| {} | {} | `{}` | `{}` | {} | {} | ☐ | |",
                i + 1,
                BENCH_SHAPES.get(i).copied().unwrap_or("—"),
                c.expect,
                ctx.replace('|', "\\|"),
                oc_rank,
                oc_hit
            );
        }
        let hit_n = ranks.iter().filter(|r| r.is_some()).count();
        let _ = writeln!(md);
        let _ = writeln!(
            md,
            "## 小结（人工填）"
        );
        let _ = writeln!(md);
        let _ = writeln!(md, "- Pylume 命中：{hit_n}/{}", cases.len());
        let _ = writeln!(md, "- PyCharm 命中：___/{}（人工填）", cases.len());
        let _ = writeln!(md, "- 结论（人工填）：☐ Pylume ≥ PyCharm　☐ Pylume < PyCharm　☐ 持平");
        if let Ok(mut f) = std::fs::File::create(path) {
            use std::io::Write as _;
            let _ = f.write_all(md.as_bytes());
        }
    }

    /// 解析 `<|>` 标记为 (0 基行, 0 基 UTF-16 列)。
    fn cursor_of(doc: &str) -> (u32, u32) {
        let pos = doc.find("<|>").expect("缺光标标记 <|>");
        let before: String = doc.chars().take(pos).collect();
        let line = before.matches('\n').count() as u32;
        let col = before.chars().rev().take_while(|&c| c != '\n').count() as u32;
        (line, col)
    }

    /// 模拟无注解「订单 + 爬虫」项目运行后的 trace 观测（deterministic seed）。
    fn bench_seed() -> TraceIndex {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bench.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            let funcs = [
                ("shop.py", "parse_page", 1, 120, 0),
                ("shop.py", "make_order", 2, 80, 0),
                ("shop.py", "fetch_product", 3, 60, 0),
                ("shop.py", "get_user", 4, 45, 0),
                ("shop.py", "list_users", 5, 30, 0),
                ("shop.py", "handle_order", 6, 15, 0),
            ];
            for (f, q, l, h, s) in funcs {
                conn.execute(
                    "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES(?1,?2,?3,?4,?5)",
                    rusqlite::params![f, q, l, h, s],
                )
                .unwrap();
            }
            let rets = [
                (1, "dict[str, str|list]", "[\"links\",\"title\"]", 100),
                (2, "Order", "[\"customer\",\"id\",\"items\",\"total\"]", 80),
                (3, "dict[str, str|float|int]", "[\"name\",\"price\",\"sku\",\"stock\"]", 60),
                (4, "User", "[\"email\",\"name\",\"roles\"]", 45),
                (5, "list[User]", "", 30),
            ];
            for (fid, ty, shape, c) in rets {
                conn.execute(
                    "INSERT INTO ret_types(fid,type_label,shape,count) VALUES(?1,?2,?3,?4)",
                    rusqlite::params![fid, ty, shape, c],
                )
                .unwrap();
            }
            conn.execute(
                "INSERT INTO arg_types(fid,arg,type_label,shape,count) VALUES(6,'order','Order','[\"customer\",\"id\",\"items\",\"total\"]',15)",
                [],
            )
            .unwrap();
        }
        TraceIndex::open(&path).unwrap()
    }

    /// 运行时补全准确率（确定性 seed + 评测点集，覆盖无注解代码四种核心形态）。
    #[test]
    fn runtime_completion_accuracy() {
        let idx = bench_seed();
        let cases: &[BenchCase] = &[
            // ① 函数返回 dict → 下标访问补全键
            BenchCase { doc: "data = parse_page(html)\nprint(data[\"<|>", expect: "title" },
            BenchCase { doc: "data = parse_page(html)\nprint(data[\"<|>", expect: "links" },
            BenchCase { doc: "data = parse_page(html)\nprint(data[\"tit<|>", expect: "title" },
            BenchCase { doc: "data = parse_page(html)\nprint(data[\"li<|>", expect: "links" },
            // ② 工厂返回自定义实例 → 属性补全
            BenchCase { doc: "o = make_order(c)\nprint(o.<|>", expect: "id" },
            BenchCase { doc: "o = make_order(c)\nprint(o.<|>", expect: "customer" },
            BenchCase { doc: "o = make_order(c)\nprint(o.<|>", expect: "items" },
            BenchCase { doc: "o = make_order(c)\nprint(o.<|>", expect: "total" },
            BenchCase { doc: "o = make_order(c)\nprint(o.cu<|>", expect: "customer" },
            BenchCase { doc: "o = make_order(c)\nprint(o.it<|>", expect: "items" },
            // ③ 商品字典键（下标访问）
            BenchCase { doc: "p = fetch_product(sku)\nprint(p[\"<|>", expect: "sku" },
            BenchCase { doc: "p = fetch_product(sku)\nprint(p[\"<|>", expect: "name" },
            BenchCase { doc: "p = fetch_product(sku)\nprint(p[\"na<|>", expect: "name" },
            BenchCase { doc: "p = fetch_product(sku)\nprint(p[\"pr<|>", expect: "price" },
            BenchCase { doc: "p = fetch_product(sku)\nprint(p[\"st<|>", expect: "stock" },
            // ④ 用户实例属性
            BenchCase { doc: "u = get_user(uid)\nprint(u.<|>", expect: "name" },
            BenchCase { doc: "u = get_user(uid)\nprint(u.<|>", expect: "email" },
            BenchCase { doc: "u = get_user(uid)\nprint(u.em<|>", expect: "email" },
            BenchCase { doc: "u = get_user(uid)\nprint(u.ro<|>", expect: "roles" },
            // ⑤ for 循环变量（P3-T08 补强）
            BenchCase { doc: "for u in list_users():\n    print(u.<|>", expect: "name" },
            BenchCase { doc: "for u in list_users():\n    print(u.<|>", expect: "email" },
            // ⑥ 函数参数类型观测
            BenchCase { doc: "def handle_order(order):\n    return order.<|>", expect: "id" },
            BenchCase { doc: "def handle_order(order):\n    return order.<|>", expect: "customer" },
        ];

        let mut hit = 0usize;
        let mut miss: Vec<&str> = Vec::new();
        // 记录每个评测点的实际排名（None = 未进 top-5），既用于工作单也便于失败定位
        let mut ranks: Vec<Option<usize>> = Vec::with_capacity(cases.len());
        for c in cases {
            let (line, col) = cursor_of(c.doc);
            let text = c.doc.replace("<|>", "");
            let cands = complete(&idx, &text, line, col);
            let top5: Vec<&str> = cands.iter().take(5).map(|x| x.label.as_str()).collect();
            let rank = top5.iter().position(|l| *l == c.expect);
            if rank.is_some() {
                hit += 1;
            } else {
                miss.push(c.expect);
            }
            ranks.push(rank);
        }
        let total = cases.len();
        let rate = hit as f64 / total as f64;
        println!("[bench] 运行时补全准确率: {hit}/{total} = {:.1}%", rate * 100.0);
        if !miss.is_empty() {
            println!("[bench] 未命中: {miss:?}");
        }
        // 人工对标工作单（Gate D 剩余项 1）：仅在显式设 OC_GATE_D_WORKLIST 时写文件
        if let Ok(path) = std::env::var("OC_GATE_D_WORKLIST") {
            if !path.trim().is_empty() {
                dump_worklist(path.trim(), cases, &ranks);
                println!("[bench] 人工对标工作单已导出: {}", path.trim());
            }
        }
        assert!(
            rate >= 0.85,
            "运行时补全准确率 {:.1}% 低于 85% 红线",
            rate * 100.0
        );
    }

    /// stale 降权参数被钉住：`STALE_HITS_DIVISOR` 不得被改回裸字面量或悄悄变更。
    ///
    /// 为什么要这条：`runtime_completion_accuracy` 的 seed **全部 stale=0**
    /// （`bench_seed()`），所以 23 个评测点对降权策略**零覆盖**——100% 分数
    /// 无法证明降权行为正确或合理。参数一旦被改回字面量，也没有任何测试会失败。
    /// 本用例补上这个空白：同一 hits 下 stale 候选必须排在新鲜候选之后。
    #[test]
    fn stale_candidates_rank_below_fresh_ones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stale.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            // 同样 hits=40，一个 fresh 一个 stale —— 排序差异必须只由 stale 标记决定
            for (lineno, qual, stale) in [(1, "fresh_fn", 0), (2, "stale_fn", 1)] {
                conn.execute(
                    "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('m.py',?1,?2,40,?3)",
                    rusqlite::params![qual, lineno, stale],
                )
                .unwrap();
            }
        }
        let idx = TraceIndex::open(&path).unwrap();

        // 直接取符号候选的原始 score（同模块私有函数），避免受补全入口的
        // 光标/前缀判定与 MAX_CANDIDATES 截断影响 —— 本用例只验降权语义。
        let cands = symbol_candidates(&idx, &[], "");
        let score_of = |label: &str| {
            cands
                .iter()
                .find(|c| c.label == label)
                .unwrap_or_else(|| panic!("{label} 应在符号候选中，实际 {:?}", cands))
                .score
        };
        let (fresh, stale) = (score_of("fresh_fn"), score_of("stale_fn"));

        assert_eq!(fresh, 40, "新鲜候选分数应等于原 hits");
        assert_eq!(
            stale,
            40 / STALE_HITS_DIVISOR,
            "stale 候选分数应等于 hits / STALE_HITS_DIVISOR"
        );
        assert!(
            stale < fresh,
            "同 hits 下 stale 必须排后（fresh={fresh} stale={stale}）"
        );
        // 参数语义：除数是整数除法，必须 >=2 才不会把 stale 抬到与 fresh 同分
        assert!(STALE_HITS_DIVISOR >= 2, "除数 <2 会使 stale 与 fresh 同分，降权失效");
        // stale 只降权、不隐藏 —— 降权是排序手段，不是可见性开关
        assert!(
            cands.iter().any(|c| c.label == "stale_fn" && c.detail.contains("stale")),
            "stale 候选应仍在列表中并带 · stale 标注"
        );
    }

    /// CR-12：jmespath 调用识别收窄——re.search 不再误判，正常补全不被吞。
    #[test]
    fn jmespath_detection_narrowed() {
        // 判定函数本身：正例
        assert!(is_jmespath_call_prefix("result = jmespath.search("));
        assert!(is_jmespath_call_prefix("result = jmespath.compile("));
        assert!(is_jmespath_call_prefix("result = jmespath.compile(\"a\").search("));
        assert!(is_jmespath_call_prefix("result = compile(\"a\").search("));
        // 判定函数本身：负例（曾误命中）
        assert!(!is_jmespath_call_prefix("result = re.search("));
        assert!(!is_jmespath_call_prefix("result = re.compile("));
        assert!(!is_jmespath_call_prefix("result = search("));
        assert!(!is_jmespath_call_prefix("result = compile("));
        assert!(!is_jmespath_call_prefix("x = myobj.compile("));
        assert!(!is_jmespath_call_prefix("x = myobj.search("));

        // 端到端（补全）：re.search 路径串内不触发 jmespath 补全（原被吞，正常补全失效）
        let idx = jmespath_fixture();
        let text = "quotes = get_quotes()\nresult = re.search(\"data.dff\", quotes)";
        let l2 = text.lines().nth(1).unwrap();
        let col = l2.find("dff").unwrap() as u32 + 2;
        let cands = complete(&idx, text, 1, col);
        assert!(
            !cands.iter().any(|c| c.label == "diff"),
            "re.search 不应触发 jmespath 补全，实际 {cands:?}"
        );

        // 端到端（补全）：jmespath.search 正常触发
        let text2 = "quotes = get_quotes()\nresult = jmespath.search(\"data.d\", quotes)";
        let l2b = text2.lines().nth(1).unwrap();
        let col2 = l2b.find("data.d").unwrap() as u32 + 6;
        let cands2 = complete(&idx, text2, 1, col2);
        assert!(
            cands2.iter().any(|c| c.label == "diff"),
            "jmespath.search 应补 diff，实际 {cands2:?}"
        );
    }

    /// jmespath 测试索引：get_quotes() → dict{data: dict{k: diff: list{e: dict{k: code}}}}。
    fn jmespath_fixture() -> TraceIndex {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute(
                "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('m.py','get_quotes',1,10,0)",
                [],
            )
            .unwrap();
            conn.execute(
                r#"INSERT INTO ret_types(fid,type_label,shape,count) VALUES(1,'dict[str, object]','{"data":{"t":"dict","k":{"diff":{"t":"list","e":{"t":"dict","k":{"code":"str"}}}}}}',7)"#,
                [],
            )
            .unwrap();
        }
        TraceIndex::open(&path).unwrap()
    }
}