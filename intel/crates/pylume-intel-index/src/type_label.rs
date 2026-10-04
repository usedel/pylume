//! 类型紧凑表示解析：把 trace 库里 `type_label` 字符串解析为结构化 AST。
//!
//! 对齐 `probe/src/pylume_probe/compact.py` 的输出词汇：
//! - 实例 → `模块.类名`（builtins/`__main__` 前缀省略，如 `pathlib.Path`、`int`）；
//! - 容器 → `list[T]` / `dict[K, V]` / `tuple[T]` / `set[T]` / `frozenset[T]` / `type[T]`；
//! - 联合 → 容器内元素用 `|` 分隔（`list[int|str]`），截断用 `...`（`list[...]`、`int|...`）；
//! - 裸容器名（空容器，无 `[...]`）→ `list`、`dict`、`tuple`、`set`、`frozenset`；
//! - 特殊：`None`、`bool`、`module`、`Callable`。
//!
//! 解析目标是补全/跳转/hover 的输入，不还原 Python 对象本身。

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeLabel {
    /// 命名类型：标量（`int`）或实例类名（`pathlib.Path`）、`None`、`module`、`bool`。
    Named(String),
    /// `type[X]`。
    TypeOf(Box<TypeLabel>),
    /// `list[T]`（T 可能是联合）。
    List(Box<TypeLabel>),
    /// `set[T]`。
    Set(Box<TypeLabel>),
    /// `frozenset[T]`。
    Frozenset(Box<TypeLabel>),
    /// `tuple[T]`（T 可能是联合；compact.py 对元组元素同样用 `|` 采样联合分隔）。
    /// 空 tuple 为 `Any`（无元素类型信息）。
    Tuple(Box<TypeLabel>),
    /// `dict[K, V]`。
    Dict {
        key: Box<TypeLabel>,
        value: Box<TypeLabel>,
    },
    /// 容器元素联合（`A|B|C`）。
    Union(Vec<TypeLabel>),
    /// 深度截断/未观测到的容器内部（`...`）。
    Unknown,
    /// `Callable`。
    Callable,
    /// 解析失败或空输入。
    Any,
}

/// 将 trace 库 `type_label` 字符串解析为 AST。
pub fn parse(s: &str) -> TypeLabel {
    let s = s.trim();
    if s.is_empty() {
        return TypeLabel::Any;
    }

    // 空容器（compact.py 对空容器只返回容器名，无 `[...]`）
    match s {
        "list" => return TypeLabel::List(Box::new(TypeLabel::Any)),
        "set" => return TypeLabel::Set(Box::new(TypeLabel::Any)),
        "frozenset" => return TypeLabel::Frozenset(Box::new(TypeLabel::Any)),
        "dict" => return TypeLabel::Dict { key: Box::new(TypeLabel::Any), value: Box::new(TypeLabel::Any) },
        "tuple" => return TypeLabel::Tuple(Box::new(TypeLabel::Any)),
        "Callable" => return TypeLabel::Callable,
        "..." => return TypeLabel::Unknown,
        _ => {}
    }

    // 容器 / type 包装：`name[body]`
    if let Some(open) = s.find('[') {
        if s.ends_with(']') {
            let name = &s[..open];
            let body = &s[open + 1..s.len() - 1];
            match name {
                "list" => return TypeLabel::List(Box::new(parse(body))),
                "set" => return TypeLabel::Set(Box::new(parse(body))),
                "frozenset" => return TypeLabel::Frozenset(Box::new(parse(body))),
                "type" => return TypeLabel::TypeOf(Box::new(parse(body))),
                "dict" => {
                    let kv = split_top_level(body, ',');
                    if kv.len() >= 2 {
                        return TypeLabel::Dict {
                            key: Box::new(parse(kv[0])),
                            value: Box::new(parse(kv[1])),
                        };
                    }
                    return TypeLabel::Dict {
                        key: Box::new(TypeLabel::Any),
                        value: Box::new(TypeLabel::Any),
                    };
                }
                "tuple" => return TypeLabel::Tuple(Box::new(parse(body))),
                _ => {} // 非已知容器名：走 Named（如 `pathlib.Path` 没有 `[`，不会到这）
            }
        }
    }

    // 联合（顶层 `|`，如 `int|str`、`int|...`）
    if s.contains('|') {
        let parts = split_top_level(s, '|');
        if parts.len() > 1 {
            return TypeLabel::Union(parts.iter().map(|p| parse(p)).collect());
        }
    }

    TypeLabel::Named(s.to_string())
}

/// 判断类型标签是否为 dict（`dict` 或 `dict[K, V]`）。
/// 用于区分「键补全（下标访问 `d["k"]` / `d.get("k")`）」与「属性补全（点访问 `o.attr`）」。
pub fn is_dict(type_label: &str) -> bool {
    matches!(parse(type_label), TypeLabel::Dict { .. })
}

/// 按「顶层」分隔符切分（忽略 `[...]` 内的分隔符）。
fn split_top_level(s: &str, sep: char) -> Vec<&str> {
    let mut depth = 0usize;
    let mut parts = Vec::new();
    let mut start = 0usize;
    for (i, c) in s.char_indices() {
        match c {
            '[' => depth += 1,
            ']' => depth = depth.saturating_sub(1),
            _ if c == sep && depth == 0 => {
                parts.push(&s[start..i]);
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(&s[start..]);
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(s: &str) -> TypeLabel {
        TypeLabel::Named(s.to_string())
    }

    #[test]
    fn parses_scalars_and_named() {
        assert_eq!(parse("int"), named("int"));
        assert_eq!(parse("str"), named("str"));
        assert_eq!(parse("bool"), named("bool"));
        assert_eq!(parse("None"), named("None"));
        assert_eq!(parse("module"), named("module"));
        assert_eq!(parse("Callable"), TypeLabel::Callable);
        assert_eq!(parse("pathlib.Path"), named("pathlib.Path"));
        assert_eq!(parse("myapp.models.User"), named("myapp.models.User"));
    }

    #[test]
    fn parses_containers() {
        assert_eq!(parse("list[int]"), TypeLabel::List(Box::new(named("int"))));
        assert_eq!(parse("set[str]"), TypeLabel::Set(Box::new(named("str"))));
        assert_eq!(
            parse("frozenset[int]"),
            TypeLabel::Frozenset(Box::new(named("int")))
        );
        assert_eq!(
            parse("type[pathlib.Path]"),
            TypeLabel::TypeOf(Box::new(named("pathlib.Path")))
        );
        assert_eq!(
            parse("dict[str, int]"),
            TypeLabel::Dict {
                key: Box::new(named("str")),
                value: Box::new(named("int")),
            }
        );
        assert_eq!(
            parse("tuple[int|str]"),
            TypeLabel::Tuple(Box::new(TypeLabel::Union(vec![named("int"), named("str")])))
        );
    }

    #[test]
    fn parses_unions_and_truncation() {
        assert_eq!(
            parse("list[int|str]"),
            TypeLabel::List(Box::new(TypeLabel::Union(vec![named("int"), named("str")])))
        );
        assert_eq!(
            parse("list[int|...]"),
            TypeLabel::List(Box::new(TypeLabel::Union(vec![
                named("int"),
                TypeLabel::Unknown
            ])))
        );
        assert_eq!(parse("list[...]"), TypeLabel::List(Box::new(TypeLabel::Unknown)));
        assert_eq!(parse("..."), TypeLabel::Unknown);
    }

    #[test]
    fn parses_empty_containers() {
        assert_eq!(parse("list"), TypeLabel::List(Box::new(TypeLabel::Any)));
        assert_eq!(parse("set"), TypeLabel::Set(Box::new(TypeLabel::Any)));
        assert_eq!(parse("tuple"), TypeLabel::Tuple(Box::new(TypeLabel::Any)));
        assert_eq!(
            parse("dict"),
            TypeLabel::Dict {
                key: Box::new(TypeLabel::Any),
                value: Box::new(TypeLabel::Any),
            }
        );
    }

    #[test]
    fn is_dict_detects_dict_only() {
        assert!(is_dict("dict"));
        assert!(is_dict("dict[str, int]"));
        assert!(is_dict("dict[str, list[int]]"));
        assert!(!is_dict("list[int]"));
        assert!(!is_dict("int"));
        assert!(!is_dict("requests.Response"));
        assert!(!is_dict(""));
    }

    #[test]
    fn parses_nested_containers() {
        // dict 值本身是嵌套容器：dict[str, list[int]]
        assert_eq!(
            parse("dict[str, list[int]]"),
            TypeLabel::Dict {
                key: Box::new(named("str")),
                value: Box::new(TypeLabel::List(Box::new(named("int")))),
            }
        );
        // dict 值含逗号的内层 dict：dict[str, dict[int, str]]
        assert_eq!(
            parse("dict[str, dict[int, str]]"),
            TypeLabel::Dict {
                key: Box::new(named("str")),
                value: Box::new(TypeLabel::Dict {
                    key: Box::new(named("int")),
                    value: Box::new(named("str")),
                }),
            }
        );
        assert_eq!(parse(""), TypeLabel::Any);
        assert_eq!(parse("   "), TypeLabel::Any);
    }
}