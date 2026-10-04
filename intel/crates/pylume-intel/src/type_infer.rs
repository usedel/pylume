//! P3-T03b 轻量类型推断：从文档文本推断「对象变量」的运行时类型，并从类型反查成员。
//!
//! 不引入 Python 解析器，仅覆盖无注解脚本里最高频形态（逐行回溯 + 前缀匹配）：
//! - `x = fn()`        → `fn` 的 ret_types 观测（count 最高者）；
//! - `x = <字面量>`    → list / dict / str / int / float / bool / None；
//! - `def f(x, ...)` 内使用 `x` → `f` 的 arg_types 同名参数观测；
//! - `x: T = ...` 注解赋值 → 同上走右值（注解本身不用于推断，简化为右值规则）。
//!
//! `members_for_type`：给定类型标签，聚合 trace 里该类型的 `shape`（dict 键 / 实例属性名）
//! 作为成员候选（属性补全用）。

use std::collections::HashMap;

use pylume_intel_index::type_label::{parse, TypeLabel};
use pylume_intel_index::TraceIndex;

/// 推断 receiver 变量（如 `x`）在 `line` 行处的运行时类型标签（字符串），无法推断返回 `None`。
pub fn infer_receiver_type(
    index: &TraceIndex,
    text: &str,
    receiver: &str,
    line: u32,
) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    infer_upward(index, &lines, line as usize, receiver)
}

/// 从 `idx` 行向上回溯推断 `receiver` 的运行时类型（P3-T08：支持 for 循环变量）。
fn infer_upward(
    index: &TraceIndex,
    lines: &[&str],
    mut idx: usize,
    receiver: &str,
) -> Option<String> {
    while idx > 0 {
        idx -= 1;
        let l = lines[idx].trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        if let Some(rhs) = assignment_rhs(l, receiver) {
            return infer_rhs(index, rhs);
        }
        // P3-T08：`for x in <expr>:` → x = <expr> 的元素类型（递归推断 expr 变量）
        if l.starts_with("for ") {
            if let Some(ty) = for_var_type(index, lines, idx, l, receiver) {
                return Some(ty);
            }
            continue;
        }
        if l.starts_with("def ") || l.starts_with("class ") {
            // 到达作用域边界：`def` 行可做参数推断，`class` 停止
            if l.starts_with("def ") {
                if let Some(ty) = infer_param_type(index, l, receiver) {
                    return Some(ty);
                }
            }
            break;
        }
    }
    None
}

/// 给定类型标签，聚合该类型所有 shape 字段 → `(字段名, 证据计数)`，按计数降序。
/// CR-17：走 `(type_label, fid)` 倒排（原全量函数扫描 × 每观测重复 parse_shape）。
/// CR-27：`members_for_type` 实现为 `chain_keys(index, ty, &[])` 的薄封装（两者原本 ~90% 重复）。
pub fn members_for_type(index: &TraceIndex, type_label: &str) -> Vec<(String, i64)> {
    chain_keys(index, type_label, &[])
}

/// 沿访问链解析 type_label 的 shape，返回最终层的键集合（带证据计数），供链式下标补全。
/// 空链 → 顶层键集合（等价 `members_for_type`）。
/// CR-17：走 `(type_label, fid)` 倒排迭代（原全量函数扫描）；shape 解析结果
/// 经 `shape_cache` 复用（同 (type_label,shape) 字符串只解析一次）。
pub(crate) fn chain_keys(
    index: &TraceIndex,
    type_label: &str,
    chain: &[Access],
) -> Vec<(String, i64)> {
    thread_local! {
        /// (type_label, shape 字符串) → 解析结果。单次查询后即清空（见函数末尾），
        /// 不跨请求累积——同一请求内 members/chain 多次命中同 shape 的重复解析被消除。
        static SHAPE_CACHE: std::cell::RefCell<HashMap<(String, String), Option<ParsedShape>>> =
            std::cell::RefCell::new(HashMap::new());
    }
    let mut counts: HashMap<String, i64> = HashMap::new();
    for (f, obs, _is_ret) in index.observations_of_type(type_label) {
        if f.stale {
            continue; // P3-T08：陈旧观测（代码已变更）降权丢弃
        }
        let Some(shape) = &obs.shape else { continue };
        let parsed = SHAPE_CACHE.with(|c| {
            let key = (type_label.to_string(), shape.clone());
            if let Some(v) = c.borrow().get(&key) {
                return v.clone();
            }
            let v = parse_shape(shape, type_label).ok();
            c.borrow_mut().insert(key, v.clone());
            v
        });
        let Some(parsed) = parsed else { continue };
        if let Some(node) = resolve_node(parsed, chain) {
            if let ShapeNode::Dict(map) = node {
                for key in map.keys() {
                    *counts.entry(key.clone()).or_insert(0) += obs.count.max(1);
                }
            }
        }
    }
    SHAPE_CACHE.with(|c| c.borrow_mut().clear()); // 查询结束即清空，防跨请求累积
    let mut v: Vec<(String, i64)> = counts.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    v
}

/// 沿链解析：`Key` 进入 dict 子节点，`Index` 进入 list 元素；任一步不匹配则 None。
fn resolve_node(shape: ParsedShape, chain: &[Access]) -> Option<ShapeNode> {
    let mut cur = match shape {
        // 旧数组格式（实例属性名/旧 dict 键集合）：视为「键 → 标量」的扁平 dict，支持顶层键补全
        ParsedShape::Keys(keys) => Some(ShapeNode::Dict(
            keys.into_iter().map(|k| (k, ShapeNode::Scalar)).collect(),
        )),
        ParsedShape::Dict(map) => Some(ShapeNode::Dict(map)),
        ParsedShape::List(n) => Some(n),
    };
    for acc in chain {
        match (cur, acc) {
            (Some(ShapeNode::Dict(map)), Access::Key(k)) => cur = map.get(k).cloned(),
            (Some(ShapeNode::List(elem)), Access::Index) => cur = Some(*elem),
            _ => return None,
        }
    }
    cur
}

/// 沿访问链校验 shape，返回第一个错误描述；全合法返回 None（供 jmespath 诊断）。
pub(crate) fn validate_chain(index: &TraceIndex, type_label: &str, chain: &[Access]) -> Option<String> {
    let mut cur = first_shape_node(index, type_label)?;
    for acc in chain {
        match (cur, acc) {
            (ShapeNode::Dict(map), Access::Key(k)) => match map.get(k) {
                Some(next) => cur = next.clone(),
                None => {
                    let hint = suggestion(&map, k);
                    return Some(match hint {
                        Some(s) => format!("字段 \"{k}\" 不存在，是否想写 \"{s}\"？"),
                        None => format!("字段 \"{k}\" 不在运行时观测到的结构中"),
                    });
                }
            },
            (ShapeNode::Dict(_), Access::Index) => {
                return Some("对对象使用了下标 [n]，应为字段访问".to_string());
            }
            (ShapeNode::List(_), Access::Key(k)) => {
                return Some(format!("对数组使用了字段访问 .{k}，应先 [*] 或 [0] 取元素"));
            }
            (ShapeNode::List(elem), Access::Index) => cur = *elem,
            (ShapeNode::Scalar, _) => {
                return Some("对非容器值继续访问字段/下标".to_string());
            }
        }
    }
    None
}

/// 取 type_label 的第一个可解析结构（dict 顶层 / list 顶层 / 旧 Keys 视作扁平 dict）。
/// CR-17：走 `(type_label, fid)` 倒排（原全量函数扫描）。
fn first_shape_node(index: &TraceIndex, type_label: &str) -> Option<ShapeNode> {
    for (f, obs, _is_ret) in index.observations_of_type(type_label) {
        if f.stale {
            continue;
        }
        let Some(shape) = obs.shape.as_deref() else { continue };
        if let Ok(parsed) = parse_shape(shape, type_label) {
            return match parsed {
                ParsedShape::Dict(map) => Some(ShapeNode::Dict(map)),
                ParsedShape::List(elem) => Some(elem),
                ParsedShape::Keys(keys) => Some(ShapeNode::Dict(
                    keys.into_iter().map(|k| (k, ShapeNode::Scalar)).collect(),
                )),
            };
        }
    }
    None
}

/// 轻量拼写建议：取共享前缀最长的候选键（无共同前缀则 None）。
fn suggestion(map: &HashMap<String, ShapeNode>, key: &str) -> Option<String> {
    let mut best: Option<(String, usize)> = None;
    for k in map.keys() {
        let common = k.chars().zip(key.chars()).take_while(|(a, b)| a == b).count();
        if common == 0 {
            continue;
        }
        if best.as_ref().map(|(_, c)| common > *c).unwrap_or(true) {
            best = Some((k.clone(), common));
        }
    }
    best.map(|(s, _)| s)
}

/// 判断 `l` 是否为 `receiver` 的赋值语句，返回右值（不含尾逗号/空白）。
fn assignment_rhs<'a>(l: &'a str, receiver: &str) -> Option<&'a str> {
    let rest = l.strip_prefix(receiver)?;
    let rest = rest.trim_start();
    if let Some(rhs) = rest.strip_prefix('=') {
        return Some(rhs.trim_start());
    }
    // 注解赋值 `x: T = ...`
    if let Some(after_colon) = rest.strip_prefix(':') {
        if let Some(eq) = after_colon.find('=') {
            return Some(after_colon[eq + 1..].trim_start());
        }
    }
    None
}

/// 从右值文本推断类型标签（供补全属性推断与 inlay hints 共用）。
pub(crate) fn infer_rhs(index: &TraceIndex, rhs: &str) -> Option<String> {
    let rhs = rhs.trim().trim_end_matches(',').trim();
    if rhs.is_empty() {
        return None;
    }
    // 字符串（含 f-string）
    if rhs.starts_with('"') || rhs.starts_with('\'') || rhs.starts_with("f\"") || rhs.starts_with("f'") {
        return Some("str".into());
    }
    // 空容器字面量
    if rhs.starts_with('[') || rhs == "list()" {
        return Some("list".into());
    }
    if rhs.starts_with('{') {
        return Some("dict".into());
    }
    // 标量
    if rhs == "True" || rhs == "False" {
        return Some("bool".into());
    }
    if rhs == "None" {
        return Some("None".into());
    }
    if rhs.parse::<i64>().is_ok() {
        return Some("int".into());
    }
    if rhs.parse::<f64>().is_ok() {
        return Some("float".into());
    }
    // 函数调用返回值
    if let Some(name) = call_name(rhs) {
        return ret_type_of(index, name);
    }
    None
}

/// 提取形如 `name(...)` 的调用名（允许模块前缀 `mod.func(...)`）；非调用返回 None。
fn call_name(rhs: &str) -> Option<&str> {
    let open = rhs.find('(')?;
    let name = rhs[..open].trim();
    is_path_name(name).then_some(name)
}

/// 聚合 `name` 的返回类型观测（count 最高者）。`name` 可能与 qualname 仅最后一段对齐
/// （调用点写短名 `parse_page()` 或全限定名 `scraper.parse_page()` 均按最后一段匹配）。
/// CR-17：走 `by_last_segment` 倒排（原全量函数扫描 + 每函数 rsplit）。
fn ret_type_of(index: &TraceIndex, name: &str) -> Option<String> {
    let seg = last_segment(name);
    let mut best: Option<(String, i64)> = None;
    for f in index.by_last_segment(seg) {
        if f.stale {
            continue; // P3-T08
        }
        if let Some(r) = f.rets.iter().max_by_key(|r| r.count) {
            if best.as_ref().map_or(true, |(_, c)| r.count > *c) {
                best = Some((r.type_label.clone(), r.count));
            }
        }
    }
    best.map(|(t, _)| t)
}

/// 从 `def f(x, ...):` 行推断参数 `receiver` 的类型观测。
fn infer_param_type(index: &TraceIndex, def_line: &str, receiver: &str) -> Option<String> {
    let after_def = def_line.strip_prefix("def ")?;
    let open = after_def.find('(')?;
    let fn_name = after_def[..open].trim();
    let close = after_def.rfind(')')?;
    let params = &after_def[open + 1..close];
    let names: Vec<&str> = params
        .split(',')
        .map(|p| p.split(&['=', ':'][..]).next().unwrap_or("").trim())
        .collect();
    if !names.iter().any(|n| *n == receiver) {
        return None;
    }
    let mut best: Option<(String, i64)> = None;
    for f in index.by_last_segment(fn_name) {
        if f.stale {
            continue; // P3-T08
        }
        for a in &f.args {
            if a.arg == receiver {
                if best.as_ref().map_or(true, |(_, c)| a.count > *c) {
                    best = Some((a.type_label.clone(), a.count));
                }
            }
        }
    }
    best.map(|(t, _)| t)
}

/// P3-T08：`for x in <expr>:` 中循环变量 `x` 的类型 = `<expr>` 的元素类型。
fn for_var_type(
    index: &TraceIndex,
    lines: &[&str],
    for_idx: usize,
    for_line: &str,
    receiver: &str,
) -> Option<String> {
    let rest = for_line.strip_prefix("for ")?;
    let body = rest.split(':').next().unwrap_or(rest).trim();
    let in_pos = body.find(" in ")?;
    let var = body[..in_pos].trim();
    if var != receiver {
        return None;
    }
    let expr = body[in_pos + 4..].trim();
    let expr_ty = if is_identifier(expr) {
        // 迭代对象是变量：递归向上推断其类型（只回溯，不再进入循环语义）
        infer_upward(index, lines, for_idx, expr)?
    } else {
        infer_rhs(index, expr)?
    };
    element_type(&expr_ty)
}

/// 容器类型标签 → 元素类型标签（`list[T]` / `set[T]` / `tuple[T, ...]` → `T`）。
fn element_type(label: &str) -> Option<String> {
    match parse(label) {
        TypeLabel::List(t) | TypeLabel::Set(t) | TypeLabel::Frozenset(t) => named_element(&t),
        TypeLabel::Tuple(t) => named_element(&t),
        TypeLabel::Union(items) => items.iter().find_map(named_element),
        _ => None,
    }
}

/// 元素类型里取第一个具名类型（跳过 Unknown/Any/嵌套容器，MVP）。
fn named_element(t: &TypeLabel) -> Option<String> {
    match t {
        TypeLabel::Named(s) => Some(s.clone()),
        TypeLabel::Union(items) => items.iter().find_map(named_element),
        _ => None,
    }
}

fn is_identifier(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_')
}

/// qualname 最后一段（如 `scraper.parse_page` → `parse_page`）。
fn last_segment(qualname: &str) -> &str {
    qualname.rsplit('.').next().unwrap_or(qualname)
}

/// 调用路径名：标识符 + 点（如 `scraper.parse_page`）。
fn is_path_name(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.')
}

/// shape 递归节点：dict（键→子节点）/ list（元素节点）/ 标量（无子结构）。
#[derive(Debug, Clone)]
pub(crate) enum ShapeNode {
    Dict(HashMap<String, ShapeNode>),
    List(Box<ShapeNode>),
    Scalar,
}

/// 链式访问段：字符串键或 list 数字索引。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Access {
    Key(String),
    Index,
}

/// 链式访问最大层数（与 probe 的 `_MAX_SHAPE_DEPTH` 对齐，性能上限）。
pub(crate) const MAX_CHAIN: usize = 5;

/// shape 解析结果：JSON 数组（旧格式 / 实例属性名）、顶层 dict、或顶层 list（`{"e": ...}`）。
#[derive(Debug, Clone)]
pub(crate) enum ParsedShape {
    /// 扁平键名（实例属性名 / 旧版 dict 键集合），无子结构。
    Keys(Vec<String>),
    /// 顶层 dict：键 → 递归子结构。
    Dict(HashMap<String, ShapeNode>),
    /// 顶层 list（`{"e": ...}`）：元素结构。
    List(ShapeNode),
}

impl ParsedShape {
    /// 键名集合（顶层补全候选）。CR-27：members_for_type 改走 chain_keys 后仅测试使用。
    #[cfg(test)]
    pub(crate) fn keys(&self) -> Vec<&str> {
        match self {
            ParsedShape::Keys(v) => v.iter().map(|s| s.as_str()).collect(),
            ParsedShape::Dict(m) => m.keys().map(|s| s.as_str()).collect(),
            ParsedShape::List(_) => Vec::new(),
        }
    }
}

/// `shape` 为 compact.py 的 shape_fingerprint：数组（键名）或递归对象（键→值信息）。
///
/// 歧义消除：顶层 list 的 shape 是 `{"e": <对象>}`，而一个恰好只含键 `"e"` 且值为 dict 的
/// 顶层 dict 也会序列化成同样形态。两者只能靠 `type_label` 区分——序列类型
/// （list/tuple/set/frozenset）→ 顶层 list；dict 类型 → 单键 dict。
fn parse_shape(shape: &str, type_label: &str) -> Result<ParsedShape, serde_json::Error> {
    let v: serde_json::Value = serde_json::from_str(shape)?;
    Ok(match v {
        serde_json::Value::Array(arr) => ParsedShape::Keys(
            arr.iter()
                .filter_map(|x| x.as_str())
                .map(str::to_owned)
                .collect(),
        ),
        serde_json::Value::Object(map) => {
            // 顶层 list：`{"e": <元素结构>}` 且类型标签为序列；否则视为顶层 dict
            if map.len() == 1
                && map.get("e").map(|e| e.is_object()).unwrap_or(false)
                && is_sequence_label(type_label)
            {
                ParsedShape::List(node_from(&map["e"]))
            } else {
                let dict = map
                    .into_iter()
                    .map(|(k, val)| (k, node_from(&val)))
                    .collect();
                ParsedShape::Dict(dict)
            }
        }
        _ => ParsedShape::Keys(Vec::new()),
    })
}

/// 类型标签是否为序列容器（list/tuple/set/frozenset）——用于 shape `{"e"}` 歧义消除。
fn is_sequence_label(label: &str) -> bool {
    matches!(
        parse(label),
        TypeLabel::List(_) | TypeLabel::Tuple(_) | TypeLabel::Set(_) | TypeLabel::Frozenset(_)
    )
}

/// 递归解析 shape 节点：字符串 → 标量；`{"k":{...}}` → dict；`{"e":{...}}` → list。
fn node_from(v: &serde_json::Value) -> ShapeNode {
    match v {
        serde_json::Value::Object(o) => {
            if let Some(k) = o.get("k").and_then(|x| x.as_object()) {
                return ShapeNode::Dict(
                    k.iter()
                        .map(|(kk, vv)| (kk.clone(), node_from(vv)))
                        .collect(),
                );
            }
            if let Some(e) = o.get("e") {
                if e.is_object() {
                    return ShapeNode::List(Box::new(node_from(e)));
                }
            }
            ShapeNode::Scalar
        }
        _ => ShapeNode::Scalar,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pylume_intel_index::{TraceIndex, SCHEMA};
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
                "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('m.py','scraper.fetch',2,5,0)",
                [],
            )
            .unwrap();
            // parse_page 返回 dict[str,int]，shape 含 title/url
            conn.execute(
                "INSERT INTO ret_types(fid,type_label,shape,count) VALUES(1,'dict[str, int]','[\"title\",\"url\"]',7)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO ret_types(fid,type_label,shape,count) VALUES(1,'dict[str, int]','[\"title\"]',3)",
                [],
            )
            .unwrap();
            // parse_page 参数 resp 观测为 requests.Response，shape 含 status_code/text
            conn.execute(
                "INSERT INTO arg_types(fid,arg,type_label,shape,count) VALUES(1,'resp','requests.Response','[\"status_code\",\"text\"]',9)",
                [],
            )
            .unwrap();
        }
        TraceIndex::open(&path).unwrap()
    }

    #[test]
    fn infers_return_type_from_call() {
        let idx = fixture();
        let text = "data = scraper.parse_page(url)\nprint(data)\n";
        // 光标在第 1 行，receiver = data（向上第 0 行 `data = parse_page(...)`）
        assert_eq!(
            infer_receiver_type(&idx, text, "data", 1),
            Some("dict[str, int]".into())
        );
    }

    #[test]
    fn infers_literal_types() {
        let idx = fixture();
        let cases = [
            ("s = 'hi'\n", "s", "str"),
            ("n = 3\n", "n", "int"),
            ("f = 1.5\n", "f", "float"),
            ("b = True\n", "b", "bool"),
            ("l = []\n", "l", "list"),
            ("d = {}\n", "d", "dict"),
            ("x = None\n", "x", "None"),
        ];
        for (head, name, want) in cases {
            // receiver 在第 1 行，赋值在第 0 行
            let text = format!("{head}z = {name}\n");
            assert_eq!(
                infer_receiver_type(&idx, &text, name, 1),
                Some(want.into()),
                "case {name}"
            );
        }
    }

    #[test]
    fn infers_param_type() {
        let idx = fixture();
        let text = "def parse_page(resp):\n    return resp.status_code\n";
        assert_eq!(
            infer_receiver_type(&idx, text, "resp", 1),
            Some("requests.Response".into())
        );
    }

    #[test]
    fn members_for_type_aggregates_shape() {
        let idx = fixture();
        let members = members_for_type(&idx, "dict[str, int]");
        // title 出现两次（count 7+3），url 一次（7）→ title 居前
        assert_eq!(members[0], ("title".to_string(), 10));
        assert!(members.contains(&("url".to_string(), 7)));
    }

    #[test]
    fn chain_keys_resolves_nested_and_index() {
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
            // 递归 shape：data → dict{k: diff → list{e: dict{k: code,name → str}}}
            conn.execute(
                "INSERT INTO ret_types(fid,type_label,shape,count) VALUES(1,'dict[str, object]','{\"data\":{\"t\":\"dict\",\"k\":{\"diff\":{\"t\":\"list\",\"e\":{\"t\":\"dict\",\"k\":{\"code\":\"str\",\"name\":\"str\"}}}}}}',7)",
                [],
            )
            .unwrap();
        }
        let idx = TraceIndex::open(&path).unwrap();

        // 键进入 dict 子节点
        let keys = chain_keys(&idx, "dict[str, object]", &[Access::Key("data".into())]);
        assert!(keys.contains(&("diff".to_string(), 7)), "data 子键应有 diff，实际 {keys:?}");

        // 键 → 键 → 数字索引 → 元素 dict 的键 code/name（多层 + list 索引）
        let deep = chain_keys(
            &idx,
            "dict[str, object]",
            &[Access::Key("data".into()), Access::Key("diff".into()), Access::Index],
        );
        assert!(deep.contains(&("code".to_string(), 7)), "深层应有 code，实际 {deep:?}");
        assert!(deep.contains(&("name".to_string(), 7)), "深层应有 name，实际 {deep:?}");

        // 未知键 / 中途类型不匹配 → 空
        assert!(chain_keys(&idx, "dict[str, object]", &[Access::Key("nope".into())]).is_empty());
        assert!(chain_keys(&idx, "dict[str, object]", &[Access::Index]).is_empty());
    }

    #[test]
    fn no_inference_when_unknown() {
        let idx = fixture();
        let text = "z = y + 1\nprint(z)\n";
        assert_eq!(infer_receiver_type(&idx, text, "z", 1), None);
    }

    /// list[myapp.User] 参数 + User 实例 shape（P3-T08 循环变量推断 fixture）。
    fn list_fixture() -> TraceIndex {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute(
                "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('m.py','process_users',1,10,0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO arg_types(fid,arg,type_label,shape,count) VALUES(1,'items','list[myapp.User]','',8)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('m.py','get_user',2,5,0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO ret_types(fid,type_label,shape,count) VALUES(2,'myapp.User','[\"name\",\"email\"]',5)",
                [],
            )
            .unwrap();
        }
        TraceIndex::open(&path).unwrap()
    }

    #[test]
    fn infers_for_loop_variable_element_type() {
        let idx = list_fixture();
        let text = "def process_users(items):\n    for u in items:\n        print(u)\n";
        assert_eq!(
            infer_receiver_type(&idx, text, "u", 2),
            Some("myapp.User".into())
        );
        let members = members_for_type(&idx, "myapp.User");
        assert!(members.iter().any(|(m, _)| m == "name"));
    }

    #[test]
    fn shape_e_key_disambiguated_by_type_label() {
        // 回归：顶层 list 与「仅有 "e" 键的 dict」shape 序列化形态相同，必须靠 type_label 区分。
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            // 顶层 list-of-dict：type_label 为序列 → {"e":...} 解读为 list 元素
            conn.execute(
                "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('m.py','make_rows',1,10,0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO ret_types(fid,type_label,shape,count) VALUES(1,'list[dict[str, str]]','{\"e\":{\"t\":\"dict\",\"k\":{\"code\":\"str\",\"name\":\"str\"}}}',7)",
                [],
            )
            .unwrap();
            // 单键 "e" 的 dict：type_label 为 dict → {"e":...} 解读为 dict 键
            conn.execute(
                "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('m.py','make_obj',2,10,0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO ret_types(fid,type_label,shape,count) VALUES(2,'dict[str, dict[str, str]]','{\"e\":{\"t\":\"dict\",\"k\":{\"code\":\"str\"}}}',3)",
                [],
            )
            .unwrap();
        }
        let idx = TraceIndex::open(&path).unwrap();

        // 序列类型：顶层 {"e"} = list 元素结构 → 元素 dict 的键为 code/name（而非把 "e" 误当键）
        let list_keys = chain_keys(&idx, "list[dict[str, str]]", &[]);
        assert!(list_keys.contains(&("code".to_string(), 7)));
        assert!(list_keys.contains(&("name".to_string(), 7)));
        assert!(!list_keys.iter().any(|(k, _)| k == "e"));

        // dict 类型：{"e"} 是键名 → 顶层成员含 "e"
        let members = members_for_type(&idx, "dict[str, dict[str, str]]");
        assert!(members.iter().any(|(k, _)| k == "e"), "实际 {members:?}");

        // dict 类型：["e"] 进入子 dict 得到 code
        let obj_keys = chain_keys(&idx, "dict[str, dict[str, str]]", &[Access::Key("e".into())]);
        assert!(obj_keys.contains(&("code".to_string(), 3)));
    }
}