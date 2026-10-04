"""pylume-probe CLI。

用法：
  pylume-probe run <script.py> [args...]   # 采集运行并写入 trace 库
  pylume-probe show [pattern] [--json]     # 查看 trace 库汇总
  pylume-probe inject -- <command...>      # 以注入方式运行任意命令（uv run 等）
  pylume-probe clean [--days N] [--stale] [--all-runs]  # trace 库清理（P2-T07）
  pylume-probe check <script.py> [--expect file.json]   # 正确率抽检（P2-T08）
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import subprocess
import sys

from .config import load_config
from .store import db_path, load_summary, load_summary_json


def _safe_stdio() -> None:
    """GBK 控制台兜底：✓/✗ 等字符编码失败时降级替换而非崩溃。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass


def _cmd_run(args) -> int:
    from .runner import run_with_probe

    cfg = load_config(quiet=args.quiet)
    summary: dict | None = None
    try:
        summary = run_with_probe(cfg, args.script, args.argv)
    except FileNotFoundError as e:
        print(f"[pylume-probe] ✗ 脚本不存在：{e}", file=sys.stderr)
        return 2
    except (sqlite3.Error, OSError, RuntimeError) as e:
        # P2-2（2026-09-29 review）：落库失败（盘满/库损坏）、monitor 初始化失败
        #（低版本无 sys.monitoring 的 RuntimeError）等不再以裸 traceback 面向用户
        #（对比注入模式 autostart 已有完整兜底）。脚本原始异常由 run_with_probe
        # 原样抛出（类型各异，不走此分支——SystemExit 已被 runner 转为 exit_code）。
        print(f"[pylume-probe] ✗ 采集运行失败：{e}", file=sys.stderr)
        return 3
    if summary is None:  # 静态分析守卫：上方分支均已 return
        return 3
    if not cfg.quiet:
        print(f"[pylume-probe] ✓ {summary['functions']} 函数 · "
              f"{summary['observations']} 类型观测 · {summary['elapsed']:.3f}s → {summary['db']}")
    # P2-1（2026-09-29 review）：退出码透传——runner 精心计算的 exit_code 此前被
    # 无条件 return 0 吞掉，CI/脚本链中 `pylume-probe run app.py && next` 会误判成功。
    return int(summary.get("exit_code", 0))


def _cmd_show(args) -> int:
    cfg = load_config()
    path = db_path(cfg, os.path.abspath(args.project or os.getcwd()))
    if not path.is_file():
        print(f"[pylume-probe] ✗ 无 trace 库：{path}", file=sys.stderr)
        return 2
    if args.json:
        print(load_summary_json(path, args.pattern))
        return 0
    rows = load_summary(path, args.pattern)
    if not rows:
        print("[pylume-probe] （无匹配记录）")
        return 0
    for r in rows:
        loc = f"{os.path.relpath(r['filename'], os.path.dirname(path.parent))}" \
              if r["filename"].startswith(os.path.dirname(path.parent)) else r["filename"]
        print(f"◆ {r['qualname']}  ({loc}:{r['lineno']})  ×{r['hits']}")
        for arg, t, c in r["args"]:
            print(f"    arg {arg}: {t}  ×{c}")
        for t, c in r["rets"]:
            print(f"    ret {t}  ×{c}")
        for e, c in r["excs"]:
            print(f"    raise {e}  ×{c}")
    return 0


def _inject_env(script: str) -> dict:
    """注入模式环境变量（inject/check 共用）：PYTHONPATH 前置 src/ + 激活探针。"""
    env = os.environ.copy()
    # sitecustomize 注入路径：src/ 顶层（含 pylume_probe 包 + sitecustomize.py）
    src_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = src_dir if not existing else src_dir + os.pathsep + existing
    env.setdefault("PYLUME_PROBE_AUTOSTART", "1")
    env["PYLUME_PROBE_SCRIPT"] = script
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def _cmd_inject(args) -> int:
    """以环境注入方式运行命令：子进程 import pylume_probe 后自动采集。

    用途：目标脚本依赖第三方包时，用目标项目 venv 执行（如
    `pylume-probe inject -- uv run python scraper.py`）。
    """
    if not args.command:
        print("[pylume-probe] ✗ inject 需要命令：pylume-probe inject -- <command...>",
              file=sys.stderr)
        return 2
    # P2-6（2026-09-29 review）：command[-1] 不是 .py 文件时（`uv run -m pkg` / pytest /
    # `-c "..."`）bootstrap 会静默跳过，用户得到 0 采集且无任何提示。无法可靠推断
    # 脚本路径时降级为空串（守卫用）并打印警告，明示约束。
    script = os.path.abspath(args.command[-1])
    if not script.endswith((".py", ".pyw")) or not os.path.isfile(script):
        print("[pylume-probe] ⚠ 无法从命令尾部推断 .py 脚本路径"
              "（argv[0] 守卫可能不匹配 → 0 采集）。"
              "inject 模式要求命令以脚本路径结尾（如 `inject -- uv run python app.py`）。",
              file=sys.stderr)
        script = ""
    env = _inject_env(script)
    proc = subprocess.run(args.command, env=env)
    return proc.returncode


def _cmd_clean(args) -> int:
    """trace 库清理（P2-T07）。"""
    from .store import clean

    cfg = load_config()
    stats = clean(cfg, os.path.abspath(args.project or os.getcwd()),
                  days=args.days, stale=args.stale, all_runs=args.all_runs)
    if stats.get("error") == "not_found":
        print(f"[pylume-probe] ✗ 无 trace 库：{stats['db']}", file=sys.stderr)
        return 2
    parts = [f"runs={stats['runs']}", f"functions={stats['functions']}",
             f"stale={stats['stale_functions']}"]
    if "runs_deleted" in stats:
        parts.insert(0, f"runs_deleted={stats['runs_deleted']}")
    if "functions_deleted" in stats:
        parts.insert(1, f"functions_deleted={stats['functions_deleted']}")
    print(f"[pylume-probe] ✓ clean 完成：{' · '.join(parts)} → {stats['db']}")
    return 0


def _cmd_check(args) -> int:
    """正确率抽检（P2-T08）：注入运行脚本 → 比对 trace 与期望类型标注。

    期望文件格式（JSON，默认 <脚本目录>/probe_expect.json）：
    {
      "functions": [
        {"qualname": "add", "args": {"a": ["int", "str"]}, "rets": ["int", "str"]}
      ]
    }
    args/rets 为「该位观测到的类型标签集合应包含的期望集合」——
    期望类型缺失 → miss（错误）；trace 多出的额外类型不算错（联合类型合法）。

    运行方式：默认当前解释器；--uv 用目标项目 venv（uv run python，依赖第三方包时）。
    """
    import json

    from .store import db_path, load_summary

    cfg = load_config(quiet=True)
    script = os.path.abspath(args.script)
    if not os.path.isfile(script):
        print(f"[pylume-probe] ✗ 脚本不存在：{script}", file=sys.stderr)
        return 2
    expect_path = os.path.abspath(args.expect) if args.expect else \
        os.path.join(os.path.dirname(script), "probe_expect.json")
    if not os.path.isfile(expect_path):
        print(f"[pylume-probe] ✗ 期望文件不存在：{expect_path}", file=sys.stderr)
        return 2
    with open(expect_path, encoding="utf-8") as f:
        expect = json.load(f)

    # 注入运行（子进程，脚本目录为 cwd——同级 import 与 `python script.py` 一致）
    env = _inject_env(script)
    env["PYLUME_PROBE_QUIET"] = "1"
    cmd = ["uv", "run", "python", script] if args.uv else [sys.executable, script]
    proc = subprocess.run(cmd, env=env, cwd=os.path.dirname(script),
                          capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        print(f"[pylume-probe] ✗ 脚本运行失败（exit {proc.returncode}）",
              file=sys.stderr)
        if proc.stderr:
            print(proc.stderr, file=sys.stderr)
        return 2

    path = db_path(cfg, os.path.dirname(script))
    if not path.is_file():
        print(f"[pylume-probe] ✗ 运行后无 trace 库：{path}", file=sys.stderr)
        return 2
    rows = load_summary(path)
    by_qualname: dict[str, dict] = {}
    for r in rows:
        by_qualname.setdefault(r["qualname"], r)

    total = miss = 0
    misses: list[str] = []
    for fn in expect.get("functions", []):
        qn = fn["qualname"]
        row = by_qualname.get(qn)
        if row is None:
            total += 1
            miss += 1
            misses.append(f"{qn}: 函数未被采集到")
            continue
        for arg, want_types in (fn.get("args") or {}).items():
            got = {t for (a, t, _c) in row["args"] if a == arg}
            for want in want_types:
                total += 1
                if want not in got:
                    miss += 1
                    misses.append(f"{qn}.arg {arg}: 期望 {want}，实际 {sorted(got) or '无'}")
        for want in fn.get("rets") or []:
            got = {t for (t, _c) in row["rets"]}
            total += 1
            if want not in got:
                miss += 1
                misses.append(f"{qn}.ret: 期望 {want}，实际 {sorted(got) or '无'}")

    rate = (1 - miss / total) * 100 if total else 100.0
    print(f"[pylume-probe] 抽检 {total} 项 · 命中 {total - miss} · "
          f"正确率 {rate:.1f}%（阈值 {args.threshold}%）")
    for m in misses:
        print(f"  ✗ {m}")
    if rate < args.threshold:
        print("[pylume-probe] ✗ 低于阈值", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    _safe_stdio()
    parser = argparse.ArgumentParser(
        prog="pylume-probe",
        description="Pylume 运行时探针（PEP 669 采集 → SQLite trace 库）",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="采集运行脚本并写入 trace 库")
    p_run.add_argument("script", help="目标脚本路径")
    p_run.add_argument("argv", nargs="*", help="传给脚本的参数")
    p_run.add_argument("--quiet", action="store_true", help="抑制摘要输出")
    p_run.set_defaults(func=_cmd_run)

    p_show = sub.add_parser("show", help="查看 trace 库汇总")
    p_show.add_argument("pattern", nargs="?", default=None, help="qualname 过滤（LIKE）")
    p_show.add_argument("--project", default=None, help="项目根（默认当前目录）")
    p_show.add_argument("--json", action="store_true", help="JSON 输出（shell/Phase 3 消费）")
    p_show.set_defaults(func=_cmd_show)

    p_inj = sub.add_parser("inject", help="以注入方式运行命令（uv run 等）")
    p_inj.add_argument("command", nargs=argparse.REMAINDER, help="-- 后跟完整命令")
    p_inj.set_defaults(func=_cmd_inject)

    p_clean = sub.add_parser("clean", help="trace 库清理（P2-T07）")
    p_clean.add_argument("--project", default=None, help="项目根（默认当前目录）")
    p_clean.add_argument("--days", type=int, default=None,
                         help="删除 N 天前的 runs 行（观测保留）")
    p_clean.add_argument("--stale", action="store_true",
                         help="删除陈旧函数及其全部观测")
    p_clean.add_argument("--all-runs", action="store_true", dest="all_runs",
                         help="清空 runs 表（保留观测）")
    p_clean.set_defaults(func=_cmd_clean)

    p_check = sub.add_parser("check", help="正确率抽检（P2-T08）")
    p_check.add_argument("script", help="目标脚本路径")
    p_check.add_argument("--expect", default=None,
                         help="期望类型 JSON（默认 <脚本目录>/probe_expect.json）")
    p_check.add_argument("--uv", action="store_true",
                         help="用目标项目 venv 运行（uv run python，依赖第三方包时）")
    p_check.add_argument("--threshold", type=float, default=98.0,
                         help="正确率阈值（%%，默认 98）")
    p_check.set_defaults(func=_cmd_check)

    args = parser.parse_args(argv)
    if getattr(args, "command", None) and args.command and args.command[0] == "--":
        args.command = args.command[1:]
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
