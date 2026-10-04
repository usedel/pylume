// @vitest-environment happy-dom
// B3 SQLite 数据库工具：纯函数单测（docs/sqlite_tool_dev_plan.md §10）。
//
// v1.4 Tab 化重设计后覆盖三块：
// 1. sqliteGrid.ts —— 单元格格式化 / 分页换算 / 排序三态 / CSV·JSON / 状态条 / 表格构建；
// 2. sqliteSql.ts —— SQL 判定（Rust classify_sql 的前端镜像，含全部对抗样本）
//    与语句切分（split_statements 镜像）；
// 3. 宽屏态与窄栏裁列纯函数已随架构退役（编辑器区宽度充足，恒全列渲染）。
//
// 断言走 t(key)（默认中文等价于原文），切默认语言不用改断言——与 output.test.ts 同款纪律。

import { describe, expect, it } from "vitest";
import { t } from "../i18n";
import {
  buildGridTable,
  CELL_MAX_CHARS,
  csvCell,
  formatCell,
  nextSort,
  offsetOfPage,
  pageOf,
  rowToJson,
  statusText,
  toCsv,
  type DbQueryResult,
} from "../sqliteGrid";
import { classifySql, currentStatement, splitSqlStatements, statementSpans, stripSqlNoise, topLevelWords } from "../sqliteSql";

/** 造一个结果对象（只写用例关心的字段） */
function res(partial: Partial<DbQueryResult> = {}): DbQueryResult {
  return {
    columns: ["id", "name"],
    rows: [["1", "a"]],
    total: 1,
    offset: 0,
    truncated: false,
    elapsedMs: 5,
    affected: null,
    ...partial,
  };
}

describe("formatCell：NULL / BLOB / 空串 / 截断四态", () => {
  it("NULL 与空串必须视觉可分（前者斜体 NULL，后者引号占位）", () => {
    const nul = formatCell(null);
    expect(nul.kind).toBe("null");
    expect(nul.text).toBe(t("database.null"));
    const empty = formatCell("");
    expect(empty.kind).toBe("empty");
    expect(empty.text).toBe('""');
  });

  it("BLOB 标签按 Rust blob_label 的三种单位识别（B / KB / MB）", () => {
    for (const label of ["<blob 2 B>", "<blob 2.4 KB>", "<blob 1.1 MB>"]) {
      const d = formatCell(label);
      expect(d.kind, label).toBe("blob");
      expect(d.text).toBe(label);
    }
    // 形近但非标签的文本仍按普通文本处理
    expect(formatCell("<blob 2 B").kind).toBe("text");
  });

  it("长度撞到后端上限才加省略号（后端按字符截断，前端据此判断可能还有更多）", () => {
    const short = formatCell("abc");
    expect(short.truncated).toBe(false);
    expect(short.text).toBe("abc");
    const long = formatCell("x".repeat(CELL_MAX_CHARS));
    expect(long.truncated).toBe(true);
    expect(long.text.endsWith("…")).toBe(true);
    expect(long.full.length).toBe(CELL_MAX_CHARS);
  });
});

describe("pageOf：分页换算与越界收敛", () => {
  it("空结果不显示「第 1/1 页」以外的假页码", () => {
    const p = pageOf(0, 0, 200);
    expect(p).toMatchObject({ page: 1, pages: 1, from: 0, to: 0, hasPrev: false, hasNext: false });
  });

  it("总数按页大小向上取整，首末页 from/to 正确", () => {
    expect(pageOf(250, 0, 200)).toMatchObject({ page: 1, pages: 2, from: 1, to: 200, hasPrev: false, hasNext: true });
    expect(pageOf(250, 200, 200)).toMatchObject({ page: 2, pages: 2, from: 201, to: 250, hasPrev: true, hasNext: false });
  });

  it("offset 越界时页码夹到最后一页（删行后停在空页是常见事故）", () => {
    const p = pageOf(100, 800, 200);
    expect(p.page).toBe(1);
    expect(p.hasNext).toBe(false);
  });

  it("非法 pageSize 回落到 200", () => {
    expect(pageOf(300, 0, 0).pages).toBe(2);
  });
});

describe("offsetOfPage：页码 ↔ 行偏移的互逆（DB-Q-1 回归）", () => {
  it("页码 1 起 → 偏移 0 起", () => {
    expect(offsetOfPage(1, 200)).toBe(0);
    expect(offsetOfPage(2, 200)).toBe(200);
    expect(offsetOfPage(3, 100)).toBe(200);
  });

  it("与 pageOf 互逆：pageOf(t, offsetOfPage(n), s).page === n", () => {
    for (const size of [100, 200, 500]) {
      for (let n = 1; n <= 5; n++) {
        const total = size * 8;
        expect(pageOf(total, offsetOfPage(n, size), size).page).toBe(n);
      }
    }
  });

  it("非法入参收敛（页码 <1 → 0；pageSize 非法回落 200）", () => {
    expect(offsetOfPage(0, 200)).toBe(0);
    expect(offsetOfPage(-3, 200)).toBe(0);
    expect(offsetOfPage(2, 0)).toBe(200);
    expect(offsetOfPage(Number.NaN, 200)).toBe(0);
  });
});

describe("nextSort：表数据排序三态循环（无 → 升序 → 降序 → 无）", () => {
  it("换列一律回到升序", () => {
    expect(nextSort(null, "a")).toEqual({ col: "a", desc: false });
    expect(nextSort({ col: "b", desc: true }, "a")).toEqual({ col: "a", desc: false });
  });

  it("同列循环：升序 → 降序 → 无", () => {
    expect(nextSort({ col: "a", desc: false }, "a")).toEqual({ col: "a", desc: true });
    expect(nextSort({ col: "a", desc: true }, "a")).toBeNull();
  });
});

describe("CSV / JSON 导出", () => {
  it("含逗号 / 引号 / 换行的字段整体加引号且内部引号双写", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("l1\nl2")).toBe('"l1\nl2"');
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe(""); // NULL → 空字段
  });

  it("整表导出首行列名，行以 CRLF 分隔", () => {
    const csv = toCsv(res({ columns: ["a", "b"], rows: [["1", null], ["x,y", "z"]] }));
    expect(csv).toBe('a,b\r\n1,\r\n"x,y",z');
  });

  it("rowToJson 保留 null（显式）而非丢键", () => {
    expect(rowToJson(["a", "b"], ["1", null])).toBe('{\n  "a": "1",\n  "b": null\n}');
  });
});

describe("statusText：状态条优先级与内容", () => {
  it("错误 > 执行中 > 结果 > 空态", () => {
    expect(statusText({ result: res(), writable: false, querying: false, cancelling: false, error: "查询失败：x" })).toBe("查询失败：x");
    expect(statusText({ result: res(), writable: false, querying: true, cancelling: false })).toBe(t("database.executing"));
    expect(statusText({ result: res(), writable: false, querying: true, cancelling: true })).toBe(t("database.cancelling"));
    expect(statusText({ result: null, writable: false, querying: false, cancelling: false })).toBe(t("database.statusIdle"));
  });

  it("读结果拼「已显示/总数 行 · 耗时 · 只读」；截断追加提示", () => {
    const s = statusText({
      result: res({ columns: ["id", "name", "note"], rows: [["1", "a", "b"]], total: 250, elapsedMs: 12, truncated: true }),
      writable: false,
      querying: false,
      cancelling: false,
    });
    expect(s).toContain(t("database.statusRows", { shown: 1, total: 250 }));
    expect(s).toContain(t("database.elapsed", { ms: 12 }));
    expect(s).toContain(t("database.modeRead"));
    expect(s).toContain(t("database.truncated", { n: 1 }));
  });

  it("写语句显示影响行数并带复数变体（中文同文，英文按 Intl 选形）", () => {
    const s = statusText({
      result: res({ rows: [], total: 0, affected: 3 }),
      writable: true,
      querying: false,
      cancelling: false,
    });
    expect(s).toContain(t("database.statusAffected", { count: 3 }));
    expect(s).toContain(t("database.modeWrite"));
  });
});

describe("buildGridTable：网格 DOM", () => {
  it("空结果返回 null（让调用方走空态，而不是造一张空表）", () => {
    expect(buildGridTable(res({ rows: [] }), { offset: 0 })).toBeNull();
  });

  it("行号列用绝对行号（offset + 序号），列名与单元格齐全", () => {
    const table = buildGridTable(res({ rows: [["1", "a"], ["2", "b"]] }), { offset: 200 })!;
    expect(table).not.toBeNull();
    const head = Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent);
    expect(head).toEqual(["#", "id", "name"]);
    const rows = table.querySelectorAll("tbody tr");
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector(".db-rowno")!.textContent).toBe("201");
    expect(rows[1].querySelector(".db-rowno")!.textContent).toBe("202");
  });

  it("特殊单元格带对应类名，NULL 不落 title（避免与 tooltip 冲突）", () => {
    const table = buildGridTable(res({ columns: ["a", "b"], rows: [[null, "x"]] }), { offset: 0 })!;
    const cells = table.querySelectorAll("tbody td");
    expect(cells[1].className).toContain("db-cell-null");
    expect(cells[1].getAttribute("title")).toBeNull();
    expect(cells[2].className).toContain("db-cell-text");
    expect(cells[2].getAttribute("title")).toBe("x");
  });

  it("点击单元格回调带列名与绝对行号（单元格详情用）", () => {
    let got: { column: string; row: number } | null = null;
    const table = buildGridTable(res({ rows: [["1", "a"]] }), {
      offset: 40,
      onCellClick: (info) => {
        got = { column: info.column, row: info.row };
      },
    })!;
    (table.querySelectorAll("tbody td")[2] as HTMLElement).click();
    expect(got).toEqual({ column: "name", row: 41 });
  });

  it("可排序列头：点击回调列名，排序态带箭头与 aria-sort", () => {
    let clicked: string | null = null;
    const table = buildGridTable(res(), {
      offset: 0,
      sort: { col: "name", desc: true },
      onHeaderClick: (col) => {
        clicked = col;
      },
    })!;
    const ths = table.querySelectorAll("thead th");
    (ths[2] as HTMLElement).click(); // name 列
    expect(clicked).toBe("name");
    const sorted = table.querySelector('th[aria-sort="descending"]');
    expect(sorted).not.toBeNull();
    expect(sorted!.textContent).toContain("name");
    // 未排序列不带箭头
    expect(ths[1].className).not.toContain("db-th-asc");
    expect(ths[1].className).not.toContain("db-th-desc");
  });

  it("无 onHeaderClick 时表头不可点（查询 Tab 的任意结果集不排序）", () => {
    const table = buildGridTable(res(), { offset: 0 })!;
    expect(table.querySelector(".db-th-sortable")).toBeNull();
  });
});

describe("SQL 判定（Rust classify_sql 的前端镜像，含对抗样本）", () => {
  it("stripSqlNoise 把注释与字符串替换为空格（保持长度）", () => {
    const src = "SELECT '; DROP' -- 注释";
    const out = stripSqlNoise(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain("DROP");
  });

  it("topLevelWords 跳过括号块内的词", () => {
    expect(topLevelWords("WITH x AS (SELECT 1) SELECT 2")).toEqual(["with", "x", "as", "select", "2"]);
  });

  const cases: [string, "read" | "write"][] = [
    ["SELECT * FROM t", "read"],
    ["-- 注释\nSELECT 1", "read"],
    ["/* DELETE FROM t */ SELECT 1", "read"],
    ["SELECT '; DROP TABLE t;'", "read"],
    ["select 1", "read"],
    ["WITH x AS (SELECT 1) SELECT * FROM x", "read"],
    ["WITH RECURSIVE x AS (SELECT 1) SELECT * FROM x", "read"],
    ["PRAGMA table_info(t)", "read"],
    ["VALUES (1)", "read"],
    ["EXPLAIN SELECT 1", "read"],
    ["INSERT INTO t VALUES (1)", "write"],
    ["UPDATE t SET a = 1", "write"],
    ["DELETE FROM t", "write"],
    ["CREATE TABLE t (a INT)", "write"],
    ["DROP TABLE t", "write"],
    ["VACUUM", "write"],
    ["PRAGMA journal_mode=WAL", "write"],
    ["WITH x AS (SELECT 1) DELETE FROM t", "write"],
    ["  \n\t  ", "write"],
    ["-- 只有注释", "write"],
  ];
  for (const [sql, want] of cases) {
    it(`classifySql(${JSON.stringify(sql)}) === ${want}`, () => {
      expect(classifySql(sql)).toBe(want);
    });
  }
});

describe("语句切分（Rust split_statements 的前端镜像）", () => {
  it("按分号切分并丢弃空片段；末尾无分号也算一条", () => {
    expect(splitSqlStatements("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
    expect(splitSqlStatements("SELECT 1;")).toEqual(["SELECT 1"]);
    expect(splitSqlStatements("  ;;  ")).toEqual([]);
  });

  it("字符串与注释里的分号不算分隔符", () => {
    expect(splitSqlStatements("SELECT 'a;b'; SELECT 2")).toEqual(["SELECT 'a;b'", "SELECT 2"]);
    expect(splitSqlStatements("SELECT 1 -- a;b\n; SELECT 2")).toEqual(["SELECT 1 -- a;b", "SELECT 2"]);
    expect(splitSqlStatements("SELECT \"a;b\"")).toEqual(['SELECT "a;b"']);
  });

  it("statementSpans 记录每条语句的结束下标（含分号）", () => {
    const spans = statementSpans("SELECT 1; SELECT 2");
    expect(spans.map((s) => s.end)).toEqual([9, 18]);
  });

  it("currentStatement 按光标位置取当前语句；落在分隔空白上取前一条", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    expect(currentStatement(sql, 3)).toBe("SELECT 1");
    expect(currentStatement(sql, 9)).toBe("SELECT 1"); // 正好在分号上
    expect(currentStatement(sql, 12)).toBe("SELECT 2");
    expect(currentStatement(sql, 999)).toBe("SELECT 2");
    expect(currentStatement("", 0)).toBe("");
  });

  it("单条语句时返回整条（含未 trim 的前后空白已归一）", () => {
    expect(currentStatement("  SELECT 1  ", 4)).toBe("SELECT 1");
  });
});
