# pylume 受控脚本 · regex_test
# 职责：在真实 Python re 引擎下验证正则模式（match / finditer / subn）。
# 约束（docs/python_library_support_dev_plan.md §3.1）：只读、无网络、无写文件、只用标准库；
# 入参经 stdin 读 JSON（args_json 不走 argv——正则含引号/反斜杠/换行，且 Windows argv 有 32K 限制）；
# 输出 stdout 单行 JSON {"ok": true, "data": ...} / {"ok": false, "error": "..."}。
# 由 Rust 侧以 `python -I -X utf8 -c <本文件> <kind>` 启动（-X utf8 强制 UTF-8 stdio）。

import json
import re
import sys

MAX_MATCHES = 500  # 与前端匹配表上限一致（PR-2 面板 500 行）


def _match_info(m):
    return {
        "span": list(m.span()),
        "groups": list(m.groups()),
        "named": m.groupdict(),
    }


def run(args):
    pattern = args.get("pattern")
    if not isinstance(pattern, str):
        raise ValueError("pattern 必须是字符串")
    test = args.get("test")
    if not isinstance(test, str):
        raise ValueError("test 必须是字符串")
    flags = args.get("flags", 0)
    if not isinstance(flags, int):
        raise ValueError("flags 必须是整数位掩码")

    rx = re.compile(pattern, flags)

    # 全量计数 + 截断列表：count 反映真实总数，matches 只带前 MAX_MATCHES 个
    matches = []
    count = 0
    for m in rx.finditer(test):
        count += 1
        if count <= MAX_MATCHES:
            matches.append(_match_info(m))

    first = rx.search(test) if count else None  # 只扫一次（count>0 才有匹配）
    data = {
        "match": _match_info(first) if first else None,
        "matches": matches,
        "count": count,
        "truncated": count > MAX_MATCHES,
    }

    repl = args.get("repl")
    if isinstance(repl, str):
        new_text, n = rx.subn(repl, test)
        data["sub"] = {"result": new_text, "count": n}
    return data


def main():
    try:
        args = json.loads(sys.stdin.read() or "{}")
        out = {"ok": True, "data": run(args)}
    except re.error as e:
        # re.error 原文透传（前端面板要显示「re.error: ...」原文）
        out = {"ok": False, "error": "re.error: %s" % e}
    except Exception as e:  # noqa: BLE001 —— 受控脚本的兜底协议出口
        out = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


main()
