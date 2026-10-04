# pylume 受控脚本 · format_preview
# 职责：在真实 Python 运行时预览三类格式串（strftime / format spec / logging %()s）。
# 约束同 regex_test.py：只读、无网络、只用标准库、stdin 进 JSON、stdout 出单行 JSON。
# 由 Rust 侧以 `python -I -X utf8 -c <本文件> <kind>` 启动。

import json
import logging
import sys
from datetime import datetime

# 降级口径（dev plan §5）：无解释器时前端速查表照常、预览置灰；
# 有解释器时预览必须用真实引擎，**不做 JS 近似**。

STRFTIME_EXAMPLES = {
    "Y": 2026, "m": 9, "d": 27, "H": 10, "M": 30, "S": 15,
}


def run_strftime(fmt):
    # Python 3.8+ 的 strftime 对非法指令多按原样输出，不报错——照实返回即可
    now = datetime.now()
    return {"result": now.strftime(fmt), "epoch": now.timestamp()}


def run_format(fmt, values):
    if values is None:
        values = {}
    # dict → 关键字实参（{name}）；list/tuple → 位置实参（{} / {0}）；标量 → 单个位置实参
    try:
        if isinstance(values, dict):
            result = fmt.format(**values)
        elif isinstance(values, (list, tuple)):
            result = fmt.format(*values)
        else:
            result = fmt.format(values)
    except (KeyError, IndexError) as e:
        raise ValueError("缺少示例值：%s" % e)
    except ValueError as e:
        # {:q} 等未知格式码 → ValueError("Unknown format code 'q' ...")
        raise ValueError(str(e))
    return {"result": result}


def run_logging(fmt, values):
    if values is None:
        values = {}
    if not isinstance(values, dict):
        raise ValueError("values 必须是对象")
    level = values.get("level", logging.INFO)
    if isinstance(level, str):
        level = getattr(logging, level.upper(), logging.INFO)
    rec = logging.LogRecord(
        name=str(values.get("name", "root")),
        level=level,
        pathname=str(values.get("pathname", "script.py")),
        lineno=int(values.get("lineno", 1)),
        msg=str(values.get("message", "")),
        args=(),
        exc_info=None,
    )
    # 用户自定义字段并入 record（logging %(...)s 直接读 record.__dict__）
    reserved = {"name", "level", "pathname", "lineno", "message"}
    rec.__dict__.update({k: v for k, v in values.items() if k not in reserved})
    try:
        result = logging.Formatter(fmt).format(rec)
    except KeyError as e:
        raise ValueError("未知记录字段：%s" % e)
    except ValueError as e:
        raise ValueError(str(e))
    return {"result": result}


def run(args):
    mode = args.get("mode")
    fmt = args.get("fmt")
    if not isinstance(fmt, str):
        raise ValueError("fmt 必须是字符串")
    values = args.get("values")
    if mode == "strftime":
        return run_strftime(fmt)
    if mode == "format":
        return run_format(fmt, values)
    if mode == "logging":
        return run_logging(fmt, values)
    raise ValueError("mode 必须是 strftime / format / logging 之一")


def main():
    try:
        args = json.loads(sys.stdin.read() or "{}")
        out = {"ok": True, "data": run(args)}
    except Exception as e:  # noqa: BLE001 —— 受控脚本的兜底协议出口
        out = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


main()
