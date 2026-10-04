#!/usr/bin/env python3
"""扫描 TS 源里的中文字符串字面量，产出「待抽取清单」。

与 extract_html.py 的关系：那个处理静态骨架（index.html），这个处理 TS 里的动态文案
（toast / 对话框 / 面板渲染）。两者的产物都是「归一化模板 → key」映射表的输入。

为什么自己扫而不用 TS AST：项目没引 AST 依赖，而这里要的是「字面量原文 + 精确字节区间」
（用于后续按 offset 改写），正则 + 引号配对足够；真正容易错的是模板字符串里嵌套的
`${...}`，故对 `${}` 内部做递归扫描。

用法：
    python3 tools/i18n/scan_ts.py src/git.ts            # 打印统计与样本
    python3 tools/i18n/scan_ts.py src/git.ts -o data/x.json
"""
import json
import re
import sys
from pathlib import Path

CJK = re.compile(r"[\u4e00-\u9fff]")
# 模板插值：${ ... }（括号配对，支持一层嵌套）
INTERP = re.compile(r"\$\{")
# 归一化后的占位符
PH = "§"


def _match_quoted(src: str, start: int) -> int | None:
    """src[start] 是引号，返回对应闭合引号的下标（不含）；跨行/未闭合返回 None。"""
    q = src[start]
    i = start + 1
    n = len(src)
    while i < n:
        c = src[i]
        if c == "\\":
            i += 2
            continue
        if c == "\n":
            return None
        if c == q:
            return i
        i += 1
    return None


def _interp_end(src: str, open_at: int) -> int | None:
    """src[open_at:open_at+2] == '${'，返回匹配的 '}' 下标（不含）。"""
    depth = 0
    i = open_at + 1
    n = len(src)
    while i < n:
        c = src[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
        elif c == "\n":
            return None
        i += 1
    return None


def iter_strings(src: str, base: int = 0, depth: int = 0) -> list[dict]:
    """提取所有字符串字面量（含模板字符串内 ${} 的递归扫描）。

    返回 [{start, end, quote, body}]，start/end 为文件内绝对下标（end 为闭引号后一位）。
    """
    out: list[dict] = []
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        if c in "\"'`":
            end = _match_quoted(src, i)
            if end is None:
                i += 1
                continue
            body = src[i + 1 : end]
            if CJK.search(body):
                out.append({"start": base + i, "end": base + end + 1, "quote": c, "body": body})
            # 模板字符串：递归扫 ${} 内部（三元里的中文短串就藏在这里）
            if c == "`":
                for m in INTERP.finditer(body):
                    j = m.start()
                    close = _interp_end(body, j)
                    if close is None:
                        continue
                    inner = body[j + 2 : close]
                    out.extend(iter_strings(inner, base + i + 1 + j + 2, depth + 1))
            i = end + 1
            continue
        i += 1
    return out


def norm_body(body: str) -> str:
    """把 `${...}` 归一化成 §，作为映射表的键（同一文案的不同插值表达式归并成一条）。"""
    out = []
    i = 0
    n = len(body)
    while i < n:
        if body.startswith("${", i):
            close = _interp_end(body, i)
            if close is None:
                out.append(body[i:])
                break
            out.append(PH)
            i = close + 1
            continue
        out.append(body[i])
        i += 1
    return "".join(out)


def exprs_of(body: str) -> list[str]:
    """取出模板里所有插值表达式原文（顺序即占位顺序）。"""
    exprs = []
    i = 0
    n = len(body)
    while i < n:
        if body.startswith("${", i):
            close = _interp_end(body, i)
            if close is None:
                break
            exprs.append(body[i + 2 : close].strip())
            i = close + 1
            continue
        i += 1
    return exprs


def collect(path: Path) -> dict:
    src = path.read_text(encoding="utf-8")
    lines = src.split("\n")
    entry: dict[str, dict] = {}
    for s in iter_strings(src):
        body = s["body"]
        key = norm_body(body)
        line_no = src.count("\n", 0, s["start"]) + 1
        rec = entry.setdefault(
            key, {"count": 0, "exprs": exprs_of(body), "sites": []}
        )
        rec["count"] += 1
        rec["sites"].append(
            {
                "line": line_no,
                "quote": s["quote"],
                "body": body,
                "start": s["start"],
                "end": s["end"],
                "src": lines[line_no - 1].strip()[:200],
            }
        )
    return entry


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    out = None
    if "-o" in sys.argv:
        out = sys.argv[sys.argv.index("-o") + 1]
    if not args:
        print(__doc__)
        return 2
    entry = collect(Path(args[0]))

    htmlish = [k for k in entry if re.search(r"</[a-z]|=\s*[\"']|[a-z-]+=\"", k)]
    print(f"唯一模板: {len(entry)}   出现总数: {sum(e['count'] for e in entry.values())}")
    print(f"含 HTML 片段的模板: {len(htmlish)}")
    for k in htmlish[:15]:
        print(f"   HTML | {k[:100]}")
    if out:
        Path(out).write_text(
            json.dumps(entry, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        print(f"→ {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
