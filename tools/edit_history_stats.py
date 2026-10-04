#!/usr/bin/env python3
"""整行可预测性统计（低延迟编辑预测数据源 V1）。

量化「用上一行 + 前缀，回放/补全下一整行」的可预测性，是决定后续预测引擎
走「本地行对回放」还是「小模型兜底」的关键证据。

数据源（至少给一个）：
  --jsonl <文件>   读编辑历史 JSONL（真实采集，字段 {prev, line, ...}）。真实值。
  --dir <目录>     递归 *.py 逐行切分相邻非空行。这是「成品代码」代理，前后行强相关，
                   命中的是**上界**（真实编辑流有中间态，命中会低于此）。

评估方式：**流式、只用「过去」见到的历史**预测当前行，无数据泄漏——
模拟「你现在打字时，预测只能依赖你之前写过的内容」。

输出指标：
  1. 规模：事件总数、去重行对数、出现 >= 2/3/5/10 次的行对占比（重复够不够撑回放）
  2. 整行回放：覆盖率（prev 有历史可查的比例）+ top-1 / top-K 精确率
  3. 行中补全：给出行前半段（默认 50% 字符）作前缀，能否回放出整行

用法：
  python -u tools/edit_history_stats.py --jsonl %LOCALAPPDATA%\\Pylume\\edit_history\\events.jsonl
  python -u tools/edit_history_stats.py --dir bench/sample
  python -u tools/edit_history_stats.py --dir . --jsonl events.jsonl   # 混合
"""

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


def iter_jsonl_pairs(path: str):
    """读编辑历史 JSONL，yield (prev, line)。跳过非法/空行。"""
    bad = 0
    total_lines = 0
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            total_lines += 1
            raw = raw.strip()
            if not raw:
                continue
            try:
                e = json.loads(raw)
            except json.JSONDecodeError:
                bad += 1
                continue
            line = e.get("line")
            if not isinstance(line, str) or not line.strip():
                continue
            prev = e.get("prev")
            yield (prev if isinstance(prev, str) else None), line
    if bad:
        print(f"[warn] 跳过 {bad}/{total_lines} 条非法 JSON 行", flush=True)


def iter_dir_pairs(root: str):
    """递归 *.py 逐行切分，yield 相邻非空行的 (prev, line)。"""
    files = sorted(Path(root).rglob("*.py"))
    print(f"[dir] 扫描 {len(files)} 个 .py 文件", flush=True)
    for p in files:
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rows = [ln.strip() for ln in text.splitlines()]
        rows = [ln for ln in rows if ln]  # 去空行
        prev = None
        for ln in rows:
            yield (prev, ln)
            prev = ln


def evaluate(pairs, topk: int, prefix_ratio: float):
    """流式评估，返回 (指标字典, final_succ)。"""
    succ = defaultdict(Counter)  # prev -> Counter[line]

    total = 0
    covered = 0        # prev 有历史（能出预测）的事件数
    prec1 = 0          # covered 里 top-1 命中
    preck = 0          # covered 里 top-K 命中

    prefix_total = 0   # prev 有历史 + 前缀能筛出候选的事件数
    prefix_hit = 0

    for prev, line in pairs:
        total += 1
        c = succ.get(prev)
        if not c:
            # 尚无历史，无法预测；随后把本行并入历史
            succ[prev][line] += 1
            continue

        covered += 1
        top1 = c.most_common(1)[0][0]
        if top1 == line:
            prec1 += 1
        if line in [x for x, _ in c.most_common(topk)]:
            preck += 1

        # 行中补全：取前 prefix_ratio 字符作已输入前缀，筛「同 prev 且同前缀」的候选
        cut = max(1, int(len(line) * prefix_ratio))
        prefix = line[:cut]
        cands = [ln for ln in c if ln.startswith(prefix) and len(ln) >= len(prefix)]
        if cands:
            prefix_total += 1
            best = max(cands, key=lambda ln: c[ln])
            if best == line:
                prefix_hit += 1

        succ[prev][line] += 1

    metrics = {
        "total": total,
        "coverage": covered / total if total else 0.0,
        "precision@1": prec1 / covered if covered else 0.0,
        f"precision@{topk}": preck / covered if covered else 0.0,
        "prefix_coverage": prefix_total / total if total else 0.0,
        "prefix_precision": prefix_hit / prefix_total if prefix_total else 0.0,
    }
    return metrics, succ


def freq_distribution(succ) -> dict:
    """行对出现频次分布：出现 >= N 次的行对占全部去重行对的比例。"""
    counts = []
    for c in succ.values():
        counts.extend(c.values())
    if not counts:
        return {}
    total_pairs = len(counts)
    dist = {}
    for n in (1, 2, 3, 5, 10):
        hit = sum(1 for x in counts if x >= n)
        dist[n] = hit / total_pairs
    return dist


def print_report(metrics: dict, dist: dict, topk: int):
    print("=" * 60, flush=True)
    print("整行可预测性报告", flush=True)
    print("=" * 60, flush=True)
    print(f"事件总数           : {metrics['total']}", flush=True)
    print(f"覆盖率（能出预测）  : {metrics['coverage']:.1%}", flush=True)
    print(f"整行回放 top-1 精确 : {metrics['precision@1']:.1%}", flush=True)
    print(f"整行回放 top-{topk} 精确 : {metrics[f'precision@{topk}']:.1%}", flush=True)
    print(f"行中补全覆盖率      : {metrics['prefix_coverage']:.1%}", flush=True)
    print(f"行中补全精确率      : {metrics['prefix_precision']:.1%}", flush=True)
    print("-" * 60, flush=True)
    print("行对复现频次分布（去重行对中，出现 >= N 次的比例）:", flush=True)
    for n, r in dist.items():
        print(f"  >= {n:>2} 次 : {r:6.1%}", flush=True)
    print("=" * 60, flush=True)


def main():
    # Windows 下强制 UTF-8 输出，避免控制台 GBK 解码中文乱码
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="整行可预测性统计（低延迟编辑预测）")
    ap.add_argument("--jsonl", help="编辑历史 JSONL 路径")
    ap.add_argument("--dir", help="递归 *.py 目录作为代理数据")
    ap.add_argument("--topk", type=int, default=5, help="top-K 精确率里的 K（默认 5）")
    ap.add_argument("--prefix", type=float, default=0.5, help="行中补全的前缀比例（默认 0.5）")
    args = ap.parse_args()

    if not args.jsonl and not args.dir:
        ap.error("至少指定 --jsonl 或 --dir 之一")

    def source():
        if args.jsonl:
            print(f"[jsonl] {args.jsonl}", flush=True)
            yield from iter_jsonl_pairs(args.jsonl)
        if args.dir:
            print(f"[dir] {args.dir}", flush=True)
            yield from iter_dir_pairs(args.dir)

    metrics, succ = evaluate(source(), args.topk, args.prefix)
    dist = freq_distribution(succ)
    print_report(metrics, dist, args.topk)


if __name__ == "__main__":
    sys.exit(main())