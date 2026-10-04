#!/usr/bin/env python3
"""trace 库统计分析 —— 把 intel 的「拍脑袋值」换成有据值。

背景：`docs/python_ide_dev_plan_v2.md` §7 与 `intel/README.md` 都标注「基于真实使用
数据调整降权/清理策略 ⚠️ 未做」。本脚本是那件事的取数工具：读真实 trace 库（SQLite，
`<data_root>/traces/<project_hash>.db`），把当前**硬编码**的策略参数与真实分布摆在一起。

被审视的三个硬编码策略：

| 参数 | 现值 | 位置 |
|---|---|---|
| stale 补全降权 | `hits / 2`（0.5） | `intel/crates/pylume-intel/src/completion.rs:168` |
| stale 类型推断 | 直接丢弃 | `type_infer.rs:88,170,269,297` |
| trace 保留窗口 | 无（仅手动 `probe clean --days N`，且只删 runs 行） | `probe/src/pylume_probe/store.py:214` |

用法：
    python tools/intel/trace_stats.py                # 扫默认数据根
    python tools/intel/trace_stats.py <db> [<db>…]  # 指定库
    python tools/intel/trace_stats.py --out r.md     # 落盘 Markdown

只读：不写、不改、不删任何 trace 库（清理由 `probe clean` 负责，本脚本不越权）。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import statistics
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

# 本机控制台代码页是 GBK：直接 print 中文/符号会 UnicodeEncodeError。
# 统一把 stdout/stderr 切到 UTF-8（errors=replace 保证再窄的码页也不炸）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # 老 Python / 被重定向为非 TextIO
        pass

# 与 intel 源码保持同步的现值（改源码时改这里；本脚本不改源码）
STALE_DIVISOR = 2          # completion.rs:168 的 `f.hits / 2`
STALE_TYPE_INFER_DROP = True


def default_data_roots() -> list[Path]:
    """trace 库数据根候选（口径对齐 shell/src-tauri/src/util.rs:55-80）。"""
    roots: list[Path] = []
    if os.environ.get("PYLUME_DATA_ROOT"):
        roots.append(Path(os.environ["PYLUME_DATA_ROOT"]))
    if os.environ.get("LOCALAPPDATA"):
        roots.append(Path(os.environ["LOCALAPPDATA"]) / "Pylume")
    if os.environ.get("PYLUME_PROBE_HOME"):
        roots.append(Path(os.environ["PYLUME_PROBE_HOME"]))
    roots.append(Path.home() / ".pylume")
    seen, out = set(), []
    for r in roots:
        k = str(r).rstrip("\\/").lower()
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out


def find_trace_dbs(explicit: list[str]) -> list[Path]:
    if explicit:
        return [Path(p) for p in explicit]
    found: list[Path] = []
    for root in default_data_roots():
        tdir = root / "traces"
        if tdir.is_dir():
            found.extend(sorted(tdir.glob("*.db")))
    return found


@dataclass
class DbStats:
    path: Path
    size_bytes: int = 0
    runs: int = 0
    functions: int = 0
    stale_functions: int = 0
    arg_types: int = 0
    ret_types: int = 0
    exc_types: int = 0
    hits_total: int = 0
    hits_values: list[int] = field(default_factory=list)
    first_run: float | None = None
    last_run: float | None = None
    error: str | None = None

    @property
    def stale_ratio(self) -> float:
        return self.stale_functions / self.functions if self.functions else 0.0


def pct(vals: list[int], p: float) -> float:
    """线性插值分位数（vals 需已排序）。"""
    if not vals:
        return 0.0
    if len(vals) == 1:
        return float(vals[0])
    pos = p * (len(vals) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(vals) - 1)
    return vals[lo] * (1 - (pos - lo)) + vals[hi] * (pos - lo)


def analyze_db(path: Path) -> DbStats:
    st = DbStats(path=path)
    try:
        st.size_bytes = path.stat().st_size
    except OSError:
        pass
    try:
        con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    except sqlite3.Error as e:
        st.error = f"打开失败: {e}"
        return st

    def sc(sql: str, default=0):
        try:
            row = con.execute(sql).fetchone()
            return row[0] if row and row[0] is not None else default
        except sqlite3.Error:
            return default

    try:
        st.runs = sc("SELECT COUNT(*) FROM runs")
        st.functions = sc("SELECT COUNT(*) FROM functions")
        st.stale_functions = sc("SELECT COUNT(*) FROM functions WHERE stale=1")
        st.arg_types = sc("SELECT COUNT(*) FROM arg_types")
        st.ret_types = sc("SELECT COUNT(*) FROM ret_types")
        st.exc_types = sc("SELECT COUNT(*) FROM exc_types")
        st.hits_total = sc("SELECT COALESCE(SUM(hits),0) FROM functions")
        st.first_run = sc("SELECT MIN(started) FROM runs", None)
        st.last_run = sc("SELECT MAX(started) FROM runs", None)
        try:
            st.hits_values = [int(r[0] or 0) for r in
                              con.execute("SELECT hits FROM functions ORDER BY hits")]
        except sqlite3.Error:
            pass
    finally:
        con.close()
    return st


def aggregate(stats: list[DbStats]) -> dict:
    hits: list[int] = []
    for s in stats:
        hits.extend(s.hits_values)
    hits.sort()
    ok = [s for s in stats if not s.error]
    fn = sum(s.functions for s in stats)
    stale = sum(s.stale_functions for s in stats)
    byts = sum(s.size_bytes for s in stats)
    lasts = [s.last_run for s in ok if s.last_run]
    span = (max(lasts) - min(lasts)) / 86400 if len(lasts) > 1 else (0.0 if lasts else None)
    nz = [h for h in hits if h > 0]
    return {
        "dbs": len(stats), "dbs_ok": len(ok),
        "runs": sum(s.runs for s in stats), "functions": fn,
        "stale_functions": stale, "stale_ratio": (stale / fn) if fn else 0.0,
        "arg_types": sum(s.arg_types for s in stats),
        "ret_types": sum(s.ret_types for s in stats),
        "exc_types": sum(s.exc_types for s in stats),
        "total_bytes": byts, "bytes_per_function": (byts / fn) if fn else 0.0,
        "hits_total": sum(s.hits_total for s in stats),
        "hits_max": hits[-1] if hits else 0,
        "hits_p50": pct(hits, 0.5), "hits_p90": pct(hits, 0.9), "hits_p99": pct(hits, 0.99),
        "hits_mean": statistics.fmean(hits) if hits else 0.0,
        "hits_median_nonzero": statistics.median(nz) if nz else 0.0,
        "functions_never_run": sum(1 for h in hits if h == 0),
        "span_days": span,
    }


BUDGET_BYTES = 8 * 1024 * 1024  # 单库体积预算：SQLite 会被 intel 整表读入内存，过大拖慢 LSP 索引加载


def recommend(a: dict) -> list[dict]:
    """据真实分布给建议值。规则透明，读者可自行判断是否采纳。"""
    out: list[dict] = []
    r = a["stale_ratio"]

    # 1) stale 补全降权系数
    if a["dbs_ok"] == 0:
        coef, why = None, "无真实数据，无法反推（需先真机跑一次带探针的脚本）。"
    elif r == 0:
        coef, why = 1.0, "真实库 stale 占比为 0，降权对排序无影响；建议暂不降权，待出现 stale 再启用。"
    elif r < 0.10:
        coef = 0.75
        why = (f"stale 占比仅 {r:.1%}，降权对整体排序影响小；0.75 足以压住单个高频 stale 函数"
               f"（p90 hits={a['hits_p90']:.0f}）的榜首抢占，又不误伤其真实高频信号。")
    elif r < 0.30:
        coef = 1.0 / STALE_DIVISOR
        why = f"stale 占比 {r:.1%} 属中位，维持现状系数 0.5（与 completion.rs:168 一致），本次不改。"
    else:
        coef = 0.25
        why = (f"stale 占比 {r:.1%} 偏高，0.5 已不足以把过期观测压到新鲜观测之后；建议降到 0.25。"
               "同时应复查 stale 标记逻辑（判据是文件 mtime > 末次 run.started），"
               "可能是文件频繁改动导致过度标记，而非真的观测失效。")
    out.append({
        "param": "stale 补全降权系数",
        "current": f"hits/{STALE_DIVISOR}（0.5，硬编码 completion.rs:168 字面量，无常量名）",
        "suggested": "无法建议（缺真实数据）" if coef is None else f"×{coef}",
        "basis": why,
    })

    # 2) stale 在类型推断里是否该继续硬丢弃
    if a["dbs_ok"] == 0:
        s2 = "无法建议（缺真实数据）"
        b2 = "硬丢弃使 stale 函数完全失去类型补全能力，比排序降权更激进；需真实占比才能判断代价是否可接受。"
    elif r < 0.30:
        s2, b2 = "维持丢弃", f"stale 占比 {r:.1%}，硬丢弃最多影响这个比例的补全场景，代价可接受。"
    else:
        s2 = "改为降权（不清零）"
        b2 = (f"stale 占比 {r:.1%} 已偏高，硬丢弃让这些函数**完全**失去类型补全，"
              "建议改为「参与但降权」，与补全排序策略保持一致。")
    out.append({
        "param": "stale 类型推断（硬丢弃）",
        "current": "直接 continue（type_infer.rs:88,170,269,297）",
        "suggested": s2, "basis": b2,
    })

    # 3) 保留窗口（条数 / 体积上限）
    per = a["bytes_per_function"] or 600.0
    cap = int(BUDGET_BYTES / per) if per else 0
    if a["dbs_ok"] == 0:
        out.append({
            "param": "trace 库保留窗口", "current": "无上限",
            "suggested": "无法建议（缺真实数据）",
            "basis": "每条观测的平均字节数未知，无法反推条数上限。",
        })
    else:
        over = a["total_bytes"] > BUDGET_BYTES
        out.append({
            "param": "trace 库保留窗口（条数上限）",
            "current": "无上限；仅手动 `probe clean --days N`，且 --days **只删 runs 行、不删观测数据**",
            "suggested": f"单库 functions ≤ {cap:,} 条 或 8 MB（先到者提示清理）",
            "basis": (f"实测每条函数观测约 {per:.0f} 字节，按 8 MB 预算反推约 {cap:,} 条。"
                      f"当前 {a['functions']:,} 条 / {a['total_bytes'] / 1024:.0f} KB，"
                      f"{'已超预算' if over else '仍在预算内'}。"
                      "注意现行 --days 只删 runs 行，**观测数据永不因时间减少**，"
                      "真正的清理手段是 `--stale`（删 stale 函数及其观测）。"),
        })

    # 4) clean --days 的语义澄清（这是文档缺陷，不是参数）
    span_txt = f"跨度 {a['span_days']:.1f} 天 / {a['runs']} 次运行" if a["span_days"] is not None else "无运行记录"
    out.append({
        "param": "probe clean --days 语义",
        "current": "只删 runs 行（保留全部观测数据）",
        "suggested": "保留该设计，但在 --help 与 README 显式写明它≠保留窗口",
        "basis": (f"真实库{span_txt}。「删运行记录但留观测」是有意设计（观测是沉淀），"
                  "但字段名 --days 极易被误读为保留窗口；应改名或加显式说明。"),
    })
    return out


def render(a: dict, stats: list[DbStats], recs: list[dict], at: str) -> str:
    L = ["# trace 库统计报告", ""]
    L.append(f"- 生成时间：{at}")
    L.append(f"- 数据根候选：{', '.join(str(p) for p in default_data_roots())}")
    L.append("- 脚本：`tools/intel/trace_stats.py`（只读，不改 trace 库）")
    L.append("")
    if a["dbs_ok"] == 0:
        L += [
            "## 结论：无可分析的真实 trace 库", "",
            "未在任何数据根下找到 `traces/*.db`。这意味着：", "",
            "- `intel` 的降权/保留策略**至今没有任何真实数据支撑**，",
            "  `dev_plan_v2` §7「基于真实使用数据调整降权/清理策略 ⚠️」仍然成立；",
            "- 要把参数改成有据值，第一步是**用 IDE 真机跑一次带探针的脚本**生成 trace 库。", "",
            "手工生成方式（等价于 IDE 注入的那套 env）：", "",
            "```",
            "set PYLUME_PROBE_AUTOSTART=1",
            "set PYLUME_PROBE_SCRIPT=<主脚本绝对路径>",
            "set PYLUME_PROBE_HOME=<数据根>",
            "set PYTHONPATH=<probe/src>;%PYTHONPATH%",
            "python <主脚本绝对路径>",
            "```", "",
        ]
        return "\n".join(L)

    L += ["## 汇总", "", "| 项 | 值 |", "|---|---|"]
    table = [
        ("trace 库数", a["dbs"]), ("运行次数", a["runs"]), ("函数观测数", a["functions"]),
        ("stale 函数数", a["stale_functions"]), ("参数类型观测", a["arg_types"]),
        ("返回类型观测", a["ret_types"]), ("异常类型观测", a["exc_types"]),
        ("从未运行（hits=0）", a["functions_never_run"]),
    ]
    for k, v in table:
        L.append(f"| {k} | {v:,} |")
    L.append(f"| stale 占比 | {a['stale_ratio']:.1%} |")
    L.append(f"| 总体积 | {a['total_bytes'] / 1024:.0f} KB |")
    L.append(f"| 每条观测平均字节 | {a['bytes_per_function']:.0f} B |")
    L.append(f"| hits 均值 / p50 / p90 / p99 / max | {a['hits_mean']:.1f} / {a['hits_p50']:.0f} / {a['hits_p90']:.0f} / {a['hits_p99']:.0f} / {a['hits_max']} |")
    L.append(f"| hits 中位数（仅 >0） | {a['hits_median_nonzero']:.0f} |")
    if a["span_days"] is not None:
        L.append(f"| 运行跨度 | {a['span_days']:.1f} 天 |")
    L += ["", "## 参数建议（拍脑袋值 → 有据值）", ""]
    for x in recs:
        L += [f"### {x['param']}", "", f"- **现状**：{x['current']}",
              f"- **建议**：{x['suggested']}", f"- **依据**：{x['basis']}", ""]
    L += ["## 逐库明细", "", "| 库 | 体积 | runs | functions | stale | stale 占比 | 最后运行 |",
          "|---|---|---|---|---|---|---|"]
    for s in sorted(stats, key=lambda x: -x.size_bytes):
        if s.error:
            L.append(f"| `{s.path.name}` | — | — | — | — | — | 错误：{s.error} |")
            continue
        last = (datetime.fromtimestamp(s.last_run, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
                if s.last_run else "—")
        L.append(f"| `{s.path.name}` | {s.size_bytes / 1024:.0f} KB | {s.runs} | {s.functions} "
                 f"| {s.stale_functions} | {s.stale_ratio:.1%} | {last} |")
    L += ["",
          "> 口径：`functions.stale=1` 表示该函数所在文件在**末次运行之后**被修改过",
          "> （判据：文件 mtime > `MAX(runs.started)`，`probe/src/pylume_probe/store.py:185-211`）；",
          "> 它**不是**「N 天未运行」——真实库没有 per-function 时间戳，这是结构性限制。", ""]
    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser(description="trace 库统计分析（只读）")
    ap.add_argument("dbs", nargs="*", help="trace 库路径；缺省扫默认数据根")
    ap.add_argument("--out", help="落盘 Markdown 报告路径")
    ap.add_argument("--quiet", action="store_true", help="只落盘，不打印")
    args = ap.parse_args()

    paths = find_trace_dbs(args.dbs)
    stats = [analyze_db(p) for p in paths]
    a = aggregate(stats)
    recs = recommend(a)
    at = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S %z")
    md = render(a, stats, recs, at)

    if args.out:
        outp = Path(args.out)
        outp.parent.mkdir(parents=True, exist_ok=True)
        outp.write_text(md, encoding="utf-8")
        if not args.quiet:
            print(f"报告已写入: {outp}")
    if not args.quiet:
        print(md)
    if args.dbs and any(s.error for s in stats):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
