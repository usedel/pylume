// SQLite 语句分析纯函数（B3 · docs/sqlite_tool_dev_plan.md §4/§5）。
//
// 纪律：本模块**零依赖**（不 import state / invoke / DOM）——SQL 判定与语句切分是
// Rust db_cmds.rs 的前端镜像（真源在 Rust，改前先回文档），只读连接上前端拦截省一次 IPC，
// **硬闸门在后端**（DbReadOnly:），镜像被绕过也写不坏库。
// 单独成模块（而非并入 sqliteTabs）：单测不必拉起 Tab 子系统的依赖链。

const READ_KEYWORDS = new Set(["select", "values", "explain"]);
/** 只读类 PRAGMA（与 Rust `READ_PRAGMAS` 同源；其余 PRAGMA 一律按写处理，最保守） */
const READ_PRAGMAS = new Set([
  "table_info",
  "table_list",
  "table_xinfo",
  "index_list",
  "index_info",
  "index_xinfo",
  "database_list",
  "function_list",
  "collation_list",
]);

/**
 * 去噪：行注释 / 块注释 / 单双引号字符串一律替换为**等长空格**（保持字符位置），
 * 后续判定只看去噪文本，避免 `SELECT '; DROP TABLE t;'` 这类字符串内的关键字被误判。
 * 与 Rust `strip_noise` 同源。
 */
export function stripSqlNoise(sql: string): string {
  const out = sql.split("");
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      out[i++] = " ";
      out[i++] = " ";
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) out[i++] = " ";
      if (i < n) {
        out[i++] = " ";
        out[i++] = " ";
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      out[i++] = " ";
      while (i < n) {
        const ch = sql[i];
        out[i++] = " ";
        if (ch === quote) {
          // SQL 里连续两个引号是转义，不算字符串结束
          if (sql[i] === quote) out[i++] = " ";
          else break;
        }
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

/** 取顶层词序列（小写）：跳过成对括号内的内容，词内只留字母数字与下划线。与 Rust `top_level_words` 同源。 */
export function topLevelWords(sql: string): string[] {
  const words: string[] = [];
  let cur = "";
  let depth = 0;
  const flush = (): void => {
    const w = cur.replace(/[^\p{L}\p{N}_]/gu, "").toLowerCase();
    cur = "";
    if (w) words.push(w);
  };
  for (const c of stripSqlNoise(sql)) {
    if (c === "(") {
      flush();
      depth++;
      continue;
    }
    if (c === ")") {
      flush();
      depth = Math.max(0, depth - 1);
      continue; // 不把 ')' 计入词序列（与 Rust top_level_words 同源）
    }
    if (depth > 0) continue; // 括号内一律忽略
    if (/\s/.test(c) || c === "," || c === ";") {
      flush();
      continue;
    }
    cur += c;
  }
  flush();
  return words;
}

export type SqlKind = "read" | "write";

/**
 * 判定 SQL 大类。**不确定一律 `write`**（保守：宁可多弹一次确认，也不放走一次写）。
 *
 * 用途仅两处：① 只读连接上省一次 IPC 直接拦下；② 可写连接上决定是否弹写确认框。
 */
export function classifySql(sql: string): SqlKind {
  const words = topLevelWords(sql);
  if (words.length === 0) return "write";
  let i = 0;
  // WITH 前缀：跳过 `name AS (…)` 的 CTE 定义，落到真正的主语句上
  if (words[i] === "with") {
    i++;
    if (words[i] === "recursive") i++;
    while (i + 1 < words.length && words[i + 1] === "as") i += 2;
  }
  const w = words[i] ?? "";
  if (READ_KEYWORDS.has(w)) return "read";
  if (w === "pragma") return READ_PRAGMAS.has(words[i + 1] ?? "") ? "read" : "write";
  return "write";
}

export interface StatementSpan {
  /** 语句文本（已 trim，不含结尾分号） */
  text: string;
  /** 该语句在原文中的结束下标（含结尾 `;`；末条无分号时为原文长度） */
  end: number;
}

/**
 * 扫描出各语句的文本与结束位置（**字符串与注释内的分号不算分隔符**）。
 *
 * 与 Rust `split_statements` 同源。为什么前端也要一份：后端的**读**查询路径会拒绝多语句
 * （`DbSqlError:一次只能执行一条查询语句`），所以「执行全部」必须由前端切好、逐条发
 * `db_query`；「执行当前语句」也要靠它定位光标所在的那一条。
 */
export function statementSpans(sql: string): StatementSpan[] {
  const out: StatementSpan[] = [];
  let cur = "";
  let i = 0;
  const n = sql.length;
  const flush = (end: number): void => {
    const text = cur.trim();
    if (text) out.push({ text, end });
    cur = "";
  };
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") cur += sql[i++];
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      cur += sql[i++];
      cur += sql[i++];
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) cur += sql[i++];
      if (i < n) {
        cur += sql[i++];
        cur += sql[i++];
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      cur += sql[i++];
      while (i < n) {
        const ch = sql[i];
        cur += sql[i++];
        if (ch === quote) {
          if (sql[i] === quote) cur += sql[i++]; // 双写引号是转义，不算收尾
          else break;
        }
      }
      continue;
    }
    if (c === ";") {
      i++;
      flush(i);
      continue;
    }
    cur += c;
    i++;
  }
  flush(n);
  return out;
}

/** 按 `;` 切分语句（空片段丢弃）。「执行全部」用。 */
export function splitSqlStatements(sql: string): string[] {
  return statementSpans(sql).map((s) => s.text);
}

/**
 * 取光标所在的语句（`offset` = 光标在整段 SQL 中的字符下标）。
 *
 * 落在两条语句之间的空白/分号上时**取前一条**——用户的直觉是「我刚写完的那条」；
 * 全空时返回空串（调用方据此提示，而不是把空串发到后端）。
 */
export function currentStatement(sql: string, offset: number): string {
  const spans = statementSpans(sql);
  if (spans.length === 0) return "";
  const pos = Math.max(0, Math.min(offset, sql.length));
  for (const s of spans) {
    if (pos <= s.end) return s.text;
  }
  return spans[spans.length - 1].text;
}
