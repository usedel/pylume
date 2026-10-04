// SQLite 结果网格的纯渲染层（B3 · docs/sqlite_tool_dev_plan.md §6.1）。
//
// 纪律：本模块**不 import state / 不 invoke / 不订阅事件**——只做「数据 → DOM / 文本」的
// 确定性变换，因而可被 vitest 直接单测（交叉能力一律由调用方以参数注入，照 endpointView
// 的 handler 注入纪律）。
//
// 双端同源约定（改前回文档 §4 / §5.4，Rust 侧同名实现见 db_cmds.rs）：
// - 单元格文本已由 Rust 按 CELL_MAX_CHARS 个**字符**截断（不是字节——中文场景字节口径会多切）；
// - BLOB 只回标签 `<blob N B>`，不回内容；NULL 回 null（不是空串）——两者必须能区分。
//
// v1.4 Tab 化重设计：结果网格现在渲染在编辑器区的数据库 Tab 里（宽度充足），
// 窄栏裁列与宽屏态常量已随宽屏 hack 一并退役；表头支持点击排序、单元格支持右键菜单。

import { t } from "./i18n";

/** 与 Rust `db_cmds::CELL_MAX_CHARS` 同源。后端已按此截断，前端据此判断「可能还有更多」。 */
export const CELL_MAX_CHARS = 200;

/** 查询结果（字段名与 Rust `DbQueryResult` 对齐：serde camelCase）。 */
export interface DbQueryResult {
  columns: string[];
  /** 一律字符串化（避免 JSON 类型歧义）；NULL = null */
  rows: (string | null)[][];
  /** 满足条件的总行数（分页用；后端算不出时退化为本次行数） */
  total: number;
  offset: number;
  /** 是否撞到后端硬上限（10000 行） */
  truncated: boolean;
  elapsedMs: number;
  /** 写语句影响行数；读语句为 null */
  affected: number | null;
}

// ---------- 单元格格式化 ----------

export type CellKind = "null" | "blob" | "empty" | "text";

export interface CellDisplay {
  /** 网格里显示的文本 */
  text: string;
  kind: CellKind;
  /** 详情 / title 用的文本（**注意**：后端可能已截断，见 CELL_MAX_CHARS） */
  full: string;
  /** 是否可能被后端截断（长度撞到上限即视为可能——后端不额外回标记，省一次 IPC） */
  truncated: boolean;
}

/** Rust `blob_label` 的输出格式：`<blob 2 B>` / `<blob 2.4 KB>` / `<blob 1.1 MB>`。 */
const BLOB_RE = /^<blob \d+(?:\.\d+)? (?:B|KB|MB)>$/;

/** 单元格 → 显示信息。NULL / BLOB / 空串三种「看起来空」的值必须视觉可分。 */
export function formatCell(v: string | null): CellDisplay {
  if (v === null) return { text: t("database.null"), kind: "null", full: "", truncated: false };
  if (BLOB_RE.test(v)) return { text: v, kind: "blob", full: v, truncated: false };
  if (v === "") return { text: '""', kind: "empty", full: "", truncated: false };
  const truncated = v.length >= CELL_MAX_CHARS;
  return { text: truncated ? `${v}…` : v, kind: "text", full: v, truncated };
}

// ---------- 分页 ----------

export interface PageInfo {
  /** 当前页（1 起） */
  page: number;
  pages: number;
  /** 本页首行的**绝对**行号（1 起）；空结果 = 0 */
  from: number;
  /** 本页末行的绝对行号 */
  to: number;
  hasPrev: boolean;
  hasNext: boolean;
}

/**
 * 由 `total` / `offset` / `pageSize` 推分页态。
 *
 * 越界收敛：`offset` 超出总数时把 `page` 夹到最后一页（删除行后停在空页是常见事故），
 * 但**不**改写 `offset` 本身——offset 的真源是调用方的查询参数，这里只做展示换算。
 */
export function pageOf(total: number, offset: number, pageSize: number): PageInfo {
  const size = pageSize > 0 ? pageSize : 200;
  const safeTotal = Math.max(0, total);
  const safeOffset = Math.max(0, offset);
  const pages = Math.max(1, Math.ceil(safeTotal / size));
  const page = Math.min(pages, Math.floor(safeOffset / size) + 1);
  const from = safeTotal <= 0 ? 0 : Math.min(safeOffset + 1, safeTotal);
  const to = Math.min(safeOffset + size, safeTotal);
  return { page, pages, from, to, hasPrev: page > 1, hasNext: page < pages };
}

/**
 * 页码（**1 基**）→ 行偏移，`pageOf` 的逆运算：`pageOf(t, offsetOfPage(n, s), s).page === n`。
 *
 * 存在的意义是消灭「页码 / 行偏移」两套单位的混用入口——分页按钮的 ±1 算的是页码，
 * 而 `db_query` / `db_rows` 收的是偏移，中间必须过这一道。曾经两者在同一处裸算
 * （`gotoPage(page + 1)` 里 `page` 其实是偏移），导致「下一页」原地不动（e2e DB-Q-1 抓到的真 bug）。
 */
export function offsetOfPage(pageNo: number, pageSize: number): number {
  const size = pageSize > 0 ? pageSize : 200;
  const safePage = Number.isFinite(pageNo) ? Math.max(1, Math.floor(pageNo)) : 1;
  return (safePage - 1) * size;
}

/** 表数据 Tab 的排序三态循环：无 → 升序 → 降序 → 无（纯函数，单测目标）。 */
export function nextSort(cur: { col: string; desc: boolean } | null, col: string): { col: string; desc: boolean } | null {
  if (!cur || cur.col !== col) return { col, desc: false };
  if (!cur.desc) return { col, desc: true };
  return null;
}

// ---------- CSV / JSON 导出 ----------

/** RFC 4180 单元格转义：含 `"` `,` CR LF 时整体加引号，内部 `"` 双写。NULL → 空字段。 */
export function csvCell(v: string | null): string {
  if (v === null) return "";
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** 结果 → CSV 文本（首行列名）。行上限由调用方控制（导出前 10000 行）。 */
export function toCsv(result: DbQueryResult): string {
  const lines = [result.columns.map(csvCell).join(",")];
  for (const row of result.rows) lines.push(row.map(csvCell).join(","));
  return lines.join("\r\n");
}

/** 单行 → JSON 对象文本（右键「复制为 JSON」用；NULL 显式保留 null）。 */
export function rowToJson(columns: string[], row: (string | null)[]): string {
  const obj: Record<string, string | null> = {};
  columns.forEach((c, i) => {
    obj[c] = row[i] ?? null;
  });
  return JSON.stringify(obj, null, 2);
}

// ---------- 状态条 ----------

export interface StatusInput {
  result: DbQueryResult | null;
  writable: boolean;
  querying: boolean;
  cancelling: boolean;
  /** 已本地化的整句错误（如 `查询失败：…`）；非空时优先显示 */
  error?: string;
}

/**
 * 结果状态条文本：`已显示/总数 行 · 耗时 · 只读/可写`。
 * 优先级：错误 > 执行中/取消中 > 结果 > 空态。
 */
export function statusText(s: StatusInput): string {
  if (s.error) return s.error;
  if (s.querying) return s.cancelling ? t("database.cancelling") : t("database.executing");
  const r = s.result;
  if (!r) return t("database.statusIdle");
  const parts: string[] = [];
  if (r.affected !== null) parts.push(t("database.statusAffected", { count: r.affected }));
  else parts.push(t("database.statusRows", { shown: r.rows.length, total: r.total }));
  if (r.elapsedMs > 0) parts.push(t("database.elapsed", { ms: r.elapsedMs }));
  parts.push(s.writable ? t("database.modeWrite") : t("database.modeRead"));
  if (r.truncated) parts.push(t("database.truncated", { n: r.rows.length }));
  return parts.join(" · ");
}

// ---------- 表格构建 ----------

export interface CellClickInfo {
  column: string;
  /** 1 起**绝对**行号（不是页内序号） */
  row: number;
  display: CellDisplay;
}

export interface GridOptions {
  /** 本页首行的绝对行号（= 查询的 offset） */
  offset: number;
  /** 当前排序（仅用于表头箭头显示；实际排序由调用方发查询） */
  sort?: { col: string; desc: boolean } | null;
  /** 列头点击（表数据 Tab 的排序三态切换）；缺省 = 表头不可点 */
  onHeaderClick?: (col: string) => void;
  /** 点击单元格（单元格详情用） */
  onCellClick?: (info: CellClickInfo) => void;
  /** 单元格右键（复制值 / 复制行为 JSON·CSV） */
  onCellContext?: (info: CellClickInfo, ev: MouseEvent) => void;
}

/**
 * 构建结果表格；**结果为空集时返回 null**（调用方据此走 `emptyState`，不要在这里造空表格——
 * 空表格会让「查询没跑」和「查询跑了但 0 行」看起来一样）。
 */
export function buildGridTable(result: DbQueryResult, opts: GridOptions): HTMLTableElement | null {
  if (result.rows.length === 0) return null;
  const cols = result.columns;

  const table = document.createElement("table");
  table.className = "db-grid";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "db-rowno";
  corner.scope = "col";
  corner.textContent = "#";
  headRow.appendChild(corner);
  for (const name of cols) {
    const th = document.createElement("th");
    th.scope = "col";
    th.title = name;
    const label = document.createElement("span");
    label.className = "db-th-label";
    label.textContent = name;
    th.appendChild(label);
    if (opts.onHeaderClick) {
      th.classList.add("db-th-sortable");
      if (opts.sort?.col === name) {
        th.classList.add(opts.sort.desc ? "db-th-desc" : "db-th-asc");
        th.setAttribute("aria-sort", opts.sort.desc ? "descending" : "ascending");
        th.appendChild(codiconArrow(opts.sort.desc ? "arrow-down" : "arrow-up"));
      }
      th.addEventListener("click", () => opts.onHeaderClick?.(name));
    }
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  const tbody = document.createElement("tbody");
  result.rows.forEach((row, i) => {
    const tr = document.createElement("tr");
    const no = document.createElement("td");
    no.className = "db-rowno db-num";
    no.textContent = String(opts.offset + i + 1);
    tr.appendChild(no);
    for (let ci = 0; ci < cols.length; ci++) {
      const td = document.createElement("td");
      const d = formatCell(row[ci] ?? null);
      td.className = `db-cell db-cell-${d.kind}`;
      td.textContent = d.text;
      if (d.kind === "text") td.title = d.full;
      if (opts.onCellClick) {
        td.classList.add("db-cell-clickable");
        td.addEventListener("click", () => opts.onCellClick?.({ column: cols[ci], row: opts.offset + i + 1, display: d }));
      }
      if (opts.onCellContext) {
        td.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          opts.onCellContext?.({ column: cols[ci], row: opts.offset + i + 1, display: d }, ev);
        });
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });

  table.append(thead, tbody);
  return table;
}

/** 排序箭头（aria-hidden，排序态已由 aria-sort 表达） */
function codiconArrow(name: string): HTMLElement {
  const el = document.createElement("i");
  el.className = `codicon codicon-${name} db-th-arrow`;
  el.setAttribute("aria-hidden", "true");
  return el;
}
