//! SQLite 数据库工具（B3 · `docs/sqlite_tool_dev_plan.md`）。
//!
//! **PR-1**：依赖落地（rusqlite 0.32.1 + bundled）+ 连接骨架 + 全局连接列表持久化 + 路径校验纯函数。
//! 对象树 / 查询 / 取消见 PR-2，前端视图见 PR-3/4。
//!
//! 三条设计约定（与开发文档一致，改动前先回文档）：
//! 1. **连接表是全局的，不按窗口隔离**——数据库文件通常在项目之外（用户数据目录、爬虫产物），
//!    与窗口生命周期无关；故用普通 `static` 而非 `PerWindow`（后者用于窗口私有的进程/监听状态）。
//! 2. **默认只读**（产品裁决 2026-10-02）：`db_open` 未显式 `writable` 时以
//!    `SQLITE_OPEN_READ_ONLY` 打开；写语句另有后端硬闸门（PR-2 的 `DbReadOnly`）兜底。
//! 3. **连接 id 由路径哈希派生**（确定性）：同一路径重开得到同一 id，列表里的 SQL 草稿与
//!    历史得以复用；路径按 Windows 大小写不敏感口径归一（与 `file_ops::project_hash` 同口径）。
//!
//! 命令错误一律 `Result<T, String>`，前缀见文档 §4「错误码」（`DbInvalidPath:` / `DbLocked:` …），
//! 前端经 `i18n/backendError.ts` 本地化。

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;

use regex::Regex;
use rusqlite::{types::Value, Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::util::{pylume_home, unpoison};

// ---------- 常量 ----------

/// 单元格文本截断长度（前端 title 与「单元格详情」显示全量）
const CELL_MAX_CHARS: usize = 200;
/// 单次查询硬上限（防把几十 MB 塞进 IPC）
const HARD_MAX_ROWS: usize = 10_000;
/// 只读类 PRAGMA（其余 PRAGMA 一律按写处理，最保守）
const READ_PRAGMAS: [&str; 9] = [
    "table_info",
    "table_list",
    "table_xinfo",
    "index_list",
    "index_info",
    "index_xinfo",
    "database_list",
    "function_list",
    "collation_list",
];

// ---------- 数据契约（与前端 sqliteView.ts 同名 camelCase） ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DbConnection {
    pub id: String,
    pub path: String,
    pub name: String,
    pub writable: bool,
    /// SQL 编辑器草稿（PR-4 写入，此处保留以免切换连接时丢失）
    pub sql: String,
    /// 查询历史（最近 20 条，PR-4 写入）
    pub history: Vec<String>,
}

/// 对象树条目（PR-2）
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DbObject {
    pub name: String,
    /// "table" | "view" | "index"
    pub kind: String,
    /// 建表/建索引语句（`sqlite_master.sql`）
    pub sql: Option<String>,
    /// 表/视图行数；索引为 None
    pub row_count: Option<i64>,
    /// 表/视图列信息；索引为 None
    pub columns: Option<Vec<DbColumn>>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DbColumn {
    pub name: String,
    pub decl_type: String,
    pub pk: bool,
    pub not_null: bool,
}

/// 查询结果（PR-2）
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryResult {
    pub columns: Vec<String>,
    /// NULL = `None`；一律字符串化，避免 JSON 类型歧义
    pub rows: Vec<Vec<Option<String>>>,
    /// 满足条件的总行数（分页用；未知时退化为本次行数）
    pub total: i64,
    pub offset: i64,
    /// 是否撞到硬上限
    pub truncated: bool,
    pub elapsed_ms: u64,
    /// 写语句影响行数；读语句为 None
    pub affected: Option<i64>,
}

// ---------- 连接表 ----------

struct DbOp {
    conn: Mutex<Connection>,
    /// SQLite 协作式中断句柄（`db_cancel` 调用，让查询在下一个安全点返回 interrupted）
    interrupt: rusqlite::InterruptHandle,
    /// 取消标志（供查询前后与未来流式场景判定）
    cancel: AtomicBool,
    writable: bool,
}

static DB_OPS: LazyLock<Mutex<HashMap<String, Arc<DbOp>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 取连接的 Arc 快照（锁外操作，避免长时间持锁）
fn get_op(id: &str) -> Result<Arc<DbOp>, String> {
    let ops = unpoison(DB_OPS.lock());
    ops.get(id)
        .cloned()
        .ok_or_else(|| "DbNoConnection:连接已关闭，请重新选择".to_string())
}

// ---------- 纯函数（单测目标） ----------

/// 允许的扩展名（小写比对；覆盖 SQLite 主流命名）
const DB_EXTENSIONS: [&str; 4] = ["sqlite", "sqlite3", "db", "db3"];

/// 数据库路径校验：非空 → 绝对路径 → 扩展名白名单 → 存在且是文件 → canonicalize。
///
/// 返回 canonicalize 后的路径（符号链接已解析，供后续 `starts_with` 类判定使用）。
/// 失败返回**短原因串**（不含前缀），由调用方拼 `DbInvalidPath:`。
pub(crate) fn validate_db_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty".to_string());
    }
    let p = Path::new(trimmed);
    if !p.is_absolute() {
        return Err("not-absolute".to_string());
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !DB_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("ext:{}", ext));
    }
    let canon = fs::canonicalize(p).map_err(|e| format!("io:{}", e))?;
    if !canon.is_file() {
        return Err("not-file".to_string());
    }
    Ok(canon)
}

/// 连接 id：由**归一化后**的路径哈希派生（同路径同 id，跨会话稳定）。
pub(crate) fn conn_id(path: &str) -> String {
    let mut h = DefaultHasher::new();
    path.to_lowercase().hash(&mut h);
    format!("db-{:016x}", h.finish())
}

// ---------- SQL 解析纯函数（PR-2，双端同源：前端 sqliteView.ts 镜像同一套规则） ----------

/// SQL 大类。**`Unknown` 一律按 `Write` 处理**（保守：宁可拦下也不误执行）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlKind {
    Read,
    Write,
    Unknown,
}

/// 把注释与字符串字面量替换为空格——后续所有判定都在「去噪文本」上做，
/// 避免 `SELECT '; DROP TABLE t;'` 这类字符串内的分号/关键字被误判。
fn strip_noise(sql: &str) -> String {
    let bytes: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(bytes.len());
    let mut i = 0usize;
    let n = bytes.len();
    // 逐字符**等长**替换（噪声 → ' '，保留 '\n' 占位换行）：strip_trailing_limit
    // 依赖「noised 偏移 == 原 SQL 偏移」把尾部 LIMIT 切点映射回原文。
    while i < n {
        let c = bytes[i];
        // 行注释 -- ...（到行尾）
        if c == '-' && i + 1 < n && bytes[i + 1] == '-' {
            while i < n && bytes[i] != '\n' {
                out.push(' ');
                i += 1;
            }
            continue;
        }
        // 块注释 /* ... */
        if c == '/' && i + 1 < n && bytes[i + 1] == '*' {
            out.push(' ');
            out.push(' ');
            i += 2;
            while i < n {
                if bytes[i] == '*' && i + 1 < n && bytes[i + 1] == '/' {
                    out.push(' ');
                    out.push(' ');
                    i += 2;
                    break;
                }
                out.push(if bytes[i] == '\n' { '\n' } else { ' ' });
                i += 1;
            }
            continue;
        }
        // 字符串/双引号标识符：'...'（'' 转义）与 "..."（"" 转义）
        if c == '\'' || c == '"' {
            let quote = c;
            out.push(' ');
            i += 1;
            while i < n {
                if bytes[i] == quote {
                    out.push(' ');
                    i += 1;
                    if i < n && bytes[i] == quote {
                        // '' / "" 转义：仍在串内
                        out.push(' ');
                        i += 1;
                        continue;
                    }
                    break;
                }
                out.push(if bytes[i] == '\n' { '\n' } else { ' ' });
                i += 1;
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// 顶层词列表：**跳过所有括号块**（CTE 体、子查询里的关键词都不决定语句性质），
/// 逗号与分号当分隔符。判定只在顶层词上进行。
fn top_level_words(clean: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut depth = 0i32;
    let flush = |cur: &mut String, out: &mut Vec<String>| {
        let w: String = cur
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '_')
            .collect::<String>()
            .to_ascii_lowercase();
        cur.clear();
        if !w.is_empty() {
            out.push(w);
        }
    };
    for c in clean.chars() {
        match c {
            '(' => {
                flush(&mut cur, &mut out);
                depth += 1;
            }
            ')' => {
                flush(&mut cur, &mut out);
                depth = depth.saturating_sub(1);
            }
            _ if depth > 0 => {} // 括号内一律忽略
            c if c.is_whitespace() || c == ',' || c == ';' => flush(&mut cur, &mut out),
            _ => cur.push(c),
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// 判定 SQL 大类（对抗样本见单测）。
///
/// 关键：`WITH` 开头必须**跳过 CTE 定义**再看主语句——否则
/// `WITH x AS (SELECT 1) DELETE FROM t` 会被误判为读，进而在可写连接上绕过写确认框。
pub(crate) fn classify_sql(sql: &str) -> SqlKind {
    let words = top_level_words(&strip_noise(sql));
    let mut i = 0usize;
    if words.first().map(|s| s.as_str()) == Some("with") {
        i = 1;
        if words.get(i).map(|s| s.as_str()) == Some("recursive") {
            i += 1;
        }
        // 括号体已剔除，CTE 定义退化为「name AS」词对，逐个跳过
        while i + 1 < words.len() && words[i + 1] == "as" {
            i += 2;
        }
    }
    match words.get(i).map(|s| s.as_str()) {
        Some("select") | Some("values") | Some("explain") => SqlKind::Read,
        // PRAGMA 读写分家：白名内的读类放行，其余（如 journal_mode=WAL）按写处理
        Some("pragma") => match words.get(i + 1).map(|s| s.as_str()).unwrap_or_default() {
            p if READ_PRAGMAS.contains(&p) => SqlKind::Read,
            _ => SqlKind::Write,
        },
        Some("insert") | Some("update") | Some("delete") | Some("replace") | Some("create")
        | Some("drop") | Some("alter") | Some("attach") | Some("detach") | Some("reindex")
        | Some("vacuum") | Some("begin") | Some("commit") | Some("rollback") => SqlKind::Write,
        _ => SqlKind::Unknown,
    }
}

/// 尾部是否自带 LIMIT（自带时不追加分页 LIMIT，尊重用户意图）
pub(crate) fn has_limit(sql: &str) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?is)\blimit\s+\d+(\s*,\s*\d+|\s+offset\s+\d+)?\s*$").unwrap()
    });
    RE.is_match(&strip_noise(sql).trim_end().trim_end_matches(';'))
}

/// 去掉尾部 LIMIT 子句（用于 `SELECT COUNT(*) FROM (<inner>)` 求总数）。
/// 返回**原 SQL**（保留引号标识符与字符串），strip_noise 的等长去噪文本只用于定位切点。
/// 旧实现直接返回去噪文本，`SELECT * FROM "t"` 会被抹成 `SELECT * FROM`，
/// COUNT 失败退化为 rows.len() → 真机上翻页失效（§10.3-3 抓到的真 bug）。
pub(crate) fn strip_trailing_limit(sql: &str) -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        // 不带前导 \s+：去噪后标识符也是空格，前导 \s+ 会把切点吸到标识符之前；
        // 尾部 [\s;]* 放行分号与注释占位——因此对 noised **不做 trim**（结尾的
        // 去噪空格可能对应原文的字符串/标识符字符，裁剪会破坏偏移映射）。
        Regex::new(r"(?is)\blimit\s+\d+(\s*,\s*\d+|\s+offset\s+\d+)?[\s;]*$").unwrap()
    });
    let noised = strip_noise(sql);
    let cut = match RE.find(&noised) {
        Some(m) => m.start(),
        None => noised.len(),
    };
    sql[..cut].trim_end().trim_end_matches(';').trim_end().to_string()
}

/// 按 `;` 拆分语句（**字符串与注释内的分号不拆**）。用于「执行全部」。
pub(crate) fn split_statements(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = sql.chars().collect();
    let mut i = 0usize;
    let n = chars.len();
    let mut line_comment = false;
    while i < n {
        let c = chars[i];
        if line_comment {
            if c == '\n' {
                line_comment = false;
            }
            cur.push(c);
            i += 1;
            continue;
        }
        if c == '-' && i + 1 < n && chars[i + 1] == '-' {
            line_comment = true;
            cur.push(c);
            i += 1;
            continue;
        }
        if c == '/' && i + 1 < n && chars[i + 1] == '*' {
            cur.push(c);
            i += 1;
            while i < n && !(chars[i] == '*' && i + 1 < n && chars[i + 1] == '/') {
                cur.push(chars[i]);
                i += 1;
            }
            if i < n {
                cur.push('*');
                cur.push('/');
                i += 2;
            }
            continue;
        }
        if c == '\'' || c == '"' {
            let quote = c;
            cur.push(c);
            i += 1;
            while i < n {
                cur.push(chars[i]);
                if chars[i] == quote {
                    if i + 1 < n && chars[i + 1] == quote {
                        cur.push(chars[i + 1]);
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if c == ';' {
            let piece = cur.trim().to_string();
            if !piece.is_empty() {
                out.push(piece);
            }
            cur.clear();
            i += 1;
            continue;
        }
        cur.push(c);
        i += 1;
    }
    let tail = cur.trim().to_string();
    if !tail.is_empty() {
        out.push(tail);
    }
    out
}

/// 单元格文本截断（按字符数，非字节——中文场景字节口径会多切）
pub(crate) fn truncate_cell(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/// BLOB 单元格标签（不读内容，只报大小）
pub(crate) fn blob_label(bytes: usize) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let b = bytes as f64;
    if b < KB {
        format!("<blob {} B>", bytes)
    } else if b < MB {
        format!("<blob {:.1} KB>", b / KB)
    } else {
        format!("<blob {:.1} MB>", b / MB)
    }
}

/// SQLite 标识符转义（拼 PRAGMA / DDL 用）：`"` → `""`
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// 连接列表反序列化（薄 IO 之上的纯函数，便于单测）：损坏 / 非数组一律返回空列表，绝不 panic。
pub(crate) fn parse_connections(json: &str) -> Vec<DbConnection> {
    serde_json::from_str::<Vec<DbConnection>>(json).unwrap_or_default()
}

/// 连接列表序列化（同上，纯函数）。
pub(crate) fn serialize_connections(list: &[DbConnection]) -> Result<String, String> {
    serde_json::to_string_pretty(list).map_err(|e| format!("DbIo:{}", e))
}

// ---------- 持久化（薄 IO） ----------

fn connections_path() -> PathBuf {
    pylume_home().join("config").join("db_connections.json")
}

/// 读全局连接列表（缺失 / 损坏 → 空列表）。
pub(crate) fn load_connections() -> Vec<DbConnection> {
    fs::read_to_string(connections_path())
        .ok()
        .map(|s| parse_connections(&s))
        .unwrap_or_default()
}

/// 写全局连接列表（原子写：临时文件 + rename）。
///
/// Windows 上 `fs::rename` 落到已存在路径会失败，故先 `remove_file` 再 rename。
pub(crate) fn save_connections(list: &[DbConnection]) -> Result<(), String> {
    let p = connections_path();
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("DbIo:{}", e))?;
    }
    let payload = serialize_connections(list)?;
    // 临时文件名带纳秒后缀：多处并发保存（如多个查询面板 / 测试）时不会互相踩同一个 tmp
    // ——否则 A 写 tmp、B 覆盖 tmp、A 再 rename 就会 os error 2（找不到文件）。
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = p.with_extension(format!("json.{}.tmp", nanos));
    fs::write(&tmp, payload).map_err(|e| format!("DbIo:{}", e))?;
    let _ = fs::remove_file(&p);
    fs::rename(&tmp, &p).map_err(|e| format!("DbIo:{}", e))
}

// ---------- 命令 ----------

/// 打开（或重开）一个数据库连接并登记到全局列表。
///
/// `writable=false`（默认）以只读方式打开；`writable=true` 走 `READ_WRITE`，
/// **不**带 `CREATE`——不存在的路径直接报错，避免手滑建出空库。
#[tauri::command]
pub fn db_open(path: String, writable: bool) -> Result<DbConnection, String> {
    let canon = validate_db_path(&path).map_err(|d| format!("DbInvalidPath:{}", d))?;
    let canon_str = canon.to_string_lossy().to_string();
    let id = conn_id(&canon_str);

    let flags = if writable {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let conn = Connection::open_with_flags(&canon, flags).map_err(|e| format!("DbLocked:{}", e))?;

    let interrupt = conn.get_interrupt_handle();
    unpoison(DB_OPS.lock()).insert(
        id.clone(),
        Arc::new(DbOp {
            conn: Mutex::new(conn),
            interrupt,
            cancel: AtomicBool::new(false),
            writable,
        }),
    );

    let name = canon
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| canon_str.clone());

    // 合并进列表：命中同 id 时保留该连接已有的 SQL 草稿与历史（切连接不丢工作成果）
    let mut list = load_connections();
    let entry = match list.iter().find(|c| c.id == id) {
        Some(old) => DbConnection {
            id: id.clone(),
            path: canon_str.clone(),
            name,
            writable,
            sql: old.sql.clone(),
            history: old.history.clone(),
        },
        None => DbConnection {
            id: id.clone(),
            path: canon_str.clone(),
            name,
            writable,
            sql: String::new(),
            history: Vec::new(),
        },
    };
    match list.iter_mut().find(|c| c.id == id) {
        Some(slot) => *slot = entry.clone(),
        None => list.push(entry.clone()),
    }
    save_connections(&list)?;
    Ok(entry)
}

/// 关闭连接（从表内摘除即 drop；进行中的查询随连接释放而中断）。
#[tauri::command]
pub fn db_close(id: String) -> Result<(), String> {
    unpoison(DB_OPS.lock()).remove(&id);
    Ok(())
}

/// 读取对象树（表 → 视图 → 索引，组内按名排序）
#[tauri::command]
pub async fn db_list_objects(id: String) -> Result<Vec<DbObject>, String> {
    tauri::async_runtime::spawn_blocking(move || db_list_objects_impl(&id))
        .await
        .map_err(|e| format!("DbSqlError:任务执行异常：{e}"))?
}

fn db_list_objects_impl(id: &str) -> Result<Vec<DbObject>, String> {
    let op = get_op(id)?;
    let conn = unpoison(op.conn.lock());
    let mut stmt = conn
        .prepare(
            "SELECT name, type, sql FROM sqlite_master \
             WHERE type IN ('table','view','index') AND name NOT LIKE 'sqlite_%' \
             ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 ELSE 2 END, name",
        )
        .map_err(map_sql_err)?;
    let mut rows = stmt.query([]).map_err(map_sql_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(map_sql_err)? {
        let name: String = row.get(0).map_err(map_sql_err)?;
        let kind: String = row.get(1).map_err(map_sql_err)?;
        let sql: Option<String> = row.get(2).map_err(map_sql_err)?;
        // 索引无列信息与行数；表/视图两者都要（行数失败只丢数字，不影响整棵树）
        let (columns, row_count) = if kind == "index" {
            (None, None)
        } else {
            (
                Some(columns_of(&conn, &name)?),
                count_of(&conn, &name).ok(),
            )
        };
        out.push(DbObject { name, kind, sql, row_count, columns });
    }
    Ok(out)
}

fn columns_of(conn: &Connection, name: &str) -> Result<Vec<DbColumn>, String> {
    // PRAGMA 不支持参数绑定，只能拼；标识符经 quote_ident 转义
    let sql = format!("PRAGMA table_info({})", quote_ident(name));
    let mut stmt = conn.prepare(&sql).map_err(map_sql_err)?;
    let mut rows = stmt.query([]).map_err(map_sql_err)?;
    let mut out = Vec::new();
    // table_info 列序：cid, name, type, notnull, dflt_value, pk
    while let Some(r) = rows.next().map_err(map_sql_err)? {
        out.push(DbColumn {
            name: r.get(1).map_err(map_sql_err)?,
            decl_type: r.get::<_, Option<String>>(2).map_err(map_sql_err)?.unwrap_or_default(),
            not_null: r.get::<_, i64>(3).map_err(map_sql_err)? > 0,
            pk: r.get::<_, i64>(5).map_err(map_sql_err)? > 0,
        });
    }
    Ok(out)
}

fn count_of(conn: &Connection, name: &str) -> Result<i64, String> {
    let sql = format!("SELECT COUNT(*) FROM {}", quote_ident(name));
    conn.query_row(&sql, [], |r| r.get(0)).map_err(map_sql_err)
}

/// 执行查询（读）或语句（写）。
///
/// - 只读连接的写语句在**后端**硬闸门拦下（`DbReadOnly:`），前端拦截只是省一次往返；
/// - 用户 SQL 自带 LIMIT 时不追加分页 LIMIT（尊重意图）；
/// - 总数用 `SELECT COUNT(*) FROM (<去掉 LIMIT 的原 SQL>)`，失败退化为本次行数，绝不拖垮查询。
#[tauri::command]
pub async fn db_query(id: String, sql: String, limit: u32, offset: u32) -> Result<DbQueryResult, String> {
    tauri::async_runtime::spawn_blocking(move || db_query_impl(&id, &sql, limit, offset))
        .await
        .map_err(|e| format!("DbSqlError:任务执行异常：{e}"))?
}

fn db_query_impl(id: &str, sql: &str, limit: u32, offset: u32) -> Result<DbQueryResult, String> {
    let started = Instant::now();
    let op = get_op(id)?;
    let is_write = matches!(classify_sql(sql), SqlKind::Write | SqlKind::Unknown);
    if is_write && !op.writable {
        return Err("DbReadOnly:只读模式下不允许写操作".to_string());
    }
    // 新查询清除上一次的取消标志（取消是「中断这次」，不是「禁用以后」）
    op.cancel.store(false, Ordering::SeqCst);
    if op.cancel.load(Ordering::SeqCst) {
        return Err("DbCancelled:查询已取消".to_string());
    }

    // 读路径：SQLite 的 prepare 只编译第一条语句，其余会被**静默丢弃**——显式拦下，
    // 免得用户以为整段都跑了（写路径走 execute_batch，天然支持多语句批处理）。
    if !is_write && split_statements(sql).len() > 1 {
        return Err("DbSqlError:一次只能执行一条查询语句（多条写语句可一次性批处理）".to_string());
    }

    let conn = unpoison(op.conn.lock());
    if is_write {
        conn.execute_batch(sql).map_err(map_sql_err)?;
        return Ok(DbQueryResult {
            columns: vec![],
            rows: vec![],
            total: 0,
            offset: 0,
            truncated: false,
            elapsed_ms: started.elapsed().as_millis() as u64,
            affected: Some(conn.changes() as i64),
        });
    }

    let limit = if limit == 0 { 200 } else { limit.min(HARD_MAX_ROWS as u32) };
    let base = sql.trim_end().trim_end_matches(';');
    let effective = if has_limit(sql) {
        base.to_string()
    } else {
        format!("{} LIMIT {} OFFSET {}", base, limit, offset)
    };

    let mut stmt = conn.prepare(&effective).map_err(map_sql_err)?;
    let columns: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
    let ncols = columns.len();
    let mut rows_iter = stmt.query([]).map_err(map_sql_err)?;
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut truncated = false;
    while let Some(row) = rows_iter.next().map_err(map_sql_err)? {
        let mut r = Vec::with_capacity(ncols);
        for i in 0..ncols {
            let v: Value = row.get(i).map_err(map_sql_err)?;
            r.push(match v {
                Value::Null => None,
                Value::Integer(n) => Some(n.to_string()),
                Value::Real(f) => Some(f.to_string()),
                Value::Text(s) => Some(truncate_cell(&s, CELL_MAX_CHARS)),
                Value::Blob(b) => Some(blob_label(b.len())),
            });
        }
        rows.push(r);
        if rows.len() >= HARD_MAX_ROWS {
            truncated = true;
            break;
        }
    }
    drop(rows_iter);

    let total = count_total(&conn, sql).unwrap_or(rows.len() as i64);
    Ok(DbQueryResult {
        columns,
        rows,
        total,
        offset: offset as i64,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
        affected: None,
    })
}

fn count_total(conn: &Connection, sql: &str) -> Option<i64> {
    let inner = strip_trailing_limit(sql);
    if inner.is_empty() {
        return None;
    }
    let q = format!("SELECT COUNT(*) FROM ({})", inner);
    conn.query_row(&q, [], |r| r.get(0)).ok()
}

/// 取消进行中的查询：置标志 + 触发 SQLite 协作式中断（查询会在下一个安全点返回 interrupted）。
#[tauri::command]
pub fn db_cancel(id: String) -> Result<(), String> {
    let op = get_op(&id)?;
    op.cancel.store(true, Ordering::SeqCst);
    op.interrupt.interrupt();
    Ok(())
}

// ---------- 表数据浏览（编辑器 Tab 化重设计 v1.4） ----------
//
// 表数据 Tab 不再让前端拼 `SELECT * FROM "t"` 发 db_query，而是收结构化的排序/筛选参数，
// 拼装全部在后端完成：表名经 sqlite_master 白名单校验、排序列经 table_info 校验、
// 筛选表达式只允许单个语句（防 `; DROP` 式拼接）。

/// 筛选表达式归一：trim 后非空才生效；**多语句拒绝**（复用 split_statements 的引号/注释
/// 语义——字符串里的分号不算分隔符，`name = 'a;b'` 依然合法）。
pub(crate) fn sanitize_filter(filter: Option<&str>) -> Result<Option<String>, String> {
    let f = match filter {
        Some(f) => f.trim(),
        None => return Ok(None),
    };
    if f.is_empty() {
        return Ok(None);
    }
    if split_statements(f).len() > 1 {
        return Err("DbSqlError:筛选条件只能写一个表达式（多余的分号请去掉）".to_string());
    }
    Ok(Some(f.to_string()))
}

/// 排序方向归一：`desc`（大小写不敏感）→ true（DESC），其余 → false（ASC）。纯函数，单测目标。
pub(crate) fn sort_dir_desc(dir: Option<&str>) -> bool {
    matches!(dir, Some(d) if d.eq_ignore_ascii_case("desc"))
}

/// 拼装表数据查询（纯函数，单测目标）。`where_clause` / `order_clause` 为空串时不拼；
/// 调用方保证两者已过校验（where 是单语句、order 列名来自 table_info）。
pub(crate) fn build_rows_sql(
    name: &str,
    where_clause: &str,
    order_clause: &str,
    limit: u32,
    offset: u32,
) -> String {
    let limit = if limit == 0 { 200 } else { limit.min(HARD_MAX_ROWS as u32) };
    format!(
        "SELECT * FROM {}{}{} LIMIT {limit} OFFSET {offset}",
        quote_ident(name),
        where_clause,
        order_clause,
    )
}

/// 校验表/视图名：必须存在于 sqlite_master（table 或 view），防把任意 SQL 塞进表名位。
/// 返回校验通过的名字（即入参，冗余返回方便链式使用）。
fn ensure_table(conn: &Connection, name: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE name = ?1 AND type IN ('table','view')")
        .map_err(map_sql_err)?;
    let found = stmt.exists([&name]).map_err(map_sql_err)?;
    if found {
        Ok(())
    } else {
        Err(format!("DbSqlError:表「{name}」不存在"))
    }
}

/// 表数据浏览查询（读）：`SELECT * FROM "name" [WHERE (filter)] [ORDER BY "col" DIR]` + 分页。
///
/// - **只读路径**：不经过写判定（SELECT 固定），只读/可写连接均可调用；
/// - 筛选为自由表达式（如 `status = 'paid' AND amount > 0`），由 WHERE (…) 包裹；
/// - 排序列必须在目标对象的列清单里（table_info），否则拒绝——防注入；
/// - 总数 `SELECT COUNT(*) FROM "name" [WHERE …]`，失败退化为本次行数（视图/复杂筛选兜底）。
#[tauri::command]
pub async fn db_rows(
    id: String,
    name: String,
    sort: Option<String>,
    dir: Option<String>,
    filter: Option<String>,
    limit: u32,
    offset: u32,
) -> Result<DbQueryResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        db_rows_impl(&id, &name, sort.as_deref(), dir.as_deref(), filter.as_deref(), limit, offset)
    })
    .await
    .map_err(|e| format!("DbSqlError:任务执行异常：{e}"))?
}

fn db_rows_impl(
    id: &str,
    name: &str,
    sort: Option<&str>,
    dir: Option<&str>,
    filter: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<DbQueryResult, String> {
    let started = Instant::now();
    let op = get_op(id)?;
    let filter = sanitize_filter(filter)?;
    let where_clause = match &filter {
        Some(f) => format!(" WHERE ({f})"),
        None => String::new(),
    };

    let conn = unpoison(op.conn.lock());
    ensure_table(&conn, name)?;

    // 排序列校验：必须命中 table_info 的列名（ASCII 大小写不敏感，命中后用表内真名拼装）
    let order_clause = match sort.map(str::trim).filter(|s| !s.is_empty()) {
        Some(col) => {
            let columns = columns_of(&conn, name)?;
            let hit = columns
                .iter()
                .find(|c| c.name.eq_ignore_ascii_case(col))
                .map(|c| c.name.clone());
            match hit {
                Some(real) => format!(
                    " ORDER BY {} {}",
                    quote_ident(&real),
                    if sort_dir_desc(dir) { "DESC" } else { "ASC" }
                ),
                None => return Err(format!("DbSqlError:排序列「{col}」不存在")),
            }
        }
        None => String::new(),
    };

    let sql = build_rows_sql(name, &where_clause, &order_clause, limit, offset);
    let mut stmt = conn.prepare(&sql).map_err(map_sql_err)?;
    let columns: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
    let ncols = columns.len();
    let mut rows_iter = stmt.query([]).map_err(map_sql_err)?;
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut truncated = false;
    while let Some(row) = rows_iter.next().map_err(map_sql_err)? {
        let mut r = Vec::with_capacity(ncols);
        for i in 0..ncols {
            let v: Value = row.get(i).map_err(map_sql_err)?;
            r.push(match v {
                Value::Null => None,
                Value::Integer(n) => Some(n.to_string()),
                Value::Real(f) => Some(f.to_string()),
                Value::Text(s) => Some(truncate_cell(&s, CELL_MAX_CHARS)),
                Value::Blob(b) => Some(blob_label(b.len())),
            });
        }
        rows.push(r);
        if rows.len() >= HARD_MAX_ROWS {
            truncated = true;
            break;
        }
    }
    drop(rows_iter);

    // 总数：直查表/视图（不包子查询），失败退化为本次行数
    let count_sql = format!(
        "SELECT COUNT(*) FROM {}{where_clause}",
        quote_ident(name)
    );
    let total = conn
        .query_row(&count_sql, [], |r| r.get::<_, i64>(0))
        .ok()
        .unwrap_or(rows.len() as i64);

    Ok(DbQueryResult {
        columns,
        rows,
        total,
        offset: offset as i64,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
        affected: None,
    })
}

/// 取单个对象的建表/建索引语句
#[tauri::command]
pub async fn db_ddl(id: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let op = get_op(&id)?;
        let conn = unpoison(op.conn.lock());
        conn.query_row("SELECT sql FROM sqlite_master WHERE name = ?1", [&name], |r| r.get(0))
            .map_err(map_sql_err)
    })
    .await
    .map_err(|e| format!("DbSqlError:任务执行异常：{e}"))?
}

/// 统一错误映射：SQLite 的中断（interrupt）映射为业务错误码 `DbCancelled:`
fn map_sql_err(e: rusqlite::Error) -> String {
    let s = e.to_string();
    if s.to_ascii_lowercase().contains("interrupt") {
        return "DbCancelled:查询已取消".to_string();
    }
    format!("DbSqlError:{}", s)
}

/// 读全局连接列表（前端初始化用）。
#[tauri::command]
pub fn db_connections_load() -> Result<Vec<DbConnection>, String> {
    Ok(load_connections())
}

/// 写全局连接列表（前端整份回写：增删改连、SQL 草稿、历史都由前端编排）。
#[tauri::command]
pub fn db_connections_save(list: Vec<DbConnection>) -> Result<(), String> {
    save_connections(&list)
}

// ---------- 退出清理 ----------

/// 应用退出时释放全部连接（照 `lsp_stop_all_for_exit` 先例，由 `lib.rs` 的 `RunEvent::Exit` 调用）。
pub fn db_stop_for_exit() {
    let dropped = {
        let mut ops = unpoison(DB_OPS.lock());
        let n = ops.len();
        ops.clear();
        n
    };
    if dropped > 0 {
        crate::logging::log_line(
            crate::logging::Level::Info,
            &format!("[exit] 关闭 {} 个 SQLite 连接", dropped),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let d = std::env::temp_dir().join(format!("oc-db-{}-{}", tag, nanos));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn validate_rejects_empty() {
        assert_eq!(validate_db_path("").unwrap_err(), "empty");
        assert_eq!(validate_db_path("   ").unwrap_err(), "empty");
    }

    #[test]
    fn validate_rejects_relative() {
        let e = validate_db_path("data/app.db").unwrap_err();
        assert_eq!(e, "not-absolute");
    }

    #[test]
    fn validate_rejects_unknown_extension() {
        let d = tmp_dir("ext");
        let f = d.join("notes.txt");
        fs::write(&f, b"x").unwrap();
        let e = validate_db_path(&f.to_string_lossy()).unwrap_err();
        assert!(e.starts_with("ext:"), "实际：{}", e);
    }

    #[test]
    fn validate_rejects_missing_file() {
        let d = tmp_dir("missing");
        let f = d.join("nope.db");
        let e = validate_db_path(&f.to_string_lossy()).unwrap_err();
        assert!(e.starts_with("io:"), "实际：{}", e);
    }

    #[test]
    fn validate_rejects_directory() {
        // 目录名带合法扩展名（真实场景：导出时误选了文件夹）——须走到「不是文件」而非被扩展名拦下
        let d = tmp_dir("dir");
        let dir = d.join("looks-like-db.db");
        fs::create_dir_all(&dir).unwrap();
        let e = validate_db_path(&dir.to_string_lossy()).unwrap_err();
        assert_eq!(e, "not-file");
    }

    #[test]
    fn validate_checks_extension_before_existence() {
        // 校验顺序固定为「非空 → 绝对 → 扩展名 → 存在性 → 是文件」：
        // 无扩展名的路径在扩展名一步就被拒（不落到 IO），故目录报的是 ext: 而非 not-file
        let d = tmp_dir("order");
        let e = validate_db_path(&d.to_string_lossy()).unwrap_err();
        assert_eq!(e, "ext:");
    }

    #[test]
    fn validate_accepts_all_whitelisted_extensions() {
        let d = tmp_dir("ok");
        for ext in ["sqlite", "sqlite3", "db", "db3", "DB"] {
            let f = d.join(format!("x.{}", ext));
            fs::write(&f, b"").unwrap();
            assert!(
                validate_db_path(&f.to_string_lossy()).is_ok(),
                "扩展名 {} 应被接受",
                ext
            );
        }
    }

    #[test]
    fn conn_id_is_stable_and_case_insensitive() {
        let a = conn_id("C:\\data\\App.db");
        let b = conn_id("c:\\data\\app.db");
        assert_eq!(a, b, "Windows 路径大小写不敏感，id 必须一致");
        assert_ne!(a, conn_id("C:\\data\\Other.db"));
        assert!(a.starts_with("db-"));
    }

    #[test]
    fn parse_connections_tolerates_garbage() {
        assert!(parse_connections("not json").is_empty());
        assert!(parse_connections("{}").is_empty());
        assert!(parse_connections("null").is_empty());
        assert!(parse_connections("[]").is_empty());
    }

    #[test]
    fn parse_connections_reads_payload() {
        let json = r#"[{"id":"db-1","path":"C:/a.db","name":"a.db","writable":false,"sql":"select 1","history":["select 1"]}]"#;
        let got = parse_connections(json);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "db-1");
        assert_eq!(got[0].sql, "select 1");
        assert_eq!(got[0].history, vec!["select 1".to_string()]);
        assert!(!got[0].writable);
    }

    #[test]
    fn serialize_parse_roundtrip() {
        let list = vec![DbConnection {
            id: "db-1".into(),
            path: "C:/a.db".into(),
            name: "a.db".into(),
            writable: true,
            sql: "SELECT * FROM t".into(),
            history: vec!["SELECT 1".into()],
        }];
        let json = serialize_connections(&list).unwrap();
        assert_eq!(parse_connections(&json), list);
    }

    #[test]
    fn open_real_db_readonly_then_reopen_preserves_draft() {
        let _g = test_guard();
        // 集成向：用真实 SQLite 文件验证 open_with_flags 与列表合并（不依赖 PR-2 的查询命令）
        let d = tmp_dir("open");
        let f = d.join("t.db");
        {
            let c = Connection::open(&f).unwrap();
            c.execute_batch("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);")
                .unwrap();
        }
        let path = f.to_string_lossy().to_string();
        let first = db_open(path.clone(), false).unwrap();
        assert_eq!(first.name, "t.db");
        assert!(!first.writable);
        // 手工把草稿写进列表（模拟 PR-4 的持久化），重开后应保留
        let mut list = load_connections();
        if let Some(slot) = list.iter_mut().find(|c| c.id == first.id) {
            slot.sql = "SELECT * FROM t".to_string();
        }
        save_connections(&list).unwrap();

        let second = db_open(path, false).unwrap();
        assert_eq!(second.id, first.id, "同路径必须复用同一 id");
        assert_eq!(second.sql, "SELECT * FROM t", "重开必须保留 SQL 草稿");

        db_close(second.id.clone()).unwrap();
        // 清理：避免污染用户真实的连接列表
        let mut list = load_connections();
        list.retain(|c| c.id != second.id);
        let _ = save_connections(&list);
        let _ = fs::remove_dir_all(&d);
    }

    // ---------- PR-2：SQL 解析纯函数 ----------

    #[test]
    fn classify_reads_baseline() {
        assert_eq!(classify_sql("SELECT * FROM t"), SqlKind::Read);
        assert_eq!(classify_sql("select 1"), SqlKind::Read, "大小写不敏感");
        assert_eq!(classify_sql("  \n\t SELECT 1"), SqlKind::Read, "前导空白");
        assert_eq!(classify_sql("WITH x AS (SELECT 1) SELECT * FROM x"), SqlKind::Read);
        assert_eq!(classify_sql("VALUES (1),(2)"), SqlKind::Read);
        assert_eq!(classify_sql("EXPLAIN QUERY PLAN SELECT 1"), SqlKind::Read);
    }

    #[test]
    fn classify_skips_comments() {
        assert_eq!(classify_sql("-- DELETE FROM t\nSELECT 1"), SqlKind::Read);
        assert_eq!(classify_sql("/* DELETE FROM t */ SELECT 1"), SqlKind::Read);
        assert_eq!(
            classify_sql("/* multi\nline\nDROP TABLE t */\nSELECT 1"),
            SqlKind::Read
        );
    }

    #[test]
    fn classify_ignores_semicolons_and_keywords_in_strings() {
        // 字符串里的 `;` 与 DROP 不得影响判定（最典型的误判来源）
        assert_eq!(classify_sql("SELECT '; DROP TABLE t;'"), SqlKind::Read);
        assert_eq!(classify_sql(r#"SELECT "drop table" FROM t"#), SqlKind::Read);
        assert_eq!(classify_sql("SELECT 'it''s; fine' FROM t"), SqlKind::Read, "'' 转义");
    }

    #[test]
    fn classify_writes() {
        assert_eq!(classify_sql("INSERT INTO t VALUES (1)"), SqlKind::Write);
        assert_eq!(classify_sql("UPDATE t SET a = 1"), SqlKind::Write);
        assert_eq!(classify_sql("DELETE FROM t"), SqlKind::Write);
        assert_eq!(classify_sql("CREATE TABLE t (a)"), SqlKind::Write);
        assert_eq!(classify_sql("DROP TABLE t"), SqlKind::Write);
        assert_eq!(classify_sql("ALTER TABLE t ADD COLUMN b"), SqlKind::Write);
    }

    #[test]
    fn classify_looks_past_cte_definitions() {
        // 安全关键：CTE + 写语句必须判为写，否则可写连接上会绕过确认框
        assert_eq!(classify_sql("WITH x AS (SELECT 1) DELETE FROM t"), SqlKind::Write);
        assert_eq!(classify_sql("WITH x AS (SELECT 1) SELECT * FROM x"), SqlKind::Read);
        assert_eq!(
            classify_sql("WITH RECURSIVE c(n) AS (SELECT 1) DELETE FROM t"),
            SqlKind::Write
        );
        assert_eq!(
            classify_sql("WITH a AS (SELECT 1), b AS (SELECT 2) UPDATE t SET x = 1"),
            SqlKind::Write,
            "多个 CTE 也要逐个跳过"
        );
    }

    #[test]
    fn classifys_pragma_by_name() {
        assert_eq!(classify_sql("PRAGMA table_info(t)"), SqlKind::Read);
        assert_eq!(classify_sql("PRAGMA index_list(t)"), SqlKind::Read);
        // 非白名 PRAGMA 一律按写处理（journal_mode 会改库状态）
        assert_eq!(classify_sql("PRAGMA journal_mode=WAL"), SqlKind::Write);
        assert_eq!(classify_sql("PRAGMA foreign_keys=ON"), SqlKind::Write);
    }

    #[test]
    fn classify_unknown_is_treated_as_write() {
        assert_eq!(classify_sql(""), SqlKind::Unknown);
        assert_eq!(classify_sql("   \n\t  "), SqlKind::Unknown);
        assert_eq!(classify_sql("VACUUM"), SqlKind::Write);
        // Unknown 在 db_query_impl 里与 Write 同路径拦截（下面集成用例覆盖）
    }

    #[test]
    fn has_limit_detects_trailing_limit_only() {
        assert!(has_limit("SELECT * FROM t LIMIT 10"));
        assert!(has_limit("SELECT * FROM t LIMIT 10 OFFSET 20"));
        assert!(has_limit("SELECT * FROM t limit 5;"));
        assert!(!has_limit("SELECT * FROM t"));
        assert!(!has_limit("SELECT * FROM t WHERE a = 10"), "行内数字不算 LIMIT");
        assert!(!has_limit("SELECT 'limit 1' FROM t"), "字符串里的 limit 不算");
    }

    #[test]
    fn strip_trailing_limit_removes_clause() {
        assert_eq!(strip_trailing_limit("SELECT * FROM t LIMIT 10"), "SELECT * FROM t");
        assert_eq!(
            strip_trailing_limit("SELECT * FROM t LIMIT 10 OFFSET 5"),
            "SELECT * FROM t"
        );
        assert_eq!(strip_trailing_limit("SELECT * FROM t"), "SELECT * FROM t");
        let masked = strip_trailing_limit("SELECT 'limit 9' FROM t");
        assert_eq!(
            masked, "SELECT 'limit 9' FROM t",
            "字符串内的 limit 不是子句：必须原样返回原文（含引号与内容）"
        );
        assert_eq!(
            strip_trailing_limit("SELECT * FROM \"t\" LIMIT 1"),
            "SELECT * FROM \"t\"",
            "引号标识符必须原样保留（等长去噪定位，切原文）"
        );
        assert_eq!(
            strip_trailing_limit("SELECT * FROM t LIMIT 1 -- c"),
            "SELECT * FROM t",
            "尾部注释不吞切点"
        );
        assert_eq!(
            strip_trailing_limit("SELECT * FROM \"t\" LIMIT 1;"),
            "SELECT * FROM \"t\"",
            "尾分号一并去掉"
        );
        assert_eq!(
            strip_trailing_limit("SELECT * FROM \"t\""),
            "SELECT * FROM \"t\"",
            "无 LIMIT 且以标识符结尾：原样返回"
        );
    }

    #[test]
    fn split_statements_respects_quotes_and_comments() {
        assert_eq!(split_statements("SELECT 1; SELECT 2"), vec!["SELECT 1", "SELECT 2"]);
        assert_eq!(
            split_statements("SELECT ';'; SELECT 2"),
            vec!["SELECT ';'", "SELECT 2"],
            "字符串内的分号不拆"
        );
        assert_eq!(
            split_statements("-- a; b\nSELECT 1"),
            vec!["-- a; b\nSELECT 1"],
            "注释内的分号不拆"
        );
        assert!(split_statements("").is_empty());
        assert!(split_statements("  ;  ").is_empty(), "纯分号不产生空语句");
    }

    #[test]
    fn truncate_cell_counts_chars_not_bytes() {
        let s = "a".repeat(250);
        assert_eq!(truncate_cell(&s, 200).chars().count(), 200);
        // 中文按字符截断：200 个汉字不会被字节口径切碎
        let zh = "中".repeat(250);
        assert_eq!(truncate_cell(&zh, 200).chars().count(), 200);
        assert_eq!(truncate_cell("abc", 200), "abc", "未超长原样返回");
    }

    #[test]
    fn blob_label_formats_sizes() {
        assert_eq!(blob_label(512), "<blob 512 B>");
        assert_eq!(blob_label(2048), "<blob 2.0 KB>");
        assert_eq!(blob_label(5 * 1024 * 1024), "<blob 5.0 MB>");
    }

    // ---------- 表数据浏览（v1.4 Tab 化）：纯函数 ----------

    #[test]
    fn sanitize_filter_trims_and_rejects_multi_statement() {
        assert_eq!(sanitize_filter(None).unwrap(), None);
        assert_eq!(sanitize_filter(Some("   ")).unwrap(), None);
        assert_eq!(sanitize_filter(Some(" status = 'paid' ")).unwrap(), Some("status = 'paid'".into()));
        // 字符串里的分号不算语句分隔符（split_statements 语义），必须放行
        assert_eq!(sanitize_filter(Some("name = 'a;b'")).unwrap(), Some("name = 'a;b'".into()));
        // 真正的多语句拒绝
        assert!(sanitize_filter(Some("1=1; DROP TABLE t")).is_err());
        assert!(sanitize_filter(Some("1=1;")).is_ok(), "尾部单个分号是单语句");
    }

    #[test]
    fn sort_dir_desc_is_explicit() {
        assert!(!sort_dir_desc(None));
        assert!(!sort_dir_desc(Some("asc")));
        assert!(!sort_dir_desc(Some("junk")));
        assert!(sort_dir_desc(Some("desc")));
        assert!(sort_dir_desc(Some("DESC")));
    }

    #[test]
    fn build_rows_sql_quotes_and_paginates() {
        assert_eq!(
            build_rows_sql("t", "", "", 200, 0),
            "SELECT * FROM \"t\" LIMIT 200 OFFSET 0"
        );
        assert_eq!(
            build_rows_sql("we\"ird", " WHERE (a > 1)", " ORDER BY \"a\" DESC", 0, 400),
            "SELECT * FROM \"we\"\"ird\" WHERE (a > 1) ORDER BY \"a\" DESC LIMIT 200 OFFSET 400",
            "limit=0 归一为 200"
        );
        assert_eq!(
            build_rows_sql("t", "", "", 999_999, 0),
            "SELECT * FROM \"t\" LIMIT 10000 OFFSET 0",
            "limit 超过硬上限时夹到 HARD_MAX_ROWS"
        );
    }

    // ---------- PR-2：集成（真实 SQLite 文件） ----------

    /// 集成测试串行锁：所有集成用例都会读写**同一份全局连接列表**
    /// （`~/.pylume/config/db_connections.json`），并行跑会互相覆盖导致 flaky。
    /// 纯函数用例不需要它。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn test_guard() -> std::sync::MutexGuard<'static, ()> {
        unpoison(TEST_LOCK.lock())
    }

    /// 造一个真实库：t(a INTEGER PK, name TEXT NN) 三行 + 一个视图 + 一个索引
    fn seed_db(tag: &str) -> (PathBuf, String) {
        let d = tmp_dir(tag);
        let f = d.join("seed.db");
        {
            let c = Connection::open(&f).unwrap();
            c.execute_batch(
                "CREATE TABLE t (a INTEGER PRIMARY KEY, name TEXT NOT NULL);
                 INSERT INTO t (name) VALUES ('alice'),('bob'),('carol');
                 CREATE VIEW v AS SELECT name FROM t;
                 CREATE INDEX idx_name ON t(name);",
            )
            .unwrap();
        }
        (d, f.to_string_lossy().to_string())
    }

    #[test]
    fn list_objects_returns_tables_views_indexes() {
        let _g = test_guard();
        let (d, path) = seed_db("list");
        let conn = db_open(path, false).unwrap();
        let objects = db_list_objects_impl(&conn.id).unwrap();
        assert_eq!(objects.len(), 3, "表 + 视图 + 索引");
        assert_eq!(objects[0].kind, "table");
        assert_eq!(objects[0].name, "t");
        assert_eq!(objects[0].row_count, Some(3));
        let cols = objects[0].columns.as_ref().unwrap();
        assert_eq!(cols.len(), 2);
        assert_eq!(cols[0].name, "a");
        assert!(cols[0].pk);
        assert!(cols[1].not_null, "name 是 NOT NULL");
        assert_eq!(objects[1].kind, "view");
        assert_eq!(objects[2].kind, "index");
        assert!(objects[2].columns.is_none(), "索引无列信息");
        assert!(objects[2].row_count.is_none(), "索引无行数");
        cleanup_conn(&conn.id, &d);
    }

    #[test]
    fn query_reads_rows_and_counts_total() {
        let _g = test_guard();
        let (d, path) = seed_db("query");
        let conn = db_open(path, false).unwrap();
        let r = db_query_impl(&conn.id, "SELECT a, name FROM t", 2, 0).unwrap();
        assert_eq!(r.columns, vec!["a", "name"]);
        assert_eq!(r.rows.len(), 2, "limit=2 只取两行");
        assert_eq!(r.total, 3, "total 是满足条件的总数，不是本页行数");
        // 引号标识符路径（前端浏览表恒为 SELECT * FROM "表名"）：COUNT 不得因去噪失效
        let quoted = db_query_impl(&conn.id, "SELECT * FROM \"t\"", 2, 0).unwrap();
        assert_eq!(quoted.total, 3, "引号标识符下 total 仍应为全表行数（真机 §10.3-3 回归）");
        assert_eq!(r.rows[0][1].as_deref(), Some("alice"));
        assert!(!r.truncated);
        assert!(r.affected.is_none());

        let page2 = db_query_impl(&conn.id, "SELECT a, name FROM t", 2, 2).unwrap();
        assert_eq!(page2.rows.len(), 1);
        assert_eq!(page2.rows[0][1].as_deref(), Some("carol"));
        cleanup_conn(&conn.id, &d);
    }

    #[test]
    fn query_renders_null_and_blob() {
        let _g = test_guard();
        let (d, path) = seed_db("nullblob");
        let conn = db_open(path, true).unwrap();
        db_query_impl(&conn.id, "INSERT INTO t (name) VALUES ('dave')", 0, 0).unwrap();
        let r = db_query_impl(&conn.id, "SELECT NULL AS n, x'0102' AS b", 10, 0).unwrap();
        assert_eq!(r.rows[0][0], None, "NULL 必须是 None 而非 \"\"");
        assert_eq!(r.rows[0][1].as_deref(), Some("<blob 2 B>"));
        cleanup_conn(&conn.id, &d);
    }

    #[test]
    fn query_blocks_write_on_readonly_connection() {
        let _g = test_guard();
        let (d, path) = seed_db("readonly");
        let conn = db_open(path, false).unwrap();
        let err = db_query_impl(&conn.id, "DELETE FROM t", 0, 0).unwrap_err();
        assert!(err.starts_with("DbReadOnly:"), "实际：{}", err);
        // 未知语句同样按写拦截（保守口径）
        let err2 = db_query_impl(&conn.id, "VACUUM", 0, 0).unwrap_err();
        assert!(err2.starts_with("DbReadOnly:"), "实际：{}", err2);
        cleanup_conn(&conn.id, &d);
    }

    /// 读查询多语句守卫：SQLite prepare 只跑第一条，其余静默丢弃 → 显式报错，
    /// 同时保证「字符串内的分号」不被误判（走 split_statements 的真源）。
    #[test]
    fn query_rejects_multi_statement_read() {
        let _g = test_guard();
        let (d, path) = seed_db("multi");
        let conn = db_open(path, true).unwrap();
        let err = db_query_impl(&conn.id, "SELECT 1; SELECT 2", 10, 0).unwrap_err();
        assert!(err.starts_with("DbSqlError:"), "实际：{}", err);
        // 分号在字符串里不算多语句
        let ok = db_query_impl(&conn.id, "SELECT 'a;b' AS s", 10, 0).unwrap();
        assert_eq!(ok.rows[0][0].as_deref(), Some("a;b"));
        // 末尾分号（单语句）也不算
        let ok2 = db_query_impl(&conn.id, "SELECT 7 AS n;", 10, 0).unwrap();
        assert_eq!(ok2.rows[0][0].as_deref(), Some("7"));
        // 写路径走 execute_batch，多语句批处理是允许的
        let w = db_query_impl(
            &conn.id,
            "INSERT INTO t (name) VALUES ('x'); INSERT INTO t (name) VALUES ('y')",
            0,
            0,
        )
        .unwrap();
        assert!(w.affected.is_some(), "写路径必须回填 affected");
        let n = db_query_impl(&conn.id, "SELECT COUNT(*) AS c FROM t WHERE name IN ('x','y')", 10, 0).unwrap();
        assert_eq!(n.rows[0][0].as_deref(), Some("2"), "两条 INSERT 都应落库");
        cleanup_conn(&conn.id, &d);
    }

    #[test]
    fn query_write_reports_affected_rows() {
        let _g = test_guard();
        let (d, path) = seed_db("write");
        let conn = db_open(path, true).unwrap();
        let r = db_query_impl(&conn.id, "DELETE FROM t WHERE name = 'bob'", 0, 0).unwrap();
        assert_eq!(r.affected, Some(1));
        let left = db_query_impl(&conn.id, "SELECT COUNT(*) AS c FROM t", 10, 0).unwrap();
        assert_eq!(left.rows[0][0].as_deref(), Some("2"));
        cleanup_conn(&conn.id, &d);
    }

    #[test]
    fn query_respects_user_supplied_limit() {
        let _g = test_guard();
        let (d, path) = seed_db("userlimit");
        let conn = db_open(path, false).unwrap();
        // 用户自带 LIMIT 1：即便 limit 参数传 100 也只返回 1 行（尊重意图）
        let r = db_query_impl(&conn.id, "SELECT * FROM t LIMIT 1", 100, 0).unwrap();
        assert_eq!(r.rows.len(), 1);
        cleanup_conn(&conn.id, &d);
    }

    #[test]
    fn cancel_interrupts_running_query() {
        let _g = test_guard();
        let (d, path) = seed_db("cancel");
        let conn = db_open(path, false).unwrap();
        let id = conn.id.clone();
        // 递归 CTE 生成 500 万行再计数：足够慢（数百 ms 量级），保证取消有窗口；
        // 用 started 标志消除「线程还没开始就取消」的竞态。
        let slow = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000000) \
                    SELECT COUNT(*) FROM c";
        let started = Arc::new(AtomicBool::new(false));
        let started_in_thread = Arc::clone(&started);
        let handle = std::thread::spawn(move || {
            started_in_thread.store(true, Ordering::SeqCst);
            db_query_impl(&id, slow, 10, 0)
        });
        while !started.load(Ordering::SeqCst) {
            std::thread::yield_now();
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
        db_cancel(conn.id.clone()).unwrap();
        let res = handle.join().expect("查询线程不应 panic");
        match res {
            Err(e) => assert!(e.starts_with("DbCancelled:"), "期望取消错误码，实际：{}", e),
            Ok(_) => panic!("查询应在取消后返回错误（若太快跑完则加大数据集）"),
        }
        // 取消后新查询必须能正常执行（取消是「中断这次」，不是「禁用连接」）
        let again = db_query_impl(&conn.id, "SELECT * FROM t", 10, 0).unwrap();
        assert_eq!(again.rows.len(), 3);
        cleanup_conn(&conn.id, &d);
    }

    #[test]
    fn ddl_returns_create_statement() {
        let _g = test_guard();
        let (d, path) = seed_db("ddl");
        let conn = db_open(path, false).unwrap();
        let sql = db_ddl_impl(&conn.id, "t").unwrap();
        assert!(sql.contains("CREATE TABLE t"), "实际：{}", sql);
        cleanup_conn(&conn.id, &d);
    }

    /// db_rows 集成：排序 / 筛选 / 分页 / 引号表名 / 非法列拒绝 / 表名白名单
    #[test]
    fn db_rows_sorts_filters_paginates() {
        let _g = test_guard();
        let (d, path) = seed_db("rows");
        let conn = db_open(path, false).unwrap();

        // 基线：无排序无筛选
        let base = db_rows_impl(&conn.id, "t", None, None, None, 2, 0).unwrap();
        assert_eq!(base.total, 3);
        assert_eq!(base.rows.len(), 2);

        // 排序：按 name DESC，翻页衔接
        let desc = db_rows_impl(&conn.id, "t", Some("name"), Some("desc"), None, 2, 2).unwrap();
        assert_eq!(desc.rows.len(), 1);
        assert_eq!(desc.rows[0][1].as_deref(), Some("alice"));
        let asc = db_rows_impl(&conn.id, "t", Some("NAME"), Some("ASC"), None, 10, 0).unwrap();
        assert_eq!(asc.rows[0][1].as_deref(), Some("alice"), "列名大小写不敏感命中");

        // 筛选：自由表达式 + 引号字符串里的分号
        let filtered =
            db_rows_impl(&conn.id, "t", None, None, Some("name = 'bo;b' OR name = 'bob'"), 10, 0).unwrap();
        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.rows[0][1].as_deref(), Some("bob"));

        // 排序 + 筛选组合
        let combo = db_rows_impl(&conn.id, "t", Some("a"), Some("desc"), Some("a < 3"), 10, 0).unwrap();
        assert_eq!(combo.rows[0][0].as_deref(), Some("2"));

        // 非法排序列 / 不存在的表 / 多语句筛选 → 明确报错
        assert!(db_rows_impl(&conn.id, "t", Some("nope"), None, None, 10, 0).is_err());
        assert!(db_rows_impl(&conn.id, "sqlite_master", None, None, None, 10, 0).is_err());
        assert!(db_rows_impl(&conn.id, "t", None, None, Some("1=1; DELETE FROM t"), 10, 0).is_err());
        // 只读连接照样可查（读路径不走写判定）
        assert_eq!(db_rows_impl(&conn.id, "v", None, None, None, 10, 0).unwrap().total, 3);
        cleanup_conn(&conn.id, &d);
    }

    fn db_ddl_impl(id: &str, name: &str) -> Result<String, String> {
        let op = get_op(id)?;
        let conn = unpoison(op.conn.lock());
        conn.query_row("SELECT sql FROM sqlite_master WHERE name = ?1", [name], |r| r.get(0))
            .map_err(map_sql_err)
    }

    /// 关闭连接 + 删临时目录 + 清掉列表里的测试连接（避免污染用户真实数据）
    fn cleanup_conn(id: &str, dir: &Path) {
        db_close(id.to_string()).unwrap();
        let mut list = load_connections();
        list.retain(|c| c.id != id);
        let _ = save_connections(&list);
        let _ = fs::remove_dir_all(dir);
    }
}
