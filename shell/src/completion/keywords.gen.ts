// 本文件由 tools/extract-keywords.mjs 生成，请勿手动编辑。
// 数据源：monaco-editor@0.52.2 的 basic-languages Monarch `language.keywords`
//         （json 为手工补充，见脚本内 MANUAL_KEYWORDS）。
// 重新生成：node tools/extract-keywords.mjs
// 用途：零引擎静态关键字补全（shell/src/completion/keywordCompletion.ts）。
// 不含 python：Python 补全由静态引擎 / 运行时 intel / live templates 三段提供。

/** 语言 ID → 静态关键字表（已去重、按字典序排列） */
export const KEYWORDS: Record<string, readonly string[]> = {
  bat: [
    "call", "defined", "echo", "errorlevel", "exist", "for", "goto", "if", "not", "pause", "popd",
    "pushd", "set", "shift", "start", "title",
  ],
  javascript: [
    "async", "await", "break", "case", "catch", "class", "const", "constructor", "continue",
    "debugger", "default", "delete", "do", "else", "export", "extends", "false", "finally", "for",
    "from", "function", "get", "if", "import", "in", "instanceof", "let", "new", "null", "of",
    "return", "set", "static", "super", "switch", "symbol", "this", "throw", "true", "try",
    "typeof", "undefined", "var", "void", "while", "with", "yield",
  ],
  json: [
    "false", "null", "true",
  ],
  powershell: [
    "begin", "break", "catch", "class", "configuration", "continue", "data", "define", "do",
    "dynamicparam", "else", "elseif", "end", "exit", "filter", "finally", "for", "foreach", "from",
    "function", "if", "in", "inlinescript", "parallel", "param", "process", "return", "sequence",
    "switch", "throw", "trap", "try", "until", "using", "var", "while", "workflow",
  ],
  rust: [
    "abstract", "alignof", "as", "async", "await", "become", "box", "break", "catch", "const",
    "continue", "crate", "default", "do", "dyn", "else", "enum", "extern", "false", "final", "fn",
    "for", "if", "impl", "in", "let", "loop", "macro", "match", "mod", "move", "mut", "offsetof",
    "override", "priv", "proc", "pub", "pure", "ref", "return", "self", "sizeof", "static",
    "struct", "super", "trait", "true", "try", "type", "typeof", "union", "unsafe", "unsized",
    "use", "virtual", "where", "while", "yield",
  ],
  shell: [
    "do", "done", "elif", "else", "esac", "exit", "export", "fi", "fil", "fin", "for", "function",
    "if", "in", "set", "then", "unset", "until", "while",
  ],
  sql: [
    "ABORT", "ABSOLUTE", "ACTION", "ADA", "ADD", "AFTER", "ALL", "ALLOCATE", "ALTER", "ALWAYS",
    "ANALYZE", "AND", "ANY", "ARE", "AS", "ASC", "ASSERTION", "AT", "ATTACH", "AUTHORIZATION",
    "AUTOINCREMENT", "AVG", "BACKUP", "BEFORE", "BEGIN", "BETWEEN", "BIT", "BIT_LENGTH", "BOTH",
    "BREAK", "BROWSE", "BULK", "BY", "CASCADE", "CASCADED", "CASE", "CAST", "CATALOG", "CHAR",
    "CHAR_LENGTH", "CHARACTER", "CHARACTER_LENGTH", "CHECK", "CHECKPOINT", "CLOSE", "CLUSTERED",
    "COALESCE", "COLLATE", "COLLATION", "COLUMN", "COMMIT", "COMPUTE", "CONFLICT", "CONNECT",
    "CONNECTION", "CONSTRAINT", "CONSTRAINTS", "CONTAINS", "CONTAINSTABLE", "CONTINUE", "CONVERT",
    "CORRESPONDING", "COUNT", "CREATE", "CROSS", "CURRENT", "CURRENT_DATE", "CURRENT_TIME",
    "CURRENT_TIMESTAMP", "CURRENT_USER", "CURSOR", "DATABASE", "DATE", "DAY", "DBCC", "DEALLOCATE",
    "DEC", "DECIMAL", "DECLARE", "DEFAULT", "DEFERRABLE", "DEFERRED", "DELETE", "DENY", "DESC",
    "DESCRIBE", "DESCRIPTOR", "DETACH", "DIAGNOSTICS", "DISCONNECT", "DISK", "DISTINCT",
    "DISTRIBUTED", "DO", "DOMAIN", "DOUBLE", "DROP", "DUMP", "EACH", "ELSE", "END", "END-EXEC",
    "ERRLVL", "ESCAPE", "EXCEPT", "EXCEPTION", "EXCLUDE", "EXCLUSIVE", "EXEC", "EXECUTE", "EXISTS",
    "EXIT", "EXPLAIN", "EXTERNAL", "EXTRACT", "FAIL", "FALSE", "FETCH", "FILE", "FILLFACTOR",
    "FILTER", "FIRST", "FLOAT", "FOLLOWING", "FOR", "FOREIGN", "FORTRAN", "FOUND", "FREETEXT",
    "FREETEXTTABLE", "FROM", "FULL", "FUNCTION", "GENERATED", "GET", "GLOB", "GLOBAL", "GO", "GOTO",
    "GRANT", "GROUP", "GROUPS", "HAVING", "HOLDLOCK", "HOUR", "IDENTITY", "IDENTITY_INSERT",
    "IDENTITYCOL", "IF", "IGNORE", "IMMEDIATE", "IN", "INCLUDE", "INDEX", "INDEXED", "INDICATOR",
    "INITIALLY", "INNER", "INPUT", "INSENSITIVE", "INSERT", "INSTEAD", "INT", "INTEGER",
    "INTERSECT", "INTERVAL", "INTO", "IS", "ISNULL", "ISOLATION", "JOIN", "KEY", "KILL", "LANGUAGE",
    "LAST", "LEADING", "LEFT", "LEVEL", "LIKE", "LIMIT", "LINENO", "LOAD", "LOCAL", "LOWER",
    "MATCH", "MATERIALIZED", "MAX", "MERGE", "MIN", "MINUTE", "MODULE", "MONTH", "NAMES",
    "NATIONAL", "NATURAL", "NCHAR", "NEXT", "NO", "NOCHECK", "NONCLUSTERED", "NONE", "NOT",
    "NOTHING", "NOTNULL", "NULL", "NULLIF", "NULLS", "NUMERIC", "OCTET_LENGTH", "OF", "OFF",
    "OFFSET", "OFFSETS", "ON", "ONLY", "OPEN", "OPENDATASOURCE", "OPENQUERY", "OPENROWSET",
    "OPENXML", "OPTION", "OR", "ORDER", "OTHERS", "OUTER", "OUTPUT", "OVER", "OVERLAPS", "PAD",
    "PARTIAL", "PARTITION", "PASCAL", "PERCENT", "PIVOT", "PLAN", "POSITION", "PRAGMA", "PRECEDING",
    "PRECISION", "PREPARE", "PRESERVE", "PRIMARY", "PRINT", "PRIOR", "PRIVILEGES", "PROC",
    "PROCEDURE", "PUBLIC", "QUERY", "RAISE", "RAISERROR", "RANGE", "READ", "READTEXT", "REAL",
    "RECONFIGURE", "RECURSIVE", "REFERENCES", "REGEXP", "REINDEX", "RELATIVE", "RELEASE", "RENAME",
    "REPLACE", "REPLICATION", "RESTORE", "RESTRICT", "RETURN", "RETURNING", "REVERT", "REVOKE",
    "RIGHT", "ROLLBACK", "ROW", "ROWCOUNT", "ROWGUIDCOL", "ROWS", "RULE", "SAVE", "SAVEPOINT",
    "SCHEMA", "SCROLL", "SECOND", "SECTION", "SECURITYAUDIT", "SELECT", "SEMANTICKEYPHRASETABLE",
    "SEMANTICSIMILARITYDETAILSTABLE", "SEMANTICSIMILARITYTABLE", "SESSION", "SESSION_USER", "SET",
    "SETUSER", "SHUTDOWN", "SIZE", "SMALLINT", "SOME", "SPACE", "SQL", "SQLCA", "SQLCODE",
    "SQLERROR", "SQLSTATE", "SQLWARNING", "STATISTICS", "SUBSTRING", "SUM", "SYSTEM_USER", "TABLE",
    "TABLESAMPLE", "TEMP", "TEMPORARY", "TEXTSIZE", "THEN", "TIES", "TIME", "TIMESTAMP",
    "TIMEZONE_HOUR", "TIMEZONE_MINUTE", "TO", "TOP", "TRAILING", "TRAN", "TRANSACTION", "TRANSLATE",
    "TRANSLATION", "TRIGGER", "TRIM", "TRUE", "TRUNCATE", "TRY_CONVERT", "TSEQUAL", "UNBOUNDED",
    "UNION", "UNIQUE", "UNKNOWN", "UNPIVOT", "UPDATE", "UPDATETEXT", "UPPER", "USAGE", "USE",
    "USER", "USING", "VACUUM", "VALUE", "VALUES", "VARCHAR", "VARYING", "VIEW", "VIRTUAL",
    "WAITFOR", "WHEN", "WHENEVER", "WHERE", "WHILE", "WINDOW", "WITH", "WITHOUT", "WORK", "WRITE",
    "WRITETEXT", "YEAR", "ZONE",
  ],
  typescript: [
    "abstract", "any", "as", "asserts", "async", "await", "bigint", "boolean", "break", "case",
    "catch", "class", "const", "constructor", "continue", "debugger", "declare", "default",
    "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from",
    "function", "get", "global", "if", "implements", "import", "in", "infer", "instanceof",
    "interface", "is", "keyof", "let", "module", "namespace", "never", "new", "null", "number",
    "object", "of", "out", "override", "package", "private", "protected", "public", "readonly",
    "require", "return", "satisfies", "set", "static", "string", "super", "switch", "symbol",
    "this", "throw", "true", "try", "type", "typeof", "undefined", "unique", "unknown", "var",
    "void", "while", "with", "yield",
  ],
  yaml: [
    "FALSE", "False", "false", "Null", "null", "TRUE", "True", "true",
  ],
};

/** 支持关键字补全的语言 ID（= KEYWORDS 的键，provider 直接用它注册） */
export const KEYWORD_LANGUAGES: readonly string[] = Object.keys(KEYWORDS);
